const { EventEmitter } = require('events');

// Process-singleton event bus. storage/engine emits 'node' after each save;
// the proxy's SSE endpoint subscribes to push live capture events to the
// dashboard. Pure in-process — with no listeners, emits are a no-op, so the
// capture/storage path stays unchanged for tests, the seeder, and MCP.
const bus = new EventEmitter();

// A busy agent can open several dashboard tabs plus the poll fallback; lift
// the default 10-listener cap so Node doesn't warn on legitimate fan-out.
bus.setMaxListeners(64);

module.exports = { bus };
