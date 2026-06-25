import dagre from 'dagre';

const NODE_W = 220;
const NODE_H = 96;

/**
 * Extract a short, human-readable preview from a node's request — the latest
 * user message — so the canvas card shows what the turn was about.
 */
function requestPreview(node) {
  const msgs = node.request?.messages;
  if (Array.isArray(msgs) && msgs.length) {
    const last = msgs[msgs.length - 1];
    const c = last?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      // Anthropic / multimodal content blocks.
      const text = c.find((b) => b.type === 'text');
      if (text) return text.text;
    }
  }
  return '(no message)';
}

/**
 * Convert raw ForkMind nodes into React Flow {nodes, edges}, laid out top-down
 * with dagre. Parent→child edges come straight from each node's parentId.
 *
 * @param {object[]} rawNodes
 * @returns {{nodes: object[], edges: object[]}}
 */
export function buildGraph(rawNodes) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 70 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of rawNodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  const edges = [];
  for (const n of rawNodes) {
    if (n.parentId && rawNodes.some((p) => p.id === n.parentId)) {
      g.setEdge(n.parentId, n.id);
      edges.push({
        id: `${n.parentId}->${n.id}`,
        source: n.parentId,
        target: n.id,
        animated: false,
      });
    }
  }

  dagre.layout(g);

  const nodes = rawNodes.map((n) => {
    const pos = g.node(n.id);
    return {
      id: n.id,
      type: 'fmNode',
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data: {
        raw: n,
        preview: requestPreview(n),
        provider: n.meta?.provider || '—',
        stream: !!n.meta?.stream,
      },
    };
  });

  return { nodes, edges };
}
