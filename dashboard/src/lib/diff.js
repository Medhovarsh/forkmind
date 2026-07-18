// Word-level diff powering the branch compare view. Zero dependencies —
// classic LCS is ~60 lines and giant diff libraries earn nothing here.
//
// NOTE: tests/diff.test.js (root jest, CJS) loads THIS file by stripping the
// `export` keywords and evaluating it, so the shipped code is what's tested.
// Keep exports as top-level `export function` / `export const` declarations.

// Above this many words per side we refuse to diff: the DP table is O(n·m)
// and giant LLM outputs would freeze the UI. Callers fall back to plain
// side-by-side rendering.
export const MAX_WORDS = 3000;

/**
 * Split into word tokens, each carrying its trailing whitespace so that
 * re-joining segments reproduces the original text exactly.
 */
function tokenize(text) {
  return text.match(/\S+\s*/g) || [];
}

/**
 * Word-level LCS diff of two strings.
 *
 * @param {string} a
 * @param {string} b
 * @returns {Array<{type: 'same'|'add'|'del', text: string}>|null}
 *   Ordered segments (consecutive same-type tokens merged), or null when
 *   either side exceeds MAX_WORDS — render plain text in that case.
 */
export function wordDiff(a, b) {
  const ta = tokenize(a || '');
  const tb = tokenize(b || '');
  if (ta.length > MAX_WORDS || tb.length > MAX_WORDS) return null;

  // LCS length table. Compare on trimmed tokens so whitespace variations
  // between the same words don't register as changes.
  const n = ta.length;
  const m = tb.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        ta[i].trim() === tb[j].trim()
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Walk the table emitting del (from a) / add (from b) / same tokens.
  const out = [];
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ta[i].trim() === tb[j].trim()) {
      // Prefer b's whitespace so the "new" side reads naturally.
      push('same', tb[j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('del', ta[i]);
      i += 1;
    } else {
      push('add', tb[j]);
      j += 1;
    }
  }
  while (i < n) push('del', ta[i++]);
  while (j < m) push('add', tb[j++]);

  return out;
}
