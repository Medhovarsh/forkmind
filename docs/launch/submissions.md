# Directory submissions — ForkMind v0.3.0

Status tracker + ready-to-paste content for MCP/plugin directories.

| Directory | Method | Status |
|---|---|---|
| Smithery | `smithery.yaml` in repo (auto-indexed) | ✅ configured, uses `npx -y forkmind mcp` |
| Glama | `glama.json` in repo (auto-indexed from GitHub/npm) | ✅ added |
| awesome-mcp-servers | PR to punkpeye/awesome-mcp-servers | filed — see PR link in repo activity |
| mcp.so | Issue on chatmcp/mcpso | filed — see issue link in repo activity |
| PulseMCP | Web form (https://www.pulsemcp.com/submit) | ⬜ manual — paste content below |
| npm | published | ✅ `forkmind@0.3.0` |
| Claude Code marketplace | git-based | ✅ live |

---

## PulseMCP form (paste)

**Name:** ForkMind

**Short description (≤160 chars):**
Git for LLM context: capture calls as a branchable DAG, regression-test
prompts, and offload context into encrypted, restorable capsules. Local-first.

**Long description:**
ForkMind is a local-first MCP server + proxy that records every LLM call into
a content-addressed DAG on disk. Agents query their own history mid-task
(recent turns, lineage, branches, search) and manage context capsules —
immutable, AES-256-GCM-encrypted snapshots of conversation context that can be
removed from the model window and restored later, in full or per segment.
Deletion is crypto-shredding; a RAID layer replicates capsules across
filesystem targets with self-healing restore. 12 tools, no API keys, no cloud,
no telemetry. MIT.

**Install command:** `npx -y forkmind mcp`
**Repository:** https://github.com/Medhovarsh/forkmind
**Website:** https://medhovarsh.github.io/forkmind/
**npm:** https://www.npmjs.com/package/forkmind

---

## awesome-mcp-servers entry (Knowledge & Memory section)

```markdown
- [Medhovarsh/forkmind](https://github.com/Medhovarsh/forkmind) 📇 🏠 🍎 🪟 🐧 - Git-style branching, debugging, and context offloading for LLM conversations. Captures every call as a content-addressed DAG; context capsules archive conversation context as immutable, AES-256-GCM-encrypted snapshots with per-segment restore, crypto-shred deletion, and RAID replication across disks. 12 tools for history recall and capsule management. `npx -y forkmind mcp`
```

Legend: 📇 TypeScript/JavaScript · 🏠 local · 🍎 🪟 🐧 macOS/Windows/Linux.

---

## mcp.so submission (issue body for chatmcp/mcpso)

**Title:** Submit MCP Server: ForkMind — LLM history DAG + encrypted context capsules

## Server Name
ForkMind

## Server Description
Local-first MCP server that gives AI agents access to their own LLM call
history and encrypted context storage. ForkMind's proxy records every LLM call
as a node in a content-addressed DAG; the MCP server exposes that history
(recent turns, lineage, branches, substring search, stats) plus context
capsules — immutable, AES-256-GCM-encrypted DAG snapshots of conversation
context that agents can save, verify, restore (full or per segment), and
crypto-shred. Includes RAID-style capsule replication with self-healing
restore. No API keys, no cloud, no telemetry. MIT licensed.

## Server URL / Endpoint
stdio (local): `npx -y forkmind mcp`

## Installation
```json
{
  "mcpServers": {
    "forkmind": { "command": "npx", "args": ["-y", "forkmind", "mcp"] }
  }
}
```

## Available Tools
- `forkmind_recent` — newest captured LLM turns (compact)
- `forkmind_get_node` — full request/response for one node
- `forkmind_lineage` — root→node conversation path
- `forkmind_children` — sibling branches of a node
- `forkmind_search` — substring search across history
- `forkmind_stats` — tree totals
- `forkmind_context_save` — offload context into an encrypted DAG capsule
- `forkmind_context_list` — list capsules (title, digest, size, age)
- `forkmind_context_digest` — digest + segment map probe
- `forkmind_context_restore` — full or per-segment restore, integrity-verified
- `forkmind_context_forget` — irreversible crypto-shred
- `forkmind_context_replicas` — replica (RAID) health + sync

## GitHub Repository
https://github.com/Medhovarsh/forkmind

## Author
@Medhovarsh
