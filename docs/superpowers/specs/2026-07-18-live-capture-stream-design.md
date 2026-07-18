# Live Capture Stream — Design Spec

**Date:** 2026-07-18
**Status:** Approved
**Sub-project:** 4 of 4 (demo mode → branch diff → time-travel replay → **live capture stream**)

## Goal

"Watch your agent think." Captured nodes appear in the DAG the instant they
are written — no polling lag — and pulse briefly as they arrive. Turns the
dashboard from a periodic snapshot into a live view of an agent running.

## Behavior

### Event bus — `src/events.js`

- A process-singleton Node `EventEmitter` exported as `bus`.
- `storage/engine.saveNode()` emits `bus.emit('node', node)` after the node
  and its tree links are written.
- Pure in-process, zero I/O. With no listeners attached the emit is a no-op,
  so existing tests, the demo seeder, and the MCP path are unaffected.

### SSE endpoint — `GET /api/stream`

- Responds `text/event-stream`, `Cache-Control: no-cache`, `Connection:
  keep-alive`.
- On connect: subscribes to `bus`'s `node` event and writes
  `data: <node JSON>\n\n` for each new node.
- Sends a `: heartbeat\n\n` comment every 15 seconds so idle proxies don't
  drop the connection.
- Removes its listener and clears the heartbeat on client disconnect
  (`req.on('close')`).

### Dashboard — `useGraphData`

- Opens an `EventSource('/api/stream')`. Each `node` event merges the node
  into the list (dedup by id) and records its id as "just arrived".
- Keeps the existing periodic refresh as a fallback (SSE unavailable →
  dashboard still works), with the interval relaxed to 5s since SSE now
  carries live updates.
- "Just arrived" ids are held ~1.2s to drive the arrival animation, then
  cleared.
- Exposes a `streaming` boolean (SSE open) for the topbar indicator.

### Animation — `GraphView` / topbar

- A newly arrived node card gets a `fresh` class → a short pulse keyframe
  (scale + accent glow).
- Topbar shows `● streaming` in accent-green while the SSE connection is
  open; falls back to the existing `live` / `proxy offline` text otherwise.

## Error handling

- SSE endpoint write after client close is guarded (listener removed on
  `close`).
- EventSource error → browser auto-reconnects; the poll fallback covers any
  gap. `streaming` flips false on error, true on open.

## Testing

- **Bus (jest):** `saveNode` emits a `node` event carrying the saved node;
  no listeners → no throw.
- **SSE (supertest):** connecting sets the event-stream content type; a
  `saveNode` after connect pushes a `data:` line containing the node id.

## Out of scope

- Token-by-token streaming into a node (this streams whole nodes on
  completion, matching how the proxy saves them).
- Replacing the poll fallback entirely.
- Server-side fan-out limits / auth (loopback-only bind already constrains
  this).
