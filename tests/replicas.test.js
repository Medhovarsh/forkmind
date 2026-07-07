const os = require('os');
const path = require('path');
const fs = require('fs-extra');

// Isolated key dir, same pattern as context.test.js.
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
  verifyCapsule,
  forgetCapsule,
  replicasAdd,
  replicasRemove,
  replicasStatus,
  replicasSync,
  paths,
} = require('../src/context/engine');

describe('capsule replicas (RAID)', () => {
  let tmp;
  let replicaDir;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-'));
    replicaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-replica-'));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
    fs.removeSync(replicaDir);
  });

  const items = [
    { role: 'user', content: 'replicate me' },
    { role: 'assistant', content: 'copied to the array' },
  ];

  test('save mirrors the capsule to configured targets', () => {
    replicasAdd(replicaDir);
    const out = saveCapsule({ title: 'raid', items });
    expect(out.replication.replicated).toEqual([path.resolve(replicaDir)]);
    expect(fs.existsSync(path.join(replicaDir, out.id, 'manifest.json'))).toBe(true);
    // Replica holds ciphertext only — no plaintext, no keys.
    const seg = fs
      .readdirSync(path.join(replicaDir, out.id))
      .find((f) => f.endsWith('.enc'));
    expect(fs.readFileSync(path.join(replicaDir, out.id, seg)).toString('utf8')).not.toContain(
      'replicate'
    );
  });

  test('self-heal: corrupted primary is restored from a replica on read', () => {
    replicasAdd(replicaDir);
    const { id } = saveCapsule({ title: 'raid', items });

    // Nuke the primary copy entirely.
    fs.removeSync(path.join(paths().contextsDir, id));
    expect(verifyCapsule(id).ok).toBe(false);

    const cap = readCapsule(id); // heals transparently
    expect(cap.items[0].content).toBe('replicate me');
    expect(verifyCapsule(id).ok).toBe(true); // primary restored
  });

  test('self-heal also fixes bit-rot (tampered primary segment)', () => {
    replicasAdd(replicaDir);
    const { id } = saveCapsule({ title: 'raid', items });
    const dir = path.join(paths().contextsDir, id);
    const seg = fs.readdirSync(dir).find((f) => f.endsWith('.enc'));
    const raw = fs.readFileSync(path.join(dir, seg));
    raw[raw.length - 1] ^= 0xff;
    fs.writeFileSync(path.join(dir, seg), raw);

    expect(readCapsule(id).items[1].content).toBe('copied to the array');
  });

  test('heal never resurrects a forgotten capsule', () => {
    replicasAdd(replicaDir);
    const { id } = saveCapsule({ title: 'raid', items });

    // Simulate an offline replica during forget: config removed, then forget,
    // then the "mount" comes back.
    replicasRemove(replicaDir);
    forgetCapsule(id, id);
    replicasAdd(replicaDir); // replica still holds the old copy

    expect(() => readCapsule(id)).toThrow(/forgotten/i);
    // sync propagates the tombstone and shreds the stale replica copy.
    const s = replicasSync();
    expect(s.shredded).toBe(1);
    expect(fs.existsSync(path.join(replicaDir, id))).toBe(false);
  });

  test('forget shreds reachable replicas immediately', () => {
    replicasAdd(replicaDir);
    const { id } = saveCapsule({ title: 'raid', items });
    expect(fs.existsSync(path.join(replicaDir, id))).toBe(true);
    const out = forgetCapsule(id, id);
    expect(out.replicaWarning).toBeUndefined();
    expect(fs.existsSync(path.join(replicaDir, id))).toBe(false);
  });

  test('status reports coverage and unreachable targets', () => {
    replicasAdd(replicaDir);
    saveCapsule({ title: 'raid', items });

    let [st] = replicasStatus();
    expect(st).toMatchObject({ reachable: true, capsules: 1, missing: 0 });

    fs.removeSync(replicaDir);
    [st] = replicasStatus();
    expect(st.reachable).toBe(false);
  });

  test('sync catches up a target added after saves', () => {
    const { id } = saveCapsule({ title: 'raid', items });
    replicasAdd(replicaDir); // add runs via engine only in CLI; engine add does not sync
    const s = replicasSync();
    expect(s.copied).toBe(1);
    expect(fs.existsSync(path.join(replicaDir, id, 'manifest.json'))).toBe(true);
  });

  test('primary store is rejected as a replica target', () => {
    expect(() => replicasAdd(paths().contextsDir)).toThrow(/primary/i);
  });
});
