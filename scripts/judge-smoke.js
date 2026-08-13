#!/usr/bin/env node
/**
 * Live end-to-end check for the LLM judge against a real backend.
 *
 * The judge unit tests mock the network, so they prove the logic but not that a
 * real model returns something we can parse. This script closes that gap: it
 * makes real calls, in a throwaway directory, and asserts the judge disagrees
 * with word-overlap in both directions.
 *
 *   node scripts/judge-smoke.js
 *   FORKMIND_MODEL=llama3.2 node scripts/judge-smoke.js
 *   FORKMIND_UPSTREAM=https://api.groq.com/openai FORKMIND_API_KEY=... \
 *     FORKMIND_MODEL=llama-3.1-8b-instant node scripts/judge-smoke.js
 */

const os = require('os');
const path = require('path');
const fs = require('fs-extra');

const UPSTREAM = process.env.FORKMIND_UPSTREAM || 'http://localhost:11434';
const MODEL = process.env.FORKMIND_MODEL || 'llama3.2';
const API_KEY = process.env.FORKMIND_API_KEY || '';
const PROVIDER = process.env.FORKMIND_PROVIDER || 'openai';

const originalCwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-smoke-'));

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  process.chdir(tmp);
  const { initStorage, saveNode } = require('../src/storage/engine');
  const { pinNode } = require('../src/regression/engine');
  const { runCase } = require('../src/regression/runner');
  const { forward } = require('../src/proxy/interceptor');
  const { PROVIDER_PATHS, authHeaders } = require('../src/regression/providers');
  const { assistantText } = require('../src/lib/extract');

  initStorage();
  console.log(`\nForkMind judge smoke test\n  upstream: ${UPSTREAM}\n  model:    ${MODEL}\n`);

  const request = {
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: 'In one short sentence: how many hearts does an octopus have?',
      },
    ],
    temperature: 0,
  };

  // 1. Make a real call so the baseline is genuine model output, not a fixture.
  console.log('1. capturing a real baseline');
  const { status, data } = await forward(
    UPSTREAM,
    PROVIDER_PATHS[PROVIDER],
    request,
    authHeaders(API_KEY)
  );
  if (status < 200 || status >= 300) {
    throw new Error(`upstream HTTP ${status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const baselineText = assistantText(data);
  check('baseline is non-empty text', Boolean(baselineText.trim()), JSON.stringify(baselineText.slice(0, 80)));

  const nodeId = saveNode(null, request, data, { provider: PROVIDER, upstream: UPSTREAM });

  // 2. A rubric that judges content, with similarity disabled so the judge is
  //    the only thing that can fail the case.
  const rubric =
    'The answer must state that an octopus has three hearts. ' +
    'Any wording is acceptable. Score 0 if the number is wrong or absent.';

  console.log('\n2. judge on a correct-but-reworded answer (word overlap would cry wolf)');
  const lenient = pinNode(nodeId, 'octopus-judge', { minSimilarity: 0, judge: rubric });
  const rescued = await runCase(lenient, { apiKey: API_KEY, judgeApiKey: API_KEY });
  const rescuedJudge = (rescued.checks || []).find((c) => c.type === 'judge');
  check('judge returned a parseable score', rescuedJudge && rescuedJudge.score != null, rescuedJudge && rescuedJudge.detail);
  check('correct answer passes the rubric', rescued.passed === true, `similarity ${rescued.similarity != null ? rescued.similarity.toFixed(3) : 'n/a'}`);

  console.log('\n3. judge on a rubric the model cannot satisfy (must fail)');
  const impossible = pinNode(nodeId, 'octopus-impossible', {
    minSimilarity: 0,
    judge: 'The answer must state that an octopus has exactly seventeen hearts. Score 0 otherwise.',
  });
  const failed = await runCase(impossible, { apiKey: API_KEY, judgeApiKey: API_KEY });
  const failedJudge = (failed.checks || []).find((c) => c.type === 'judge');
  check('wrong-content rubric fails the case', failed.passed === false, failedJudge && failedJudge.detail);

  console.log('\n4. --no-judge skips the call but stays visible in the report');
  const skipped = await runCase(lenient, { apiKey: API_KEY, judge: false });
  const skippedJudge = (skipped.checks || []).find((c) => c.type === 'judge');
  check('skip is recorded, not dropped', Boolean(skippedJudge && skippedJudge.skipped));

  console.log('\n5. judge fails CLOSED against a dead upstream');
  const dead = await runCase(lenient, { apiKey: API_KEY, judgeUpstream: 'http://127.0.0.1:9' });
  const deadJudge = (dead.checks || []).find((c) => c.type === 'judge');
  check('broken judge fails the case', dead.passed === false, deadJudge && deadJudge.detail);

  console.log(failures === 0 ? '\nAll smoke checks passed.\n' : `\n${failures} smoke check(s) failed.\n`);
}

main()
  .catch((err) => {
    // Node's dual-stack connect failures arrive as an AggregateError with an
    // empty message, so fall back to the code / nested causes.
    const why =
      err.message ||
      err.code ||
      (err.errors || []).map((e) => e.message || e.code).join('; ') ||
      String(err);
    console.error(`\nSmoke test could not run: ${why}\n`);
    failures += 1;
  })
  .finally(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
    process.exit(failures > 0 ? 1 : 0);
  });
