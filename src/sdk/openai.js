let OpenAI;
try {
  // Optional peer dependency — only required if you actually use this wrapper.
  OpenAI = require('openai');
} catch {
  OpenAI = null;
}

const PROXY_BASE = process.env.FORKMIND_PROXY || 'http://localhost:4500/v1';

/**
 * Drop-in replacement for the OpenAI client that records every call into the
 * local ForkMind tree.
 *
 *   const { ForkMindOpenAI } = require('forkmind');
 *   const client = new ForkMindOpenAI({ apiKey });
 *   await client.chat.completions.create({ model, messages });
 *
 * Beyond the stock client it does two things:
 *   1. Routes traffic through the local ForkMind proxy (baseURL swap).
 *   2. Auto-chains calls into a tree — each response's x-forkmind-node-id
 *      becomes the x-forkmind-parent of the NEXT call on this instance.
 *
 * Works against ANY OpenAI-compatible endpoint (OpenAI, Ollama, vLLM, Together,
 * Groq, OpenRouter...) — set `upstream` and the proxy forwards there.
 *
 * @param {object} opts - standard OpenAI options, plus:
 * @param {string} [opts.upstream] - upstream base to forward to (x-forkmind-upstream).
 */
function createForkMindOpenAI() {
  if (!OpenAI) {
    throw new Error(
      "ForkMindOpenAI requires the 'openai' package. Install it: npm i openai"
    );
  }

  return class ForkMindOpenAI extends OpenAI {
    constructor(opts = {}) {
      const { upstream, ...rest } = opts;
      super({ ...rest, baseURL: rest.baseURL || PROXY_BASE });

      this._parentId = null; // last node id; null => next call is a root
      this._upstream = upstream || null;

      // Override fetch so we can stamp/read ForkMind headers transparently.
      // OpenAI SDK v4 accepts a custom fetch. Requires Node 18+ global fetch.
      this.fetch = this._trackingFetch.bind(this);
    }

    async _trackingFetch(url, init = {}) {
      const headers = new Headers(init.headers || {});
      if (this._parentId) headers.set('x-forkmind-parent', this._parentId);
      if (this._upstream) headers.set('x-forkmind-upstream', this._upstream);

      const response = await fetch(url, { ...init, headers });

      // Header is readable immediately, before the (possibly streamed) body.
      const newId = response.headers.get('x-forkmind-node-id');
      if (newId) this._parentId = newId;

      return response;
    }

    /** Pin the branch point (e.g. forking from a historical node). */
    setParent(nodeId) {
      this._parentId = nodeId;
    }

    /** Reset chaining — next call starts a fresh root. */
    resetParent() {
      this._parentId = null;
    }

    /** Current parent node id (the head of this conversation branch). */
    get parentId() {
      return this._parentId;
    }
  };
}

module.exports = { createForkMindOpenAI, PROXY_BASE };
