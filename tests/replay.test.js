const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { initStorage, saveNode, readNode } = require('../src/storage/engine');
const { replayChain, replayPath, tailMessages } = require('../src/replay/engine');

// Build a small captured chain the way the proxy would: each request carries
// the full message history; each node's response is OpenAI-shaped.
function resp(text, model = 'llama3.1') {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    model,
  };
}

const META = { provider: 'openai', upstream: 'http://localhost:11434', stream: false, status: 200 };

function seedChain() {
  const m1 = [{ role: 'user', content: 'question one' }];
  const r1 = resp('answer one');
  const n1 = saveNode(null, { model: 'llama3.1', messages: m1 }, r1, META);

  const m2 = [...m1, r1.choices[0].message, { role: 'user', content: 'question two' }];
  const r2 = resp('answer two');
  const n2 = saveNode(n1, { model: 'llama3.1', messages: m2 }, r2, META);

  const m3 = [
    ...m2,
    r2.choices[0].message,
    { role: 'tool', tool_call_id: 'call_x', content: 'tool output' },
    { role: 'user', content: 'question three' },
  ];
  const r3 = resp('answer three');
  const n3 = saveNode(n2, { model: 'llama3.1', messages: m3 }, r3, META);

  return { n1, n2, n3, m1, m2, m3 };
}

describe('replay engine', () => {
  let tmp;
  let originalCwd;
  let chain;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkmind-replay-'));
    process.chdir(tmp);
    initStorage();
    chain = seedChain();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(tmp);
  });

  test('tailMessages returns what the child added after the parent reply', () => {
    const p = readNode(chain.n2);
    const c = readNode(chain.n3);
    const tail = tailMessages(p, c);
    expect(tail).toHaveLength(2);
    expect(tail[0].role).toBe('tool');
    expect(tail[1].content).toBe('question three');
  });

  test('replayPath validates descendant relationship', () => {
    expect(replayPath(chain.n1, chain.n3).map((n) => n.id)).toEqual([
      chain.n1,
      chain.n2,
      chain.n3,
    ]);
    expect(() => replayPath(chain.n3, chain.n1)).toThrow(/not a descendant/);
    expect(() => replayPath('000000000000', chain.n3)).toThrow(/not found/);
  });

  test('replays a 3-node chain: threading, parentage, sibling root', async () => {
    const sent = [];
    const forwardFn = async (body) => {
      sent.push(body);
      return { status: 200, data: resp(`regen ${sent.length}`) };
    };

    const edited = {
      model: 'llama3.1',
      messages: [{ role: 'user', content: 'question one REVISED' }],
    };
    const { nodes } = await replayChain({
      fromNodeId: chain.n1,
      leafId: chain.n3,
      request: edited,
      forwardFn,
    });

    expect(nodes).toHaveLength(3);
    expect(sent).toHaveLength(3);

    // First new node is a sibling of the edited node (alternate history).
    expect(readNode(nodes[0]).parentId).toBe(readNode(chain.n1).parentId);
    expect(readNode(nodes[1]).parentId).toBe(nodes[0]);
    expect(readNode(nodes[2]).parentId).toBe(nodes[1]);

    // Second call = revised q1 + regenerated answer + original tail (q2).
    const call2 = sent[1].messages;
    expect(call2[0].content).toBe('question one REVISED');
    expect(call2[1].content).toBe('regen 1');
    expect(call2[2].content).toBe('question two');

    // Third call carries the original tool tail.
    const call3 = sent[2].messages;
    expect(call3.some((m) => m.role === 'tool' && m.content === 'tool output')).toBe(true);
    expect(call3[call3.length - 1].content).toBe('question three');

    // Provenance marks what each replayed node regenerates.
    expect(readNode(nodes[2]).meta.replayOf).toBe(chain.n3);
  });

  test('model override rewrites every replayed call', async () => {
    const sent = [];
    const forwardFn = async (body) => {
      sent.push(body);
      return { status: 200, data: resp('x', 'gpt-4o-mini') };
    };
    await replayChain({
      fromNodeId: chain.n1,
      leafId: chain.n3,
      request: { model: 'llama3.1', messages: [{ role: 'user', content: 'q' }] },
      model: 'gpt-4o-mini',
      forwardFn,
    });
    expect(sent.every((b) => b.model === 'gpt-4o-mini')).toBe(true);
  });

  test('mid-chain upstream failure keeps earlier nodes and reports them', async () => {
    let calls = 0;
    const forwardFn = async () => {
      calls += 1;
      if (calls === 2) return { status: 500, data: { error: 'boom' } };
      return { status: 200, data: resp('ok') };
    };
    await expect(
      replayChain({
        fromNodeId: chain.n1,
        leafId: chain.n3,
        request: { model: 'llama3.1', messages: [{ role: 'user', content: 'q' }] },
        forwardFn,
      })
    ).rejects.toMatchObject({ saved: [expect.any(String)] });
  });

  test('single-node path replays just that node', async () => {
    const forwardFn = async () => ({ status: 200, data: resp('solo') });
    const { nodes } = await replayChain({
      fromNodeId: chain.n3,
      leafId: chain.n3,
      request: readNode(chain.n3).request,
      forwardFn,
    });
    expect(nodes).toHaveLength(1);
  });
});
