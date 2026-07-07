const os = require('os');
const path = require('path');
const fs = require('fs-extra');

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
  readCapsule,
  exportCapsule,
  importCapsule,
  forgetCapsule,
  capsuleStats,
} = require('../src/context/engine');

describe('capsule export / import (portable bundles)', () => {
  let tmpA, tmpB, keyA, keyB;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-a-'));
    tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-b-'));
    keyA = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-keyA-'));
    keyB = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-keyB-'));
    process.chdir(tmpA);
    process.env.FORKMIND_KEY_DIR = keyA;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmpA);
    fs.removeSync(tmpB);
    fs.removeSync(keyA);
    fs.removeSync(keyB);
    process.env.FORKMIND_KEY_DIR = keyTmp;
  });

  const items = [
    { role: 'user', content: 'export me across machines' },
    { role: 'assistant', content: 'portable, encrypted, verified on the way in' },
  ];

  test('export → import into a DIFFERENT project (different master key) round-trips content', () => {
    const saved = saveCapsule({ title: 'portable', items, digest: 'cross-machine test' });
    const bundle = exportCapsule(saved.id, 'correct horse battery staple');

    expect(bundle.format).toBe('forkmind-capsule-export');
    // The bundle must not carry the local wrapped DEK or master key material.
    expect(JSON.stringify(bundle)).not.toContain('wrappedKey');

    // Switch to a wholly separate project + separate master key — simulates
    // a different machine.
    process.chdir(tmpB);
    process.env.FORKMIND_KEY_DIR = keyB;

    const out = importCapsule(bundle, 'correct horse battery staple');
    expect(out.id).toBe(saved.id);

    const restored = readCapsule(saved.id);
    expect(restored.items.map((i) => i.content)).toEqual(items.map((i) => i.content));
    expect(restored.digest).toBe('cross-machine test');
  });

  test('wrong passphrase on import is rejected', () => {
    const saved = saveCapsule({ title: 'portable', items });
    const bundle = exportCapsule(saved.id, 'right-passphrase-123');

    process.chdir(tmpB);
    process.env.FORKMIND_KEY_DIR = keyB;
    expect(() => importCapsule(bundle, 'wrong-passphrase-456')).toThrow(/passphrase|corrupted/i);
  });

  test('tampered bundle segment is rejected before anything is written', () => {
    const saved = saveCapsule({ title: 'portable', items });
    const bundle = exportCapsule(saved.id, 'tamper-test-pass');
    const firstSegId = bundle.dag.segments.find((s) => s.role !== 'root').id;
    // Corrupt the base64 ciphertext for one segment.
    bundle.segments[firstSegId] = Buffer.from('not the real ciphertext at all').toString('base64');

    process.chdir(tmpB);
    process.env.FORKMIND_KEY_DIR = keyB;
    expect(() => importCapsule(bundle, 'tamper-test-pass')).toThrow();
    // Nothing should have been written for a failed import.
    expect(() => readCapsule(saved.id)).toThrow(/not found/i);
  });

  test('export requires a real passphrase (min length enforced)', () => {
    const saved = saveCapsule({ title: 'portable', items });
    expect(() => exportCapsule(saved.id, 'short')).toThrow(/8 characters/);
  });

  test('import is idempotent and respects tombstones', () => {
    const saved = saveCapsule({ title: 'portable', items });
    const bundle = exportCapsule(saved.id, 'idempotent-pass-1');

    process.chdir(tmpB);
    process.env.FORKMIND_KEY_DIR = keyB;
    importCapsule(bundle, 'idempotent-pass-1');
    const second = importCapsule(bundle, 'idempotent-pass-1'); // re-import same bundle
    expect(second.id).toBe(saved.id);

    forgetCapsule(saved.id, saved.id);
    expect(() => importCapsule(bundle, 'idempotent-pass-1')).toThrow(/forgotten/i);
  });

  test('export refuses an unverifiable (corrupted) local capsule', () => {
    const saved = saveCapsule({ title: 'portable', items });
    // Corrupt the local ciphertext before exporting.
    const dir = path.join(process.cwd(), '.forkmind', 'contexts', saved.id);
    const seg = fs.readdirSync(dir).find((f) => f.endsWith('.enc'));
    const raw = fs.readFileSync(path.join(dir, seg));
    raw[raw.length - 1] ^= 0xff;
    fs.writeFileSync(path.join(dir, seg), raw);

    expect(() => exportCapsule(saved.id, 'whatever-pass-1')).toThrow();
  });

  test('capsuleStats reports an estimated token count', () => {
    saveCapsule({ title: 'a', items, digest: 'd' });
    const stats = capsuleStats();
    expect(stats.tokensEstimated).toBeGreaterThan(0);
  });
});
