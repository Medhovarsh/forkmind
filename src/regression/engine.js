const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const { readNode } = require('../storage/engine');
const { assistantText, userPreview, toolCalls, matchesSubset } = require('../lib/extract');
const { judge, normalizeJudge } = require('./judge');

// Regression cases live alongside nodes but in their own dir so they survive
// node pruning and are easy to commit to a repo for shared baselines.
function regDir() {
  return path.join(process.cwd(), '.forkmind', 'regressions');
}
function casePath(id) {
  return path.join(regDir(), `${id}.json`);
}

function caseId(name) {
  // Stable id from the case name so re-pinning the same name updates in place.
  return crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 12);
}

/**
 * Tokenize to lowercased word set for similarity comparison.
 */
function tokens(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
}

/**
 * Jaccard similarity between two strings' word sets. 1 = identical word set,
 * 0 = disjoint. A robust-enough "did the output drift" signal for non-
 * deterministic LLM text, without pretending exact-match makes sense.
 */
function similarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Normalize tool-call expectations into the shape stored on a case.
 * Returns null when nothing about tools was asserted.
 *
 * @param {object|Array} [input] - { called[], notCalled[], exact } or a bare
 *   array of names/specs treated as `called`.
 */
function normalizeTools(input) {
  if (!input) return null;
  const cfg = Array.isArray(input) ? { called: input } : input;
  const called = (cfg.called || []).map((t) =>
    typeof t === 'string' ? { name: t, args: null } : { name: t.name, args: t.args || null }
  );
  const notCalled = (cfg.notCalled || []).map((t) => (typeof t === 'string' ? t : t.name));
  if (!called.length && !notCalled.length && !cfg.exact) return null;
  return { called, notCalled, exact: Boolean(cfg.exact) };
}

/**
 * Pin a saved node as a regression baseline.
 *
 * @param {string} nodeId
 * @param {string} name - human label; also the case key (re-pin updates).
 * @param {object} [assertions] - { contains[], notContains[], regex[], minSimilarity, judge }
 * @returns {object} the saved case.
 */
function pinNode(nodeId, name, assertions = {}) {
  const node = readNode(nodeId);
  if (!node) throw new Error(`node ${nodeId} not found`);
  if (!name) throw new Error('a --name is required to pin a regression case');

  const baselineText = assistantText(node.response);
  const id = caseId(name);

  const caseObj = {
    id,
    name,
    sourceNodeId: nodeId,
    createdAt: new Date().toISOString(),
    provider: node.meta && node.meta.provider,
    upstream: node.meta && node.meta.upstream,
    request: { ...node.request, stream: false }, // replay non-streaming
    baseline: { text: baselineText, response: node.response },
    assertions: {
      contains: assertions.contains || [],
      notContains: assertions.notContains || [],
      regex: assertions.regex || [],
      // Default guard: flag if the new output drifts far from the baseline.
      minSimilarity:
        assertions.minSimilarity != null ? assertions.minSimilarity : 0.3,
      // What the model DID, not what it said. Free and offline like the other
      // mechanical checks — a tool call is structured data, so verifying it
      // needs no model in the loop.
      tools: normalizeTools(assertions.tools),
      // Opt-in, and the only check that reads meaning. Costs an API call per
      // run, so it stays off unless a rubric is supplied.
      judge: normalizeJudge(assertions.judge),
    },
  };

  fs.ensureDirSync(regDir());
  fs.writeJsonSync(casePath(id), caseObj, { spaces: 2 });
  return caseObj;
}

function listCases() {
  const dir = regDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => fs.readJsonSync(path.join(dir, f)));
}

function getCase(nameOrId) {
  const byId = casePath(nameOrId);
  if (fs.existsSync(byId)) return fs.readJsonSync(byId);
  const byName = casePath(caseId(nameOrId));
  return fs.existsSync(byName) ? fs.readJsonSync(byName) : null;
}

function removeCase(nameOrId) {
  const c = getCase(nameOrId);
  if (!c) return false;
  fs.removeSync(casePath(c.id));
  return true;
}

/**
 * Evaluate a fresh response against a case's MECHANICAL assertions only —
 * substring, regex, and word-overlap similarity. Deterministic, offline, free.
 *
 * The judge assertion is deliberately NOT run here: it costs a network call, so
 * it lives behind the async `evaluateWithJudge`. Anything that wants the full
 * verdict must opt into paying for it.
 *
 * @param {object} caseObj
 * @param {object} newResponse - provider response from the replay
 * @returns {object} { passed, similarity, checks: [{type, ok, detail}] }
 */
