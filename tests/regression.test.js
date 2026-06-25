const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { saveNode } = require('../src/storage/engine');
const {
  pinNode,
  listCases,
  getCase,
  removeCase,
  evaluate,
  similarity,
} = require('../src/regression/engine');

describe('regression engine', () => {
  let tmp;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-reg-'));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
  });

  const reply = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });
  const req = { model: 'llama3', messages: [{ role: 'user', content: 'fact about octopuses' }] };

  describe('similarity', () => {
    test('identical text scores 1', () => {
      expect(similarity('the cat sat', 'the cat sat')).toBe(1);
    });
    test('disjoint text scores 0', () => {
      expect(similarity('cat dog', 'fish bird')).toBe(0);
    });
    test('partial overlap is between 0 and 1', () => {
      const s = similarity('octopus has three hearts', 'octopus has nine brains');
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(1);
    });
  });

  describe('pin / list / get / remove', () => {
    test('pinNode stores a case derived from a node', () => {
      const nodeId = saveNode(null, req, reply('Octopuses have three hearts.'), {
        provider: 'openai',
        upstream: 'http://localhost:11434',
      });
      const c = pinNode(nodeId, 'octopus-hearts', { contains: ['hearts'] });
      expect(c.name).toBe('octopus-hearts');
      expect(c.baseline.text).toContain('three hearts');
      expect(c.request.stream).toBe(false);
      expect(c.assertions.minSimilarity).toBe(0.3); // default guard
      expect(listCases()).toHaveLength(1);
    });

    test('re-pinning the same name updates in place (stable id)', () => {
      const nodeId = saveNode(null, req, reply('v1'), {});
      const a = pinNode(nodeId, 'case-x');
      const b = pinNode(nodeId, 'case-x');
      expect(a.id).toBe(b.id);
      expect(listCases()).toHaveLength(1);
    });

    test('getCase resolves by name or id; removeCase deletes', () => {
      const nodeId = saveNode(null, req, reply('hello'), {});
      const c = pinNode(nodeId, 'greet');
      expect(getCase('greet').id).toBe(c.id);
      expect(getCase(c.id).name).toBe('greet');
      expect(removeCase('greet')).toBe(true);
      expect(getCase('greet')).toBeNull();
    });

    test('pinNode throws on missing node or missing name', () => {
      expect(() => pinNode('deadbeef0000', 'x')).toThrow(/not found/);
      const nodeId = saveNode(null, req, reply('y'), {});
      expect(() => pinNode(nodeId, '')).toThrow(/name/);
    });
  });

  describe('evaluate', () => {
    function caseWith(assertions, baselineText = 'Octopuses have three hearts and blue blood.') {
      return {
        baseline: { text: baselineText },
        assertions: {
          contains: [],
          notContains: [],
          regex: [],
          minSimilarity: 0,
          ...assertions,
        },
      };
    }

    test('passes when contains + regex + similarity all hold', () => {
      const c = caseWith({ contains: ['hearts'], regex: ['blue|red'], minSimilarity: 0.5 });
      const r = evaluate(c, reply('Octopuses have three hearts and blue blood.'));
      expect(r.passed).toBe(true);
      expect(r.similarity).toBe(1);
    });

    test('fails a missing contains substring', () => {
      const c = caseWith({ contains: ['gills'] });
      const r = evaluate(c, reply('Octopuses have three hearts.'));
      expect(r.passed).toBe(false);
      expect(r.checks.find((x) => x.type === 'contains').ok).toBe(false);
    });

    test('fails notContains when forbidden text appears', () => {
      const c = caseWith({ notContains: ['error'] });
      const r = evaluate(c, reply('error: model unavailable'));
      expect(r.passed).toBe(false);
    });

    test('flags similarity drop (degradation) below threshold', () => {
      const c = caseWith({ minSimilarity: 0.6 });
      const r = evaluate(c, reply('Completely different unrelated answer about cars.'));
      expect(r.passed).toBe(false);
      expect(r.checks.find((x) => x.type === 'minSimilarity').ok).toBe(false);
    });

    test('invalid regex is reported as a failed check, not a throw', () => {
      const c = caseWith({ regex: ['([unclosed'] });
      const r = evaluate(c, reply('anything'));
      expect(r.passed).toBe(false);
    });
  });
});
