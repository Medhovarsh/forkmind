let Anthropic;
try {
  // Optional peer dependency.
  Anthropic = require('@anthropic-ai/sdk');
} catch {
  Anthropic = null;
}

const PROXY_BASE = process.env.FORKMIND_PROXY_ANTHROPIC || 'http://localhost:4500';

/**
 * Drop-in replacement for the Anthropic client that records calls into the
 * ForkMind tree. Same chaining model as the OpenAI wrapper: each response's
 * x-forkmind-node-id becomes the next call's x-forkmind-parent.
 *
 *   const { ForkMindAnthropic } = require('forkmind');
 *   const client = new ForkMindAnthropic({ apiKey });
 *   await client.messages.create({ model, max_tokens, messages });
 */
function createForkMindAnthropic() {
  if (!Anthropic) {
    throw new Error(
      "ForkMindAnthropic requires '@anthropic-ai/sdk'. Install it: npm i @anthropic-ai/sdk"
    );
  }

  const Base = Anthropic.Anthropic || Anthropic; // support both export shapes

  return class ForkMindAnthropic extends Base {
    constructor(opts = {}) {
      const { upstream, ...rest } = opts;
      // Anthropic SDK appends /v1/messages to baseURL itself, so point at root.
      super({ ...rest, baseURL: rest.baseURL || PROXY_BASE });

      this._parentId = null;
      this._upstream = upstream || null;
      this.fetch = this._trackingFetch.bind(this);
    }

    async _trackingFetch(url, init = {}) {
      const headers = new Headers(init.headers || {});
      if (this._parentId) headers.set('x-forkmind-parent', this._parentId);
      if (this._upstream) headers.set('x-forkmind-upstream', this._upstream);

      const response = await fetch(url, { ...init, headers });
      const newId = response.headers.get('x-forkmind-node-id');
      if (newId) this._parentId = newId;
      return response;
    }

    setParent(nodeId) {
      this._parentId = nodeId;
    }

    resetParent() {
      this._parentId = null;
    }

    get parentId() {
      return this._parentId;
    }
  };
}

module.exports = { createForkMindAnthropic, PROXY_BASE };
