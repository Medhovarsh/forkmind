const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const request = require('supertest');
const { createServer } = require('../src/proxy/server');
const { saveNode } = require('../src/storage/engine');

// These tests exercise the dashboard data API only — no network/forwarding,
// so CI stays hermetic. Forwarding logic is covered by unit tests on
// reconstruct + interceptor.
describe('proxy data API', () => {
  let app;
  let tmp;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-srv-'));
    process.chdir(tmp);
    app = createServer();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
  });

  test('GET /health reports ok and registered providers', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.providers).toEqual(expect.arrayContaining(['openai', 'anthropic']));
  });

  test('GET /api/graph returns saved nodes', async () => {
    const id = saveNode(null, { model: 'llama3', messages: [] }, { ok: true });
    const res = await request(app).get('/api/graph');
    expect(res.status).toBe(200);
    expect(res.body.nodes).toHaveLength(1);
    expect(res.body.nodes[0].id).toBe(id);
  });

  test('GET /api/node/:id returns one node, 404 when missing', async () => {
    const id = saveNode(null, { model: 'llama3', messages: [] }, { ok: true });
    const hit = await request(app).get(`/api/node/${id}`);
    expect(hit.status).toBe(200);
    expect(hit.body.id).toBe(id);

    const miss = await request(app).get('/api/node/deadbeef0000');
    expect(miss.status).toBe(404);
  });
});