function evaluate(caseObj, newResponse) {
  const newText = assistantText(newResponse);
  const sim = similarity(caseObj.baseline.text, newText);
  const a = caseObj.assertions || {};
  const checks = [];

  for (const sub of a.contains || []) {
    checks.push({
      type: 'contains',
      ok: newText.toLowerCase().includes(String(sub).toLowerCase()),
      detail: sub,
    });
  }
  for (const sub of a.notContains || []) {
    checks.push({
      type: 'notContains',
      ok: !newText.toLowerCase().includes(String(sub).toLowerCase()),
      detail: sub,
    });
  }
  for (const pattern of a.regex || []) {
    let ok = false;
    try {
      ok = new RegExp(pattern).test(newText);
    } catch (e) {
      checks.push({ type: 'regex', ok: false, detail: `invalid /${pattern}/: ${e.message}` });
      continue;
    }
    checks.push({ type: 'regex', ok, detail: pattern });
  }
  if (a.minSimilarity != null) {
    checks.push({
      type: 'minSimilarity',
      ok: sim >= a.minSimilarity,
      detail: `${sim.toFixed(3)} >= ${a.minSimilarity}`,
    });
  }

  // Tool-call assertions. Text checks ask whether the answer still reads right;
  // these ask whether the agent still DID the right thing. A wrong sentence is
  // annoying, a wrong action writes to somebody's system.
  const calls = toolCalls(newResponse);
  if (a.tools) {
    for (const want of a.tools.called) {
      const named = calls.filter((c) => c.name === want.name);
      const hit = want.args ? named.find((c) => matchesSubset(want.args, c.args)) : named[0];
      checks.push({
        type: 'toolCalled',
        ok: Boolean(hit),
        detail: want.args
          ? `${want.name}(${JSON.stringify(want.args)})${
              !hit && named.length ? ` — called with ${JSON.stringify(named[0].args)}` : ''
            }`
          : want.name,
      });
    }
    for (const name of a.tools.notCalled) {
      checks.push({
        type: 'toolNotCalled',
        ok: !calls.some((c) => c.name === name),
        detail: name,
      });
    }
    if (a.tools.exact) {
      // Sorted multiset compare: an EXTRA call is a real regression even when
      // every expected call is present.
      const got = calls.map((c) => c.name).sort();
      const want = a.tools.called.map((t) => t.name).sort();
      checks.push({
        type: 'toolsExact',
        ok: got.length === want.length && got.every((n, i) => n === want[i]),
        detail: `called [${got.join(', ')}] vs expected [${want.join(', ')}]`,
      });
    }
  }

  const passed = checks.every((c) => c.ok);
  return { passed, similarity: sim, newText, toolCalls: calls, checks };
}

/**
 * Full evaluation: the mechanical checks, plus the LLM judge when the case has
 * a rubric pinned and judging hasn't been disabled.
 *
 * A skipped judge is recorded as a passing check flagged `skipped` so the
 * report can say so out loud — a gate that quietly stops running is how a
 * regression suite rots without anyone noticing.
 *
 * @param {object} caseObj
 * @param {object} newResponse - provider response from the replay
 * @param {object} [opts] - { judge: false to skip, judgeApiKey, judgeUpstream }
 * @returns {Promise<object>} { passed, similarity, checks }
 */
async function evaluateWithJudge(caseObj, newResponse, opts = {}) {
  const result = evaluate(caseObj, newResponse);
  const cfg = caseObj.assertions && caseObj.assertions.judge;
  if (!cfg) return result;

  if (opts.judge === false) {
    result.checks.push({
      type: 'judge',
      ok: true,
      skipped: true,
      detail: 'skipped (judging disabled)',
    });
    return result;
  }

  const check = await judge(caseObj, result.newText, {
    apiKey: opts.judgeApiKey,
    upstream: opts.judgeUpstream,
    userPrompt: userPreview(caseObj.request),
  });
  if (check) {
    result.checks.push(check);
    result.judgeScore = check.score;
    result.passed = result.checks.every((c) => c.ok);
  }
  return result;
}

module.exports = {
  pinNode,
  listCases,
  getCase,
  removeCase,
  evaluate,
  evaluateWithJudge,
  normalizeTools,
  similarity,
  caseId,
  regDir,
};
