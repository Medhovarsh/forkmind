// Shared parent-chaining fetch used by every ForkMind client integration
// (the OpenAI wrapper, LangChain, Vercel AI SDK, …).
//
// All ForkMind capture happens in the proxy. A client only needs to:
//   1. send its traffic to the proxy baseURL, and
//   2. stamp each request with the previous response's node id so the proxy can
//      chain calls into a conversation tree.
//
// `createTracking()` returns a `fetch` that does exactly that, plus a tiny
// stateful API (setParent/resetParent/parentId) so callers can branch from a
// historical node — identical semantics to the ForkMindOpenAI wrapper.

const PROXY_BASE = process.env.FORKMIND_PROXY || 'http://localhost:4500/v1';

/**
 * @param {object} [opts]
 * @param {string|null} [opts.parentId] - initial branch point (null = next call is a root).
 * @param {string|null} [opts.upstream] - upstream base forwarded via x-forkmind-upstream.
 * @param {Function}    [opts.fetchImpl] - underlying fetch (defaults to global fetch; Node 18+).
 * @returns {{ fetch: Function, setParent: Function, resetParent: Function, parentId: string|null }}
 */
function createTracking(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'ForkMind tracking requires a global fetch (Node 18+) or an explicit fetchImpl.'
    );
  }

  const state = {
    parentId: opts.parentId || null,
    upstream: opts.upstream || null,
  };

  async function trackingFetch(url, init = {}) {
    const headers = new Headers(init.headers || {});
    if (state.parentId) headers.set('x-forkmind-parent', state.parentId);
    if (state.upstream) headers.set('x-forkmind-upstream', state.upstream);

    const response = await fetchImpl(url, { ...init, headers });

    // Readable immediately, before any (streamed) body finishes.
    const newId = response.headers.get('x-forkmind-node-id');
    if (newId) state.parentId = newId;

    return response;
  }

  return {
    fetch: trackingFetch,
    /** Pin the branch point (e.g. forking from a historical node). */
    setParent(nodeId) {
      state.parentId = nodeId || null;
    },
    /** Reset chaining — next call starts a fresh root. */
    resetParent() {
      state.parentId = null;
    },
    /** Current head of this conversation branch. */
    get parentId() {
      return state.parentId;
    },
  };
}

module.exports = { createTracking, PROXY_BASE };
