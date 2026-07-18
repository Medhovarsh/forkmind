const { saveNode } = require('../storage/engine');
const capsules = require('../context/engine');

// Sample story: a coding agent hunts down an auth bug. The lineage forks at the
// diagnosis node — one branch applies a plausible-but-wrong patch, the other
// (re-prompted to check units) finds the real cause. Nodes are built through
// the real saveNode() so ids stay content-addressed and the data can never
// drift from the live capture schema.

const OLLAMA = 'http://localhost:11434';
const OPENAI = 'https://api.openai.com';

const SYSTEM = {
  role: 'system',
  content:
    'You are a coding agent. Use the tools to read files, edit code, and run tests. ' +
    'Confirm every fix by running the test suite.',
};

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the repository',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Overwrite a file with new content',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_tests',
      description: 'Run the project test suite',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const LOGIN_JS = `const { verify } = require('./jwt');

async function login(req, res) {
  const payload = verify(req.headers.authorization);
  // Reject expired tokens.
  if (payload.exp < Date.now()) {
    return res.status(401).json({ error: 'token expired' });
  }
  const user = await db.users.find(payload.sub);
  return res.json({ user });
}

module.exports = { login };`;

const FAIL_OUTPUT = `FAIL  tests/auth/login.test.js
  ✕ accepts a fresh token (12 ms)
  ✕ returns the user for a valid session (9 ms)
  ✕ keeps a session alive across requests (11 ms)
  ✓ 9 other tests passed

Tests: 3 failed, 9 passed, 12 total
  expected 200 "OK", got 401 "Unauthorized"`;

const PASS_OUTPUT = `PASS  tests/auth/login.test.js
  ✓ accepts a fresh token (11 ms)
  ✓ returns the user for a valid session (8 ms)
  ✓ keeps a session alive across requests (10 ms)
  ✓ 9 other tests passed

Tests: 12 passed, 12 total`;

// --- small builders keep the turn definitions below readable ---

