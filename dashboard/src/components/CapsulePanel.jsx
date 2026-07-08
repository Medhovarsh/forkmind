import React, { useEffect, useState, useCallback } from 'react';

/**
 * Read-only capsule browser. Lists saved context capsules (title, digest,
 * size, estimated tokens), expands one into its digest + DAG segment map,
 * and runs an on-demand integrity verification.
 *
 * Deliberately read-only: save/restore/forget stay in the CLI, HTTP API, and
 * MCP tools so the browser can never decrypt content or shred a capsule.
 */
export default function CapsulePanel({ onClose }) {
  const [capsules, setCapsules] = useState([]);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [verify, setVerify] = useState({}); // id → result | 'running'

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/context');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCapsules(data.capsules || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const runVerify = async (id) => {
    setVerify((v) => ({ ...v, [id]: 'running' }));
    try {
      const res = await fetch(`/api/context/${id}/verify`, { method: 'POST' });
      const result = await res.json();
      setVerify((v) => ({ ...v, [id]: result }));
    } catch (e) {
      setVerify((v) => ({ ...v, [id]: { ok: false, reason: e.message } }));
    }
  };

  return (
    <aside className="sidebar">
      <header>
        <h2>💊 Context capsules ({capsules.length})</h2>
        <button onClick={onClose}>✕</button>
      </header>
      <div className="body">
        {error && <div className="error">proxy error: {error}</div>}
        {!error && capsules.length === 0 && (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            No capsules saved yet. Offload context via the CLI (
            <code>forkmind context save</code>), the HTTP API, or the
            <code> forkmind_context_save</code> MCP tool.
          </div>
        )}

        {capsules.map((c) => {
          const open = openId === c.id;
          const v = verify[c.id];
          return (
            <div key={c.id} className="capsule-card">
              <div
                className="capsule-head"
                onClick={() => setOpenId(open ? null : c.id)}
              >
                <span className="capsule-title">{c.title}</span>
                <span className="capsule-meta">
                  {c.id} · {c.bytes}B · {c.dag.segments.length} seg
                </span>
              </div>
              <div className="capsule-digest">
                {c.digest ? c.digest : <em>(private — no digest)</em>}
              </div>

              {open && (
                <div className="capsule-detail">
                  <h3>Segments (DAG)</h3>
                  <pre className="json">
                    {JSON.stringify(
                      c.dag.segments.map((s) => ({
                        id: s.id,
                        role: s.role,
                        bytes: s.bytes,
                        parents: s.parents.length,
                      })),
                      null,
                      2
                    )}
                  </pre>

                  <button onClick={() => runVerify(c.id)} disabled={v === 'running'}>
                    {v === 'running' ? 'verifying…' : '✓ Verify integrity'}
                  </button>
                  {v && v !== 'running' && (
                    <pre className="json" style={{ marginTop: 8 }}>
                      {JSON.stringify(v, null, 2)}
                    </pre>
                  )}
                  <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 10 }}>
                    Restore: <code>forkmind context show {c.id}</code> or the
                    <code> forkmind_context_restore</code> MCP tool.
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
