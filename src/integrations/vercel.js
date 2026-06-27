// Vercel AI SDK integration.
//
// The AI SDK's OpenAI provider (`@ai-sdk/openai`) accepts a `baseURL` and a
// custom `fetch`. Point them at the ForkMind proxy with a parent-chaining fetch
// and every generateText / streamText / generateObject call is captured into
// the local tree.
//
//   const { generateText } = require('ai');
//   const { forkmindOpenAI } = require('forkmind/vercel');
//
//   const openai = forkmindOpenAI({ upstream: 'http://localhost:11434' }); // free local Ollama
//   const { text } = await generateText({
//     model: openai('llama3'),
//     prompt: 'Explain backpropagation simply.',
//   });
//   // sequential calls on the same `openai` auto-chain; openai.setParent(id) to branch.
//
// `@ai-sdk/openai` is an optional peer dep — only required if you call this.

let createOpenAI;
try {
  ({ createOpenAI } = require('@ai-sdk/openai'));
} catch {
  createOpenAI = null;
}

const { createTracking, PROXY_BASE } = require('./tracking');

/**
 * Build a ForkMind-tracked Vercel AI SDK OpenAI provider.
 *
 * @param {object} [opts]
 * @param {string}      [opts.upstream]  - upstream base forwarded to the provider.
 * @param {string}      [opts.baseURL]   - proxy base URL (defaults to FORKMIND_PROXY or :4500/v1).
 * @param {string}      [opts.apiKey]    - provider key (any string for keyless local models).
 * @param {string|null} [opts.parentId]  - initial branch point.
 * @param {Function}    [opts.fetchImpl] - underlying fetch.
 * @param {object}      [opts.providerOptions] - extra options passed to createOpenAI.
 * @returns {Function} the AI SDK provider, augmented with setParent/resetParent/parentId.
 */
function forkmindOpenAI(opts = {}) {
  if (!createOpenAI) {
    throw new Error(
      "forkmindOpenAI requires '@ai-sdk/openai'. Install it: npm i @ai-sdk/openai ai"
    );
  }

  const tracker = createTracking(opts);

  const provider = createOpenAI({
    apiKey: opts.apiKey || 'forkmind', // ignored by keyless local models; SDK requires a value
    baseURL: opts.baseURL || PROXY_BASE,
    fetch: tracker.fetch,
    ...(opts.providerOptions || {}),
  });

  // Expose the branch controls alongside the provider callable.
  provider.setParent = tracker.setParent;
  provider.resetParent = tracker.resetParent;
  Object.defineProperty(provider, 'parentId', {
    get: () => tracker.parentId,
  });

  return provider;
}

module.exports = { forkmindOpenAI };
