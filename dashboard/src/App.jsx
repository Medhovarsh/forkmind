import React, { useState } from 'react';
import { ReactFlowProvider } from 'reactflow';
import GraphView from './components/GraphView.jsx';
import NodePanel from './components/NodePanel.jsx';
import BranchModal from './components/BranchModal.jsx';
import { useGraphData } from './hooks/useGraphData.js';

export default function App() {
  const { nodes, error, loading, refresh } = useGraphData(2000);
  const [selected, setSelected] = useState(null);
  const [forking, setForking] = useState(null);

  // Keep the selected node object in sync with fresh poll data.
  const selectedNode = selected ? nodes.find((n) => n.id === selected.id) || selected : null;

  return (
    <div className="app">
      <div className="graph-pane">
        <div className="topbar">
          <span className="brand">ForkMind 🧠</span>
          <span className="status">
            {loading ? 'loading…' : `${nodes.length} nodes`}
            {error ? `  ·  proxy offline (${error})` : '  ·  live'}
          </span>
        </div>

        {nodes.length === 0 && !loading ? (
          <div className="empty">
            <div style={{ fontSize: 28 }}>🧠</div>
            <div>No conversations captured yet.</div>
            <div style={{ fontSize: 12 }}>
              Point your LLM client at <code>http://localhost:4500/v1</code> and make a call.
            </div>
          </div>
        ) : (
          <ReactFlowProvider>
            <GraphView
              rawNodes={nodes}
              selectedId={selectedNode?.id}
              onSelect={(n) => setSelected(n)}
            />
          </ReactFlowProvider>
        )}
      </div>

      {selectedNode && (
        <NodePanel
          node={selectedNode}
          onClose={() => setSelected(null)}
          onFork={(n) => setForking(n)}
        />
      )}

      {forking && (
        <BranchModal
          node={forking}
          onClose={() => setForking(null)}
          onDone={() => {
            setForking(null);
            refresh(); // show the new branch immediately
          }}
        />
      )}
    </div>
  );
}
