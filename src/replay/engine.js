const { readNode, getLineage, saveNode } = require('../storage/engine');

/**
 * Messages a lineage node added AFTER its parent's assistant reply.
 *
 * Consecutive captured requests share a prefix: child.request.messages =
 * parent.request.messages + [parent's assistant message] + tail. The tail is
 * the user turns / tool results the conversation added before the next call —
 * exactly what must re-apply on top of a regenerated history.
 */
function tailMessages(parentNode, childNode) {
  const parentLen = (parentNode.request?.messages || []).length;
  const childMsgs = childNode.request?.messages || [];
  return childMsgs.slice(parentLen + 1);
}

/** Assistant message object from an OpenAI-shaped response. */
function assistantMessage(response) {
  const m = response?.choices?.[0]?.message;
  if (!m) throw new Error('upstream response has no choices[0].message');
  return m;
}

/**
 * Root→leaf lineage sliced to start at fromNodeId.
 * @throws when ids are unknown or leaf is not downstream of fromNode.
 */
function replayPath(fromNodeId, leafId) {
  if (!readNode(fromNodeId)) throw new Error(`node not found: ${fromNodeId}`);
  const lineage = getLineage(leafId);
  if (!lineage.length) throw new Error(`node not found: ${leafId}`);
  const start = lineage.findIndex((n) => n.id === fromNodeId);
  if (start === -1) throw new Error(`${leafId} is not a descendant of ${fromNodeId}`);
  return lineage.slice(start);
}

/**
 * Replay a captured chain with a modified first request.
 *
 * The first result saves as a SIBLING of the edited node (an alternate
 * history, parent = fromNode.parentId); each later result chains under the
 * previous new node. Original tails (user turns, tool results) re-apply
 * verbatim — no live tool execution.
 *
 * @param {object} opts
 * @param {string} opts.fromNodeId  node whose request was edited
 * @param {string} opts.leafId      end of the downstream path to replay
 * @param {object} opts.request     full edited request body for the first call
 * @param {string} [opts.model]     override model on every replayed call
 * @param {function} opts.forwardFn async (body) => ({ status, data }) — transport
 * @returns {Promise<{nodes: string[]}>} new node ids in replay order
 * @throws {Error & {saved?: string[]}} upstream failure mid-chain; `saved`
 *         carries the ids persisted before the failure.
 */
async function replayChain({ fromNodeId, leafId, request, model, forwardFn }) {
  const path = replayPath(fromNodeId, leafId);
  const fromNode = path[0];
  if ((fromNode.meta?.provider || 'openai') !== 'openai') {
    throw new Error('replay supports openai-shaped chains only');
  }

  const saved = [];
  let parentId = fromNode.parentId || null;
  let messages = (request.messages || []).slice();
  let body = { ...request, messages, stream: false };
  if (model) body.model = model;

  for (let step = 0; step < path.length; step += 1) {
    const { status, data } = await forwardFn(body);
    if (status < 200 || status >= 300) {
      const err = new Error(
        `upstream returned ${status} at step ${step + 1}/${path.length}: ` +
          JSON.stringify(data).slice(0, 300)
      );
      err.saved = saved;
      throw err;
    }

    const meta = { ...fromNode.meta, stream: false, status, replayOf: path[step].id };
    parentId = saveNode(parentId, body, data, meta);
    saved.push(parentId);

    if (step + 1 >= path.length) break;

    // Thread the regenerated reply + the original tail into the next call.
    messages = [...messages, assistantMessage(data), ...tailMessages(path[step], path[step + 1])];
    body = { ...path[step + 1].request, messages, stream: false };
    if (model) body.model = model;
  }

  return { nodes: saved };
}

module.exports = { replayChain, replayPath, tailMessages };
