const axios = require('axios');

/**
 * Headers we must NOT forward upstream. Either hop-by-hop, host-specific, or
 * ForkMind-internal control headers. Everything else (including ALL provider
 * auth schemes — Authorization, x-api-key, anthropic-version, etc.) passes
 * through verbatim, which is what makes ForkMind provider-agnostic.
 */
const STRIP_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'accept-encoding', // let axios negotiate; avoids double-compression issues
  'x-forkmind-parent',
  'x-forkmind-upstream',
]);

/**
 * Copy incoming request headers, dropping the ones we must not relay.
 */
function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * Resolve the upstream base URL for this request.
 * Priority: per-request header > provided fallback (env/default).
 * The header is the "any open-source provider" escape hatch — point a single
 * call at Ollama (http://localhost:11434), Together, Groq, OpenRouter, etc.
 */
function resolveUpstream(headers, fallback) {
  return headers['x-forkmind-upstream'] || fallback;
}

/**
 * Parent-node pointer from incoming headers. Absent => root node.
 */
function extractParentId(headers) {
  return headers['x-forkmind-parent'] || null;
}

/**
 * Forward a NON-streaming request and return the full response.
 * validateStatus:()=>true so provider 4xx/5xx bodies relay verbatim instead of
 * being masked as a generic error.
 *
 * @returns {Promise<{status:number, data:object, headers:object}>}
 */
async function forward(upstreamBase, apiPath, body, headers) {
  const resp = await axios.post(`${upstreamBase}${apiPath}`, body, {
    headers: sanitizeHeaders(headers),
    validateStatus: () => true,
  });
  return { status: resp.status, data: resp.data, headers: resp.headers };
}

/**
 * Forward a STREAMING request. Returns the upstream response with `data` as a
 * Node stream the caller pipes to the client while tee-ing chunks for
 * reconstruction.
 *
 * @returns {Promise<{status:number, headers:object, stream:NodeJS.ReadableStream}>}
 */
async function forwardStream(upstreamBase, apiPath, body, headers) {
  const resp = await axios.post(`${upstreamBase}${apiPath}`, body, {
    headers: sanitizeHeaders(headers),
    responseType: 'stream',
    validateStatus: () => true,
  });
  return { status: resp.status, headers: resp.headers, stream: resp.data };
}

module.exports = {
  forward,
  forwardStream,
  sanitizeHeaders,
  resolveUpstream,
  extractParentId,
};
