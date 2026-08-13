const { forward } = require('../proxy/interceptor');
const { listCases, getCase, evaluateWithJudge } = require('./engine');
const { PROVIDER_PATHS, authHeaders } = require('./providers');

/**
 * Replay one case against its upstream and evaluate the result.
 *
 * @param {object} caseObj
 * @param {object} opts - { apiKey, upstream, judge, judgeApiKey, judgeUpstream }
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
    const result = await evaluateWithJudge(caseObj, data, {
      judge: opts.judge,
      // Judging can point at a different (stronger) model than the case itself.
      judgeApiKey: opts.judgeApiKey || opts.apiKey,
      judgeUpstream: opts.judgeUpstream,
    });
    return { name: caseObj.name, ...result };
  } catch (err) {
    return { name: caseObj.name, passed: false, error: err.message };
  }
}

/**
 * Replay all (or a named subset of) regression cases.
 *
 * @param {object} opts - { apiKey, upstream, only?, judge?, judgeApiKey?, judgeUpstream? }
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
    const judged = r.checks.find((c) => c.type === 'judge');
    const judgeNote = judged
      ? judged.skipped
        ? ', judge skipped'
        : `, judge ${judged.score != null ? judged.score.toFixed(2) : 'n/a'}`
      : '';
    console.log(`  ${mark}  ${r.name}  (similarity ${r.similarity.toFixed(3)}${judgeNote})`);
    for (const c of r.checks) {
      if (!c.ok) console.log(`         ↳ failed ${c.type}: ${c.detail}`);
    }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  return failed > 0 ? 1 : 0;
}

// PROVIDER_PATHS/authHeaders re-exported from ./providers so existing importers
// of the runner keep working after the move.
module.exports = { runCase, runAll, printReport, PROVIDER_PATHS, authHeaders };
