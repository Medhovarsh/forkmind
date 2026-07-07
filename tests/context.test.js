const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const request = require('supertest');

// Point key storage at a throwaway dir BEFORE loading the engine, so tests
// never touch the user's real ~/.forkmind-keys.
let keyTmp;
beforeAll(() => {
  keyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-keys-'));
  process.env.FORKMIND_KEY_DIR = keyTmp;
});
afterAll(() => {
  delete process.env.FORKMIND_KEY_DIR;
  fs.removeSync(keyTmp);
});

const {
  saveCapsule,
  listCapsules,
  getDigest,
  readCapsule,
  readSegments,
  verifyCapsule,
  forgetCapsule,
  capsuleStats,
  paths,
  MAX_SEGMENT_BYTES,
} = require('../src/context/engine');
const { createServer } = require('../src/proxy/server');

describe('context capsule engine', () => {
  let tmp;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-'));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
  });

  const items = [
    { role: 'user', content: 'How do I fix the OAuth refresh loop?' },
    { role: 'assistant', content: 'The refresh token is being rotated twice…' },
    { role: 'tool', content: 'GET /token → 401 invalid_grant' },
  ];

  test('save → restore roundtrip preserves content and order', () => {
    const out = saveCapsule({ title: 'auth debug', items, digest: 'oauth loop root-caused' });
    expect(out.id).toMatch(/^[0-9a-f]{12}$/);
    expect(out.segments).toBe(items.length + 1); // + root

    const cap = readCapsule(out.id);
    expect(cap.title).toBe('auth debug');
    expect(cap.items.map((i) => i.content)).toEqual(items.map((i) => i.content));
    expect(cap.items.map((i) => i.role)).toEqual(items.map((i) => i.role));
  });

  test('nothing readable as plaintext on disk; keys live outside .forkmind', () => {
    const out = saveCapsule({ title: 'secret stuff', items, digest: null });
    const dir = path.join(paths().contextsDir, out.id);
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.enc'))) {
      const raw = fs.readFileSync(path.join(dir, f)).toString('utf8');
      expect(raw).not.toContain('OAuth');
      expect(raw).not.toContain('refresh');
    }
    // Manifest carries structure, not content.
    const manifest = fs.readJsonSync(path.join(dir, 'manifest.json'));
    expect(JSON.stringify(manifest)).not.toContain('OAuth');
    // No key material anywhere under .forkmind/.
    expect(fs.readdirSync(paths().root)).not.toContain('keys');
  });

  test('capsule is content-addressed and idempotent on re-save', () => {
    const a = saveCapsule({ title: 'same', items, digest: 'd' });
    const b = saveCapsule({ title: 'same', items, digest: 'd' });
    expect(b.id).toBe(a.id);
    expect(listCapsules()).toHaveLength(1);
  });

  test('verifyCapsule passes on a healthy capsule (acyclic, parents, hashes)', () => {
    const { id } = saveCapsule({ title: 't', items });
    expect(verifyCapsule(id)).toEqual({
      ok: true,
      acyclic: true,
      parentsResolved: true,
      hashesValid: true,
    });
  });

  test('tampered ciphertext is detected and restore refuses', () => {
    const { id } = saveCapsule({ title: 't', items });
    const dir = path.join(paths().contextsDir, id);
    const seg = fs.readdirSync(dir).find((f) => f.endsWith('.enc'));
    const p = path.join(dir, seg);
    const raw = fs.readFileSync(p);
    raw[raw.length - 1] ^= 0xff; // flip a tag bit
    fs.writeFileSync(p, raw);

    expect(verifyCapsule(id).ok).toBe(false);
    expect(() => readCapsule(id)).toThrow(/integrity/i);
  });

  test('oversized items are chunked and reassemble exactly', () => {
    const big = 'x'.repeat(MAX_SEGMENT_BYTES * 2 + 137) + 'END';
    const { id, segments } = saveCapsule({
      title: 'big',
      items: [{ role: 'tool', content: big }],
    });
    expect(segments).toBeGreaterThan(2); // multiple chunks + root
    const cap = readCapsule(id);
    expect(cap.items.map((i) => i.content).join('')).toBe(big);
  });

  test('partial restore returns one verified segment', () => {
    const { id } = saveCapsule({ title: 't', items });
    const digest = getDigest(id);
    const firstSeg = digest.dag.segments.find((s) => s.role !== 'root');
    const [seg] = readSegments(id, [firstSeg.id]);
    expect(seg.content).toBe(items[0].content);
  });

  test('digest is optional (private capsules) and searchable when present', () => {
    saveCapsule({ title: 'public one', items, digest: 'covers oauth work' });
    saveCapsule({
      title: 'private one',
      items: [{ role: 'user', content: 'api key sk-123' }],
      digest: null,
    });
    expect(listCapsules({ q: 'oauth' })).toHaveLength(1);
    const priv = listCapsules({ q: 'private one' })[0];
    expect(priv.digest).toBeNull();
    // Public manifests never expose key material.
    expect(priv.crypto).toBeUndefined();
  });

  test('forget crypto-shreds, tombstones, and blocks resurrection', () => {
    const { id } = saveCapsule({ title: 't', items });
    expect(() => forgetCapsule(id, 'wrong')).toThrow(/confirm/i);

    forgetCapsule(id, id);
    expect(fs.existsSync(path.join(paths().contextsDir, id))).toBe(false);
    expect(() => readCapsule(id)).toThrow(/forgotten/i);
    // Same content re-saved would produce the same id → must stay dead.
    expect(() => saveCapsule({ title: 't', items })).toThrow(/forgotten/i);
    expect(capsuleStats().forgotten).toBe(1);
  });

  test('stats aggregate over capsules', () => {
    saveCapsule({ title: 'a', items, digest: 'd' });
    saveCapsule({ title: 'b', items: [{ role: 'user', content: 'other' }] });
    const s = capsuleStats();
    expect(s.total).toBe(2);
    expect(s.withDigest).toBe(1);
    expect(s.bytes).toBeGreaterThan(0);
  });
});

