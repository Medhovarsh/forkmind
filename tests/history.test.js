const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { saveNode, getLineage, getChildren, searchNodes } = require('../src/storage/engine');

// History query helpers backing the MCP server.
describe('history queries', () => {
  let tmp;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-hist-'));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
  });

  const mk = (content) => ({ model: 'llama3', messages: [{ role: 'user', content }] });
  const reply = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });

  test('getLineage returns root→node path in order', () => {
    const root = saveNode(null, mk('a'), reply('A'));
    const mid = saveNode(root, mk('b'), reply('B'));
    const leaf = saveNode(mid, mk('c'), reply('C'));

    const chain = getLineage(leaf);
    expect(chain.map((n) => n.id)).toEqual([root, mid, leaf]);
  });

  test('getLineage of a root is just itself', () => {
    const root = saveNode(null, mk('solo'), reply('S'));
    expect(getLineage(root).map((n) => n.id)).toEqual([root]);
  });

  test('getLineage of a missing id is empty', () => {
    expect(getLineage('deadbeef0000')).toEqual([]);
  });

  test('getChildren returns direct branches', () => {
    const root = saveNode(null, mk('root'), reply('R'));
    const a = saveNode(root, mk('branch-a'), reply('A'));
    const b = saveNode(root, mk('branch-b'), reply('B'));

    const kids = getChildren(root).map((n) => n.id);
    expect(kids).toEqual(expect.arrayContaining([a, b]));
    expect(kids).toHaveLength(2);
  });

  test('searchNodes matches request and response text, case-insensitive', () => {
    saveNode(null, mk('tell me about photosynthesis'), reply('plants convert light'));
    saveNode(null, mk('unrelated'), reply('nothing here'));

    expect(searchNodes('PHOTOSYNTHESIS')).toHaveLength(1); // request hit
    expect(searchNodes('convert light')).toHaveLength(1); // response hit
    expect(searchNodes('xyzzy')).toHaveLength(0);
    expect(searchNodes('')).toHaveLength(0);
  });
});
