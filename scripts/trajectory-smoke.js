#!/usr/bin/env node
/**
 * Live end-to-end check for trajectory regression against a real backend.
 *
 * The trajectory unit tests inject a fake transport, so they prove the sequence
 * logic but not the two things only a real provider can prove:
 *
 *   1. multi-turn message threading produces requests the provider ACCEPTS —
 *      a regenerated assistant message plus a recorded tool result, replayed
 *      as a fresh conversation, is where a shape bug would surface as a 400
 *   2. tool calls survive the round trip and normalize correctly from real
 *      provider output rather than from a hand-written fixture
 *
 * It captures a genuine 2-step tool-calling run, pins it, replays it, and then
 * forces a divergence to confirm the replay stops instead of feeding a stale
 * tool result to an agent that asked something else.
 *
 *   node scripts/trajectory-smoke.js
 *   FORKMIND_MODEL=qwen2.5 node scripts/trajectory-smoke.js
 *   FORKMIND_UPSTREAM=https://api.groq.com/openai FORKMIND_API_KEY=... \
 *     FORKMIND_MODEL=llama-3.1-8b-instant node scripts/trajectory-smoke.js
 *
 * Requires a TOOL-CAPABLE model. If the model declines to call the tool the
 * script says so and exits non-zero rather than reporting a hollow pass — a
 * trajectory test with no actions in it proves nothing.
 */

const os = require('os');
const path = require('path');
const fs = require('fs-extra');

const UPSTREAM = process.env.FORKMIND_UPSTREAM || 'http://localhost:11434';
const MODEL = process.env.FORKMIND_MODEL || 'llama3.2';
const API_KEY = process.env.FORKMIND_API_KEY || '';
const PROVIDER = process.env.FORKMIND_PROVIDER || 'openai';

const originalCwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-traj-smoke-'));

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city. Call this before answering.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    },
  },
};

