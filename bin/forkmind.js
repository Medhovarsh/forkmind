#!/usr/bin/env node

// CLI entry point. Shebang lets `npx forkmind` / `forkmind` run this directly.
const { program } = require('commander');
const { initStorage } = require('../src/storage/engine');
const { startServer } = require('../src/proxy/server');
const { startMcp } = require('../src/mcp/server');
const reg = require('../src/regression/engine');
const { runAll, printReport } = require('../src/regression/runner');
const capsules = require('../src/context/engine');

// commander collects repeated --contains/--regex flags into an array.
function collect(value, prev) {
  return (prev || []).concat([value]);
}

program
  .name('forkmind')
  .description('Local-first LLM state branching, debugging & context offloading')
  .version('0.3.1');

// `forkmind init` — scaffold .forkmind/ in the current working directory.
program
  .command('init')
  .description('Create the .forkmind storage directory in the current project')
  .action(() => {
    const dir = initStorage();
    console.log(`ForkMind initialized at ${dir}`);
  });

// `forkmind start` — boot storage + the local proxy (and dashboard if built).
program
  .command('start')
  .description('Start the ForkMind proxy server (default port 4500)')
  .action(() => {
    startServer();
  });

// `forkmind mcp` — expose .forkmind/ history to AI agents over MCP (stdio).
program
  .command('mcp')
  .description('Start the MCP server so agents can query their .forkmind history')
  .action(() => {
    startMcp().catch((err) => {
      console.error(`[forkmind] MCP failed to start: ${err.message}`);
      process.exit(1);
    });
  });

// `forkmind regression ...` — pin good outputs as baselines and re-run them to
// catch output degradation after prompt/model tweaks.
const regression = program
  .command('regression')
  .alias('reg')
  .description('Pin baseline outputs and re-run them to detect regressions');

