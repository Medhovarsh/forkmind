/**
 * Shared helpers to pull human-readable text out of provider request/response
 * payloads (OpenAI-shaped and Anthropic-shaped). Used by the MCP server and the
 * regression engine so previews/comparisons stay consistent.
 */

/** Latest user message text from a request. */
function userPreview(request) {
  const msgs = request && request.messages;
  if (Array.isArray(msgs) && msgs.length) {
    const last = msgs[msgs.length - 1];
    const c = last && last.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const t = c.find((b) => b.type === 'text');
      if (t) return t.text;
    }
  }
  return '';
}

/** Assistant text from a response (text, or a tool-call summary). */
function assistantText(response) {
  const r = response;
  if (!r) return '';
  if (r.choices && r.choices[0] && r.choices[0].message) {
    const m = r.choices[0].message;
    if (m.content) return m.content;
    if (m.tool_calls) return `[tool_calls] ${JSON.stringify(m.tool_calls)}`;
  }
  if (Array.isArray(r.content)) {
    return r.content.map((b) => b.text || `[${b.type}]`).join('\n');
  }
  return '';
}

/**
 * Normalized tool/function calls from a response, across provider shapes.
 *
 * OpenAI puts them on `message.tool_calls` with the arguments as a JSON
 * *string*; Anthropic emits `tool_use` content blocks with `input` already an
 * object. Both collapse to `{ name, args }` so assertions don't have to care
 * which provider produced the call.
 *
 * A model that emits malformed argument JSON is a real failure mode, not an
 * exception: the call is still reported, with the unparsed text under
 * `args._raw`, so an assertion fails loudly instead of the call vanishing.
 *
 * @returns {Array<{name:string, args:object}>}
 */
function toolCalls(response) {
  const r = response;
  if (!r) return [];
  const out = [];

  const openai = r.choices && r.choices[0] && r.choices[0].message;
  if (openai && Array.isArray(openai.tool_calls)) {
    for (const tc of openai.tool_calls) {
      const fn = tc.function || {};
      let args = {};
      if (typeof fn.arguments === 'string') {
        try {
          args = JSON.parse(fn.arguments);
        } catch (e) {
          args = { _raw: fn.arguments };
        }
      } else if (fn.arguments && typeof fn.arguments === 'object') {
        args = fn.arguments;
      }
      out.push({ name: fn.name || tc.name || '', args });
    }
  }

  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      if (block && block.type === 'tool_use') {
        out.push({ name: block.name || '', args: block.input || {} });
      }
    }
  }

  return out;
}

/**
 * Deep "expected is a subset of actual" comparison. Lets an assertion pin the
 * arguments that matter (`{ priority: 'high' }`) without having to restate
 * every field the model happens to send.
 */
function matchesSubset(expected, actual) {
  if (expected === null || typeof expected !== 'object') return expected === actual;
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false;
    return expected.every((v, i) => matchesSubset(v, actual[i]));
  }
  return Object.keys(expected).every((k) => matchesSubset(expected[k], actual[k]));
}

function clip(s, n = 240) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

module.exports = { userPreview, assistantText, toolCalls, matchesSubset, clip };
