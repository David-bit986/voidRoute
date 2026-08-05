// Normalize strict OpenAI-compatible message shapes before upstream dispatch.
//
// Some clients (e.g. opencode) emit assistant messages carrying an empty
// `tool_calls: []` array. Strict providers (DeepSeek, OpenCode Zen, ...) reject
// that shape with 400 (`Invalid 'messages[N].tool_calls': empty array`).
// Removing the key preserves semantics: an assistant message without tool calls
// is simply an assistant message.
export function sanitizeEmptyToolCalls(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  for (const msg of body.messages) {
    if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length === 0) {
      delete msg.tool_calls;
    }
  }
  return body;
}
