// LangChain.js integration.
//
// LangChain's ChatOpenAI talks to any OpenAI-compatible endpoint via its
// `configuration` ({ baseURL, fetch }) passthrough to the OpenAI client. Point
// that at the ForkMind proxy with a parent-chaining fetch and every LangChain
// call is captured into the local tree — no model-class swap, no callbacks.
//
//   const { ChatOpenAI } = require('@langchain/openai');
//   const { forkmind } = require('forkmind/langchain');
//
//   const fm = forkmind({ upstream: 'http://localhost:11434' }); // free local Ollama
//   const model = new ChatOpenAI({
//     apiKey: 'ollama',
//     model: 'llama3',
//     configuration: fm.configuration,
//   });
//
//   await model.invoke('Explain backpropagation simply.');
//   // sequential calls on the same `fm` auto-chain; fm.setParent(id) to branch.
//
// Works for any OpenAI-compatible provider (set `upstream`): Ollama, Groq,
// OpenRouter, Together, vLLM, LM Studio, OpenAI itself.

const { createTracking, PROXY_BASE } = require('./tracking');

/**
 * @param {object} [opts]
 * @param {string}      [opts.upstream]  - upstream base forwarded to the provider.
 * @param {string}      [opts.baseURL]   - proxy base URL (defaults to FORKMIND_PROXY or :4500/v1).
 * @param {string|null} [opts.parentId]  - initial branch point.
 * @param {Function}    [opts.fetchImpl] - underlying fetch.
 * @returns {{ configuration: {baseURL: string, fetch: Function}, setParent: Function, resetParent: Function, parentId: string|null }}
 */
function forkmind(opts = {}) {
  const tracker = createTracking(opts);
  return {
    /** Spread into `new ChatOpenAI({ configuration })`. */
    configuration: {
      baseURL: opts.baseURL || PROXY_BASE,
      fetch: tracker.fetch,
    },
    setParent: tracker.setParent,
    resetParent: tracker.resetParent,
    get parentId() {
      return tracker.parentId;
    },
  };
}

module.exports = { forkmind };
