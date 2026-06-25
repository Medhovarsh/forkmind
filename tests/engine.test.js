const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const {
  initStorage,
  saveNode,
  readNode,
  readAllNodes,
  paths,
} = require('../src/storage/engine');

describe('storage engine', () => {
  let tmp;
  let originalCwd;

  // Each test runs in a throwaway temp dir. Engine resolves paths from cwd,
  // so chdir gives every test fully isolated .forkmind storage.
  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-'));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
  });

  const req = { model: 'llama3', messages: [{ role: 'user', content: 'hi' }] };
  const res = { id: 'cmpl-1', choices: [{ message: { content: 'hello' } }] };

  test('initStorage creates nodes dir and manifest', () => {
    initStorage();
    const { nodesDir, manifest } = paths();
    expect(fs.existsSync(nodesDir)).toBe(true);
    expect(fs.existsSync(manifest)).toBe(true);
    expect(fs.readJsonSync(manifest)).toHaveProperty('version', '0.1.0');
  });

  test('initStorage is idempotent and preserves manifest', () => {
    initStorage();
    const { manifest } = paths();
    const first = fs.readJsonSync(manifest);
    initStorage();
    expect(fs.readJsonSync(manifest).createdAt).toBe(first.createdAt);
  });

  test('saveNode writes a node file and returns its id', () => {
    const id = saveNode(null, req, res, { provider: 'openai', stream: false });
    const saved = readNode(id);
    expect(saved.id).toBe(id);
    expect(saved.parentId).toBeNull();
    expect(saved.request).toEqual(req);
    expect(saved.response).toEqual(res);
    expect(saved.children).toEqual([]);
    expect(saved.meta).toEqual({ provider: 'openai', stream: false });
  });

  test('root node id is tracked in manifest.roots', () => {
    initStorage();
    const id = saveNode(null, req, res);
    const { manifest } = paths();
    expect(fs.readJsonSync(manifest).roots).toContain(id);
  });

  test('child node is linked into parent children array', () => {
    const parentId = saveNode(null, req, res);
    const childReq = {
      ...req,
      messages: [...req.messages, { role: 'user', content: 'more' }],
    };
    const childId = saveNode(parentId, childReq, res);
    expect(readNode(parentId).children).toContain(childId);
  });

  test('two distinct children both link without overwriting each other', () => {
    const parentId = saveNode(null, req, res);
    const childA = saveNode(
      parentId,
      { ...req, messages: [{ role: 'user', content: 'A' }] },
      res
    );
    const childB = saveNode(
      parentId,
      { ...req, messages: [{ role: 'user', content: 'B' }] },
      res
    );
    const parent = readNode(parentId);
    expect(parent.children).toEqual(expect.arrayContaining([childA, childB]));
    expect(parent.children).toHaveLength(2);
  });

  test('re-saving same child does not duplicate the link', () => {
    const parentId = saveNode(null, req, res);
    const childReq = { ...req, messages: [{ role: 'user', content: 'dup' }] };
    saveNode(parentId, childReq, res);
    saveNode(parentId, childReq, res);
    expect(readNode(parentId).children).toHaveLength(1);
  });

  test('readAllNodes returns every saved node', () => {
    saveNode(null, { ...req, messages: [{ role: 'user', content: '1' }] }, res);
    saveNode(null, { ...req, messages: [{ role: 'user', content: '2' }] }, res);
    expect(readAllNodes()).toHaveLength(2);
  });

  test('readNode returns null for a missing id', () => {
    expect(readNode('deadbeef0000')).toBeNull();
  });
});
