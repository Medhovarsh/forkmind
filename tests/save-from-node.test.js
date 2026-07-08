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

const { saveNode } = require('../src/storage/engine');
const {
  saveFromNode,
  readCapsule,
  readCapsuleAsMessages,
  saveCapsule,
} = require('../src/context/engine');

describe('saveFromNode — archive a captured lineage into a capsule', () => {
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

  function captureTurn(parentId, userText, assistantText) {
    return saveNode(
      parentId,
      { model: 'llama3', messages: [{ role: 'user', content: userText }] },
      { choices: [{ message: { role: 'assistant', content: assistantText } }] },
      { provider: 'openai', stream: false }
    );
  }

  test('archives the full root→node lineage in conversation order', () => {
    const n1 = captureTurn(null, 'first question', 'first answer');
    const n2 = captureTurn(n1, 'second question', 'second answer');
    const n3 = captureTurn(n2, 'third question', 'third answer');

    const out = saveFromNode(n3, { digest: 'three-turn debug session' });
    const cap = readCapsule(out.id);

    expect(cap.items.map((i) => i.content)).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
      'third question',
      'third answer',
    ]);
    expect(cap.items.map((i) => i.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);

    // Links back into the turn DAG.
    const digest = require('../src/context/engine').getDigest(out.id);
    expect(digest.sourceNodeIds).toEqual([n1, n2, n3]);
    // Auto-title mentions the lineage span.
    expect(digest.title).toContain(n1);
    expect(digest.title).toContain(n3);
  });

  test('custom title wins over the auto-title', () => {
    const n1 = captureTurn(null, 'q', 'a');
    const out = saveFromNode(n1, { title: 'my archive' });
    expect(readCapsule(out.id).title).toBe('my archive');
  });

  test('unknown node id is rejected', () => {
    expect(() => saveFromNode('000000000000')).toThrow(/not found/i);
  });

  test('readCapsuleAsMessages returns a provider-ready messages[] array', () => {
    const n1 = captureTurn(null, 'hello', 'world');
    const { id } = saveFromNode(n1);
    const { messages } = readCapsuleAsMessages(id);
    expect(messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]);
  });

  test('non-chat roles are coerced to user so providers never reject a restore', () => {
    const { id } = saveCapsule({
      title: 'mixed roles',
      items: [
        { role: 'file-dump', content: 'big blob' },
        { role: 'assistant', content: 'ok' },
      ],
    });
    const { messages } = readCapsuleAsMessages(id);
    expect(messages[0].role).toBe('user'); // coerced
    expect(messages[1].role).toBe('assistant');
  });
});
