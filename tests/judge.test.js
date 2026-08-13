const os = require('os');
const path = require('path');
const fs = require('fs-extra');

jest.mock('../src/proxy/interceptor', () => ({
  forward: jest.fn(),
}));

const { forward } = require('../src/proxy/interceptor');
const { saveNode } = require('../src/storage/engine');
const { pinNode, evaluate, evaluateWithJudge } = require('../src/regression/engine');
const {
  judge,
  normalizeJudge,
  parseVerdict,
  buildRequest,
  buildPrompt,
} = require('../src/regression/judge');

const reply = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });
const verdict = (obj) => reply(JSON.stringify(obj));

describe('LLM judge', () => {
  beforeEach(() => {
    forward.mockReset();
  });

  describe('normalizeJudge', () => {
    test('returns null when no rubric is supplied (judging is opt-in)', () => {
      expect(normalizeJudge(null)).toBeNull();
      expect(normalizeJudge({})).toBeNull();
      expect(normalizeJudge({ threshold: 0.9 })).toBeNull();
    });

    test('accepts a bare rubric string and applies the default threshold', () => {
      expect(normalizeJudge('must name all three hearts')).toEqual({
        rubric: 'must name all three hearts',
        threshold: 0.7,
        model: null,
        provider: null,
        upstream: null,
      });
    });

    test('keeps an explicit threshold and model override', () => {
      const c = normalizeJudge({ rubric: 'r', threshold: 0.95, model: 'gpt-4o' });
      expect(c.threshold).toBe(0.95);
      expect(c.model).toBe('gpt-4o');
    });
  });

  describe('parseVerdict', () => {
    test('parses a clean JSON verdict', () => {
      expect(parseVerdict('{"score": 0.8, "reason": "close enough"}')).toEqual({
        score: 0.8,
        reason: 'close enough',
      });
    });

    test('recovers JSON wrapped in prose and code fences', () => {
      const raw = 'Sure! Here is my grade:\n```json\n{"score": 0.4, "reason": "missing a fact"}\n```\nHope that helps.';
      expect(parseVerdict(raw).score).toBe(0.4);
    });

    test('rescales a 0-5 score', () => {
      expect(parseVerdict('{"score": 4}').score).toBeCloseTo(0.8);
    });

    test('rescales a 0-100 score', () => {
      expect(parseVerdict('{"score": 90}').score).toBeCloseTo(0.9);
    });

    test('falls back to a boolean pass field', () => {
      expect(parseVerdict('{"pass": true}').score).toBe(1);
      expect(parseVerdict('{"pass": false}').score).toBe(0);
    });

    test('clamps out-of-range scores into 0-1', () => {
      expect(parseVerdict('{"score": -3}').score).toBe(0);
    });

    test('throws when there is no JSON at all', () => {
      expect(() => parseVerdict('I think it looks fine honestly')).toThrow(/no JSON object/);
    });

    test('throws on a non-numeric score', () => {
      expect(() => parseVerdict('{"score": "great"}')).toThrow(/non-numeric/);
    });
  });

  describe('buildRequest / buildPrompt', () => {
    test('anthropic requests carry the required max_tokens', () => {
      const r = buildRequest('anthropic', 'claude-x', 'p');
      expect(r.max_tokens).toBeGreaterThan(0);
      expect(r.temperature).toBe(0);
    });

    test('openai requests omit max_tokens and pin temperature to 0', () => {
      const r = buildRequest('openai', 'gpt-x', 'p');
      expect(r.max_tokens).toBeUndefined();
      expect(r.temperature).toBe(0);
    });

    test('prompt tells the judge not to penalize rewording', () => {
      const p = buildPrompt({ rubric: 'R', baselineText: 'B', candidateText: 'C' });
      expect(p).toMatch(/NOT as a target to match word for word/);
      expect(p).toContain('R');
      expect(p).toContain('C');
    });
  });

  describe('judge()', () => {
    const caseObj = {
      provider: 'openai',
      upstream: 'http://localhost:11434',
      request: { model: 'llama3', messages: [{ role: 'user', content: 'q' }] },
      baseline: { text: 'Octopuses have three hearts.' },
      assertions: { judge: normalizeJudge({ rubric: 'must state the heart count', threshold: 0.7 }) },
    };

    test('returns null when the case has no rubric pinned', async () => {
      const r = await judge({ assertions: {} }, 'anything');
      expect(r).toBeNull();
    });

    test('passes when the score clears the threshold', async () => {
      forward.mockResolvedValue({ status: 200, data: verdict({ score: 0.9, reason: 'correct' }) });
      const r = await judge(caseObj, 'They have three hearts.');
      expect(r.ok).toBe(true);
      expect(r.score).toBe(0.9);
      expect(r.detail).toMatch(/correct/);
    });

    test('fails when the score is below the threshold', async () => {
      forward.mockResolvedValue({ status: 200, data: verdict({ score: 0.2, reason: 'heart count wrong' }) });
      const r = await judge(caseObj, 'They have two hearts.');
      expect(r.ok).toBe(false);
      expect(r.score).toBe(0.2);
    });

    test('fails CLOSED on an upstream error', async () => {
      forward.mockResolvedValue({ status: 500, data: {} });
      const r = await judge(caseObj, 'x');
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/HTTP 500/);
    });

    test('fails CLOSED when the judge call throws', async () => {
      forward.mockRejectedValue(new Error('ECONNREFUSED'));
      const r = await judge(caseObj, 'x');
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/ECONNREFUSED/);
    });

    test('fails CLOSED on an unparseable verdict', async () => {
      forward.mockResolvedValue({ status: 200, data: reply('looks good to me') });
      const r = await judge(caseObj, 'x');
      expect(r.ok).toBe(false);
      expect(r.score).toBeNull();
      expect(r.detail).toMatch(/no JSON object/);
    });

    test('fails CLOSED with no upstream configured', async () => {
      const r = await judge({ ...caseObj, upstream: null }, 'x');
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/no judge upstream/);
      expect(forward).not.toHaveBeenCalled();
    });

    test('a judge model override is what actually gets called', async () => {
      forward.mockResolvedValue({ status: 200, data: verdict({ score: 1 }) });
      const strong = {
        ...caseObj,
        assertions: { judge: normalizeJudge({ rubric: 'r', model: 'gpt-4o' }) },
      };
      await judge(strong, 'x');
      const [, , body] = forward.mock.calls[0];
      expect(body.model).toBe('gpt-4o');
    });
  });

  describe('evaluateWithJudge', () => {
    let tmp;
    let originalCwd;

    beforeEach(() => {
      originalCwd = process.cwd();
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-judge-'));
      process.chdir(tmp);
    });

    afterEach(() => {
      process.chdir(originalCwd);
      fs.removeSync(tmp);
    });

    function pinned(assertions) {
      const nodeId = saveNode(
        null,
        { model: 'llama3', messages: [{ role: 'user', content: 'octopus facts' }] },
        reply('Octopuses have three hearts.'),
        { provider: 'openai', upstream: 'http://localhost:11434' }
      );
      return pinNode(nodeId, 'octopus', assertions);
    }

    test('a case with no rubric never calls the judge', async () => {
      const c = pinned({ contains: ['hearts'] });
      const r = await evaluateWithJudge(c, reply('Octopuses have three hearts.'));
      expect(forward).not.toHaveBeenCalled();
      expect(r.checks.some((x) => x.type === 'judge')).toBe(false);
      expect(r.passed).toBe(true);
    });

    test('judge: false records a visible skip instead of silently dropping the check', async () => {
      const c = pinned({ judge: 'must state the heart count' });
      const r = await evaluateWithJudge(c, reply('Octopuses have three hearts.'), { judge: false });
      expect(forward).not.toHaveBeenCalled();
      const j = r.checks.find((x) => x.type === 'judge');
      expect(j.skipped).toBe(true);
      expect(j.ok).toBe(true);
    });

    test('a failing judge flips an otherwise-passing case to failed', async () => {
      forward.mockResolvedValue({ status: 200, data: verdict({ score: 0.1, reason: 'wrong count' }) });
      // Mechanically identical to the baseline, so every cheap check passes...
      const c = pinned({ contains: ['hearts'], judge: 'must state the heart count' });
      const mechanical = evaluate(c, reply('Octopuses have three hearts.'));
      expect(mechanical.passed).toBe(true);

      // ...but the judge is the only check that can disagree on meaning.
      const r = await evaluateWithJudge(c, reply('Octopuses have three hearts.'));
      expect(r.passed).toBe(false);
      expect(r.judgeScore).toBe(0.1);
    });

    test('a passing judge leaves a passing case passing', async () => {
      forward.mockResolvedValue({ status: 200, data: verdict({ score: 0.95 }) });
      const c = pinned({ judge: 'must state the heart count' });
      const r = await evaluateWithJudge(c, reply('Octopuses have three hearts.'));
      expect(r.passed).toBe(true);
    });

    test('the judge can rescue meaning that word-overlap wrongly flags as drift', async () => {
      forward.mockResolvedValue({ status: 200, data: verdict({ score: 0.95, reason: 'same fact, reworded' }) });
      const c = pinned({ minSimilarity: 0, judge: 'must state the heart count' });
      // Almost no shared vocabulary with the baseline, but the fact survives.
      const r = await evaluateWithJudge(c, reply('Three separate hearts pump inside it.'));
      expect(r.similarity).toBeLessThan(0.3); // Jaccard would have cried wolf
      expect(r.passed).toBe(true);
    });
  });
});
