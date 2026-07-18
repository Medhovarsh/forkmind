# Time-Travel Replay — Design Spec

**Date:** 2026-07-18
**Status:** Approved
**Sub-project:** 3 of 4 (demo mode → branch diff → **time-travel replay** → live capture stream)

## Goal

"Undo for AI conversations." Pick any historical node, edit its prompt or
swap the model, and re-run the entire downstream chain: assistant responses
regenerate against the modified history, while the original user turns and
tool results re-apply in order. The replayed chain grows as a sibling branch,
so old and new histories sit side by side (and feed the branch diff view).

## Behavior

### UX

- NodePanel gains a **⏪ Replay from here** button, shown only when the node
  has descendants (a childless node is just a fork) and gated by the same
  `liveForking` flag as Fork (needs a reachable upstream).
- Replay modal:
  - editable text of the node's last user message,
  - optional model override (defaults to the node's model; applies to every
    replayed call),
  - a leaf picker when multiple downstream branches exist (replay follows
    one root-to-leaf path),
  - optional API key (same handling as BranchModal; blank for Ollama).
- Submit fires one request; the dashboard's 2-second poll shows the new
  branch growing live. The modal closes on completion.

### Engine — `src/replay/engine.js`

Pure logic, injectable transport (`forwardFn`) so tests never touch the
network:

- **Tail extraction:** for consecutive lineage nodes P → N,
  `tail(N) = N.request.messages.slice(P.request.messages.length + 1)` — the
  messages N added after P's assistant reply (user turns, tool results).
- **Chain replay:** given the lineage path `[F, n1, …, leaf]` and an edited
  request for F:
  1. Send the edited request; save the result as a **sibling of F**
     (parent = `F.parentId`) — an alternate history, not a continuation.
  2. For each subsequent original node: new messages = previous new
     messages + previous new assistant message + original tail; re-send;
     save as child of the previous new node.
  3. Return the new node ids in order.
- Tool results replay **verbatim from history** — no live tool execution.
  Honest caveat: stale tool output is possible; that is what the original
  chain saw.
- Model override rewrites `model` on every replayed request.
- OpenAI-shaped chains only for now (`meta.provider === 'openai'`);
  Anthropic replay is out of scope.

### API — `POST /api/replay`

Request: `{ fromNodeId, leafId, request, model? }` — `request` is the full
edited request body for the first call. Auth headers (`Authorization`,
`x-api-key`) pass through to the upstream, which comes from the original
node's `meta.upstream` (overridable via `x-forkmind-upstream`).

Responses:
- `200 { nodes: [ids…] }` on success.
- `400` unknown node ids, leaf not a descendant of fromNode, or a
  non-openai chain.
- `502 { error, nodes }` when an upstream call fails mid-chain — the nodes
  saved before the failure are reported and stay in the tree.

## Testing

- **Engine (jest, fake forwardFn):** tail extraction across a 3-turn chain;
  full replay produces correct message threading and parentage; model
  override hits every call; mid-chain upstream failure surfaces saved-so-far
  ids; sibling-of-F parentage.
- **API (supertest, mocked interceptor.forward):** happy path, bad ids,
  descendant validation.
- **UI:** manual pass — button gating, modal fields, leaf picker with the
  demo dataset.

## Out of scope

- Live tool re-execution.
- Streaming/progress UI for long chains (poll already shows growth).
- Anthropic-shape replay.
- Replaying across a different provider route.
