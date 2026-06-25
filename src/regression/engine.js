const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const { readNode } = require('../storage/engine');
const { assistantText } = require('../lib/extract');

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
 * Pin a saved node as a regression baseline.
 *
 * @param {string} nodeId
 * @param {string} name - human label; also the case key (re-pin updates).
 * @param {object} [assertions] - { contains[], notContains[], regex[], minSimilarity }
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
 * Evaluate a fresh response against a case's baseline + assertions.
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

  const passed = checks.every((c) => c.ok);
  return { passed, similarity: sim, newText, checks };
}

module.exports = {
  pinNode,
  listCases,
  getCase,
  removeCase,
  evaluate,
  similarity,
  caseId,
  regDir,
};
