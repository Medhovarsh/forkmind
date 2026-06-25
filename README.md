# ForkMind 🧠

**Local-first LLM state branching & debugging.** ForkMind treats AI context
windows like a Git repository: it captures every LLM call into a local
`.forkmind/` directory, visualizes the conversation as a Directed Acyclic Graph
(DAG), and lets you **branch** alternative prompts or model params from any point
in the history — all on your machine, no cloud, no account.

Works with **any OpenAI-compatible API**, defaulting to **free, open-source
models** via [Ollama](https://ollama.com). Also supports Anthropic and any
hosted free tier (Groq, OpenRouter, Together, vLLM, LM Studio).

---

## Why

Debugging agentic / tool-calling flows means re-running the same prompt with
tiny tweaks over and over. ForkMind records each run as a node, so you can:

- **See** the whole conversation tree, including tool calls and token usage.
- **Branch** from any historical turn — edit the prompt, swap the model, re-run.
- **Compare** outcomes visually instead of scrolling through terminal logs.

Everything is plain JSON on disk. No database. No telemetry.

---

## Install

ForkMind runs straight from a git link — no npm registry needed (the dashboard
is built automatically on install):

```bash
# Run without installing
npx github:your-org/forkmind init
npx github:your-org/forkmind start

# …or install the CLI globally from GitHub
npm install -g github:your-org/forkmind
forkmind start

# …or clone to hack on it
git clone https://github.com/your-org/forkmind
cd forkmind && npm install
```

Once published to npm, `npx forkmind ...` / `npm i -g forkmind` work too.

## Quick start (free, no API key)

```bash
# 1. Install a free local model
#    (install Ollama from https://ollama.com first)
ollama pull llama3

# 2. Init + start ForkMind
npx github:your-org/forkmind init    # create .forkmind/ in your project
npx github:your-org/forkmind start   # proxy on http://localhost:4500 + dashboard

# 3. Point your code at the proxy (see SDK below), make some calls

# 4. Open the dashboard
open http://localhost:4500
```

### Drop-in SDK (auto-builds the tree)

```bash
npm i openai            # the wrapper extends the official SDK
```

```js
const { ForkMindOpenAI } = require('forkmind');

const client = new ForkMindOpenAI({
  apiKey: 'ollama',                       // ignored by Ollama; required by SDK
  upstream: 'http://localhost:11434',     // free local open-source models
});

// Each call is recorded; sequential calls auto-chain into a conversation tree.
const res = await client.chat.completions.create({
  model: 'llama3',
  messages: [{ role: 'user', content: 'Explain backpropagation simply.' }],
});
```

Run the full example:

```bash
node examples/chain.js
```

---

## Using other free / open providers

ForkMind is provider-agnostic — it forwards your auth headers verbatim and lets
you set the upstream per client. Anything OpenAI-compatible just works:

| Provider              | `upstream`                          | `apiKey`             |
| --------------------- | ----------------------------------- | -------------------- |
| **Ollama** (local)    | `http://localhost:11434`            | any string           |
| **LM Studio** (local) | `http://localhost:1234`             | any string           |
| **Groq** (free tier)  | `https://api.groq.com/openai`       | `gsk_...`            |
| **OpenRouter**        | `https://openrouter.ai/api`         | `sk-or-...`          |
| **Together**          | `https://api.together.xyz`          | your key             |
| **OpenAI**            | `https://api.openai.com` (default)  | `sk-...`             |

```js
new ForkMindOpenAI({ apiKey: process.env.GROQ_API_KEY,
                     upstream: 'https://api.groq.com/openai' });
```

You can also override per request with the `x-forkmind-upstream` header if you
call the proxy directly instead of via the SDK.

### Anthropic (Claude)

```bash
npm i @anthropic-ai/sdk
```

```js
const { ForkMindAnthropic } = require('forkmind');
const client = new ForkMindAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
await client.messages.create({ model: 'claude-3-5-sonnet-latest', max_tokens: 512,
                               messages: [{ role: 'user', content: 'hi' }] });
```

---

## How it works

```
your app ──▶ ForkMindOpenAI (baseURL = localhost:4500/v1)
                │  injects x-forkmind-parent
                ▼
         ForkMind proxy (Express, :4500)
                │  forwards verbatim (your key, your upstream)
                ▼
         provider (Ollama / Groq / OpenAI / ...)
                │  response
                ▼
         proxy reconstructs + saveNode()  ──▶  .forkmind/nodes/<id>.json
                │  returns x-forkmind-node-id
                ▼
         wrapper chains it as the next call's parent
```

- **Deterministic node IDs.** `sha256(request + parentId)` → first 12 hex chars.
  Same prompt under the same parent collapses to one node. The ID doesn't depend
  on the response, so it can be returned as a header even before a streamed body
  finishes.
- **Streaming.** Bytes pass through to your app untouched (real SSE); the proxy
  tees them, reconstructs the full message (text **and** fragmented tool-call
  arguments), and saves the node on stream end.
- **Branching.** Each node records its provider + upstream, so "Fork from here"
  in the dashboard replays the edited request to the same host, linked to the
  historical parent.

---

## MCP — let agents query their own history

ForkMind ships an [MCP](https://modelcontextprotocol.io) server so an AI agent
can read its own `.forkmind/` history mid-task and self-correct — recall what it
already tried, see how it reached a state, or search past attempts.

```bash
forkmind mcp          # stdio MCP server (or: forkmind-mcp)
```

Register it with any MCP client (Claude Desktop / Claude Code / Cursor):

```jsonc
{
  "mcpServers": {
    "forkmind": {
      "command": "npx",
      "args": ["-y", "github:your-org/forkmind", "mcp"]
    }
  }
}
```

Tools exposed:

| Tool                | Purpose                                                   |
| ------------------- | -------------------------------------------------------- |
| `forkmind_recent`   | Newest captured turns (compact)                          |
| `forkmind_get_node` | Full request + response for one node                     |
| `forkmind_lineage`  | Root→node path — the exact context that produced a state |
| `forkmind_children` | Sibling branches forking from a node                     |
| `forkmind_search`   | Substring search across all requests/responses           |
| `forkmind_stats`    | Tree totals: nodes, roots, leaves, providers             |

The server reads the `.forkmind/` in its working directory — point the client's
`cwd` at your project.

## Zero cost & local

- **No paid API required** — defaults to free local models via Ollama.
- **No database** — every turn is a plain JSON file under `.forkmind/`.
- **No account, no telemetry** — nothing leaves your machine except the LLM call
  you were already making (relayed verbatim to the provider you choose).

## `.forkmind/` layout

```
.forkmind/
├── nodes/
│   ├── a1b2c3d4e5f6.json     # one node per turn
│   └── ...
└── manifest.json            # version + root node ids
```

Node schema:

```jsonc
{
  "id": "a1b2c3d4e5f6",
  "parentId": null,           // null = root
  "timestamp": "2026-01-01T00:00:00.000Z",
  "request":  { /* the exact request body */ },
  "response": { /* full or stream-reconstructed response */ },
  "meta": { "provider": "openai", "upstream": "http://localhost:11434", "stream": true },
  "children": ["..."]         // child node ids
}
```

---

## CLI

| Command            | Does                                                     |
| ------------------ | -------------------------------------------------------- |
| `forkmind init`    | Create `.forkmind/` in the current directory             |
| `forkmind start`   | Start the proxy (`:4500`) + serve the dashboard if built |

Env vars: `FORKMIND_PORT`, `FORKMIND_OPENAI_UPSTREAM`,
`FORKMIND_ANTHROPIC_UPSTREAM`, `FORKMIND_PROXY` (SDK target base URL).

---

## Development

```bash
npm install            # installs proxy + dashboard (npm workspaces)
npm test               # jest: hashing, storage, stream reconstruction, API
npm run dashboard:dev  # vite dev server on :5173, proxies API to :4500
npm run dashboard:build
npm run lint
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Roadmap

- [x] CLI + deterministic storage engine
- [x] Provider-agnostic proxy (OpenAI-compatible + Anthropic) with streaming
- [x] Drop-in SDK wrappers with auto-chaining
- [x] React Flow dashboard + branch execution
- [x] MCP integration — let agents query their own `.forkmind/` history
- [ ] Automated regression: pin "good" branches, re-run on prompt edits

## License

[MIT](./LICENSE)
