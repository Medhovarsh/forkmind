const { generateNodeId } = require('../src/storage/hash');

describe('generateNodeId', () => {
  const payload = { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] };

  test('is deterministic — same payload + same parent => same id', () => {
    expect(generateNodeId(payload, 'parent123')).toBe(
      generateNodeId(payload, 'parent123')
    );
  });

  test('returns a 12-char hex id', () => {
    const id = generateNodeId(payload, null);
    expect(id).toHaveLength(12);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  test('different payload => different id (same parent)', () => {
    const other = { model: 'gpt-4', messages: [{ role: 'user', content: 'bye' }] };
    expect(generateNodeId(payload, 'p')).not.toBe(generateNodeId(other, 'p'));
  });

  test('same payload under different parents => different id', () => {
    expect(generateNodeId(payload, 'parentA')).not.toBe(
      generateNodeId(payload, 'parentB')
    );
  });

  test('null parent and empty-string parent hash identically', () => {
    expect(generateNodeId(payload, null)).toBe(generateNodeId(payload, ''));
  });
});
