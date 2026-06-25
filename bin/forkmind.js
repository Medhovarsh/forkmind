#!/usr/bin/env node

// CLI entry point. Shebang lets `npx forkmind` / `forkmind` run this directly.
const { program } = require('commander');
const { initStorage } = require('../src/storage/engine');
const { startServer } = require('../src/proxy/server');
const { startMcp } = require('../src/mcp/server');
const reg = require('../src/regression/engine');
const { runAll, printReport } = require('../src/regression/runner');

// commander collects repeated --contains/--regex flags into an array.
function collect(value, prev) {
  return (prev || []).concat([value]);
}

program
  .name('forkmind')
  .description('Local-first LLM state branching and debugging tool')
  .version('0.1.0');

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

program.parse(process.argv);
