#!/usr/bin/env node

// CLI entry point. Shebang lets `npx forkmind` / `forkmind` run this directly.
const { program } = require('commander');
const { initStorage } = require('../src/storage/engine');
const { startServer } = require('../src/proxy/server');
const { startMcp } = require('../src/mcp/server');

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

program.parse(process.argv);