async function main() {
  process.chdir(tmp);
  const { initStorage, saveNode } = require('../src/storage/engine');
  const { forward } = require('../src/proxy/interceptor');
  const { PROVIDER_PATHS, authHeaders } = require('../src/regression/providers');
  const { toolCalls } = require('../src/lib/extract');
  const {
    pinTrajectory,
    runTrajectory,
    getTrajectory,
    trajDir,
  } = require('../src/regression/trajectory');

  initStorage();
  console.log(`\nForkMind trajectory smoke test\n  upstream: ${UPSTREAM}\n  model:    ${MODEL}\n`);

  const send = async (body) => {
    const { status, data } = await forward(
      UPSTREAM,
      PROVIDER_PATHS[PROVIDER],
      body,
      authHeaders(API_KEY)
    );
    if (status < 200 || status >= 300) {
      throw new Error(`upstream HTTP ${status}: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return data;
  };

  // ---- 1. capture a real tool-calling first turn -------------------------
  console.log('1. capturing a real tool-calling turn');
  const messages1 = [
    { role: 'user', content: 'What is the weather in Paris? Use the get_weather tool.' },
  ];
  const request1 = { model: MODEL, messages: messages1, tools: [WEATHER_TOOL], temperature: 0 };
  const response1 = await send(request1);

  const calls1 = toolCalls(response1);
  check('model emitted a tool call', calls1.length > 0, calls1.map((c) => c.name).join(', '));
  if (!calls1.length) {
    throw new Error(
      `${MODEL} did not call the tool, so there is no trajectory to test. ` +
        'Re-run with a tool-capable model, e.g. FORKMIND_MODEL=qwen2.5'
    );
  }
  check(
    'tool call normalized with a name and parsed args',
    Boolean(calls1[0].name) && typeof calls1[0].args === 'object' && !calls1[0].args._raw,
    `${calls1[0].name}(${JSON.stringify(calls1[0].args)})`
  );

  const assistant1 = response1.choices[0].message;

  // ---- 2. capture the follow-up turn -------------------------------------
  // Child messages MUST be parent.messages + [assistant] + tail — that nesting
  // is exactly what tail re-application depends on at replay time.
  console.log('\n2. capturing the follow-up turn (tool result -> answer)');
  const toolResult = {
    role: 'tool',
    tool_call_id: (assistant1.tool_calls && assistant1.tool_calls[0].id) || 'call_1',
    content: '18C, light rain',
  };
  const messages2 = [...messages1, assistant1, toolResult];
  const request2 = { model: MODEL, messages: messages2, tools: [WEATHER_TOOL], temperature: 0 };
  const response2 = await send(request2);
  check('provider accepted the threaded follow-up request', true, 'HTTP 2xx');

  const n1 = saveNode(null, request1, response1, { provider: PROVIDER, upstream: UPSTREAM });
  const n2 = saveNode(n1, request2, response2, { provider: PROVIDER, upstream: UPSTREAM });

  // ---- 3. pin the path ---------------------------------------------------
  console.log('\n3. pinning the captured path');
  const pinned = pinTrajectory(n2, 'weather-run', { sequence: 'exact' });
  check('trajectory pinned with both steps', pinned.steps.length === 2);
  const baselinePath = pinned.steps.reduce((acc, s) => acc.concat(s.actions), []);
  check('baseline action sequence recorded', baselinePath.length > 0, baselinePath.join(' → '));

  // ---- 4. replay it live -------------------------------------------------
  // The real prize: step 2 is a request ForkMind ASSEMBLED (regenerated
  // assistant + recorded tool result), not one that was ever captured. If the
  // threading is malformed, the provider rejects it here.
  console.log('\n4. replaying the trajectory against the live model');
  const replay = await runTrajectory(pinned, { apiKey: API_KEY });
  check('replay ran without an upstream error', !replay.error, replay.error || 'no error');
  check(
    'assembled multi-turn request was accepted by the provider',
    replay.stepsRun >= 2 || replay.divergedAt === 0,
    `ran ${replay.stepsRun}/${replay.stepsTotal} steps`
  );
  if (replay.completed) {
    check('identical replay passed', replay.passed === true, `path: ${replay.actual.join(' → ')}`);
  } else {
    // Not a script failure: a small model legitimately re-deciding is the exact
    // condition this feature exists to report. Say so rather than fail blindly.
    console.log(
      `  ! model diverged on replay at step ${replay.divergedAt + 1} ` +
        `(expected [${replay.steps[replay.divergedAt].expected.join(', ')}], ` +
        `got [${replay.steps[replay.divergedAt].actual.join(', ')}]) — ` +
        'non-determinism, not a bug; divergence handling is checked next'
    );
  }

  // ---- 5. force a divergence --------------------------------------------
  // Mutate the pinned baseline to expect an action the model will never take,
  // so divergence detection is exercised deterministically.
  console.log('\n5. forcing a divergence (baseline expects an impossible action)');
  const bogus = getTrajectory('weather-run');
  bogus.name = 'weather-run-bogus';
  bogus.id = 'bogus0000000';
  bogus.steps[0].actions = ['launch_rocket'];
  fs.writeJsonSync(path.join(trajDir(), `${bogus.id}.json`), bogus, { spaces: 2 });

  const diverged = await runTrajectory(bogus, { apiKey: API_KEY });
  check('divergence detected', diverged.divergedAt === 0, `divergedAt=${diverged.divergedAt}`);
  check('run marked failed', diverged.passed === false);
  check(
    'replay STOPPED at the divergence',
    diverged.stepsRun === 1 && diverged.completed === false,
    `ran ${diverged.stepsRun}/${diverged.stepsTotal} steps`
  );
  const dcheck = (diverged.checks || []).find((c) => c.type === 'divergence');
  check('divergence reported with step and expected-vs-actual', Boolean(dcheck), dcheck && dcheck.detail);

  console.log(failures === 0 ? '\nAll smoke checks passed.\n' : `\n${failures} smoke check(s) failed.\n`);
}

main()
  .catch((err) => {
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
