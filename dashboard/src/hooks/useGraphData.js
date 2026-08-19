import { useCallback, useEffect, useRef, useState } from 'react';

// SSE reconnect backoff. Capped low because the server is local — a restart is
// the common cause, and a stale tree is the cost of waiting.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/**
 * Fetch the conversation tree from the local proxy. Live updates arrive over
 * an SSE stream (/api/stream) so new nodes appear the instant they are
 * captured; the stream reconnects itself with backoff after a drop, and a
 * periodic refresh remains as a fallback when SSE is unavailable.
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
    let es = null;
    let retryTimer = null;
    let attempt = 0;
    let disposed = false; // set on unmount so late callbacks can't revive the stream

    const clearRetry = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || retryTimer) return;
      const backoff = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      // Half fixed, half jittered — keeps many open tabs from retrying in lockstep.
      const delay = backoff / 2 + Math.random() * (backoff / 2);
      attempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, delay);
    };

    function connect() {
      if (disposed) return;
      try {
        es = new EventSource('/api/stream');
      } catch {
        es = null;
        return; // browser without EventSource → poll-only
      }
      es.onopen = () => {
        attempt = 0;
        setStreaming(true);
        // Nodes captured while the stream was down never arrived as events —
        // pull the full graph once so the gap closes immediately.
        refresh();
      };
      es.onerror = () => {
        setStreaming(false);
        // EventSource only auto-reconnects while it is still CONNECTING. Once it
        // lands in CLOSED (suspended tab, server restart, network drop) it stays
        // dead forever, so reconnection is ours to drive.
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          es = null;
          scheduleReconnect();
        }
      };
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
    }

    // Coming back from a suspended tab or a dead network is a strong signal the
    // stream can work again — retry now instead of waiting out the backoff.
    const retryNow = () => {
      if (disposed) return;
      if (es && es.readyState !== EventSource.CLOSED) return; // open or connecting
      if (es) {
        es.close();
        es = null;
      }
      clearRetry();
      attempt = 0;
      connect();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') retryNow();
    };

    connect();
    window.addEventListener('online', retryNow);
    document.addEventListener('visibilitychange', onVisible);

    const timers = freshTimers.current;
    return () => {
      disposed = true;
      clearRetry();
      window.removeEventListener('online', retryNow);
      document.removeEventListener('visibilitychange', onVisible);
      if (es) es.close();
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, [upsertNode, markFresh, refresh]);

  return { nodes, error, loading, refresh, streaming, freshIds };
}
