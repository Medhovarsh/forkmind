import React, { useEffect, useState } from 'react';
import { ReactFlowProvider } from 'reactflow';
import GraphView from './components/GraphView.jsx';
import NodePanel from './components/NodePanel.jsx';
import BranchModal from './components/BranchModal.jsx';
import CompareView from './components/CompareView.jsx';
import ReplayModal from './components/ReplayModal.jsx';
import CapsulePanel from './components/CapsulePanel.jsx';
import { useGraphData } from './hooks/useGraphData.js';

export default function App() {
  const { nodes, error, loading, refresh } = useGraphData(2000);
  const [selected, setSelected] = useState(null);
  const [forking, setForking] = useState(null);
  const [showCapsules, setShowCapsules] = useState(false);
  // Compare flow: compareFrom = first node picked; comparePair = both picked.
  const [compareFrom, setCompareFrom] = useState(null);
  const [comparePair, setComparePair] = useState(null);
  const [replaying, setReplaying] = useState(null);
  // { demo, liveForking } — served by the proxy; demo mode disables forking
  // when no local model is available to fork against.
  const [demoStatus, setDemoStatus] = useState({ demo: false, liveForking: true });

  useEffect(() => {
    fetch('/api/demo-status')
      .then((r) => r.json())
      .then(setDemoStatus)
      .catch(() => {}); // older proxy without the endpoint → keep defaults
  }, []);

  // Escape backs out of compare mode / the compare modal.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setComparePair(null);
      setCompareFrom(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function handleSelect(n) {
    if (compareFrom) {
      if (n.id !== compareFrom.id) setComparePair([compareFrom, n]);
      setCompareFrom(null);
      return;
    }
    setSelected(n);
  }

  // Keep the selected node object in sync with fresh poll data.
  const selectedNode = selected ? nodes.find((n) => n.id === selected.id) || selected : null;

  return (
    <div className="app">
      <div className="graph-pane">
        <div className="topbar">
          <span className="brand">ForkMind 🧠</span>
          {demoStatus.demo && <span className="demo-badge">DEMO</span>}
          <span className="status">
            {loading ? 'loading…' : `${nodes.length} nodes`}
            {error ? `  ·  proxy offline (${error})` : '  ·  live'}
          </span>
          <button
            className="capsule-toggle"
            onClick={() => {
              setShowCapsules((s) => !s);
              setSelected(null); // one sidebar at a time
            }}
          >
            💊 Capsules
          </button>
        </div>

        {compareFrom && (
          <div className="compare-banner">
            ⇄ Comparing from <code>{compareFrom.id}</code> — click another node
            <button onClick={() => setCompareFrom(null)}>Cancel</button>
          </div>
        )}

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
              onSelect={handleSelect}
            />
          </ReactFlowProvider>
        )}
      </div>

      {selectedNode && !showCapsules && (
        <NodePanel
          node={selectedNode}
          onClose={() => setSelected(null)}
          onFork={(n) => setForking(n)}
          onCompare={(n) => {
            setCompareFrom(n);
            setSelected(null); // free the canvas for picking the second node
          }}
          onReplay={(n) => setReplaying(n)}
          canFork={demoStatus.liveForking}
        />
      )}

      {showCapsules && <CapsulePanel onClose={() => setShowCapsules(false)} />}

      {comparePair && (
        <CompareView
          a={comparePair[0]}
          b={comparePair[1]}
          onClose={() => setComparePair(null)}
        />
      )}

      {replaying && (
        <ReplayModal
          node={replaying}
          nodes={nodes}
          onClose={() => setReplaying(null)}
          onDone={() => {
            setReplaying(null);
            refresh();
          }}
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
