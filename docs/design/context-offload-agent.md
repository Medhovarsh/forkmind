# Design: ForkMind Context-Offload Agent (`forkmind-archivist`)

**Status:** Draft v1 · 2026-07-06
**Author:** Medhovarsh Bayyapureddi

---

## 1. Problem statement

Current industry approaches (the Palantir- and NVIDIA-style context managers referenced
in the brief) treat long-context pressure as a **cache eviction** problem: when the
window fills, drop the KV cache / truncate the transcript and move on. The evicted
context is gone.

ForkMind already proves the alternative primitive: every LLM turn is a node in a
content-addressed DAG on disk. What is missing is an **agent-facing workflow** that:

1. **Saves** an arbitrary slice of live conversational context into the DAG as an
   immutable, encrypted "context capsule."
2. **Removes** that context from the live model window (compaction), replacing it
   with a tiny handle + digest.
3. **Restores** it later — fully or as a summary — on demand, by handle.

This must ship the same way the `caveman` plugin ships: an agent + skill + command
that any Claude Code user can install, while also serving ForkMind's existing proxy
users. The core LLM (Palantir, NVIDIA, OpenAI, Anthropic, Ollama — whatever is
upstream) is **never modified**; we operate entirely at the context-assembly layer.

### Non-goals

- Modifying provider models, KV caches, or inference servers.
- Cloud storage or hosted sync (ForkMind is local-first; stays that way).
- Real-time collaborative context sharing (future work).

---

## 2. Architecture overview

```
[ARCHITECTURE DIAGRAM — placeholder for rendered visual]

 Claude Code / any MCP client                      Any OpenAI-compatible app
        │                                                   │
        │ MCP (stdio)                                       │ HTTP :4500/v1
        ▼                                                   ▼
 ┌─────────────────────────┐                     ┌─────────────────────────┐
 │  forkmind-archivist     │                     │  ForkMind proxy         │
 │  (plugin agent)         │                     │  (Express, existing)    │
 │  save / digest /        │                     │  + /api/context/* NEW   │
 │  restore / forget       │                     └───────────┬─────────────┘
 └───────────┬─────────────┘                                 │
             │                    both call                  │
             ▼                                               ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │                    Context Capsule Engine (NEW, src/context/)        │
 │  chunker → DAG builder → encryptor (AES-256-GCM) → capsule store     │
 │  digester (optional local Ollama summarization)                     │
 └───────────┬──────────────────────────────────────────────────────────┘
             ▼
 .forkmind/
 ├── nodes/                  (existing turn DAG — untouched)
 ├── contexts/               (NEW: encrypted capsule segment files)
 │   ├── <capsule-id>/
 │   │   ├── manifest.json   (public: DAG shape, hashes, digest — no content)
 │   │   └── seg-<hash>.enc  (ciphertext segments)
 ├── tombstones.json         (NEW: forgotten capsule ids)
 └── manifest.json           (existing)

 Key material lives OUTSIDE .forkmind/:  ~/.forkmind-keys/<project-hash>.key
```

**Design stance:** reuse the three surfaces ForkMind already has — the proxy
(HTTP), the MCP server (agents), and the Claude Code plugin (skill/command/agent) —
and add one new core module (`src/context/`) they all share. No new daemon, no new
port, no database.

---

## 3. Components

### 3.1 Context Capsule Engine (`src/context/engine.js`) — NEW

The heart of the feature. Mirrors the style of `src/storage/engine.js`
(per-call `process.cwd()` resolution, plain files, idempotent writes).

**Capsule model.** A capsule is a small DAG of *segments*:

- **Segment node** = one contiguous chunk of context (a message, a tool result,
  a file excerpt). Content-addressed: `id = sha256(plaintext + parentIds)[0:12]`
  — the same scheme as `src/storage/hash.js`, extended to multiple parents.
- **Edges** point child → parents (a summary segment can have many parents:
  the segments it summarizes). Multiple parents is what makes this a DAG rather
  than the existing tree.
