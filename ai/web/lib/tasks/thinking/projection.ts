// Display-only, bounded summaries of emitted activity; never prompt material.
export const THINKING_TEXT_LIMIT = 16_000;
export type ThinkingTool = { id: string; name: string; status: string; at: string };
export type ThinkingState = { progress: string; reasoning: string; tools: string; truncated: boolean };
export type ThinkingInput = { event: string; text?: string; delta?: string; replace?: boolean; toolName?: string; toolCallId?: string; toolStatus?: string };

export function redactThinkingText(text: string, secrets: string[] = []) {
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[redacted]');
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:grant|token|key|secret|signature)=)[^\s&#"'<>]+/gi, '$1[redacted]')
    .replace(/((?:["']?)(?:token|password|api[_-]?key|secret|authorization)(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g, '[redacted]');
}

export function projectThinking(previous: ThinkingState, input: ThinkingInput, seq: number, secrets: string[] = [], now = new Date()) {
  const next = { ...previous };
  const field = input.event === 'reasoning' ? 'reasoning'
    : ['partial', 'token', 'final'].includes(input.event) ? 'progress' : null;
  if (field) {
    const incoming = redactThinkingText(input.delta ?? input.text ?? '', secrets);
    if (incoming && incoming.trim() !== 'NO_REPLY' && incoming.trim() !== 'PM_SILENT_NO_CONTRIBUTION') {
      const old = next[field];
      // Snapshot frames can start a new paragraph after a tool boundary.
      // Keep earlier narration unless the snapshot already contains it.
      const text = input.delta !== undefined ? old + incoming
        : old === incoming || old.endsWith(incoming) ? old
        : incoming.startsWith(old) ? incoming
        : old ? `${old}\n\n${incoming}` : incoming;
      next.truncated ||= text.length > THINKING_TEXT_LIMIT;
      next[field] = redactThinkingText(text, secrets).slice(-THINKING_TEXT_LIMIT);
    }
  }
  if (input.event.startsWith('tool:') && input.toolName) {
    const list = JSON.parse(next.tools) as ThinkingTool[];
    const id = input.toolCallId || `event:${seq}`;
    const item = { id, name: redactThinkingText(input.toolName, secrets).slice(0, 120), status: input.toolStatus || input.event.slice(5), at: now.toISOString() };
    const i = list.findIndex((tool) => tool.id === id);
    if (i < 0) list.push(item); else list[i] = item;
    next.truncated ||= list.length > 100;
    next.tools = JSON.stringify(list.slice(-100));
  }
  return next;
}
