#!/usr/bin/env node

// CLI entry point. Shebang lets `npx forkmind` / `forkmind` run this directly.
const { program } = require('commander');
const { initStorage } = require('../src/storage/engine');
const { startServer } = require('../src/proxy/server');
const { startMcp } = require('../src/mcp/server');
const reg = require('../src/regression/engine');
const { runAll, printReport } = require('../src/regression/runner');
const traj = require('../src/regression/trajectory');
const capsules = require('../src/context/engine');

// commander collects repeated --contains/--regex flags into an array.
function collect(value, prev) {
  return (prev || []).concat([value]);
}

/**
 * Parse a --tool spec: `name` or `name:{"json":"args"}`. Splitting on the FIRST
 * colon keeps colons inside the JSON payload intact.
 */
function parseToolSpec(value, prev) {
  const i = value.indexOf(':');
  if (i === -1) return (prev || []).concat([{ name: value.trim(), args: null }]);
  const name = value.slice(0, i).trim();
  const rest = value.slice(i + 1).trim();
  let args;
  try {
    args = JSON.parse(rest);
  } catch (e) {
    throw new Error(`--tool "${name}": arguments must be valid JSON (${e.message})`);
  }
  return (prev || []).concat([{ name, args }]);
}

program
  .name('forkmind')
  .description('Local-first LLM state branching, debugging & context offloading')
  // Read from package.json so `forkmind --version` can't drift from the release.
  .version(require('../package.json').version);

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

