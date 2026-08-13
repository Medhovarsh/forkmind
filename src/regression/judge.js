/**
 * LLM-as-judge: the only check in ForkMind that reads *meaning* rather than
 * matching characters.
 *
 * The mechanical checks (contains / notContains / regex / minSimilarity) are
 * free, offline, and deterministic — but none of them can answer "is this
 * answer still correct?", only "does this text still look like that text".
 * The judge closes that gap by asking a model to grade the candidate output
 * against a human-written rubric.
 *
 * The trade is explicit and worth stating: this costs one extra API call per
 * case, it is non-deterministic, and it is only as good as the rubric. It is a
 * stronger signal than word overlap, not a proof of correctness.
 */

const { forward } = require('../proxy/interceptor');
const { assistantText } = require('../lib/extract');
const { PROVIDER_PATHS, authHeaders } = require('./providers');

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_MAX_TOKENS = 1024;

/**
 * Normalize user-supplied judge config into the shape stored on a case.
 * Returns null when no rubric was given (judging is opt-in per case).
 *
 * @param {object|string} [input] - rubric string, or { rubric, threshold, model, provider, upstream }
 * @returns {object|null}
 */
function normalizeJudge(input) {
  if (!input) return null;
  const cfg = typeof input === 'string' ? { rubric: input } : input;
  if (!cfg.rubric) return null;
  return {
    rubric: String(cfg.rubric),
    threshold: cfg.threshold != null ? Number(cfg.threshold) : DEFAULT_THRESHOLD,
    // Omitted model/provider/upstream fall back to the case's own at run time,
    // so a case is judgeable with no extra config.
    model: cfg.model || null,
    provider: cfg.provider || null,
    upstream: cfg.upstream || null,
  };
}

/**
 * The grading prompt. Deliberately narrow: the judge grades the CANDIDATE
 * against the RUBRIC, and sees the baseline only as context for what was
 * previously accepted — it is explicitly told not to penalize rewording.
 */
function buildPrompt({ rubric, baselineText, candidateText, userPrompt }) {
  return [
    'You are grading the output of another AI system for a regression test.',
    '',
    'Grade ONLY against the rubric below. The reference answer is an output that',
    'was previously approved by a human — treat it as context for what "correct"',
    'looked like, NOT as a target to match word for word. Do not lower the score',
    'for different wording, ordering, length, or style. Lower it only for content',
    'that is wrong, missing, contradictory, or violates the rubric.',
    '',
    '--- RUBRIC ---',
    rubric,
    '',
    ...(userPrompt ? ['--- ORIGINAL REQUEST ---', userPrompt, ''] : []),
    '--- REFERENCE ANSWER (previously approved) ---',
    baselineText,
    '',
    '--- CANDIDATE ANSWER (grade this) ---',
    candidateText,
    '',
    '--- OUTPUT FORMAT ---',
    'Reply with JSON only, no prose and no code fences:',
    '{"score": <number between 0 and 1>, "reason": "<one sentence, max 25 words>"}',
  ].join('\n');
}

/**
 * Build a provider-shaped request for the judge call.
 */
function buildRequest(provider, model, prompt) {
  const messages = [{ role: 'user', content: prompt }];
  if (provider === 'anthropic') {
    return { model, messages, max_tokens: DEFAULT_MAX_TOKENS, temperature: 0 };
  }
  return { model, messages, temperature: 0 };
}

/**
 * Pull a verdict out of the judge's reply. Models wrap JSON in prose and code
 * fences no matter how firmly you ask them not to, so scan for the first
 * balanced-looking object rather than trusting the whole string to parse.
 *
 * @returns {{score:number, reason:string}}
 * @throws when no usable score can be recovered
 */
function parseVerdict(text) {
  const raw = String(text || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(`judge returned no JSON object: ${raw.slice(0, 120)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    throw new Error(`judge returned unparseable JSON: ${e.message}`);
  }

  let score = parsed.score;
  // Tolerate a boolean verdict, and 0-100 / 0-5 scales, rather than failing the
  // run over a formatting choice.
  if (score == null && typeof parsed.pass === 'boolean') score = parsed.pass ? 1 : 0;
  score = Number(score);
  if (!Number.isFinite(score)) {
    throw new Error(`judge returned a non-numeric score: ${JSON.stringify(parsed.score)}`);
  }
  if (score > 1 && score <= 5) score /= 5;
  else if (score > 5 && score <= 100) score /= 100;
  score = Math.max(0, Math.min(1, score));

  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
  return { score, reason };
}

/**
 * Grade one candidate output against a case's rubric.
 *
 * Fails CLOSED: if the judge call errors, times out, or returns something
 * unparseable, the check is reported as FAILED rather than skipped. A gate that
 * silently passes when its grader is broken is worse than no gate.
 *
 * @param {object} caseObj - the pinned regression case
 * @param {string} candidateText - assistant text from the replayed response
 * @param {object} [opts] - { apiKey, upstream } judge-specific overrides
 * @returns {Promise<{type:'judge', ok:boolean, score:number|null, detail:string}>}
 */
async function judge(caseObj, candidateText, opts = {}) {
  const cfg = caseObj.assertions && caseObj.assertions.judge;
  if (!cfg) return null;

  const provider = cfg.provider || caseObj.provider || 'openai';
  const model = cfg.model || (caseObj.request && caseObj.request.model);
  const upstream = opts.upstream || cfg.upstream || caseObj.upstream;
  const apiPath = PROVIDER_PATHS[provider] || PROVIDER_PATHS.openai;

  if (!upstream) {
    return { type: 'judge', ok: false, score: null, detail: 'no judge upstream configured' };
  }
  if (!model) {
    return { type: 'judge', ok: false, score: null, detail: 'no judge model configured' };
  }

  const prompt = buildPrompt({
    rubric: cfg.rubric,
    baselineText: caseObj.baseline ? caseObj.baseline.text : '',
    candidateText,
    userPrompt: opts.userPrompt,
  });

  try {
    const { status, data } = await forward(
      upstream,
      apiPath,
      buildRequest(provider, model, prompt),
      authHeaders(opts.apiKey)
    );
    if (status < 200 || status >= 300) {
      return { type: 'judge', ok: false, score: null, detail: `judge upstream HTTP ${status}` };
    }
    const { score, reason } = parseVerdict(assistantText(data));
    return {
      type: 'judge',
      ok: score >= cfg.threshold,
      score,
      detail: `${score.toFixed(2)} >= ${cfg.threshold}${reason ? ` — ${reason}` : ''}`,
    };
  } catch (err) {
    return { type: 'judge', ok: false, score: null, detail: `judge error: ${err.message}` };
  }
}

module.exports = {
  judge,
  normalizeJudge,
  parseVerdict,
  buildPrompt,
  buildRequest,
  DEFAULT_THRESHOLD,
};
