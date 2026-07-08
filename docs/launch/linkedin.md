# LinkedIn copy — ForkMind

Two variants. Post from your personal account (personal profiles get ~10x the
reach of company pages). Attach the dashboard screenshot or demo GIF from
`docs/` — posts with an image outperform text-only. 3–5 hashtags max; LinkedIn
penalizes hashtag walls. Best posting window: Tue–Thu, 8–10am your audience's
timezone.

---

## Variant A — launch announcement (lead with the problem)

Every AI context manager solves a full context window the same way: truncate
and lose it.

I kept hitting this while debugging agentic LLM workflows — hours of
conversation state, gone, because the window filled up. So I built the
opposite.

ForkMind treats your AI context window like a Git repository:

→ Every LLM call is captured locally as a node in a content-addressed DAG
→ Branch alternative prompts or models from any past turn
→ Pin known-good outputs as regression baselines and catch drift in CI
→ And the part I'm most proud of: context capsules — instead of evicting old
context, save it as an immutable, AES-256-GCM-encrypted snapshot, compact
your window to a one-line handle, and restore it later (in full, or one
segment at a time)

Deletion is real deletion: crypto-shredding destroys the encryption key
first, so even backups of the ciphertext stay unreadable. A RAID layer
replicates capsules across disks with self-healing restore. Capsules move
between machines as passphrase-encrypted bundles.

It's local-first by design — plain JSON and ciphertext on your disk. No
cloud, no account, no telemetry. Works with any OpenAI-compatible API and
defaults to free local models via Ollama. AI agents can use it on
themselves through MCP: archive their own context mid-task and pull it
back when needed.

Open source, MIT licensed:
🔗 github.com/Medhovarsh/forkmind
⚡ npx forkmind start

If you're building agents and fighting the context window, I'd genuinely
love your feedback — especially on the capsule format.

#AIEngineering #LLM #OpenSource #AIAgents #MCP

---

## Variant B — security angle (for a follow-up post, ~1 week later)

"Delete" in most AI tools means the file is gone. The data usually isn't.

Backups, filesystem snapshots, synced folders — conversation context leaks
into all of them. If you're putting sensitive material through LLM tooling,
"we removed it from the UI" is not a deletion story.

When I built context offloading into ForkMind (open source, local-first),
I made deletion cryptographic instead:

1. Every context capsule is encrypted with its own AES-256-GCM key
2. That key is wrapped by a master key stored *outside* the data directory —
so accidentally committing your data folder leaks only ciphertext
3. Forgetting a capsule destroys the key FIRST, then tombstones the ID, then
removes ciphertext everywhere — including replicas
4. Result: any copy that survives anywhere — backup, snapshot, offline
disk — is permanently unreadable

The same design gives you the inverse guarantee too: nothing is ever removed
from your model's context window until it's provably persisted and
integrity-verified on disk. Save → verify → then compact. Never lose context
to truncation again.

All of it is content-addressed like Git, so capsules are immutable and
acyclic by construction, and every restore re-verifies hashes before
returning a byte.

MIT licensed, runs entirely on your machine:
🔗 github.com/Medhovarsh/forkmind

How does your team handle deletion guarantees for LLM conversation data?

#AISecurity #DataPrivacy #LLM #OpenSource

---

## First-comment (post immediately under either variant)

Quick links for anyone curious:

- Repo: https://github.com/Medhovarsh/forkmind
- Try it: npx forkmind start (free local models via Ollama)
- Claude Code plugin: /plugin marketplace add Medhovarsh/forkmind
- Security model: https://github.com/Medhovarsh/forkmind/blob/master/SECURITY.md

Happy to answer anything about the DAG format, the crypto design, or the
MCP integration here.
