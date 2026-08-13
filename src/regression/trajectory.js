/**
 * Trajectory regression — pin a PATH through the captured graph, not a turn.
 *
 * Single-turn regression asks "is the last message still right?". For an agent
 * that is the wrong question: agents fail in the middle of a run and then
 * produce a perfectly reasonable-looking final sentence. What matters is the
 * route — did it still search before it wrote, did it still confirm before it
 * charged, did a prompt tweak send it down a different branch to a similar
 * answer.
 *
 * This is only possible because ForkMind already captures real traffic as a
 * parent-linked DAG: a trajectory case is just a lineage (`getLineage`) frozen
 * with its action sequence.
 *
 * ## The honest limitation, stated once
 *
 * Replaying a path re-applies the ORIGINAL recorded tool results. Tools are not
 * executed live. That is deliberate — it holds the environment fixed so the only
 * variable is the model's decisions — but it has a hard consequence: the moment
 * the agent takes a different action than the baseline, the recorded tool result
 * waiting for it is an answer to a question it didn't ask. Every step after that
 * is fiction.
 *
 * So this stops at the first divergence and reports where. It does not keep
 * replaying to produce a longer, more impressive, less true report.
 */

const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const { readNode, getLineage } = require('../storage/engine');
const { assistantText, toolCalls } = require('../lib/extract');
const { judge, normalizeJudge } = require('./judge');
const { PROVIDER_PATHS, authHeaders } = require('./providers');
const { forward } = require('../proxy/interceptor');

// Own directory, parallel to single-turn cases. Trajectories have a different
// shape and a different runner; mixing them into one folder would force every
// reader to branch on `kind`.
function trajDir() {
  return path.join(process.cwd(), '.forkmind', 'trajectories');
}
function casePath(id) {
  return path.join(trajDir(), `${id}.json`);
}
function caseId(name) {
  return crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 12);
}

/** Ordered tool names a single response invoked. The step's "action". */
function stepSignature(response) {
  return toolCalls(response).map((c) => c.name);
}

/** Assistant message object from an OpenAI-shaped response. */
function assistantMessage(response) {
  const m = response && response.choices && response.choices[0] && response.choices[0].message;
  if (!m) throw new Error('upstream response has no choices[0].message');
  return m;
}

/**
 * Messages a step added after its parent's assistant reply — the user turns and
 * recorded tool results that must re-apply on top of a regenerated history.
 * Mirrors `replay/engine.tailMessages`, but reads the stored step requests so a
 * pinned case stays runnable after the original nodes are pruned.
 */
function tailFromRequests(parentRequest, childRequest) {
  const parentLen = (parentRequest.messages || []).length;
  return (childRequest.messages || []).slice(parentLen + 1);
}

/**
 * Freeze a lineage as a trajectory baseline.
 *
 * @param {string} leafId - last node of the path
 * @param {string} name - case key; re-pinning the same name updates in place
 * @param {object} [assertions] - { sequence, notCalled[], before[][], judge }
 * @param {object} [opts] - { from: nodeId to start the path at }
 */
function pinTrajectory(leafId, name, assertions = {}, opts = {}) {
  if (!name) throw new Error('a --name is required to pin a trajectory');
  const lineage = getLineage(leafId);
  if (!lineage.length) throw new Error(`node ${leafId} not found`);

  let steps = lineage;
  if (opts.from) {
    if (!readNode(opts.from)) throw new Error(`node ${opts.from} not found`);
    const start = lineage.findIndex((n) => n.id === opts.from);
    if (start === -1) throw new Error(`${leafId} is not a descendant of ${opts.from}`);
    steps = lineage.slice(start);
  }

  const head = steps[0];
  const provider = (head.meta && head.meta.provider) || 'openai';
  if (provider !== 'openai') {
    throw new Error('trajectory replay supports openai-shaped chains only');
  }

  const caseObj = {
    kind: 'trajectory',
    id: caseId(name),
    name,
    createdAt: new Date().toISOString(),
    provider,
    upstream: head.meta && head.meta.upstream,
    steps: steps.map((n) => ({
      nodeId: n.id,
      request: { ...n.request, stream: false },
      text: assistantText(n.response),
      actions: stepSignature(n.response),
    })),
    assertions: {
      // 'exact'      — same actions, same order, same count
      // 'subsequence'— baseline actions must appear in order; extras allowed
      // null         — don't constrain the sequence; rely on notCalled/before
      sequence: assertions.sequence === undefined ? 'exact' : assertions.sequence,
      // Forbidden anywhere in the run. The destructive-action guard.
      notCalled: assertions.notCalled || [],
      // Ordering constraints as [before, after] pairs, e.g. ['search','write'].
      before: assertions.before || [],
      // Optional rubric applied to the FINAL step's text.
      judge: normalizeJudge(assertions.judge),
    },
  };

  fs.ensureDirSync(trajDir());
  fs.writeJsonSync(casePath(caseObj.id), caseObj, { spaces: 2 });
  return caseObj;
}

