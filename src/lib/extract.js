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

function clip(s, n = 240) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

module.exports = { userPreview, assistantText, clip };