regression
  .command('pin <nodeId>')
  .description('Pin a captured node as a regression baseline')
  .requiredOption('-n, --name <name>', 'unique case name')
  .option('-c, --contains <text>', 'substring the output must contain (repeatable)', collect, [])
  .option('--not-contains <text>', 'substring the output must NOT contain (repeatable)', collect, [])
  .option('-r, --regex <pattern>', 'regex the output must match (repeatable)', collect, [])
  .option('-s, --min-similarity <n>', 'min Jaccard similarity vs baseline (0-1)', parseFloat)
  .action((nodeId, opts) => {
    try {
      const c = reg.pinNode(nodeId, opts.name, {
        contains: opts.contains,
        notContains: opts.notContains,
        regex: opts.regex,
        minSimilarity: opts.minSimilarity,
      });
      console.log(`Pinned regression case "${c.name}" (${c.id}) from node ${nodeId}`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

regression
  .command('list')
  .description('List pinned regression cases')
  .action(() => {
    const cases = reg.listCases();
    if (!cases.length) return console.log('No regression cases pinned.');
    for (const c of cases) {
      const a = c.assertions;
      console.log(
        `  ${c.name}  [${c.id}]  ${c.provider || '—'}  ` +
          `contains:${a.contains.length} regex:${a.regex.length} minSim:${a.minSimilarity}`
      );
    }
  });

regression
  .command('remove <nameOrId>')
  .alias('rm')
  .description('Delete a regression case')
  .action((nameOrId) => {
    console.log(reg.removeCase(nameOrId) ? `Removed "${nameOrId}"` : `Not found: ${nameOrId}`);
  });

regression
  .command('run')
  .description('Replay pinned cases and report pass/fail (exit 1 on any failure)')
  .option('-k, --key <apiKey>', 'API key for the upstream (or set FORKMIND_API_KEY)')
  .option('-u, --upstream <url>', 'override upstream base URL for all cases')
  .option('--only <nameOrId>', 'run a single case')
  .action(async (opts) => {
    const report = await runAll({
      apiKey: opts.key || process.env.FORKMIND_API_KEY,
      upstream: opts.upstream,
      only: opts.only,
    });
    process.exit(printReport(report));
  });

// `forkmind context ...` — save conversation context as an immutable encrypted
// DAG capsule, then drop it from the live model window; restore on demand.
const context = program
  .command('context')
  .alias('ctx')
  .description('Offload context into encrypted DAG capsules and restore on demand');

context
  .command('save')
  .description('Save a capsule from a JSON file or stdin ({title?, items:[{role,content}]})')
  .option('-t, --title <title>', 'capsule title')
  .option('-f, --file <path>', 'read items JSON from a file (default: stdin)')
  .option('-d, --digest <text>', 'plaintext retrieval digest (omit = private capsule)')
  .action(async (opts) => {
    try {
      const raw = opts.file
        ? require('fs').readFileSync(opts.file, 'utf8')
        : await new Promise((resolve, reject) => {
            let buf = '';
            process.stdin.on('data', (c) => (buf += c));
            process.stdin.on('end', () => resolve(buf));
            process.stdin.on('error', reject);
          });
      // Strip a UTF-8 BOM — Windows editors and PowerShell redirects add one.
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      const items = Array.isArray(parsed) ? parsed : parsed.items;
      const title = opts.title || parsed.title;
      const out = capsules.saveCapsule({ title, items, digest: opts.digest || null });
      console.log(`Saved capsule ${out.id}  (${out.segments} segments, ${out.bytes} bytes)`);
      if (out.digest) console.log(`Digest: ${out.digest}`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

context
  .command('list')
  .description('List saved capsules')
  .option('-q, --query <text>', 'substring filter over title + digest')
  .action((opts) => {
    const list = capsules.listCapsules({ q: opts.query });
    if (!list.length) return console.log('No capsules saved.');
    for (const c of list) {
      console.log(
        `  ${c.id}  ${c.createdAt}  ${c.bytes}B  ${c.title}` +
          (c.digest ? `\n      ${c.digest.split('\n')[0]}` : '  (private)')
      );
    }
  });

context
  .command('show <id>')
  .description('Restore a capsule (decrypted, integrity-verified)')
  .option('--digest-only', 'print only the digest + structure (no decryption)')
  .option('--segment <segId>', 'restore a single segment')
  .action((id, opts) => {
    try {
      if (opts.digestOnly) {
        const d = capsules.getDigest(id);
        if (!d) throw new Error('capsule not found');
        return console.log(JSON.stringify(d, null, 2));
      }
      if (opts.segment) {
        const [seg] = capsules.readSegments(id, [opts.segment]);
        return console.log(seg.content);
      }
      const cap = capsules.readCapsule(id);
      console.log(`# ${cap.title}  [${cap.id}]`);
      for (const item of cap.items) console.log(`\n[${item.role}]\n${item.content}`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

context
  .command('verify <id>')
  .description('Check DAG integrity: parents resolve, acyclic, content hashes valid')
  .action((id) => {
    const v = capsules.verifyCapsule(id);
    console.log(JSON.stringify(v, null, 2));
    process.exit(v.ok ? 0 : 1);
  });

// `forkmind context replicas ...` — RAID for capsules: mirror ciphertext to
// extra filesystem targets; the engine self-heals from them on corruption.
const replicasCmd = context
  .command('replicas')
  .description('Manage redundant capsule storage (Redundant Array of Independent DAGs)');

replicasCmd
  .command('add <path>')
  .description('Add a replica target (another disk, synced folder, network mount)')
  .action((p) => {
    try {
      const targets = capsules.replicasAdd(p);
      const sync = capsules.replicasSync();
      console.log(`Replica added. Targets: ${targets.length}. Synced ${sync.copied} copies.`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

replicasCmd
  .command('remove <path>')
  .description('Remove a replica target from the config (files left in place)')
  .action((p) => {
    const targets = capsules.replicasRemove(p);
    console.log(`Replica removed. Targets: ${targets.length}.`);
  });

replicasCmd
  .command('list')
  .alias('status')
  .description('Show replica health: reachability and capsule coverage per target')
  .action(() => {
    const st = capsules.replicasStatus();
    if (!st.length) return console.log('No replicas configured.');
    for (const r of st) {
      const state = r.reachable ? `${r.capsules} capsules, ${r.missing} missing` : 'UNREACHABLE';
      console.log(`  ${r.target}  ${state}`);
    }
  });

replicasCmd
  .command('sync')
  .description('Push all capsules to all targets and propagate tombstones')
  .action(() => {
    const s = capsules.replicasSync();
    console.log(
      `Synced ${s.capsules} capsules to ${s.targets} targets: ` +
        `${s.copied} copied, ${s.shredded} tombstones propagated, ${s.failed} failures.`
    );
  });

context
  .command('forget <id>')
  .description('IRREVERSIBLY crypto-shred a capsule (requires --confirm <id>)')
  .requiredOption('--confirm <id>', 'echo the capsule id to confirm')
  .action((id, opts) => {
    try {
      const out = capsules.forgetCapsule(id, opts.confirm);
      console.log(`Capsule ${id} forgotten (key shredded, id tombstoned).`);
      if (out.replicaWarning) console.log(`Warning: ${out.replicaWarning}`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
