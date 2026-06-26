const path = require('path');
const express = require('express');
const fs = require('fs-extra');
const {
  forward,
  forwardStream,
  resolveUpstream,
  extractParentId,
} = require('./interceptor');
const { reconstructOpenAI, reconstructAnthropic } = require('./reconstruct');
const { generateNodeId } = require('../storage/hash');
const { initStorage, saveNode, readAllNodes, readNode } = require('../storage/engine');

const PORT = process.env.FORKMIND_PORT || 4500;

/**
 * Provider registry. Routed by request path.
 * `defaultUpstream` is overridable per-request via the x-forkmind-upstream
 * header (see interceptor.resolveUpstream), so any OpenAI-compatible host
 * (Ollama, vLLM, LM Studio, Together, Groq, OpenRouter, ...) works out of the
 * box on the openai route.
 */
const PROVIDERS = {
  openai: {
    apiPath: '/v1/chat/completions',
    defaultUpstream: process.env.FORKMIND_OPENAI_UPSTREAM || 'https://api.openai.com',
    reconstruct: reconstructOpenAI,
  },
  anthropic: {
    apiPath: '/v1/messages',
    defaultUpstream:
      process.env.FORKMIND_ANTHROPIC_UPSTREAM || 'https://api.anthropic.com',
    reconstruct: reconstructAnthropic,
  },
};

/**
 * Incrementally parse an SSE buffer, returning parsed JSON payloads from
 * complete `data:` events and leaving any partial trailing event in `rest`.
 * Used to tee a passthrough stream for reconstruction without disturbing the
 * bytes sent to the client.
 */
function drainSSE(buffer) {
  const parsed = [];
  let rest = buffer;
  let idx;
  while ((idx = rest.indexOf('\n\n')) !== -1) {
    const rawEvent = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    for (const line of rawEvent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        parsed.push(JSON.parse(payload));
      } catch {
        // Partial/garbled JSON — skip; reconstruction tolerates gaps.
      }
    }
  }
  return { parsed, rest };
}

/**
 * Build the route handler for a given provider config.
 */
function makeHandler(providerName, cfg) {
  return async function handler(req, res) {
    const parentId = extractParentId(req.headers);
    const upstream = resolveUpstream(req.headers, cfg.defaultUpstream);
    const isStream = req.body && req.body.stream === true;

    // Node id is deterministic from request + parent — independent of the
    // response. Compute it now so we can return it as a header even for streams
    // (where headers must flush before the body).
    const nodeId = generateNodeId(req.body, parentId);

    const meta = {
      provider: providerName,
      upstream,
      stream: !!isStream,
    };

    try {
      if (!isStream) {
        // ---- Non-streaming path ----
        const { status, data } = await forward(
          upstream,
          cfg.apiPath,
          req.body,
          req.headers
        );
        if (status >= 200 && status < 300) {
          saveNode(parentId, req.body, data, { ...meta, status });
          res.set('x-forkmind-node-id', nodeId);
        }
        return res.status(status).json(data);
      }

      // ---- Streaming path ----
      const { status, headers, stream } = await forwardStream(
        upstream,
        cfg.apiPath,
        req.body,
        req.headers
      );

      res.status(status);
      res.set('Content-Type', headers['content-type'] || 'text/event-stream');
      res.set('Cache-Control', 'no-cache');
      res.set('Connection', 'keep-alive');
      if (status >= 200 && status < 300) res.set('x-forkmind-node-id', nodeId);

      const ok = status >= 200 && status < 300;
      let buffer = '';
      const collected = [];

      stream.on('data', (chunk) => {
        res.write(chunk); // passthrough VERBATIM — client sees real provider bytes
        if (!ok) return;
        buffer += chunk.toString('utf8');
        const { parsed, rest } = drainSSE(buffer);
        buffer = rest;
        for (const p of parsed) collected.push(p);
      });

      stream.on('end', () => {
        res.end();
        if (ok) {
          // Reconstruct the full message and save under the same deterministic id.
          const assembled = cfg.reconstruct(collected);
          saveNode(parentId, req.body, assembled, { ...meta, status });
        }
      });

      stream.on('error', (err) => {
        // Upstream stream broke mid-flight. End the client response; don't save
        // a partial node.
        if (!res.headersSent) res.status(502);
        res.end(`\n\ndata: {"error":"forkmind stream error: ${err.message}"}\n\n`);
      });
    } catch (err) {
      // Forwarding failed before any bytes were sent.
      if (!res.headersSent) {
        res.status(502).json({
          error: {
            message: `ForkMind proxy error: ${err.message}`,
            type: 'forkmind_proxy_error',
          },
        });
      } else {
        res.end();
      }
    }
  };
}

/**
 * Build the Express app. Separated from listen() so tests can import it.
 * @param {object} [opts]
 * @param {string} [opts.dashboardDist] - path to built dashboard to serve.
 */
function createServer(opts = {}) {
  const app = express();
  app.use(express.json({ limit: '25mb' })); // LLM payloads get large

  // Provider proxy routes.
  for (const [name, cfg] of Object.entries(PROVIDERS)) {
    app.post(cfg.apiPath, makeHandler(name, cfg));
  }

  // --- Dashboard data API ---

  // Whole tree as a flat array (dashboard transforms into a DAG client-side).
  app.get('/api/graph', (req, res) => {
    res.json({ nodes: readAllNodes() });
  });

  // Single node detail.
  app.get('/api/node/:id', (req, res) => {
    const node = readNode(req.params.id);
    if (!node) return res.status(404).json({ error: 'node not found' });
    res.json(node);
  });

  app.get('/health', (req, res) => res.json({ ok: true, providers: Object.keys(PROVIDERS) }));

  // Serve the built dashboard if present (production / `forkmind start`).
  if (opts.dashboardDist && fs.existsSync(opts.dashboardDist)) {
    app.use(express.static(opts.dashboardDist));
    // SPA fallback for client-side routing.
    app.get('*', (req, res) => {
      res.sendFile(path.join(opts.dashboardDist, 'index.html'));
    });
  }

  return app;
}

/**
 * Boot storage + start listening. Called by `forkmind start`.
 */
function startServer() {
  initStorage();
  const dashboardDist = path.join(__dirname, '..', '..', 'dashboard', 'dist');
  const app = createServer({ dashboardDist });
  const server = app.listen(PORT, () => {
    const hasDash = fs.existsSync(dashboardDist);
    console.log(`\n  ForkMind proxy  →  http://localhost:${PORT}`);
    console.log(`  Point your client baseURL at  http://localhost:${PORT}/v1`);
    if (hasDash) {
      console.log(`  Dashboard       →  http://localhost:${PORT}\n`);
    } else {
      console.log(`  Dashboard (dev) →  run: npm run dashboard:dev\n`);
    }
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n  Port ${PORT} is already in use — ForkMind may already be running.\n` +
          `  Stop the other process, or set a different port:  FORKMIND_PORT=4600 forkmind start\n`
      );
    } else {
      console.error(`\n  ForkMind failed to start: ${err.message}\n`);
    }
    process.exit(1);
  });
  return server;
}

module.exports = { createServer, startServer, makeHandler, drainSSE, PROVIDERS, PORT };
