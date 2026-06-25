const { forward } = require('../proxy/interceptor');
const { listCases, getCase, evaluate } = require('./engine');

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
  }
  return h;
}

/**
 * Replay one case against its upstream and evaluate the result.
 *
 * @param {object} caseObj
 * @param {object} opts - { apiKey, upstream } (upstream overrides the case's)
 * @returns {Promise<object>} { name, passed, similarity, checks, error? }
 */
async function runCase(caseObj, opts = {}) {
  const provider = caseObj.provider || 'openai';
  const apiPath = PROVIDER_PATHS[provider] || PROVIDER_PATHS.openai;
  const upstream = opts.upstream || caseObj.upstream;
  if (!upstream) {
    return { name: caseObj.name, passed: false, error: 'no upstream recorded; pass --upstream' };
  }

  try {
    const { status, data } = await forward(
      upstream,
      apiPath,
      caseObj.request,
      authHeaders(opts.apiKey)
    );
    if (status < 200 || status >= 300) {
      return { name: caseObj.name, passed: false, error: `upstream HTTP ${status}` };
    }
    const result = evaluate(caseObj, data);
    return { name: caseObj.name, ...result };
  } catch (err) {
    return { name: caseObj.name, passed: false, error: err.message };
  }
}

/**
 * Replay all (or a named subset of) regression cases.
 *
 * @param {object} opts - { apiKey, upstream, only? (case name/id) }
 * @returns {Promise<{results: object[], passed: number, failed: number}>}
 */
async function runAll(opts = {}) {
  const cases = opts.only ? [getCase(opts.only)].filter(Boolean) : listCases();
  const results = [];
  // Sequential: avoids hammering rate-limited free tiers.
  for (const c of cases) {
    results.push(await runCase(c, opts));
  }
  const failed = results.filter((r) => !r.passed).length;
  return { results, passed: results.length - failed, failed };
}

/**
 * Pretty terminal report. Returns the process exit code (0 = all pass).
 */
function printReport({ results, passed, failed }) {
  if (results.length === 0) {
    console.log('No regression cases pinned. Pin one: forkmind regression pin <nodeId> --name <name>');
    return 0;
  }
  console.log('\nForkMind regression run\n');
  for (const r of results) {
    const mark = r.passed ? '✓ PASS' : '✗ FAIL';
    if (r.error) {
      console.log(`  ${mark}  ${r.name}  —  error: ${r.error}`);
      continue;
    }
    console.log(`  ${mark}  ${r.name}  (similarity ${r.similarity.toFixed(3)})`);
    for (const c of r.checks) {
      if (!c.ok) console.log(`         ↳ failed ${c.type}: ${c.detail}`);
    }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  return failed > 0 ? 1 : 0;
}

module.exports = { runCase, runAll, printReport, PROVIDER_PATHS };
