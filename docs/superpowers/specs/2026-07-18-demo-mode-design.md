# Demo Mode (`forkmind demo`) — Design Spec

**Date:** 2026-07-18
**Status:** Approved
**Sub-project:** 1 of 4 (pre-launch feature ladder: demo mode → branch diff → time-travel replay → live capture stream)

## Goal

`npx forkmind demo` gives a viewer the full ForkMind experience in under 30
seconds: a rich, pre-seeded conversation DAG in the dashboard with zero setup
and zero API key. It doubles as the development harness for later dashboard
features (branch diff, replay, live stream), which all need rich sample data.

## Behavior

### CLI

New top-level command in `bin/forkmind.js`:

```
forkmind demo
```

1. Resolves a demo workspace at `<os.tmpdir()>/forkmind-demo/`.
2. Wipes and recreates it on every run (idempotent, always fresh).
   The user's real `.forkmind/` is never read or written.
3. `process.chdir(demoDir)` — the storage engine resolves all paths from
   `process.cwd()` per call, so no storage changes are needed.
4. Seeds the sample DAG and one capsule (see Seeder).
5. Probes Ollama (see Hybrid forking).
6. Starts the existing proxy/dashboard server (`startServer()`).
7. Prints a banner: `DEMO MODE — sample data, nothing saved to your project`,
   and opens the dashboard URL in the default browser (best-effort; failure to
   open the browser is non-fatal).

### Seeder — `src/demo/seed.js`

A generator that builds nodes through the real `saveNode()` API — never static
JSON fixtures — because node IDs are content-addressed (`src/storage/hash.js`)
and fixtures would drift from the schema.

Sample story: **coding agent debug session** (~12 nodes):

- Root: user asks the agent to fix an auth bug in `login.js`.
- Agent turns containing tool calls (`read_file`, `run_tests`) in the
  request/response payloads, matching OpenAI tool-call shapes.
- A wrong-fix branch where tests fail, then a **fork point** with a second
  branch (better prompt) where tests pass — the DAG visibly branches.
- Realistic token usage and latency values in node `meta`.
- Mixed `meta.provider` values (ollama/llama3 plus one gpt-4o-mini node) so
  provenance badges show variety in the dashboard.
- One capsule saved from the winning branch's lineage via the existing
  capsule engine, so the capsule panel is populated.

The seeder exports a `seed()` function (unit-testable) and is invoked by the
`demo` command.

### Hybrid forking

- On demo start, probe `http://localhost:11434/api/tags` with a 1-second
  timeout.
- New endpoint `GET /api/demo-status` returns
  `{ demo: boolean, liveForking: boolean }`. Outside demo mode it returns
  `{ demo: false, liveForking: true }` (no behavior change).
- Ollama reachable → the Fork dialog works for real against the local model.
- Ollama absent → Fork button disabled with tooltip:
  "Install Ollama for live forking — demo data is canned."

### Dashboard changes

- `DEMO` badge in the header when `/api/demo-status` reports demo mode.
- Fork-disabled state + tooltip in `BranchModal.jsx` (or its trigger) when
  `liveForking` is false.

## Error handling

- Port 4500 busy → existing error path, plus a hint to close the other
  ForkMind instance.
- Temp dir not writable → clear error message, exit code 1.
- Ollama probe failure of any kind (timeout, refused, bad JSON) → treated as
  "not reachable", never crashes demo start.

## Testing

- **Seeder unit tests** (jest, temp cwd): expected node count; lineage walks
  from root to leaf; fork point has 2 children; manifest registers the root;
  capsule exists and is readable.
- **CLI test:** `demo` command is registered; seeding runs before server start
  (server start mocked).
- **API test:** `/api/demo-status` shape in both demo and non-demo modes.

## Out of scope

- Fake-LLM mock upstream (revisit if the hybrid experience feels weak).
- Demo GIF recording automation.
- Live-stream events (sub-project 4).
