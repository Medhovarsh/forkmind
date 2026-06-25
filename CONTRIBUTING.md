# Contributing to ForkMind

Thanks for helping build ForkMind! It's a local-first tool — easy to hack on,
no cloud setup required.

## Setup

```bash
git clone <your-fork>
cd forkmind
npm install            # installs proxy + dashboard via npm workspaces
npm test               # everything should be green
```

## Project layout

```
bin/forkmind.js        CLI (commander)
src/storage/           deterministic hashing + JSON file engine
src/proxy/             Express proxy, provider registry, stream reconstruction
src/sdk/               drop-in client wrappers (OpenAI, Anthropic)
dashboard/             React + Vite + React Flow UI
tests/                 jest (node) — hashing, storage, reconstruct, API
examples/              runnable usage samples (Ollama by default)
```

## Dev loop

```bash
npx forkmind start            # terminal 1: proxy + data API on :4500
npm run dashboard:dev         # terminal 2: vite UI on :5173 (proxies to :4500)
node examples/chain.js        # terminal 3: generate some nodes
```

## Before you push

```bash
npm run format     # prettier
npm run lint       # eslint
npm test           # jest
```

CI runs lint + tests on Node 18/20/22 and builds the dashboard. Keep it green.

## Adding a provider

Most providers are OpenAI-compatible and need **no code** — point `upstream` at
them. Add a first-class entry only when the API shape differs (like Anthropic):

1. Add a `reconstruct*` function in `src/proxy/reconstruct.js` (stream → full).
2. Register the route + defaults in `PROVIDERS` in `src/proxy/server.js`.
3. (Optional) Add an SDK wrapper in `src/sdk/`.
4. Add tests in `tests/`.

## Guidelines

- No databases. State stays as plain JSON in `.forkmind/`.
- No telemetry. It's local-first by design.
- Keep node IDs deterministic (`request + parentId`) — many features rely on it.
- Comment the non-obvious bits (hashing, parent linkage, stream tee-ing).

## Reporting bugs

Open an issue with: provider + upstream, whether streaming was on, the request
shape, and what you expected vs. saw. A failing test is the best repro.