let callSeq = 0;
function toolCall(name, args) {
  callSeq += 1;
  return {
    id: `call_demo_${callSeq}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function assistantMsg({ content = null, tool_calls } = {}) {
  const m = { role: 'assistant', content };
  if (tool_calls) m.tool_calls = tool_calls;
  return m;
}

function toolMsg(toolCallId, content) {
  return { role: 'tool', tool_call_id: toolCallId, content };
}

let respSeq = 0;
function response(model, message, promptTokens, completionTokens) {
  respSeq += 1;
  return {
    id: `chatcmpl-demo-${respSeq}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function meta(upstream) {
  return { provider: 'openai', upstream, stream: false, status: 200 };
}

/**
 * Seed the demo DAG (10 nodes, one fork, one capsule) into the CURRENT
 * working directory's .forkmind/. Callers are expected to chdir first.
 * @returns {{ nodes: number, rootId: string, forkPointId: string,
 *             wrongLeafId: string, winningLeafId: string, capsuleId: string }}
 */
function seed() {
  callSeq = 0;
  respSeq = 0;

  const model = 'llama3.1';
  const messages = [
    SYSTEM,
    {
      role: 'user',
      content:
        'Login returns 401 for valid users since yesterday’s deploy. ' +
        'Find and fix the bug in src/auth/login.js.',
    },
  ];

  // n1 — agent asks to read the file.
  const read = toolCall('read_file', { path: 'src/auth/login.js' });
  const n1Res = response(model, assistantMsg({ tool_calls: [read] }), 412, 26);
  const n1 = saveNode(null, { model, messages: [...messages], tools: TOOLS }, n1Res, meta(OLLAMA));
  messages.push(n1Res.choices[0].message, toolMsg(read.id, LOGIN_JS));

  // n2 — agent inspects the code, wants test confirmation.
  const test1 = toolCall('run_tests', {});
  const n2Res = response(
    model,
    assistantMsg({
      content:
        'The expiry check compares `payload.exp` against `Date.now()`. Something is off with ' +
        'that comparison — let me run the tests to see the failure mode first.',
      tool_calls: [test1],
    }),
    758,
    54
  );
  const n2 = saveNode(n1, { model, messages: [...messages], tools: TOOLS }, n2Res, meta(OLLAMA));
  messages.push(n2Res.choices[0].message, toolMsg(test1.id, FAIL_OUTPUT));

  // n3 — diagnosis (slightly off). THE FORK POINT.
  const n3Res = response(
    model,
    assistantMsg({
      content:
        'Three session tests fail with 401 on fresh tokens, so valid tokens are being treated ' +
        'as expired. `payload.exp` must not be comparable to `Date.now()` as-is — ' +
        'I’ll cast it to a Date before comparing.',
    }),
    1021,
    68
  );
  const n3 = saveNode(n2, { model, messages: [...messages], tools: TOOLS }, n3Res, meta(OLLAMA));
  const forkBase = [...messages, n3Res.choices[0].message];

  // --- Branch A: plausible-but-wrong patch, tests still fail ---

  const msgsA = [...forkBase, { role: 'user', content: 'Apply the fix.' }];
  const writeA = toolCall('write_file', {
    path: 'src/auth/login.js',
    content: LOGIN_JS.replace(
      'if (payload.exp < Date.now()) {',
      'if (new Date(payload.exp) < new Date()) {'
    ),
  });
  const n4aRes = response(model, assistantMsg({ tool_calls: [writeA] }), 1104, 142);
  const n4a = saveNode(n3, { model, messages: [...msgsA], tools: TOOLS }, n4aRes, meta(OLLAMA));
  msgsA.push(n4aRes.choices[0].message, toolMsg(writeA.id, 'File written.'));

  const testA = toolCall('run_tests', {});
  const n5aRes = response(model, assistantMsg({ tool_calls: [testA] }), 1287, 22)
  const n5a = saveNode(n4a, { model, messages: [...msgsA], tools: TOOLS }, n5aRes, meta(OLLAMA));
  msgsA.push(n5aRes.choices[0].message, toolMsg(testA.id, FAIL_OUTPUT));

  const n6aRes = response(
    model,
    assistantMsg({
      content:
        'The same three tests still fail. Casting to a Date didn’t change the outcome — ' +
        'the comparison itself may not be the problem. I’m not sure where to look next.',
    }),
    1352,
    52
  );
  const n6a = saveNode(n5a, { model, messages: [...msgsA], tools: TOOLS }, n6aRes, meta(OLLAMA));

  // --- Branch B: the re-prompted fork (edited prompt, stronger model) ---

  const modelB = 'gpt-4o-mini';
  const msgsB = [
    ...forkBase,
    {
      role: 'user',
      content:
        'Before patching: think step by step about the UNITS of payload.exp versus Date.now(). ' +
        'JWT exp is defined in seconds since the epoch.',
    },
  ];
  const writeB = toolCall('write_file', {
    path: 'src/auth/login.js',
    content: LOGIN_JS.replace('if (payload.exp < Date.now()) {', 'if (payload.exp * 1000 < Date.now()) {'),
  });
  const n4bRes = response(
    modelB,
    assistantMsg({
      content:
        'Unit mismatch. JWT `exp` is SECONDS since the epoch; `Date.now()` returns MILLISECONDS. ' +
        'Every token looks expired because 1.7 billion < 1.7 trillion. ' +
        'Fix: compare `payload.exp * 1000 < Date.now()`.',
      tool_calls: [writeB],
    }),
    1163,
    196
  );
  const n4b = saveNode(n3, { model: modelB, messages: [...msgsB], tools: TOOLS }, n4bRes, meta(OPENAI));
  msgsB.push(n4bRes.choices[0].message, toolMsg(writeB.id, 'File written.'));

  const testB = toolCall('run_tests', {});
  const n5bRes = response(modelB, assistantMsg({ tool_calls: [testB] }), 1394, 20);
  const n5b = saveNode(n4b, { model: modelB, messages: [...msgsB], tools: TOOLS }, n5bRes, meta(OPENAI));
  msgsB.push(n5bRes.choices[0].message, toolMsg(testB.id, PASS_OUTPUT));

  const n6bRes = response(
    modelB,
    assistantMsg({
      content:
        'All 12 tests pass. Root cause: the deploy added an expiry check that compared JWT ' +
        '`exp` (seconds) directly against `Date.now()` (milliseconds), so every valid token ' +
        'read as expired. Fixed by normalizing to milliseconds.',
    }),
    1476,
    74
  );
  const n6b = saveNode(n5b, { model: modelB, messages: [...msgsB], tools: TOOLS }, n6bRes, meta(OPENAI));
  msgsB.push(n6bRes.choices[0].message, {
    role: 'user',
    content: 'Great — write a one-line changelog entry for the fix.',
  });

  const n7bRes = response(
    modelB,
    assistantMsg({
      content:
        'fix(auth): compare JWT exp in milliseconds — valid sessions no longer rejected as expired',
    }),
    1568,
    28
  );
  const n7b = saveNode(n6b, { model: modelB, messages: [...msgsB], tools: TOOLS }, n7bRes, meta(OPENAI));

  // Archive the winning branch as a capsule so the capsule panel has content.
  const capsule = capsules.saveFromNode(n7b, {
    title: 'Auth bug fix — winning branch',
    digest:
      'Login 401 root cause: JWT exp (seconds) compared to Date.now() (ms). ' +
      'Fixed with payload.exp * 1000. 12/12 tests pass.',
  });

  return {
    nodes: 10,
    rootId: n1,
    forkPointId: n3,
    wrongLeafId: n6a,
    winningLeafId: n7b,
    capsuleId: capsule.id,
  };
}

module.exports = { seed };
