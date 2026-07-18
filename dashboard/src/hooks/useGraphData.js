import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fetch the conversation tree from the local proxy. Live updates arrive over
 * an SSE stream (/api/stream) so new nodes appear the instant they are
 * captured; a periodic refresh remains as a fallback when SSE is unavailable.
 *
 * @param {number} intervalMs - poll fallback interval; 0 disables polling.
 * @returns {{nodes, error, loading, refresh, streaming, freshIds}}
 *   freshIds is a Set of node ids that just arrived (drives arrival animation).
 */
export function useGraphData(intervalMs = 5000) {
  const [nodes, setNodes] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [freshIds, setFreshIds] = useState(() => new Set());

  // Timers that clear a node's "fresh" flag after the animation window.
  const freshTimers = useRef(new Map());

  const markFresh = useCallback((id) => {
    setFreshIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    const timers = freshTimers.current;
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => {
        setFreshIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        timers.delete(id);
      }, 1200)
    );
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/graph');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setNodes(data.nodes || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Merge one node (from SSE) into the list, replacing any existing copy so
  // parent child-list updates land too.
  const upsertNode = useCallback((node) => {
    setNodes((prev) => {
      const rest = prev.filter((n) => n.id !== node.id);
      return [...rest, node];
    });
  }, []);

  useEffect(() => {
    refresh();
    if (!intervalMs) return undefined;
    const t = setInterval(refresh, intervalMs);
    return () => clearInterval(t);
  }, [refresh, intervalMs]);

  useEffect(() => {
    let es;
    try {
      es = new EventSource('/api/stream');
    } catch {
      return undefined; // browser without EventSource → poll-only
    }
    es.onopen = () => setStreaming(true);
    es.onerror = () => setStreaming(false); // browser auto-reconnects
    es.onmessage = (evt) => {
      try {
        const node = JSON.parse(evt.data);
        upsertNode(node);
        markFresh(node.id);
        // A new child also mutates its parent's children[]; a light refresh
        // reconciles edges without waiting for the next poll tick.
        if (node.parentId) refresh();
      } catch {
        /* ignore malformed frame */
      }
    };
    const timers = freshTimers.current;
    return () => {
      es.close();
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, [upsertNode, markFresh, refresh]);

  return { nodes, error, loading, refresh, streaming, freshIds };
}