function listTrajectories() {
  const dir = trajDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => fs.readJsonSync(path.join(dir, f)));
}

function getTrajectory(nameOrId) {
  const byId = casePath(nameOrId);
  if (fs.existsSync(byId)) return fs.readJsonSync(byId);
  const byName = casePath(caseId(nameOrId));
  return fs.existsSync(byName) ? fs.readJsonSync(byName) : null;
}

function removeTrajectory(nameOrId) {
  const c = getTrajectory(nameOrId);
  if (!c) return false;
  fs.removeSync(casePath(c.id));
  return true;
}

/**
 * Is `needle` an in-order subsequence of `hay`? (Not a substring — gaps are OK.)
 */
function isSubsequence(needle, hay) {
  let i = 0;
  for (const item of hay) {
    if (i < needle.length && item === needle[i]) i += 1;
  }
  return i === needle.length;
}

/**
 * Apply the trajectory-level assertions to a completed (or truncated) run.
 *
 * @param {object} caseObj
 * @param {string[]} actual - flattened action sequence actually observed
 * @param {boolean} completed - false when the run stopped early at a divergence
 */
function evaluateSequence(caseObj, actual, completed) {
  const a = caseObj.assertions || {};
  const expected = caseObj.steps.reduce((acc, s) => acc.concat(s.actions), []);
  const checks = [];

  if (a.sequence === 'exact') {
    checks.push({
      type: 'sequenceExact',
      ok:
        completed &&
        expected.length === actual.length &&
        expected.every((n, i) => n === actual[i]),
      detail: `[${actual.join(' → ')}] vs [${expected.join(' → ')}]`,
    });
  } else if (a.sequence === 'subsequence') {
    checks.push({
      type: 'sequenceSubsequence',
      ok: isSubsequence(expected, actual),
      detail: `[${actual.join(' → ')}] must contain [${expected.join(' → ')}] in order`,
    });
  }

  for (const name of a.notCalled || []) {
    checks.push({
      type: 'neverCalled',
      ok: !actual.includes(name),
      detail: name,
    });
  }

  for (const pair of a.before || []) {
    const [first, second] = pair;
    const i = actual.indexOf(first);
    const j = actual.indexOf(second);
    // Vacuously true when the later action never happened — this constrains
    // ORDER, not whether the pair occurred. Use sequence/notCalled for that.
    const ok = j === -1 || (i !== -1 && i < j);
    checks.push({
      type: 'ordering',
      ok,
      detail: `${first} before ${second}${ok ? '' : ` (got [${actual.join(' → ')}])`}`,
    });
  }

  return { expected, checks };
}

/**
 * Replay a pinned trajectory and evaluate it.
 *
 * Stops at the first step whose action signature differs from the baseline: past
 * that point the recorded tool results no longer answer what the agent asked, so
 * any further replay would be measuring fiction.
 *
 * @param {object} caseObj
 * @param {object} [opts] - { apiKey, upstream, judge, judgeApiKey, judgeUpstream, forwardFn }
 */
