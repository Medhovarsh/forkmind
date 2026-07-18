import React, { useMemo, useState } from 'react';

/** Last user message text + its index in the request messages. */
function lastUser(node) {
  const msgs = node.request?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].role === 'user' && typeof msgs[i].content === 'string') {
      return { index: i, text: msgs[i].content };
    }
  }
  return { index: -1, text: '' };
}

/** Leaves reachable below a node (depth-first over the polled node set). */
function descendantLeaves(node, all) {
  const byId = new Map(all.map((n) => [n.id, n]));
  const leaves = [];
  const walk = (n) => {
    const kids = (n.children || []).map((id) => byId.get(id)).filter(Boolean);
    if (!kids.length) leaves.push(n);
    else kids.forEach(walk);
  };
  walk(node);
  return leaves;
}

/**
 * Time-travel replay: edit this node's prompt (and optionally the model),
 * then re-run the whole chain down to a chosen leaf. The regenerated turns
 * appear as a sibling branch next to the original.
 */
export default function ReplayModal({ node, nodes, onClose, onDone }) {
  const { index, text } = lastUser(node);
  const leaves = useMemo(() => descendantLeaves(node, nodes), [node, nodes]);

  const [prompt, setPrompt] = useState(text);
  const [model, setModel] = useState(node.request?.model || '');
  const [leafId, setLeafId] = useState(leaves[leaves.length - 1]?.id || node.id);
  const [apiKey, setApiKey] = useState(localStorage.getItem('forkmind:key') || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setError(null);
    localStorage.setItem('forkmind:key', apiKey);

    const messages = (node.request?.messages || []).slice();
    if (index >= 0) messages[index] = { ...messages[index], content: prompt };
    const request = { ...node.request, messages };

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
      headers['x-api-key'] = apiKey;
    }

    setBusy(true);
    try {
      const res = await fetch('/api/replay', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fromNodeId: node.id,
          leafId,
          request,
          model: model || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <strong>⏪ Replay from node {node.id}</strong>
          <div className="status" style={{ fontSize: 12, color: 'var(--muted)' }}>
            regenerates {leaves.length ? 'the chain down to the chosen leaf' : 'this turn'} as a
            sibling branch — original user turns and tool results re-apply verbatim
          </div>
        </header>
        <div className="content">
          <label>Prompt (this node’s user message, edit it)</label>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} spellCheck={false} />

          <label>Model (applies to every replayed call)</label>
          <input value={model} onChange={(e) => setModel(e.target.value)} />

          {leaves.length > 1 && (
            <>
              <label>Replay down to</label>
              <select value={leafId} onChange={(e) => setLeafId(e.target.value)}>
                {leaves.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.id} — {l.request?.model}
                  </option>
                ))}
              </select>
            </>
          )}

          <label>API key (optional — leave blank for keyless local models like Ollama)</label>
          <input
            type="password"
            value={apiKey}
            placeholder="sk-... — stored only in your browser"
            onChange={(e) => setApiKey(e.target.value)}
          />

          {error && <div className="error">{error}</div>}
        </div>
        <footer>
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? 'Replaying…' : 'Replay chain'}
          </button>
        </footer>
      </div>
    </div>
  );
}
