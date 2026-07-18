// The diff implementation ships inside the dashboard as an ESM module (Vite
// serves source as ESM only; root jest is CJS). Load the exact shipped file
// by stripping the `export` keywords and evaluating it — so what we test is
// what the browser runs.
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'dashboard', 'src', 'lib', 'diff.js'),
  'utf8'
);
// eslint-disable-next-line no-new-func
const { wordDiff, MAX_WORDS } = new Function(
  `${source.replace(/^export /gm, '')}; return { wordDiff, MAX_WORDS };`
)();

function joined(segments, types) {
  return segments
    .filter((s) => types.includes(s.type))
    .map((s) => s.text)
    .join('');
}

describe('wordDiff', () => {
  test('identical inputs collapse to a single same segment', () => {
    const d = wordDiff('the quick brown fox', 'the quick brown fox');
    expect(d).toEqual([{ type: 'same', text: 'the quick brown fox' }]);
  });

  test('pure insertion', () => {
    const d = wordDiff('a c', 'a b c');
    expect(d.find((s) => s.type === 'add').text.trim()).toBe('b');
    expect(d.some((s) => s.type === 'del')).toBe(false);
  });

  test('pure deletion', () => {
    const d = wordDiff('a b c', 'a c');
    expect(d.find((s) => s.type === 'del').text.trim()).toBe('b');
    expect(d.some((s) => s.type === 'add')).toBe(false);
  });

  test('replacement yields del + add', () => {
    const d = wordDiff('tests fail badly', 'tests pass cleanly');
    expect(joined(d, ['del'])).toContain('fail');
    expect(joined(d, ['add'])).toContain('pass');
    expect(joined(d, ['same'])).toContain('tests');
  });

  test('empty sides', () => {
    expect(wordDiff('', '')).toEqual([]);
    expect(wordDiff('hello there', '')).toEqual([{ type: 'del', text: 'hello there' }]);
    expect(wordDiff('', 'hello there')).toEqual([{ type: 'add', text: 'hello there' }]);
  });

  test('reassembling same+add reproduces the b side', () => {
    const a = 'if (payload.exp < Date.now()) throw err;';
    const b = 'if (payload.exp * 1000 < Date.now()) throw err;';
    const d = wordDiff(a, b);
    expect(joined(d, ['same', 'add'])).toBe(b);
    expect(joined(d, ['same', 'del']).replace(/\s+/g, ' ').trim()).toBe(
      a.replace(/\s+/g, ' ').trim()
    );
  });

  test('newlines survive in segment text', () => {
    const d = wordDiff('line one\nline two', 'line one\nline three');
    expect(joined(d, ['same'])).toContain('\n');
  });

  test('oversized input returns null (plain-render fallback)', () => {
    const big = Array.from({ length: MAX_WORDS + 1 }, (_, k) => `w${k}`).join(' ');
    expect(wordDiff(big, 'small')).toBeNull();
    expect(wordDiff('small', big)).toBeNull();
  });
});
