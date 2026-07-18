const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const request = require('supertest');
const { createServer } = require('../src/proxy/server');
const { initStorage, readNode, getLineage, readAllNodes } = require('../src/storage/engine');
const { seed } = require('../src/demo/seed');
const capsules = require('../src/context/engine');

describe('demo seeder', () => {
  let tmp;
  let originalCwd;
  let seeded;

  beforeAll(() => {
    originalCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-demo-test-'));
    process.chdir(tmp);
    initStorage();
    seeded = seed();
  });

  afterAll(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
  });

  test('seeds the expected number of nodes', () => {
    expect(readAllNodes()).toHaveLength(seeded.nodes);
  });

  test('registers the root in the manifest', () => {
    const manifest = fs.readJsonSync(path.join(tmp, '.forkmind', 'manifest.json'));
    expect(manifest.roots).toContain(seeded.rootId);
  });

  test('fork point has exactly two children (wrong branch + winning branch)', () => {
    const forkPoint = readNode(seeded.forkPointId);
    expect(forkPoint.children).toHaveLength(2);
  });

  test('lineage walks from root to the winning leaf', () => {
    const lineage = getLineage(seeded.winningLeafId);
    expect(lineage[0].id).toBe(seeded.rootId);
    expect(lineage[lineage.length - 1].id).toBe(seeded.winningLeafId);
    expect(lineage.length).toBeGreaterThanOrEqual(4);
  });

  test('wrong-branch leaf sits under the same fork point', () => {
    const lineage = getLineage(seeded.wrongLeafId);
    expect(lineage.map((n) => n.id)).toContain(seeded.forkPointId);
  });

  test('every node has capture-schema meta and OpenAI-shaped response', () => {
    for (const n of readAllNodes()) {
      expect(n.meta).toMatchObject({ provider: 'openai', stream: false, status: 200 });
      expect(n.response.choices[0].message.role).toBe('assistant');
      expect(n.response.usage.total_tokens).toBeGreaterThan(0);
    }
  });

  test('uses more than one upstream/model for provenance variety', () => {
    const nodes = readAllNodes();
    expect(new Set(nodes.map((n) => n.meta.upstream)).size).toBeGreaterThan(1);
    expect(new Set(nodes.map((n) => n.request.model)).size).toBeGreaterThan(1);
  });

  test('archives the winning branch as a readable capsule', () => {
    const cap = capsules.readCapsule(seeded.capsuleId);
    expect(cap.title).toMatch(/auth bug fix/i);
    expect(cap.items.length).toBeGreaterThan(0);
  });

  test('re-seeding into a fresh dir yields identical node ids (deterministic)', () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-demo-test2-'));
    const before = process.cwd();
    try {
      process.chdir(tmp2);
      initStorage();
      const second = seed();
      expect(second.rootId).toBe(seeded.rootId);
      expect(second.forkPointId).toBe(seeded.forkPointId);
    } finally {
      process.chdir(before);
      fs.removeSync(tmp2);
    }
  });
});

describe('GET /api/demo-status', () => {
  let tmp;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-demostatus-'));
    process.chdir(tmp);
    delete process.env.FORKMIND_DEMO;
    delete process.env.FORKMIND_DEMO_LIVE;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
    delete process.env.FORKMIND_DEMO;
    delete process.env.FORKMIND_DEMO_LIVE;
  });

  test('outside demo mode: demo false, forking on', async () => {
    const res = await request(createServer()).get('/api/demo-status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ demo: false, liveForking: true });
  });

  test('demo mode without Ollama: forking off', async () => {
    process.env.FORKMIND_DEMO = '1';
    process.env.FORKMIND_DEMO_LIVE = '0';
    const res = await request(createServer()).get('/api/demo-status');
    expect(res.body).toEqual({ demo: true, liveForking: false });
  });

  test('demo mode with Ollama: forking on', async () => {
    process.env.FORKMIND_DEMO = '1';
    process.env.FORKMIND_DEMO_LIVE = '1';
    const res = await request(createServer()).get('/api/demo-status');
    expect(res.body).toEqual({ demo: true, liveForking: true });
  });
});
