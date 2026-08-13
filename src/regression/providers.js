/**
 * Provider routing shared by the regression runner and the LLM judge. Lives in
 * its own module so the judge can reach it without importing the runner (which
 * imports the engine, which imports the judge — that would be circular).
 */

// Provider -> upstream path. Mirrors the proxy's routing so replays hit the
// same endpoint the original call used.
const PROVIDER_PATHS = {
  openai: '/v1/chat/completions',
  anthropic: '/v1/messages',
};

/**
 * Build auth headers for a replay. We don't know the provider's exact scheme,
 * so send both common ones; the upstream ignores the irrelevant one. Keyless
 * local providers (Ollama) need nothing.
 */
function authHeaders(apiKey) {
  const h = { 'content-type': 'application/json' };
  if (apiKey) {
    h['authorization'] = `Bearer ${apiKey}`;
    h['x-api-key'] = apiKey;
    // Anthropic rejects /v1/messages without a version header.
    h['anthropic-version'] = '2023-06-01';
  }
  return h;
}

module.exports = { PROVIDER_PATHS, authHeaders };
