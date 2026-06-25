const path = require('path');
const fs = require('fs-extra');
const { generateNodeId } = require('./hash');

// Paths resolved PER CALL from process.cwd() — not cached at module load.
// This is what lets tests chdir into a temp dir and get isolated storage.
function paths() {
  const root = path.join(process.cwd(), '.forkmind');
  return {
    root,
    nodesDir: path.join(root, 'nodes'),
    manifest: path.join(root, 'manifest.json'),
  };
}

function nodePath(id) {
  return path.join(paths().nodesDir, `${id}.json`);
}

/**
 * Create the .forkmind/ structure if absent. Idempotent.
 *   .forkmind/
 *   ├── nodes/          one JSON file per conversation node
 *   └── manifest.json   tree-level metadata (version, roots)
 * @returns {string} absolute path to the .forkmind root.
 */
function initStorage() {
  const { root, nodesDir, manifest } = paths();

  // Creates dir + parents only if missing — never clobbers.
  fs.ensureDirSync(nodesDir);

  // Seed manifest only on first init so existing tree state survives re-init.
  if (!fs.existsSync(manifest)) {
    fs.writeJsonSync(
      manifest,
      { version: '0.1.0', createdAt: new Date().toISOString(), roots: [] },
      { spaces: 2 }
    );
  }

  return root;
}

/**
 * Persist one conversation node and wire it into the tree.
 *
 * @param {string|null} parentNodeId
 * @param {object} requestPayload
 * @param {object} responsePayload
 * @param {object} [meta] - provenance: { provider, upstream, stream, status }.
 *                          Lets the dashboard replay a branch to the same host.
 * @returns {string} new node ID.
 */
function saveNode(parentNodeId, requestPayload, responsePayload, meta = {}) {
  const { nodesDir, manifest } = paths();
  fs.ensureDirSync(nodesDir); // safe even if init never ran

  // Content-addressed ID from request + parent (see hash.js).
  const id = generateNodeId(requestPayload, parentNodeId);

  const node = {
    id,
    parentId: parentNodeId || null,
    timestamp: new Date().toISOString(),
    request: requestPayload,
    response: responsePayload,
    meta, // { provider, upstream, stream, status }
    children: [],
  };

  // Write node first. Re-save of identical content+parent overwrites with the
  // same data — keeps the op idempotent on replays.
  fs.writeJsonSync(nodePath(id), node, { spaces: 2 });

  if (parentNodeId && fs.existsSync(nodePath(parentNodeId))) {
    // Linked child: append id to parent's children, with a dup guard so
    // replays never double-push.
    const parent = fs.readJsonSync(nodePath(parentNodeId));
    if (!parent.children.includes(id)) {
      parent.children.push(id);
      fs.writeJsonSync(nodePath(parentNodeId), parent, { spaces: 2 });
    }
  } else if (!parentNodeId) {
    // Root node: track it in the manifest so the dashboard can find tree entry
    // points without scanning. Dup-guarded.
    if (fs.existsSync(manifest)) {
      const m = fs.readJsonSync(manifest);
      if (!Array.isArray(m.roots)) m.roots = [];
      if (!m.roots.includes(id)) {
        m.roots.push(id);
        fs.writeJsonSync(manifest, m, { spaces: 2 });
      }
    }
  }

  return id;
}

/**
 * Read one node by id, or null if missing.
 */
function readNode(id) {
  const p = nodePath(id);
  return fs.existsSync(p) ? fs.readJsonSync(p) : null;
}

/**
 * Read every node JSON into one array. Powers the dashboard's /api/graph.
 * @returns {object[]} all nodes (unordered).
 */
function readAllNodes() {
  const { nodesDir } = paths();
  if (!fs.existsSync(nodesDir)) return [];
  return fs
    .readdirSync(nodesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => fs.readJsonSync(path.join(nodesDir, f)));
}

module.exports = {
  initStorage,
  saveNode,
  readNode,
  readAllNodes,
  paths,
  nodePath,
};
