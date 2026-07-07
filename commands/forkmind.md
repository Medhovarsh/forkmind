---
description: Start ForkMind or branch/inspect/regression-test an LLM call
---

Invoke the `forkmind` skill. Based on `$ARGUMENTS`:

- no args or `start` → tell the user how to launch ForkMind
  (`npx github:medhovarsh/forkmind start`, proxy + dashboard on :4500) and how
  to point their OpenAI-compatible client at `http://localhost:4500/v1`.
- `branch` / `fork` → explain forking an alternative prompt or model from a
  historical node in the dashboard.
- `test` / `regression` → explain pinning baselines and catching drift in CI.
- `mcp` → show the MCP server config so an agent can query its own history.
- `offload` / `save` → invoke the `forkmind-archivist` skill: save the
  indicated context as an encrypted DAG capsule, verify it, then compact.
- `capsules` / `list` → list saved capsules (`forkmind_context_list`).
- `restore <id>` → restore a capsule (digest probe first, then full/partial).
- `forget <id>` → crypto-shred a capsule — confirm with the user first;
  it is irreversible.

Keep it actionable: give the exact command(s) for what the user asked.
