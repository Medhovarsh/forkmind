# Launch copy — ForkMind v0.3.0 (context capsules + RAID)

Drafts only. Nothing here has been posted anywhere. Review, edit voice, post
from your own accounts.

---

## Show HN post

**Title options (pick one, ≤ 80 chars):**

1. Show HN: ForkMind – Git for LLM context: branch, offload, and restore it
2. Show HN: Stop truncating LLM context – archive it as an encrypted DAG instead
3. Show HN: ForkMind – local-first LLM debugging with restorable context capsules

**Body:**

Hi HN — I built ForkMind because debugging agentic LLM flows meant re-running
the same prompt with tiny tweaks over and over, and because every context
manager I tried treats a full window the same way: truncate and lose it.

ForkMind is a local proxy (works with any OpenAI-compatible API; free by
default via Ollama) that records every LLM call into a `.forkmind/` directory
as a content-addressed DAG — like a Git repo for your context window. You get
a dashboard to see the conversation tree, branch alternative prompts/models
from any past turn, and pin known-good outputs as regression baselines.

New in v0.3.0 — **context capsules**: instead of evicting old context, save it
as an immutable, AES-256-GCM-encrypted DAG snapshot, verify it's on disk, and
*then* compact the window down to a one-line handle. Restore later — the whole
capsule or a single segment. Delete is crypto-shredding: the key dies first,
so backups of the ciphertext stay unreadable. And **RAID** (Redundant Array of
Independent DAGs) mirrors capsules to extra disks/synced folders with
self-healing restore.

Design choices I care about:

- Local-first: plain JSON on disk, no database, no account, no telemetry.
- The model is never touched — everything happens in what the client sends.
- Immutable + acyclic by construction: segment ids are hashes over content +
  parents, so a cycle would need a hash to contain itself.
- Agents can use it on themselves: an MCP server exposes history + capsules,
  and the Claude Code plugin teaches the "save → verify → compact" contract.

Repo: https://github.com/Medhovarsh/forkmind
Quick start: `npx github:medhovarsh/forkmind start` (+ Ollama for free local models)

Would love feedback on the capsule format and what other storage backends the
RAID layer should support.

---

## X / Twitter thread

**1/**
Every LLM context manager does the same thing when the window fills up:
truncate and lose it.

ForkMind v0.3.0 does the opposite: save context as an encrypted DAG, verify
it's on disk, THEN compact. Restore any of it later.

Local-first. Free. Open source. 🧵

**2/**
The primitive: context capsules.

- content-addressed DAG (Git-style hashes → immutable + acyclic by construction)
- AES-256-GCM, keys stored *outside* the data dir
- restore the whole capsule or one segment
- delete = crypto-shredding — the key dies first

**3/**
RAID: Redundant Array of Independent DAGs.

Mirror capsules to a second disk / synced folder / network mount. Primary
bit-rots? Restore self-heals from the first replica that passes verification.
Replicas hold ciphertext only — never keys.

**4/**
It's built for agents, not just humans:

- MCP tools: save / digest / restore / forget / replica-health
- Claude Code plugin with an archivist skill + subagent
- the contract it teaches: save → verify on disk → only then drop from window

**5/**
Plus everything ForkMind already did: capture every LLM call as a branchable
DAG, fork prompts/models from any past turn, pin regression baselines, view it
all in a local dashboard.

No cloud. No account. No telemetry.

npx github:medhovarsh/forkmind start

**6/**
Repo: github.com/Medhovarsh/forkmind
Claude Code: /plugin marketplace add Medhovarsh/forkmind

Feedback welcome — especially on capsule format + which RAID backends to add
next (S3? git remotes?).

---

## Reddit (r/LocalLLaMA) post

**Title:** ForkMind v0.3.0 — save LLM context as an encrypted DAG instead of
truncating it (local-first, works with Ollama)

**Body:**

Local-first tool, MIT licensed, no cloud/account/telemetry. It's a proxy that
sits in front of any OpenAI-compatible endpoint (Ollama by default) and records
every call as a node in a branchable DAG — Git for your context window.

v0.3.0 adds context capsules: archive conversation context into immutable,
AES-256-GCM-encrypted DAG snapshots, compact your window to a one-line handle,
restore full or per-segment later. Deleting a capsule crypto-shreds the key.
There's also a RAID layer (Redundant Array of Independent DAGs) that mirrors
capsules across disks with self-healing restore.

Everything is plain JSON + ciphertext files on disk. Works from any language
(set base URL, two headers). MCP server included so agents can archive and
recall their own context mid-task.

`npx github:medhovarsh/forkmind start` → dashboard on :4500.

Happy to answer questions about the DAG/capsule format.

---

## One-liner (for bios, directories, plugin stores)

> ForkMind — Git for LLM context: capture every call as a branchable DAG,
> regression-test prompts, and offload context into encrypted, restorable,
> RAID-replicated capsules. Local-first, free, MIT.