async function runTrajectory(caseObj, opts = {}) {
  const upstream = opts.upstream || caseObj.upstream;
  const apiPath = PROVIDER_PATHS[caseObj.provider] || PROVIDER_PATHS.openai;
  const send =
    opts.forwardFn || ((body) => forward(upstream, apiPath, body, authHeaders(opts.apiKey)));

  if (!upstream && !opts.forwardFn) {
    return { name: caseObj.name, passed: false, error: 'no upstream recorded; pass --upstream' };
  }

  const steps = [];
  const actual = [];
  let divergedAt = null;
  let finalText = '';
  let messages = (caseObj.steps[0].request.messages || []).slice();
  let body = { ...caseObj.steps[0].request, messages, stream: false };

  for (let i = 0; i < caseObj.steps.length; i += 1) {
    const baseline = caseObj.steps[i];
    let status;
    let data;
    try {
      ({ status, data } = await send(body));
    } catch (err) {
      return { name: caseObj.name, passed: false, error: `step ${i + 1}: ${err.message}`, steps };
    }
    if (status < 200 || status >= 300) {
      return { name: caseObj.name, passed: false, error: `step ${i + 1}: upstream HTTP ${status}`, steps };
    }

    const got = stepSignature(data);
    const same = got.length === baseline.actions.length && got.every((n, k) => n === baseline.actions[k]);
    actual.push(...got);
    finalText = assistantText(data);
    steps.push({
      index: i,
      nodeId: baseline.nodeId,
      expected: baseline.actions,
      actual: got,
      diverged: !same,
    });

    if (!same) {
      divergedAt = i;
      break; // recorded tool results are no longer valid past this point
    }
    if (i + 1 >= caseObj.steps.length) break;

    // Thread the regenerated reply plus the ORIGINAL tail (user turns, recorded
    // tool results) into the next call.
    messages = [
      ...messages,
      assistantMessage(data),
      ...tailFromRequests(baseline.request, caseObj.steps[i + 1].request),
    ];
    body = { ...caseObj.steps[i + 1].request, messages, stream: false };
  }

  const completed = divergedAt === null;
  const { expected, checks } = evaluateSequence(caseObj, actual, completed);

  if (divergedAt !== null) {
    const d = steps[divergedAt];
    checks.push({
      type: 'divergence',
      ok: false,
      detail:
        `step ${divergedAt + 1}/${caseObj.steps.length}: expected [${d.expected.join(', ') || 'no action'}], ` +
        `got [${d.actual.join(', ') || 'no action'}] — replay stopped (recorded tool results no longer apply)`,
    });
  }

  // The judge grades the final answer, and only makes sense on a run that
  // actually reached the end.
  const jcfg = caseObj.assertions && caseObj.assertions.judge;
  if (jcfg && completed && opts.judge !== false) {
    const check = await judge(
      {
        provider: caseObj.provider,
        upstream: caseObj.upstream,
        request: caseObj.steps[caseObj.steps.length - 1].request,
        baseline: { text: caseObj.steps[caseObj.steps.length - 1].text },
        assertions: { judge: jcfg },
      },
      finalText,
      { apiKey: opts.judgeApiKey, upstream: opts.judgeUpstream }
    );
    if (check) checks.push(check);
  } else if (jcfg && opts.judge === false) {
    checks.push({ type: 'judge', ok: true, skipped: true, detail: 'skipped (judging disabled)' });
  }

  return {
    name: caseObj.name,
    passed: checks.every((c) => c.ok),
    completed,
    divergedAt,
    stepsRun: steps.length,
    stepsTotal: caseObj.steps.length,
    expected,
    actual,
    steps,
    checks,
  };
}

/**
 * Replay all (or one) pinned trajectory.
 */
async function runAllTrajectories(opts = {}) {
  const cases = opts.only ? [getTrajectory(opts.only)].filter(Boolean) : listTrajectories();
  const results = [];
  // Sequential: a trajectory is already N calls deep; parallelising them is how
  // you get rate-limited off a free tier.
  for (const c of cases) {
    results.push(await runTrajectory(c, opts));
  }
  const failed = results.filter((r) => !r.passed).length;
  return { results, passed: results.length - failed, failed };
}

/**
 * Terminal report. Returns the process exit code (0 = all pass).
 */
function printTrajectoryReport({ results, passed, failed }) {
  if (results.length === 0) {
    console.log('No trajectories pinned. Pin one: forkmind trajectory pin <leafNodeId> --name <name>');
    return 0;
  }
  console.log('\nForkMind trajectory run\n');
  for (const r of results) {
    const mark = r.passed ? '✓ PASS' : '✗ FAIL';
    if (r.error) {
      console.log(`  ${mark}  ${r.name}  —  error: ${r.error}`);
      continue;
    }
    console.log(`  ${mark}  ${r.name}  (${r.stepsRun}/${r.stepsTotal} steps)`);
    console.log(`         path: ${r.actual.length ? r.actual.join(' → ') : 'no actions'}`);
    for (const c of r.checks) {
      if (!c.ok) console.log(`         ↳ failed ${c.type}: ${c.detail}`);
    }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  return failed > 0 ? 1 : 0;
}

module.exports = {
  pinTrajectory,
  listTrajectories,
  getTrajectory,
  removeTrajectory,
  runTrajectory,
  runAllTrajectories,
  printTrajectoryReport,
  evaluateSequence,
  isSubsequence,
  stepSignature,
  tailFromRequests,
  trajDir,
  caseId,
};
