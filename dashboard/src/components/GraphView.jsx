import React, { useMemo } from 'react';
import ReactFlow, { Background, Controls, MiniMap, Handle, Position } from 'reactflow';
import 'reactflow/dist/style.css';
import { buildGraph } from '../lib/layout.js';

/**
 * Custom canvas card for a conversation node.
 */
function FmNode({ data, selected }) {
  return (
    <div className={`fm-node ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="role">{data.provider}</div>
      <div className="preview">{data.preview}</div>
      <div className="meta">
        {data.model && <span className="badge model">{data.model}</span>}
        {data.stream && <span className="badge stream">stream</span>}
        <span className="badge">{data.raw.id}</span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { fmNode: FmNode };

/**
 * React Flow canvas rendering the conversation DAG.
 */
export default function GraphView({ rawNodes, selectedId, onSelect }) {
  const { nodes, edges } = useMemo(() => buildGraph(rawNodes), [rawNodes]);

  // Reflect selection into node props so the card can highlight.
  const decorated = nodes.map((n) => ({ ...n, selected: n.id === selectedId }));

  return (
    <ReactFlow
      nodes={decorated}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, node) => onSelect(node.data.raw)}
      fitView
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#30363d" gap={20} />
      <MiniMap
        pannable
        zoomable
        style={{ background: '#161b22' }}
        maskColor="rgba(13,17,23,0.7)"
        nodeColor="#30363d"
      />
      <Controls />
    </ReactFlow>
  );
}