- **Capsule root** = single sink node whose ancestry covers every segment.
  The capsule id is the root id.

**Acyclicity & immutability — by construction, then verified:**

1. *By construction:* a segment's id is a hash over its content **and** its
   parents' ids. A parent must exist (be fully hashed) before any child can
   reference it, so a cycle would require a hash to contain itself. Same
   guarantee Git relies on.
2. *Verified:* `verifyCapsule(id)` re-walks the manifest: every referenced
   parent exists, a DFS with a visited/in-stack set proves acyclicity, and each
   segment's stored hash is recomputed from decrypted content. Run on every
   restore and exposed as `forkmind context verify`.
3. *Immutable:* capsule directories are written once, then never rewritten.
   Any "edit" is a new capsule with new ids. Deletion is tombstoning +
   key destruction (§6), never file mutation.

**Chunking.** Default: one segment per message/tool-result boundary (natural
units of a transcript). Oversized items split at ~8 KB with an ordering edge
chain. Chunking at message boundaries is what makes partial restore useful.

**Digester.** On save, optionally produce a per-capsule digest (≤ 500 tokens):
a local summarization call through the existing proxy (Ollama default — free,
never leaves the machine). Digest is stored **in the manifest, plaintext-visible
by design choice**: it is the retrieval key the agent keeps in its window.
A `--private` flag skips digest generation for sensitive capsules (manifest then
carries only structural metadata).

### 3.2 Storage format (`.forkmind/contexts/<capsule-id>/`)

`manifest.json` (public — safe to read without keys):

```jsonc
{
  "capsuleVersion": 1,
  "id": "9f3ac21b7e04",
  "createdAt": "2026-07-06T00:00:00.000Z",
  "title": "auth-refactor context, turns 12–47",
  "digest": "User debugging OAuth refresh loop; established that ...", // or null
  "sourceNodeIds": ["a1b2c3d4e5f6"],   // link back into the existing turn DAG
  "dag": {
    "root": "e77d10aa93c4",
    "segments": [
      { "id": "e77d10aa93c4", "parents": ["b21f...", "0c9e..."],
        "role": "summary", "bytes": 1832, "sha256": "<full hash of plaintext>" },
      { "id": "b21f44d0a8c1", "parents": [], "role": "message",
        "bytes": 4096, "sha256": "..." }
    ]
  },
  "crypto": { "alg": "aes-256-gcm", "kdf": "hkdf-sha256", "keyRef": "project" }
}
```

- Segment ciphertext in `seg-<id>.enc` = `nonce (12B) ‖ ciphertext ‖ GCM tag`.
- The manifest never contains plaintext content (only the optional digest,
  which the user explicitly authorizes at save time).
- `sourceNodeIds` ties capsules into the existing turn DAG, so the dashboard
  can render capsules as annotations on the conversation graph.

### 3.3 HTTP API — new routes on the existing proxy (`src/proxy/server.js`)

Bound to `127.0.0.1` only (as today). All bodies JSON.

| Method & path | Purpose | Notes |
|---|---|---|
| `POST /api/context` | Save a capsule | Body: `{ title, items: [{role, content}], digest: true\|false, sourceNodeIds? }` → `201 { id, digest, segments, bytes }` |
| `GET /api/context` | List capsules | Manifests only (no decryption). Filter: `?q=` substring over title+digest |
| `GET /api/context/:id` | Restore full plaintext | Decrypts, runs `verifyCapsule` first; `409 INTEGRITY_FAIL` if verification fails |
| `GET /api/context/:id/digest` | Digest + manifest only | Cheap; never touches keys |
| `GET /api/context/:id/segment/:segId` | Partial restore | One segment — lets the agent pull back only what it needs |
| `DELETE /api/context/:id` | Forget (crypto-shred) | Destroys the capsule DEK, tombstones the id, best-effort unlinks ciphertext. Irreversible; requires `{"confirm": "<id>"}` in body |
| `POST /api/context/:id/verify` | Integrity check | Returns `{ acyclic, parentsResolved, hashesValid }` |

