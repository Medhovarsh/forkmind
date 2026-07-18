import React from 'react';

/**
 * Pull the assistant's text out of either an OpenAI-shaped or Anthropic-shaped
 * response for a quick-read summary.
 */
function responseText(node) {
  const r = node.response;
  if (!r) return '';
  if (r.choices?.[0]?.message) {
    const m = r.choices[0].message;
    if (m.content) return m.content;
    if (m.tool_calls) return `[tool_calls] ${JSON.stringify(m.tool_calls, null, 2)}`;
  }
  if (Array.isArray(r.content)) {
    return r.content.map((b) => b.text || `[${b.type}]`).join('\n');
  }
  return '';
}

/**
 * Sidebar inspector: formatted request/response JSON, token usage, provenance,
 * and the entry point to forking a branch from this node.
 */
export default function NodePanel({ node, onClose, onFork, onCompare, canFork = true }) {
  if (!node) return null;
  const usage = node.response?.usage;

  return (
    <aside className="sidebar">
      <header>
        <h2>Node {node.id}</h2>
        <button onClick={onClose}>✕</button>
      </header>
      <div className="body">
        <h3>Summary</h3>
        <pre className="json">{responseText(node) || '(no text response)'}</pre>

        <h3>Provenance</h3>
        <pre className="json">
          {JSON.stringify(
            {
              parentId: node.parentId,
              provider: node.meta?.provider,
              upstream: node.meta?.upstream,
              stream: node.meta?.stream,
              timestamp: node.timestamp,
            },
            null,
            2
          )}
        </pre>

        {usage && (
          <>
            <h3>Tokens</h3>
            <pre className="json">{JSON.stringify(usage, null, 2)}</pre>
          </>
        )}

        <h3>Request</h3>
        <pre className="json">{JSON.stringify(node.request, null, 2)}</pre>

        <h3>Response</h3>
        <pre className="json">{JSON.stringify(node.response, null, 2)}</pre>

        <button
          className="fork"
          onClick={() => onFork(node)}
          disabled={!canFork}
          title={canFork ? undefined : 'Install Ollama for live forking — demo data is canned.'}
        >
          ⑂ Fork from here
        </button>
        {!canFork && (
          <div className="fork-hint">
            Install <a href="https://ollama.com" target="_blank" rel="noreferrer">Ollama</a> for
            live forking — demo data is canned.
          </div>
        )}
        <button className="compare" onClick={() => onCompare(node)}>
          ⇄ Compare with…
        </button>
      </div>
    </aside>
  );
}
