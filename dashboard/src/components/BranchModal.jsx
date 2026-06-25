import React, { useState } from 'react';

// Provider -> proxy path. Branch replays go back through the same proxy that
// recorded the original node, linked to it as parent.
const PROVIDER_PATHS = {
  openai: '/v1/chat/completions',
  anthropic: '/v1/messages',
};

/**
 * Fork UI. Pre-fills the parent node's request payload, lets the user edit the
 * prompt / swap the model, then submits to the proxy with x-forkmind-parent set
 * so the new generation becomes a visible branch off the historical node.
 *
 * The dashboard has no API key of its own, so we offer an optional key field
 * (remembered in localStorage). The proxy forwards it upstream verbatim. For
 * keyless local providers (Ollama) you can leave it blank.
 */
export default function BranchModal({ node, onClose, onDone }) {
  const provider = node.meta?.provider || 'openai';
  const path = PROVIDER_PATHS[provider] || PROVIDER_PATHS.openai;

  // Editable copy of the request, forced to non-streaming so we can read the
  // full JSON result of the branch in one shot.
  const initial = { ...node.request, stream: false };

  const [payload, setPayload] = useState(JSON.stringify(initial, null, 2));
  const [apiKey, setApiKey] = useState(localStorage.getItem('forkmind:key') || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setError(null);
    let body;
    try {
      body = JSON.parse(payload);
    } catch (e) {
      setError(`Invalid JSON: ${e.message}`);
      return;
    }
    body.stream = false; // enforce

    localStorage.setItem('forkmind:key', apiKey);

    const headers = {
      'Content-Type': 'application/json',
      'x-forkmind-parent': node.id,
    };
    // Replay to the same upstream the original node used (Ollama, Groq, etc.).
    if (node.meta?.upstream) headers['x-forkmind-upstream'] = node.meta.upstream;
    // Auth header shape differs by provider; forward whichever the user supplied.
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
      headers['x-api-key'] = apiKey; // anthropic style
    }

    setBusy(true);
    try {
      const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
      }
      await res.json();
      onDone(); // triggers a graph refresh in the parent
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
          <strong>⑂ Fork from node {node.id}</strong>
          <div className="status" style={{ fontSize: 12, color: 'var(--muted)' }}>
            {provider} → {node.meta?.upstream || 'default upstream'}
          </div>
        </header>
        <div className="content">
          <label>Request payload (edit the prompt or swap the model)</label>
          <textarea value={payload} onChange={(e) => setPayload(e.target.value)} spellCheck={false} />

          <label>API key (optional — leave blank for keyless local models like Ollama)</label>
          <input
            type="password"
            value={apiKey}
            placeholder="sk-... or gsk_... — stored only in your browser"
            onChange={(e) => setApiKey(e.target.value)}
          />

          {error && <div className="error">{error}</div>}
        </div>
        <footer>
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? 'Running…' : 'Run branch'}
          </button>
        </footer>
      </div>
    </div>
  );
}
