#!/usr/bin/env node

// Standalone MCP server entry — for MCP clients that launch a binary directly
// (e.g. an `mcpServers` config). Equivalent to `forkmind mcp`.
const { startMcp } = require('../src/mcp/server');

startMcp().catch((err) => {
  // stderr only — stdout is the protocol channel.
  console.error(`[forkmind] MCP failed to start: ${err.message}`);
  process.exit(1);
});
