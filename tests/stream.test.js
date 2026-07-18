const os = require('os');
const path = require('path');
const http = require('http');
const fs = require('fs-extra');
const { bus } = require('../src/events');
const { createServer } = require('../src/proxy/server');
const { initStorage, saveNode } = require('../src/storage/engine');

describe('event bus', () => {
  let tmp;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-bus-'));
    process.chdir(tmp);
    initStorage();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
    bus.removeAllListeners('node');
  });

  test('saveNode emits a node event carrying the saved node', () => {
    const seen = [];
    bus.on('node', (n) => seen.push(n));
    const id = saveNode(null, { model: 'llama3.1', messages: [] }, { ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe(id);
    expect(seen[0].request.model).toBe('llama3.1');
  });

  test('saveNode with no listeners does not throw', () => {
    expect(() => saveNode(null, { model: 'x', messages: [] }, {})).not.toThrow();
  });
});

describe('GET /api/stream (SSE)', () => {
  let server;
  let base;
  let tmp;
  let originalCwd;

  beforeEach((done) => {
    originalCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-sse-'));
    process.chdir(tmp);
    initStorage();
    server = createServer().listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterEach((done) => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
    bus.removeAllListeners('node');
    server.close(done);
  });

  test('sets the event-stream content type and pushes a node frame', (done) => {
    let savedId;
    const req = http.get(`${base}/api/stream`, (res) => {
      expect(res.headers['content-type']).toMatch(/text\/event-stream/);

      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const line = buf.split('\n').find((l) => l.startsWith('data:'));
        if (!line) return;
        const node = JSON.parse(line.slice(5).trim());
        expect(node.id).toBe(savedId);
        req.destroy();
        done();
      });

      // Register-then-save: give the handler a tick to attach its bus listener.
      setTimeout(() => {
        savedId = saveNode(null, { model: 'llama3.1', messages: [] }, { ok: true });
      }, 60);
    });
    req.on('error', () => {}); // destroy() surfaces as ECONNRESET; ignore
  });
});
