import dagre from 'dagre';

const NODE_W = 220;
const NODE_H = 96;

/** Text of a message's content, handling Anthropic/multimodal block arrays. */
function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const text = c.find((b) => b.type === 'text');
    if (text) return text.text;
  }
  return '';
}

/** Resolve a tool_call_id back to its function name via the assistant message that issued it. */
function toolName(msgs, callId) {
  for (const m of msgs) {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    const hit = m.tool_calls.find((t) => t.id === callId);
    if (hit) return hit.function?.name;
  }
  return null;
}

/**
 * Extract a short, human-readable preview from a node's request so the canvas
 * card shows what the turn was about. Agent flows interleave tool results into
 * the transcript, so the LAST message is often a raw tool dump — label those
 * turns with the tool that ran instead of splattering its output on the card.
 */
function requestPreview(node) {
  const msgs = node.request?.messages;
  if (!Array.isArray(msgs) || !msgs.length) return '(no message)';

  const last = msgs[msgs.length - 1];
  if (last?.role === 'tool') {
    const name = toolName(msgs, last.tool_call_id) || 'tool';
    const firstLine = contentText(last.content).split('\n')[0].trim();
    return `⚙ ${name} → ${firstLine}`;
  }

  // Otherwise: the latest human turn drives this call.
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].role !== 'user') continue;
    const text = contentText(msgs[i].content);
    if (text) return text;
  }
  return contentText(last?.content) || '(no message)';
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
        model: n.request?.model || null,
        stream: !!n.meta?.stream,
      },
    };
  });

  return { nodes, edges };
}
