const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const request = require('supertest');

// Stub the upstream transport: replay must never hit the network in CI.
jest.mock('../src/proxy/interceptor', () => {
  const actual = jest.requireActual('../src/proxy/interceptor');
  return { ...actual, forward: jest.fn() };
});
const { forward } = require('../src/proxy/interceptor');
const { createServer } = require('../src/proxy/server');
const { initStorage, saveNode } = require('../src/storage/engine');

const META = { provider: 'openai', upstream: 'http://localhost:11434', stream: false, status: 200 };

function resp(text) {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

describe('POST /api/replay', () => {
  let app;
  let tmp;
  let originalCwd;
  let n1;
  let n2;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-replayapi-'));
    process.chdir(tmp);
    initStorage();

    const m1 = [{ role: 'user', content: 'one' }];
    const r1 = resp('a1');
    n1 = saveNode(null, { model: 'llama3.1', messages: m1 }, r1, META);
    const m2 = [...m1, r1.choices[0].message, { role: 'user', content: 'two' }];
    n2 = saveNode(n1, { model: 'llama3.1', messages: m2 }, resp('a2'), META);

    forward.mockReset();
    forward.mockResolvedValue({ status: 200, data: resp('regen') });
    app = createServer();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
  });

  test('replays a chain and returns the new node ids', async () => {
    const res = await request(app)
      .post('/api/replay')
      .send({
        fromNodeId: n1,
        leafId: n2,
        request: { model: 'llama3.1', messages: [{ role: 'user', content: 'one EDITED' }] },
      });
    expect(res.status).toBe(200);
    expect(res.body.nodes).toHaveLength(2);
    expect(forward).toHaveBeenCalledTimes(2);
    // Replay goes to the ORIGINAL node's upstream, not the provider default.
    expect(forward.mock.calls[0][0]).toBe('http://localhost:11434');
  });

  test('400 on unknown fromNodeId and non-descendant leaf', async () => {
    const bad = await request(app)
      .post('/api/replay')
      .send({ fromNodeId: '000000000000', request: { messages: [] } });
    expect(bad.status).toBe(400);

    const notDesc = await request(app)
      .post('/api/replay')
      .send({ fromNodeId: n2, leafId: n1, request: { messages: [] } });
    expect(notDesc.status).toBe(400);
    expect(notDesc.body.error).toMatch(/not a descendant/);
  });

  test('502 with partial nodes when upstream fails mid-chain', async () => {
    forward
      .mockResolvedValueOnce({ status: 200, data: resp('ok') })
      .mockResolvedValueOnce({ status: 500, data: { error: 'boom' } });
    const res = await request(app)
      .post('/api/replay')
      .send({
        fromNodeId: n1,
        leafId: n2,
        request: { model: 'llama3.1', messages: [{ role: 'user', content: 'x' }] },
      });
    expect(res.status).toBe(502);
    expect(res.body.nodes).toHaveLength(1);
  });
});
