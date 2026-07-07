---
name: forkmind-archivist
description: >
  Use when conversation context should be saved and then removed from the live
  model window — context is getting full, a sub-topic is finished, a large file
  dump or tool transcript is done being useful, or the user says "offload my
  context", "save this conversation and clear it", "archive this as a DAG",
  "restore that capsule", or "forget that capsule". ForkMind stores the context
  as an immutable, AES-256-GCM-encrypted DAG capsule on disk (local-first, no
  cloud) and hands back a tiny digest handle; content is restorable in full or
  per segment, and deletable by crypto-shredding.
---

# ForkMind Archivist — offload context as an encrypted DAG

Industry context managers treat a full window as a cache-eviction problem:
truncate and lose it. ForkMind capsules invert that — **persist first, verify,
then compact**. Nothing is dropped until it is provably on disk.

## Core loop

| Step | Tool | Rule |
|---|---|---|
| 1. Save | `forkmind_context_save` | Pass items + a digest YOU write (≤5 lines, decision-relevant) |
| 2. Verify | `forkmind_context_digest` | Re-reads from disk. Save is not real until this succeeds |
| 3. Compact | (your window) | Replace archived material with one handle line |
| 4. Probe | `forkmind_context_digest` | Later: check the digest before restoring anything |
| 5. Restore | `forkmind_context_restore` | Full, or `segmentIds` for just one piece |
| 6. Forget | `forkmind_context_forget` | Irreversible crypto-shred; explicit user ask + `confirm: <id>` only |

Handle line to keep in the window after compacting:

```
[capsule 9f3ac21b7e04 · "auth-refactor context" · restore via forkmind_context_restore]
```

## When to offload

- Window pressure: long session, old turns no longer active.
- Finished sub-topics: debugging concluded, decision recorded.
- Bulk payloads: file dumps, test logs, tool transcripts already acted on.
- User privacy: sensitive material that should leave the window — save it
  **without a digest** (private capsule; manifest carries structure only).

Do NOT offload: the current task's active instructions, unresolved questions,
or anything needed in the next few turns.

## Guarantees (why this is safe)

- **Immutable + acyclic by construction** — segments are content-addressed
  (hash over content + parents, Git-style), so capsules cannot be edited or
  contain cycles; `forkmind context verify <id>` re-proves it.
- **No plaintext at rest** — AES-256-GCM per-capsule keys; the master key
  lives outside `.forkmind/` (`~/.forkmind-keys/`), so a committed `.forkmind/`
  leaks only ciphertext.
- **Crypto-shred delete** — forgetting destroys the key first; backups of the
  ciphertext stay unreadable. Tombstones stop id resurrection.
- **Local-first** — no cloud, no account, no telemetry; the underlying model
  and provider are never touched (this all happens in what the client sends).
- **RAID redundancy** — if `forkmind context replicas add <path>` targets are
  configured, capsules mirror automatically (ciphertext only, never keys) and
  restore self-heals from replicas on primary loss/corruption. Check health
  with `forkmind_context_replicas`; after a forget with unreachable replicas,
  run a sync once they return.

## Heavy jobs → subagent

For "archive everything before turn 40"-scale work, spawn the
**`forkmind-archivist`** subagent: chunking/digest-writing happens in its
context, and only the one-line receipt returns.

## Other surfaces

Same engine via CLI (`forkmind context save|list|show|verify|forget`) and HTTP
(`:4500/api/context…`) for non-Claude apps using the ForkMind proxy.
