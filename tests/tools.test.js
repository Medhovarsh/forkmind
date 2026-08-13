const { toolCalls, matchesSubset } = require('../src/lib/extract');
const { evaluate, normalizeTools } = require('../src/regression/engine');

// OpenAI puts arguments in a JSON *string*; Anthropic uses a structured block.
const openaiCall = (name, args) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } },
        ],
      },
    },
  ],
});

const openaiCalls = (pairs) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: pairs.map(([name, args], i) => ({
          id: `c${i}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        })),
      },
    },
  ],
});

const anthropicCall = (name, input) => ({
  content: [{ type: 'tool_use', id: 'tu1', name, input }],
});

describe('tool-call extraction', () => {
  test('normalizes an OpenAI function call, parsing the argument string', () => {
    expect(toolCalls(openaiCall('create_ticket', { priority: 'high', team: 'ops' }))).toEqual([
      { name: 'create_ticket', args: { priority: 'high', team: 'ops' } },
    ]);
  });

  test('normalizes an Anthropic tool_use block to the same shape', () => {
    expect(toolCalls(anthropicCall('create_ticket', { priority: 'high' }))).toEqual([
      { name: 'create_ticket', args: { priority: 'high' } },
    ]);
  });

  test('malformed argument JSON is surfaced, not swallowed', () => {
    const broken = {
      choices: [
        {
          message: {
            tool_calls: [{ function: { name: 'send_email', arguments: '{"to": "a@b.c"' } }],
          },
        },
      ],
    };
    const [call] = toolCalls(broken);
    expect(call.name).toBe('send_email');
    expect(call.args._raw).toBe('{"to": "a@b.c"');
  });

  test('a text-only response has no tool calls', () => {
    expect(toolCalls({ choices: [{ message: { content: 'hello' } }] })).toEqual([]);
    expect(toolCalls(null)).toEqual([]);
  });
});

describe('matchesSubset', () => {
  test('expected keys must match; extra actual keys are allowed', () => {
    expect(matchesSubset({ a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(matchesSubset({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  test('compares nested objects', () => {
    expect(matchesSubset({ x: { y: 'z' } }, { x: { y: 'z', w: 1 } })).toBe(true);
    expect(matchesSubset({ x: { y: 'z' } }, { x: { y: 'q' } })).toBe(false);
  });

  test('arrays must match element for element', () => {
    expect(matchesSubset({ ids: [1, 2] }, { ids: [1, 2] })).toBe(true);
    expect(matchesSubset({ ids: [1, 2] }, { ids: [1, 2, 3] })).toBe(false);
  });
});

describe('normalizeTools', () => {
  test('returns null when nothing about tools was asserted', () => {
    expect(normalizeTools(null)).toBeNull();
    expect(normalizeTools({ called: [], notCalled: [], exact: false })).toBeNull();
  });

  test('accepts a bare array of names', () => {
    expect(normalizeTools(['a', 'b']).called).toEqual([
      { name: 'a', args: null },
      { name: 'b', args: null },
    ]);
  });

  test('keeps exact even with no named tools (asserts "no tools at all")', () => {
    expect(normalizeTools({ exact: true })).toEqual({ called: [], notCalled: [], exact: true });
  });
});

describe('tool assertions in evaluate()', () => {
  function caseWith(tools, baselineText = 'ok') {
    return {
      baseline: { text: baselineText },
      assertions: {
        contains: [],
        notContains: [],
        regex: [],
        minSimilarity: 0,
        tools: normalizeTools(tools),
      },
    };
  }

  test('passes when the required tool was called', () => {
    const r = evaluate(caseWith(['create_ticket']), openaiCall('create_ticket', {}));
    expect(r.passed).toBe(true);
  });

  test('fails when the required tool was not called', () => {
    const r = evaluate(caseWith(['create_ticket']), openaiCall('search_docs', {}));
    expect(r.passed).toBe(false);
    expect(r.checks.find((c) => c.type === 'toolCalled').ok).toBe(false);
  });

  test('fails when the tool is called with the wrong arguments', () => {
    const c = caseWith({ called: [{ name: 'refund', args: { amount: 50 } }] });
    const r = evaluate(c, openaiCall('refund', { amount: 5000, currency: 'usd' }));
    expect(r.passed).toBe(false);
    // The report names what it actually got, so the failure is diagnosable.
    expect(r.checks.find((c2) => c2.type === 'toolCalled').detail).toMatch(/5000/);
  });

  test('argument matching is a subset, so extra fields are fine', () => {
    const c = caseWith({ called: [{ name: 'refund', args: { amount: 50 } }] });
    const r = evaluate(c, openaiCall('refund', { amount: 50, currency: 'usd', note: 'x' }));
    expect(r.passed).toBe(true);
  });

  test('matches the right call when the same tool is invoked twice', () => {
    const c = caseWith({ called: [{ name: 'refund', args: { amount: 50 } }] });
    const r = evaluate(c, openaiCalls([['refund', { amount: 10 }], ['refund', { amount: 50 }]]));
    expect(r.passed).toBe(true);
  });

  test('notCalled catches a destructive action the agent should never take', () => {
    const c = caseWith({ notCalled: ['delete_account'] });
    const r = evaluate(c, openaiCall('delete_account', { id: 7 }));
    expect(r.passed).toBe(false);
    expect(r.checks.find((c2) => c2.type === 'toolNotCalled').ok).toBe(false);
  });

  test('exact fails on an EXTRA call even when the expected one is present', () => {
    const c = caseWith({ called: ['create_ticket'], exact: true });
    const r = evaluate(c, openaiCalls([['create_ticket', {}], ['send_email', {}]]));
    expect(r.passed).toBe(false);
    expect(r.checks.find((c2) => c2.type === 'toolsExact').detail).toMatch(/send_email/);
  });

  test('exact with no expected tools asserts the agent acted on nothing', () => {
    const c = caseWith({ exact: true });
    expect(evaluate(c, { choices: [{ message: { content: 'just an answer' } }] }).passed).toBe(true);
    expect(evaluate(c, openaiCall('charge_card', {})).passed).toBe(false);
  });

  test('works identically on Anthropic-shaped responses', () => {
    const c = caseWith({ called: [{ name: 'create_ticket', args: { priority: 'high' } }] });
    expect(evaluate(c, anthropicCall('create_ticket', { priority: 'high' })).passed).toBe(true);
    expect(evaluate(c, anthropicCall('create_ticket', { priority: 'low' })).passed).toBe(false);
  });

  test('text can be word-identical while the action is wrong', () => {
    // The whole point: identical prose, but the agent charged the wrong card.
    const c = {
      baseline: { text: 'Done — I processed that for you.' },
      assertions: {
        contains: ['processed'],
        notContains: [],
        regex: [],
        minSimilarity: 0.9,
        tools: normalizeTools({ called: [{ name: 'charge', args: { account: 'A' } }] }),
      },
    };
    const response = {
      choices: [
        {
          message: {
            content: 'Done — I processed that for you.',
            tool_calls: [
              { function: { name: 'charge', arguments: JSON.stringify({ account: 'B' }) } },
            ],
          },
        },
      ],
    };
    const r = evaluate(c, response);
    expect(r.similarity).toBe(1); // every text check is happy
    expect(r.checks.find((x) => x.type === 'contains').ok).toBe(true);
    expect(r.passed).toBe(false); // only the tool check catches it
  });

  test('cases with no tool assertions still report the calls they saw', () => {
    const c = caseWith(null);
    const r = evaluate(c, openaiCall('search_docs', { q: 'x' }));
    expect(r.passed).toBe(true);
    expect(r.toolCalls).toEqual([{ name: 'search_docs', args: { q: 'x' } }]);
  });
});
