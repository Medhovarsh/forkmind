const crypto = require('crypto');

/**
 * Deterministic node ID.
 *
 * Same (requestPayload, parentNodeId) => same ID, always. This makes the
 * conversation tree content-addressed: identical requests under the same
 * parent collapse to one node instead of duplicating.
 *
 * Parent is mixed into the hash so the SAME request appearing at two different
 * points in the tree gets two distinct IDs — position in the branch matters.
 *
 * NOTE: the ID intentionally does NOT depend on the response. This lets the
 * proxy compute the node id BEFORE a (streaming) response arrives, set it as a
 * response header, then save the reconstructed body later under the same id.
 *
 * @param {object} requestPayload - the LLM request body (messages, model, etc.)
 * @param {string|null} parentNodeId - parent node ID, or null for a root.
 * @returns {string} first 12 hex chars of the SHA-256 digest.
 */
function generateNodeId(requestPayload, parentNodeId) {
  // Stable stringify. Key order follows insertion order; payloads come straight
  // from the SDK with consistent shape so this is fine. Swap for a sorted-key
  // serializer if you ever need order-independence.
  const payloadString = JSON.stringify(requestPayload);

  // Empty string for roots keeps hash material well-defined (no
  // "null"/"undefined" ambiguity).
  const parentPart = parentNodeId || '';

  const hash = crypto.createHash('sha256');
  hash.update(payloadString);
  hash.update(parentPart);

  // 12 hex chars = 48 bits. Ample collision headroom for a local debug tree.
  return hash.digest('hex').slice(0, 12);
}

module.exports = { generateNodeId };
