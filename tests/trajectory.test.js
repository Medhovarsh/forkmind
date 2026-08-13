const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { saveNode, initStorage } = require('../src/storage/engine');
const {
  pinTrajectory,
  listTrajectories,
  getTrajectory,
  removeTrajectory,
  runTrajectory,
  evaluateSequence,
  isSubsequence,
  stepSignature,
} = require('../src/regression/trajectory');

/** OpenAI-shaped reply that calls tools. */
const acts = (names, content = null) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content,
        tool_calls: names.map((n, i) => ({
          id: `c${i}`,
          type: 'function',
          function: { name: n, arguments: '{}' },
        })),
      },
    },
  ],
});

/** OpenAI-shaped reply with plain text and no tool calls. */
const says = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });

describe('trajectory regression', () => {
  let tmp;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-traj-'));
    process.chdir(tmp);
    initStorage();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
  });

  const meta = { provider: 'openai', upstream: 'http://localhost:11434' };

  /**
   * Build a 3-step agent run: search -> write_file -> plain summary.
   * Requests nest the way real captures do (child = parent + assistant + tail),
   * which is what tail re-application depends on.
   */
  function buildRun() {
    const m1 = [{ role: 'user', content: 'fix the bug' }];
    const n1 = saveNode(null, { model: 'gpt-x', messages: m1 }, acts(['search']), meta);

    const m2 = [...m1, { role: 'assistant', content: null }, { role: 'tool', content: 'found it' }];
    const n2 = saveNode(n1, { model: 'gpt-x', messages: m2 }, acts(['write_file']), meta);

    const m3 = [...m2, { role: 'assistant', content: null }, { role: 'tool', content: 'written' }];
    const n3 = saveNode(n2, { model: 'gpt-x', messages: m3 }, says('Fixed it.'), meta);

    return { n1, n2, n3 };
  }

  describe('helpers', () => {
    test('stepSignature lists the tools a response invoked, in order', () => {
      expect(stepSignature(acts(['a', 'b']))).toEqual(['a', 'b']);
      expect(stepSignature(says('hi'))).toEqual([]);
    });

    test('isSubsequence allows gaps but not reordering', () => {
      expect(isSubsequence(['a', 'c'], ['a', 'b', 'c'])).toBe(true);
      expect(isSubsequence(['c', 'a'], ['a', 'b', 'c'])).toBe(false);
      expect(isSubsequence([], ['a'])).toBe(true);
    });
  });

  describe('pin / list / get / remove', () => {
    test('pins the whole lineage with its action sequence', () => {
      const { n3 } = buildRun();
      const c = pinTrajectory(n3, 'bugfix-run');
      expect(c.steps).toHaveLength(3);
      expect(c.steps.map((s) => s.actions)).toEqual([['search'], ['write_file'], []]);
      expect(c.assertions.sequence).toBe('exact');
      expect(listTrajectories()).toHaveLength(1);
    });

    test('--from slices the path to start at an ancestor', () => {
      const { n2, n3 } = buildRun();
      const c = pinTrajectory(n3, 'tail-only', {}, { from: n2 });
      expect(c.steps).toHaveLength(2);
      expect(c.steps[0].nodeId).toBe(n2);
    });

    test('re-pinning the same name updates in place', () => {
      const { n3 } = buildRun();
      const a = pinTrajectory(n3, 'x');
      const b = pinTrajectory(n3, 'x');
      expect(a.id).toBe(b.id);
      expect(listTrajectories()).toHaveLength(1);
    });

    test('get resolves by name or id; remove deletes', () => {
      const { n3 } = buildRun();
      const c = pinTrajectory(n3, 'named');
      expect(getTrajectory('named').id).toBe(c.id);
      expect(getTrajectory(c.id).name).toBe('named');
      expect(removeTrajectory('named')).toBe(true);
      expect(getTrajectory('named')).toBeNull();
    });

    test('rejects an unknown leaf, a missing name, and a non-descendant --from', () => {
      const { n1, n3 } = buildRun();
      expect(() => pinTrajectory('deadbeef', 'x')).toThrow(/not found/);
      expect(() => pinTrajectory(n3, '')).toThrow(/name/);
      const other = saveNode(null, { model: 'gpt-x', messages: [] }, says('unrelated'), meta);
      expect(() => pinTrajectory(n3, 'x', {}, { from: other })).toThrow(/not a descendant/);
      expect(n1).toBeTruthy();
    });
  });

  describe('evaluateSequence', () => {
    const caseObj = {
      steps: [{ actions: ['search'] }, { actions: ['write_file'] }],
      assertions: { sequence: 'exact', notCalled: [], before: [] },
    };

    test('exact passes on an identical completed path', () => {
      const { checks } = evaluateSequence(caseObj, ['search', 'write_file'], true);
      expect(checks.find((c) => c.type === 'sequenceExact').ok).toBe(true);
    });

    test('exact fails on a truncated run even if the prefix matched', () => {
      const { checks } = evaluateSequence(caseObj, ['search'], false);
      expect(checks.find((c) => c.type === 'sequenceExact').ok).toBe(false);
    });

    test('subsequence tolerates an extra action in the middle', () => {
      const c = { ...caseObj, assertions: { ...caseObj.assertions, sequence: 'subsequence' } };
      const { checks } = evaluateSequence(c, ['search', 'read_file', 'write_file'], true);
      expect(checks.find((x) => x.type === 'sequenceSubsequence').ok).toBe(true);
    });

    test('notCalled fails when a forbidden action appears anywhere', () => {
      const c = { ...caseObj, assertions: { ...caseObj.assertions, sequence: null, notCalled: ['rm_rf'] } };
      expect(evaluateSequence(c, ['search', 'rm_rf'], true).checks.find((x) => x.type === 'neverCalled').ok).toBe(false);
      expect(evaluateSequence(c, ['search'], true).checks.find((x) => x.type === 'neverCalled').ok).toBe(true);
    });

    test('ordering fails when the agent writes before it searches', () => {
      const c = {
        ...caseObj,
        assertions: { ...caseObj.assertions, sequence: null, before: [['search', 'write_file']] },
      };
      expect(evaluateSequence(c, ['write_file', 'search'], true).checks[0].ok).toBe(false);
      expect(evaluateSequence(c, ['search', 'write_file'], true).checks[0].ok).toBe(true);
    });

    test('ordering is vacuously true when the later action never happens', () => {
      const c = {
        ...caseObj,
        assertions: { ...caseObj.assertions, sequence: null, before: [['search', 'write_file']] },
      };
      expect(evaluateSequence(c, ['search'], true).checks[0].ok).toBe(true);
    });
  });

  describe('runTrajectory', () => {
    /** Fake transport returning the queued responses in order. */
    function transport(responses) {
      const calls = [];
      const fn = async (body) => {
        calls.push(body);
        const r = responses[calls.length - 1];
        if (!r) throw new Error('transport ran out of responses');
        return { status: 200, data: r };
      };
      fn.calls = calls;
      return fn;
    }

    test('an identical replay passes and runs every step', async () => {
      const { n3 } = buildRun();
      const c = pinTrajectory(n3, 'run');
      const fwd = transport([acts(['search']), acts(['write_file']), says('Fixed it.')]);
      const r = await runTrajectory(c, { forwardFn: fwd });
      expect(r.passed).toBe(true);
      expect(r.completed).toBe(true);
      expect(r.stepsRun).toBe(3);
      expect(r.actual).toEqual(['search', 'write_file']);
    });

    test('reworded final text still passes — only actions are constrained', async () => {
      const { n3 } = buildRun();
      const c = pinTrajectory(n3, 'run');
      const fwd = transport([acts(['search']), acts(['write_file']), says('All sorted, boss.')]);
      const r = await runTrajectory(c, { forwardFn: fwd });
      expect(r.passed).toBe(true);
    });

    test('STOPS at the first divergence instead of replaying fiction', async () => {
      const { n3 } = buildRun();
      const c = pinTrajectory(n3, 'run');
      // Step 2 writes without the recorded search result being what it asked for.
      const fwd = transport([acts(['search']), acts(['delete_file']), says('Done.')]);
      const r = await runTrajectory(c, { forwardFn: fwd });

      expect(r.passed).toBe(false);
      expect(r.completed).toBe(false);
      expect(r.divergedAt).toBe(1);
      expect(r.stepsRun).toBe(2);
      expect(fwd.calls).toHaveLength(2); // the third step was never requested
      const d = r.checks.find((x) => x.type === 'divergence');
      expect(d.detail).toMatch(/step 2\/3/);
      expect(d.detail).toMatch(/delete_file/);
    });

    test('divergence is reported when the agent takes NO action where it used to', async () => {
      const { n3 } = buildRun();
      const c = pinTrajectory(n3, 'run');
      const fwd = transport([says('I think we are fine actually.')]);
      const r = await runTrajectory(c, { forwardFn: fwd });
      expect(r.divergedAt).toBe(0);
      expect(r.checks.find((x) => x.type === 'divergence').detail).toMatch(/no action/);
    });

    test('a forbidden action fails the run even when the path otherwise matches', async () => {
      const { n3 } = buildRun();
      const c = pinTrajectory(n3, 'run', { sequence: null, notCalled: ['write_file'] });
      const fwd = transport([acts(['search']), acts(['write_file']), says('Fixed it.')]);
      const r = await runTrajectory(c, { forwardFn: fwd });
      expect(r.passed).toBe(false);
      expect(r.checks.find((x) => x.type === 'neverCalled').ok).toBe(false);
    });

    test('threads the regenerated reply and the ORIGINAL recorded tail forward', async () => {
      const { n3 } = buildRun();
      const c = pinTrajectory(n3, 'run');
      const fwd = transport([acts(['search']), acts(['write_file']), says('Fixed it.')]);
      await runTrajectory(c, { forwardFn: fwd });

      const second = fwd.calls[1].messages;
      // user, regenerated assistant, then the recorded tool result verbatim.
      expect(second).toHaveLength(3);
      expect(second[2]).toEqual({ role: 'tool', content: 'found it' });
    });

    test('an upstream error stops the run and names the step', async () => {
      const { n3 } = buildRun();
      const c = pinTrajectory(n3, 'run');
      const fwd = async () => ({ status: 500, data: {} });
      const r = await runTrajectory(c, { forwardFn: fwd });
      expect(r.passed).toBe(false);
      expect(r.error).toMatch(/step 1: upstream HTTP 500/);
    });

    test('a case with no upstream and no transport fails loudly', async () => {
      const { n3 } = buildRun();
      const c = pinTrajectory(n3, 'run');
      const r = await runTrajectory({ ...c, upstream: null });
      expect(r.passed).toBe(false);
      expect(r.error).toMatch(/no upstream/);
    });
  });
});
