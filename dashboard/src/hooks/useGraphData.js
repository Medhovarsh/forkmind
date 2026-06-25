import { useCallback, useEffect, useState } from 'react';

/**
 * Fetch the conversation tree from the local proxy and poll for changes so the
 * canvas auto-refreshes when new nodes (or branches) are created.
 *
 * @param {number} intervalMs - poll interval; 0 disables polling.
 */
export function useGraphData(intervalMs = 2000) {
  const [nodes, setNodes] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

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

  useEffect(() => {
    refresh();
    if (!intervalMs) return undefined;
    const t = setInterval(refresh, intervalMs);
    return () => clearInterval(t);
  }, [refresh, intervalMs]);

  return { nodes, error, loading, refresh };
}