Errors follow existing proxy conventions: `{ error: { code, message } }` with
`404 NOT_FOUND`, `410 TOMBSTONED`, `409 INTEGRITY_FAIL`, `423 KEY_UNAVAILABLE`.

### 3.4 MCP tools — added to `src/mcp/server.js`

Same registration pattern as the six existing tools; compact serializers to keep
agent token cost low.

| Tool | Purpose |
|---|---|
| `forkmind_context_save` | `{ title, items[], digest? }` → `{ id, digest }`. The agent then replaces the saved material in its window with the one-line handle. |
| `forkmind_context_list` | Compact list: id, title, digest first-line, bytes, age. |
| `forkmind_context_digest` | Digest + segment map for one capsule — the "do I need the full thing?" probe. |
| `forkmind_context_restore` | Full or `{ segmentIds: [...] }` partial rehydration. Verifies before returning. |
| `forkmind_context_forget` | Crypto-shred. Requires `confirm: "<id>"` echo — an agent cannot forget by accident. |

### 3.5 Plugin surface (the "caveman-shaped" part)

Three files, mirroring the existing plugin exactly:

- **`agents/forkmind-archivist.md`** — subagent, tools `[Read, Bash, Glob, Grep]`
  plus the MCP tools. Spawned for heavy offload jobs (e.g. "archive everything
  before turn 40") so the summarization/chunking transcript never enters the
  parent context. Returns only: `SAVED: <id> · <n> segments · <bytes> · digest: <one line>`.
- **`skills/forkmind-archivist/SKILL.md`** — triggers: "offload my context",
  "save this conversation and clear it", "archive context as a DAG", "restore
  capsule", "context is getting full", "forget that capsule". Teaches the
  **save → verify → then compact** discipline (§4) and when to restore digest
  vs full vs single segment.
- **`commands/forkmind.md`** — extend the existing command with
  `offload | capsules | restore <id> | forget <id>` argument routes.

`plugin.json` needs no change — the MCP server is already auto-wired; new tools
appear automatically.

### 3.6 CLI (`bin/forkmind.js`)

```
forkmind context save   [--title T] [--from-stdin | --file F] [--no-digest]
forkmind context list
forkmind context show   <id> [--digest-only | --segment <segId>]
forkmind context verify <id>
forkmind context forget <id> --confirm <id>
```

### 3.7 Dashboard (incremental)

Capsules appear as badge annotations on source nodes in the React Flow graph;
a "Capsules" side panel lists manifests. Read-only in v1 — save/forget stay in
CLI/MCP/HTTP to keep destructive actions out of the browser.

---

## 4. Data flow: the offload contract

The critical correctness rule — **never lose context in the gap between save and
compact**:

```
1. Agent selects items to offload (old turns, big tool results, file dumps)
2. forkmind_context_save            → capsule written, id returned
3. forkmind_context_digest(id)      → engine re-reads from DISK, verifies DAG
   (this step proves durability — the agent confirms the capsule is readable
    before anything is removed from the window)
4. Only now: compact the live context
   - Claude Code: drop the material from working context, keep the handle line
   - Proxy users: app truncates its messages[] and inserts the handle:
     "[capsule 9f3ac21b7e04: auth-refactor context — restore via ForkMind]"
5. Later: digest probe → partial restore → full restore, escalating only as needed
```

Step 3 is the difference between this design and "cache removal": removal is
gated on verified persistence.

**No model modification:** all of this happens in what the client *sends*. The
provider simply receives shorter `messages[]`. Constraint satisfied trivially and
permanently — there is nothing in this design that could touch a model.

---

## 5. Deployment plan

**Primary (matches ForkMind's ethos):** no new deployable. `forkmind start`
serves the new routes; the plugin install (`/plugin install forkmind`) delivers
agent+skill+command; MCP tools ride the existing auto-wired server. Zero-install
path `npx github:medhovarsh/forkmind start` keeps working.

**Standalone service (per brief):**

- `Dockerfile` (node:18-alpine, `npm ci --omit=dev`, dashboard prebuilt,
  `CMD ["node", "bin/forkmind.js", "start"]`).
- Volumes: `/data/.forkmind` (capsules, working dir) and `/keys` (key material)
  — **two separate volumes** so backups of `.forkmind/` never include keys.
- Port 4500; container network policy should keep it non-public.
- Orchestration: single-instance semantics (file-based store, no locking layer
  in v1). One replica per project. Compose example ships in `examples/`.
- `[FILL: deployment environment]` — target (bare Docker / K8s / Nomad),
  ingress rules, and volume driver to be confirmed.
- `[FILL: key management in shared environments]` — single-user local default
  is a keyfile; multi-user deployments need a decision (per-user keys vs
  OS keychain vs external KMS).

**Rollout order:** engine + tests → CLI → HTTP routes → MCP tools → plugin
files → dashboard panel. Each stage independently shippable.

---

## 6. Security & privacy

- **No plaintext at rest.** Every segment AES-256-GCM encrypted with a
  per-capsule DEK; DEK wrapped (HKDF-SHA256 from the project master key). Master
  key: `~/.forkmind-keys/<project-hash>.key`, created `0600` on first save.
  Only manifest metadata (title, opt-in digest, DAG shape, hashes) is readable
  without keys.
- **Digest is opt-in plaintext.** Explicit trade-off: a useful retrieval key
  vs strict secrecy. `--private` gives a null digest. Skill instructs the agent
  to use `--private` when content includes credentials/PII.
- **Crypto-shredding delete.** `forget` destroys the wrapped DEK first, then
  tombstones, then unlinks. Even if ciphertext files survive (backups, FS
  snapshots), they are unreadable. Tombstone list prevents id resurrection.
- **GCM gives integrity for free** — tampered ciphertext fails to decrypt;
  plus the explicit sha256 re-verification on restore catches manifest/DAG
  tampering.
- **Locality.** Nothing leaves the machine except the optional digest
  summarization call, which defaults to local Ollama through the existing
  proxy. No telemetry (existing ForkMind guarantee).
- **Server binding** stays `127.0.0.1` for local use; container deployments
  must add their own authn at the ingress (`[FILL: auth for shared deployments]`).
- **Keys never inside `.forkmind/`** — the directory users are told to
  `.gitignore` but sometimes don't; a committed `.forkmind/` leaks only
  ciphertext + manifests.

Threats considered: laptop theft / disk imaging (encrypted at rest), accidental
git commit of `.forkmind/` (no keys inside), agent accidentally shredding
(confirm-echo), malicious capsule crafted to cycle-bomb a restore (DFS guard +
hash construction), digest leaking secrets (opt-in + `--private`).

---

## 7. Execution checklist (from brief)

- [x] **DAG integrity checks** — construction-time (hash-over-parents),
  restore-time (`verifyCapsule`: parents resolve, DFS acyclicity, hash re-check),
  and on-demand (`forkmind context verify`, `POST /:id/verify`). §3.1, §3.3.
- [x] **No changes to the underlying model** — design operates purely on the
  request the client assembles; provider/model untouched. §4.
- [x] **Deployment placeholders** — `[FILL: deployment environment]`,
  `[FILL: key management in shared environments]`,
  `[FILL: auth for shared deployments]`. §5, §6.
- [x] **Security review of offloading** — §6; independent review still
  recommended before any multi-user deployment.

## 8. Open questions

1. Digest model choice: pin a small local model (e.g. `llama3`) or use whatever
   upstream the project already routes through?
2. Capsule GC policy: age-based reminder to forget, or keep-forever default?
3. Dashboard write actions (save/forget from UI) — deferred; revisit after v1.
4. The "RAID"/replication idea (multi-backend redundant capsule storage) —
   raised separately; out of scope for v1, but the capsule format (self-contained
   dir, content-addressed, encrypted) is deliberately replication-friendly.
