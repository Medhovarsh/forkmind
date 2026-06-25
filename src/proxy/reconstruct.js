/**
 * Stream reconstruction.
 *
 * When a client calls with `stream: true`, the provider returns Server-Sent
 * Events — a sequence of partial "delta" chunks. We pass those bytes straight
 * to the client untouched, but to STORE the turn we must reassemble the full
 * message. These functions rebuild a non-streaming-shaped response object from
 * the collected chunks so a streamed node looks the same as a normal one.
 */

/**
 * Reassemble an OpenAI-compatible chat completion from streamed chunks.
 * Handles text content AND tool/function-call deltas (which arrive fragmented
 * across many chunks and must be concatenated by index).
 *
 * @param {object[]} chunks - parsed JSON objects from each `data:` line
 *                            (the `[DONE]` sentinel is excluded by the caller).
 * @returns {object} a synthetic chat.completion response.
 */
function reconstructOpenAI(chunks) {
  const contentParts = [];
  const toolCalls = {}; // keyed by delta index
  let role = 'assistant';
  let finishReason = null;
  let id;
  let model;
  let usage;

  for (const chunk of chunks) {
    if (chunk.id) id = chunk.id;
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage; // some providers send usage at the end

    const choice = chunk.choices && chunk.choices[0];
    if (!choice) continue;

    const delta = choice.delta || {};
    if (delta.role) role = delta.role;
    if (typeof delta.content === 'string') contentParts.push(delta.content);

    // Tool calls stream as fragments: id + name arrive once, arguments stream
    // char-by-char. Accumulate per index.
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index != null ? tc.index : 0;
        if (!toolCalls[idx]) {
          toolCalls[idx] = {
            id: tc.id,
            type: tc.type || 'function',
            function: { name: '', arguments: '' },
          };
        }
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function && tc.function.name) {
          toolCalls[idx].function.name += tc.function.name;
        }
        if (tc.function && tc.function.arguments) {
          toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const message = { role, content: contentParts.join('') };
  const tcArr = Object.values(toolCalls);
  if (tcArr.length) {
    message.tool_calls = tcArr;
    // OpenAI sets content to null when only tool calls are returned.
    if (!message.content) message.content = null;
  }

  return {
    id: id || null,
    object: 'chat.completion',
    model: model || null,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: usage || null,
    _forkmind: { reconstructedFromStream: true },
  };
}

/**
 * Reassemble an Anthropic Messages response from its streamed events.
 * Anthropic uses typed events (message_start, content_block_delta, ...). We
 * accumulate text deltas; full fidelity for tool-use blocks is best-effort.
 *
 * @param {object[]} events - parsed JSON objects from each `data:` line.
 * @returns {object} a synthetic messages response.
 */
function reconstructAnthropic(events) {
  const textParts = [];
  let model;
  let id;
  let role = 'assistant';
  let stopReason = null;
  let usage;

  for (const ev of events) {
    if (ev.type === 'message_start' && ev.message) {
      id = ev.message.id;
      model = ev.message.model;
      role = ev.message.role || role;
      if (ev.message.usage) usage = ev.message.usage;
    }
    if (ev.type === 'content_block_delta' && ev.delta) {
      if (typeof ev.delta.text === 'string') textParts.push(ev.delta.text);
    }
    if (ev.type === 'message_delta') {
      if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
      if (ev.usage) usage = { ...(usage || {}), ...ev.usage };
    }
  }

  return {
    id: id || null,
    type: 'message',
    role,
    model: model || null,
    stop_reason: stopReason,
    content: [{ type: 'text', text: textParts.join('') }],
    usage: usage || null,
    _forkmind: { reconstructedFromStream: true },
  };
}

module.exports = { reconstructOpenAI, reconstructAnthropic };
