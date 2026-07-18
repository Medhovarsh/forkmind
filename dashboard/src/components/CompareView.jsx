import React from 'react';
import { wordDiff } from '../lib/diff.js';

/** Latest user message text in a node's request — "what drove this turn". */
function lastUserText(node) {
  const msgs = node.request?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].role !== 'user') continue;
    const c = msgs[i].content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const t = c.find((b) => b.type === 'text');
      if (t) return t.text;
    }
  }
  return '';
}

/** Assistant text of a response (OpenAI or Anthropic shape); tool-call turns
 * fall back to their tool_calls JSON so there is always something to diff. */
function responseText(node) {
  const r = node.response;
  if (!r) return '';
  if (r.choices?.[0]?.message) {
    const m = r.choices[0].message;
    if (m.content) return m.content;
    if (m.tool_calls) return JSON.stringify(m.tool_calls, null, 2);
  }
  if (Array.isArray(r.content)) {
    return r.content.map((b) => b.text || `[${b.type}]`).join('\n');
  }
  return '';
}

/**
 * One side of a diffed text block. Side "a" renders same+del (deletions
 * highlighted), side "b" renders same+add (additions highlighted). When
 * segments is null (too large to diff) the raw text renders plain.
 */
function DiffPane({ segments, side, plain }) {
  if (!segments) return <pre className="json">{plain}</pre>;
  const keep = side === 'a' ? ['same', 'del'] : ['same', 'add'];
  return (
    <pre className="json diff-pane">
      {segments
        .filter((s) => keep.includes(s.type))
        .map((s, i) =>
          s.type === 'same' ? (
            <span key={i}>{s.text}</span>
          ) : (
            <mark key={i} className={`diff-${s.type}`}>
              {s.text}
            </mark>
          )
        )}
    </pre>
  );
}

/** A/B/delta rows for token usage; em-dash when either side lacks usage. */
function TokenTable({ a, b }) {
  const ua = a.response?.usage;
  const ub = b.response?.usage;
  const rows = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
  return (
    <table className="token-table">
      <thead>
        <tr>
          <th></th>
          <th>A</th>
          <th>B</th>
          <th>Δ</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((k) => {
          const va = ua?.[k];
          const vb = ub?.[k];
          const hasBoth = typeof va === 'number' && typeof vb === 'number';
          const d = hasBoth ? vb - va : null;
          return (
            <tr key={k}>
              <td>{k.replace('_tokens', '')}</td>
              <td>{typeof va === 'number' ? va : '—'}</td>
              <td>{typeof vb === 'number' ? vb : '—'}</td>
              <td className={d > 0 ? 'delta-up' : d < 0 ? 'delta-down' : ''}>
                {hasBoth ? (d > 0 ? `+${d}` : `${d}`) : '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ColumnHeader({ node, label }) {
  return (
    <div className="compare-head">
      <span className="compare-label">{label}</span>
      <span className="badge model">{node.request?.model || '?'}</span>
      <span className="badge">{node.id}</span>
      <div className="compare-sub">
        {node.meta?.upstream || 'default upstream'} · {node.timestamp}
      </div>
    </div>
  );
}

/**
 * Diff two texts, but bail to plain rendering (null) when they share almost
 * nothing — a pane that is one solid highlight explains less than plain text.
 */
function usefulDiff(a, b) {
  const segments = wordDiff(a, b);
  if (!segments) return null;
  let same = 0;
  let total = 0;
  for (const s of segments) {
    total += s.text.length;
    if (s.type === 'same') same += s.text.length;
  }
  return total > 0 && same / total < 0.15 ? null : segments;
}

/**
 * Full-screen side-by-side comparison of two captured nodes: prompt delta,
 * response diff (word-level), and token usage. "Git diff for LLM outputs."
 */
export default function CompareView({ a, b, onClose }) {
  const promptA = lastUserText(a);
  const promptB = lastUserText(b);
  const respA = responseText(a);
  const respB = responseText(b);

  const promptDiff = usefulDiff(promptA, promptB);
  const respDiff = usefulDiff(respA, respB);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal compare-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <strong>⇄ Compare nodes</strong>
          <button onClick={onClose}>✕</button>
        </header>
        <div className="content">
          <div className="compare-grid">
            <ColumnHeader node={a} label="A" />
            <ColumnHeader node={b} label="B" />

            <h3 className="compare-section">Prompt</h3>
            <DiffPane segments={promptDiff} side="a" plain={promptA} />
            <DiffPane segments={promptDiff} side="b" plain={promptB} />

            <h3 className="compare-section">
              Response{!respDiff && ' (plain view — sides too different or too large to diff)'}
            </h3>
            <DiffPane segments={respDiff} side="a" plain={respA} />
            <DiffPane segments={respDiff} side="b" plain={respB} />
          </div>

          <h3 className="compare-section">Tokens</h3>
          <TokenTable a={a} b={b} />
        </div>
      </div>
    </div>
  );
}