describe('context capsule HTTP API', () => {
  let tmp;
  let originalCwd;
  let app;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-'));
    process.chdir(tmp);
    app = createServer();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
  });

  const body = {
    title: 'http capsule',
    items: [{ role: 'user', content: 'hello from http' }],
    digest: 'http test capsule',
  };

  test('POST → GET roundtrip with verify', async () => {
    const saved = await request(app).post('/api/context').send(body).expect(201);
    const { id } = saved.body;

    const digest = await request(app).get(`/api/context/${id}/digest`).expect(200);
    expect(digest.body.title).toBe('http capsule');
    expect(digest.body.crypto).toBeUndefined();

    const verify = await request(app).post(`/api/context/${id}/verify`).expect(200);
    expect(verify.body.ok).toBe(true);

    const full = await request(app).get(`/api/context/${id}`).expect(200);
    expect(full.body.items[0].content).toBe('hello from http');
  });

  test('list + stats + validation errors', async () => {
    await request(app).post('/api/context').send(body).expect(201);
    const list = await request(app).get('/api/context?q=http').expect(200);
    expect(list.body.capsules).toHaveLength(1);

    const stats = await request(app).get('/api/context/stats').expect(200);
    expect(stats.body.total).toBe(1);

    const bad = await request(app).post('/api/context').send({ items: [] }).expect(400);
    expect(bad.body.error.code).toBeDefined();
  });

  test('DELETE requires confirm and yields 410 afterwards', async () => {
    const { body: saved } = await request(app).post('/api/context').send(body).expect(201);

    await request(app).delete(`/api/context/${saved.id}`).send({}).expect(400);
    await request(app)
      .delete(`/api/context/${saved.id}`)
      .send({ confirm: saved.id })
      .expect(200);
    await request(app).get(`/api/context/${saved.id}`).expect(410);
    await request(app).get(`/api/context/${saved.id}/digest`).expect(410);
  });

  test('unknown capsule → 404', async () => {
    await request(app).get('/api/context/000000000000').expect(404);
  });

  test('path-traversal ids are rejected with 400, filesystem untouched', async () => {
    // %2E%2E%2F = ../ — Express decodes params, so this reaches the engine as
    // a traversal attempt. Must die at validation, never at path.join.
    await request(app).get('/api/context/%2E%2E%2F%2E%2E%2Fetc').expect(400);
    await request(app).get('/api/context/..%2F..%2Fx/digest').expect(400);
    await request(app).post('/api/context/..%2Fnodes/verify').expect(400);
    const del = await request(app)
      .delete('/api/context/..%2F..%2Fvictim')
      .send({ confirm: '..%2F..%2Fvictim' });
    expect([400, 404]).toContain(del.status);
    // Uppercase / wrong-length ids also rejected.
    await request(app).get('/api/context/ABCDEF123456').expect(400);
    await request(app).get('/api/context/abc').expect(400);
  });
});
