const { createTracking, PROXY_BASE } = require('../src/integrations/tracking');
const { forkmind } = require('../src/integrations/langchain');
const { forkmindOpenAI } = require('../src/integrations/vercel');

/**
 * Build a fake fetch that records the headers it was called with and replies
 * with an x-forkmind-node-id (as the real proxy does).
 */
function fakeFetch(nodeId) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return {
      headers: { get: (name) => (name === 'x-forkmind-node-id' ? nodeId : null) },
    };
  };
  impl.calls = calls;
  return impl;
}

describe('createTracking', () => {
  test('throws without a usable fetch', () => {
    expect(() => createTracking({ fetchImpl: 123 })).toThrow(/global fetch/);
  });

  test('stamps upstream header and chains parent id across calls', async () => {
    const impl = fakeFetch('node-123');
    const t = createTracking({ upstream: 'http://localhost:11434', fetchImpl: impl });

    expect(t.parentId).toBeNull();

    await t.fetch('http://localhost:4500/v1/chat/completions', {});
    // First call: no parent yet, but upstream stamped.
    expect(impl.calls[0].headers.get('x-forkmind-parent')).toBeNull();
    expect(impl.calls[0].headers.get('x-forkmind-upstream')).toBe('http://localhost:11434');
    // Response node id becomes the head.
    expect(t.parentId).toBe('node-123');

    await t.fetch('http://localhost:4500/v1/chat/completions', {});
    // Second call chains under the first node.
    expect(impl.calls[1].headers.get('x-forkmind-parent')).toBe('node-123');
  });

  test('setParent / resetParent control the branch point', async () => {
    const impl = fakeFetch(null); // proxy returns no new id
    const t = createTracking({ fetchImpl: impl });

    t.setParent('abc123');
    expect(t.parentId).toBe('abc123');
    await t.fetch('u', {});
    expect(impl.calls[0].headers.get('x-forkmind-parent')).toBe('abc123');

    t.resetParent();
    expect(t.parentId).toBeNull();
  });

  test('preserves caller-supplied headers', async () => {
    const impl = fakeFetch('n1');
    const t = createTracking({ fetchImpl: impl });
    await t.fetch('u', { headers: { authorization: 'Bearer key' } });
    expect(impl.calls[0].headers.get('authorization')).toBe('Bearer key');
  });
});

describe('langchain integration', () => {
  test('returns a configuration with proxy baseURL + tracking fetch', () => {
    const fm = forkmind({ fetchImpl: fakeFetch('x') });
    expect(fm.configuration.baseURL).toBe(PROXY_BASE);
    expect(typeof fm.configuration.fetch).toBe('function');
    expect(fm.parentId).toBeNull();
  });

  test('honors a custom baseURL', () => {
    const fm = forkmind({ baseURL: 'http://localhost:9999/v1', fetchImpl: fakeFetch('x') });
    expect(fm.configuration.baseURL).toBe('http://localhost:9999/v1');
  });

  test('configuration.fetch chains parents', async () => {
    const impl = fakeFetch('node-9');
    const fm = forkmind({ fetchImpl: impl });
    await fm.configuration.fetch('u', {});
    expect(fm.parentId).toBe('node-9');
  });
});

describe('vercel integration', () => {
  test('throws a helpful error when @ai-sdk/openai is absent', () => {
    // @ai-sdk/openai is not a dependency of this repo.
    expect(() => forkmindOpenAI()).toThrow(/@ai-sdk\/openai/);
  });
});