// `forkmind demo` — zero-setup showcase: sample DAG + dashboard in a temp dir.
program
  .command('demo')
  .description('Launch a zero-setup demo: sample conversation DAG + dashboard (nothing touches your project)')
  .action(() => {
    const { runDemo } = require('../src/demo/run');
    runDemo().catch((err) => {
      console.error(`[forkmind] demo failed to start: ${err.message}`);
      process.exit(1);
    });
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
  .option('-t, --tool <name[:jsonArgs]>', 'tool the agent must call, optionally with required args (repeatable)', parseToolSpec, [])
  .option('--not-tool <name>', 'tool the agent must NOT call (repeatable)', collect, [])
  .option('--tools-exact', 'fail if the agent calls any tool beyond those listed with --tool')
  .option('-j, --judge <rubric>', 'grade the output against this rubric with an LLM judge (costs 1 API call per run)')
  .option('--judge-threshold <n>', 'min judge score to pass (0-1, default 0.7)', parseFloat)
  .option('--judge-model <model>', 'model to grade with (default: the case\'s own model)')
  .option('--judge-provider <name>', 'judge provider: openai | anthropic (default: the case\'s own)')
  .action((nodeId, opts) => {
    try {
      const c = reg.pinNode(nodeId, opts.name, {
        contains: opts.contains,
        notContains: opts.notContains,
        regex: opts.regex,
        minSimilarity: opts.minSimilarity,
        tools: {
          called: opts.tool,
          notCalled: opts.notTool,
          exact: opts.toolsExact,
        },
        judge: opts.judge && {
          rubric: opts.judge,
          threshold: opts.judgeThreshold,
          model: opts.judgeModel,
          provider: opts.judgeProvider,
        },
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
          `contains:${a.contains.length} regex:${a.regex.length} minSim:${a.minSimilarity} ` +
          `tools:${a.tools ? a.tools.called.length + a.tools.notCalled.length : 'off'} ` +
          `judge:${a.judge ? a.judge.threshold : 'off'}`
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
  .option('--no-judge', 'skip LLM judging (mechanical checks only — free and offline)')
  .option('--judge-key <apiKey>', 'API key for the judge model (or set FORKMIND_JUDGE_API_KEY)')
  .option('--judge-upstream <url>', 'override upstream base URL for judge calls')
  .action(async (opts) => {
    const report = await runAll({
      apiKey: opts.key || process.env.FORKMIND_API_KEY,
      upstream: opts.upstream,
      only: opts.only,
      judge: opts.judge,
      judgeApiKey: opts.judgeKey || process.env.FORKMIND_JUDGE_API_KEY,
      judgeUpstream: opts.judgeUpstream,
    });
    process.exit(printReport(report));
  });

// `forkmind trajectory ...` — pin a PATH through the graph and re-run it, so a
// prompt change that reroutes an agent mid-run gets caught even when the final
// answer still reads fine.
const trajectory = program
  .command('trajectory')
  .alias('traj')
  .description('Pin multi-turn agent paths and replay them to catch rerouting');

// `--tool-order a,b` -> [['a','b']] pairs, collected across repeats.
function parseOrdering(value, prev) {
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) {
    throw new Error(`--tool-order expects "before,after" (got "${value}")`);
  }
  return (prev || []).concat([parts]);
}

trajectory
  .command('pin <leafNodeId>')
  .description('Freeze the path ending at this node as a trajectory baseline')
  .requiredOption('-n, --name <name>', 'unique trajectory name')
  .option('-f, --from <nodeId>', 'start the path at this ancestor instead of the root')
  .option(
    '-q, --sequence <mode>',
    'action sequence rule: exact | subsequence | none',
    'exact'
  )
  .option('--not-tool <name>', 'tool that must never be called anywhere in the run (repeatable)', collect, [])
  .option('--tool-order <before,after>', 'ordering constraint, e.g. search,write (repeatable)', parseOrdering, [])
  .option('-j, --judge <rubric>', 'grade the FINAL answer against this rubric (costs 1 API call)')
  .option('--judge-threshold <n>', 'min judge score to pass (0-1, default 0.7)', parseFloat)
  .option('--judge-model <model>', 'model to grade with (default: the case\'s own model)')
  .action((leafNodeId, opts) => {
    try {
      const c = traj.pinTrajectory(
        leafNodeId,
        opts.name,
        {
          sequence: opts.sequence === 'none' ? null : opts.sequence,
          notCalled: opts.notTool,
          before: opts.toolOrder,
          judge: opts.judge && {
            rubric: opts.judge,
            threshold: opts.judgeThreshold,
            model: opts.judgeModel,
          },
        },
        { from: opts.from }
      );
      const actions = c.steps.reduce((acc, s) => acc.concat(s.actions), []);
      console.log(
        `Pinned trajectory "${c.name}" (${c.id}) — ${c.steps.length} steps, ` +
          `path: ${actions.length ? actions.join(' → ') : 'no actions'}`
      );
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

trajectory
  .command('list')
  .description('List pinned trajectories')
  .action(() => {
    const cases = traj.listTrajectories();
    if (!cases.length) return console.log('No trajectories pinned.');
    for (const c of cases) {
      const actions = c.steps.reduce((acc, s) => acc.concat(s.actions), []);
      console.log(
        `  ${c.name}  [${c.id}]  ${c.steps.length} steps  ` +
          `seq:${c.assertions.sequence || 'none'}  ` +
          `path: ${actions.length ? actions.join(' → ') : '—'}`
      );
    }
  });

trajectory
  .command('remove <nameOrId>')
  .alias('rm')
  .description('Delete a pinned trajectory')
  .action((nameOrId) => {
    console.log(traj.removeTrajectory(nameOrId) ? `Removed "${nameOrId}"` : `Not found: ${nameOrId}`);
  });

trajectory
  .command('run')
  .description('Replay pinned trajectories and report pass/fail (exit 1 on any failure)')
  .option('-k, --key <apiKey>', 'API key for the upstream (or set FORKMIND_API_KEY)')
  .option('-u, --upstream <url>', 'override upstream base URL')
  .option('--only <nameOrId>', 'run a single trajectory')
  .option('--no-judge', 'skip LLM judging of the final answer')
  .option('--judge-key <apiKey>', 'API key for the judge model (or set FORKMIND_JUDGE_API_KEY)')
  .action(async (opts) => {
    const report = await traj.runAllTrajectories({
      apiKey: opts.key || process.env.FORKMIND_API_KEY,
      upstream: opts.upstream,
      only: opts.only,
      judge: opts.judge,
      judgeApiKey: opts.judgeKey || process.env.FORKMIND_JUDGE_API_KEY || opts.key,
    });
    process.exit(traj.printTrajectoryReport(report));
  });

// `forkmind context ...` — save conversation context as an immutable encrypted
// DAG capsule, then drop it from the live model window; restore on demand.
const context = program
  .command('context')
  .alias('ctx')
  .description('Offload context into encrypted DAG capsules and restore on demand');

context
  .command('save')
  .description('Save a capsule from a JSON file, stdin, or a captured turn (--from-node)')
  .option('-t, --title <title>', 'capsule title')
  .option('-f, --file <path>', 'read items JSON from a file (default: stdin)')
  .option('-d, --digest <text>', 'plaintext retrieval digest (omit = private capsule)')
  .option('-n, --from-node <nodeId>', 'archive the captured conversation lineage ending at this turn-DAG node')
  .action(async (opts) => {
    try {
      if (opts.fromNode) {
        const out = capsules.saveFromNode(opts.fromNode, {
          title: opts.title,
          digest: opts.digest || null,
        });
        console.log(
          `Saved capsule ${out.id} from lineage of ${opts.fromNode}  ` +
            `(${out.segments} segments, ${out.bytes} bytes, ~${out.tokensEstimated} tokens)`
        );
        if (out.digest) console.log(`Digest: ${out.digest}`);
        return;
      }
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
  .option('--messages', 'output as a provider-ready messages[] JSON array')
  .action((id, opts) => {
    try {
      if (opts.messages) {
        return console.log(JSON.stringify(capsules.readCapsuleAsMessages(id).messages, null, 2));
      }
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

context
  .command('stats')
  .description('Aggregate capsule stats: count, bytes, estimated tokens freed, replica health')
  .action(() => {
    console.log(JSON.stringify(capsules.capsuleStats(), null, 2));
  });

context
  .command('export <id>')
  .description('Export a capsule as a portable, passphrase-encrypted bundle (moves between projects/machines)')
  .requiredOption('-p, --passphrase <text>', 'export passphrase (min 8 chars) — required again on import')
  .requiredOption('-o, --out <path>', 'output file for the bundle JSON')
  .action((id, opts) => {
    try {
      const bundle = capsules.exportCapsule(id, opts.passphrase);
      require('fs').writeFileSync(opts.out, JSON.stringify(bundle, null, 2));
      console.log(`Exported capsule ${id} → ${opts.out}`);
      console.log('Keep the passphrase separately — it is not stored in the bundle.');
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

context
  .command('import <path>')
  .description('Import a capsule bundle produced by "forkmind context export"')
  .requiredOption('-p, --passphrase <text>', 'the passphrase used at export time')
  .action((filePath, opts) => {
    try {
      const raw = require('fs').readFileSync(filePath, 'utf8');
      const bundle = JSON.parse(raw.replace(/^\uFEFF/, ''));
      const out = capsules.importCapsule(bundle, opts.passphrase);
      console.log(`Imported capsule ${out.id}  (${out.segments} segments, ${out.bytes} bytes, ~${out.tokensEstimated} tokens)`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
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
