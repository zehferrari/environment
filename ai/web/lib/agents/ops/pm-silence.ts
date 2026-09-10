export const PM_SILENT_REPLY_TOKEN = "NO_REPLY";
const LEGACY_PM_SILENT_REPLY_TOKEN = "PM_SILENT_NO_CONTRIBUTION";

const TRANSIENT_PROGRESS = [
  /^🧹\s*Compacting context \(\d+ messages?\) so I can continue without losing history…?$/i,
  /^✅\s*Context compacted \([\d,]+\s*(?:→|->)\s*[\d,]+\s+tokens?\)\.?\s*Continuing from where I left off\.?$/i,
];

const TERMINAL_FAILURE = [
  /^⚠️\s*Auto-compaction could not recover this turn\b/i,
  /^⚠️\s*Context is too large and auto-compaction could not recover this turn\b/i,
  /^(?:⚠️\s*)?Context overflow:\s*prompt too large for the model\b/i,
  /^(?:⚠️\s*)?(?:maximum context length|context (?:length|window) (?:is )?(?:exceeded|too large)|prompt (?:is )?too (?:large|long))\b/i,
  /^(?:⚠️\s*)?Model login expired on the gateway for\s+/i,
  /^(?:⚠️\s*)?Agent couldn['’]t generate a response\./i,
  /^(?:⚠️\s*)?(?:🛠️\s*)?Exec failed:\s+/i,
];

const WORKFLOW_ACK_ONLY = [
  /^done[.!]?$/i,
  /^completed[.!]?$/i,
  /^started task[.!]?$/i,
  /^task moved to (?:in progress|review|done|to do)(?: with (?:the )?ready[- ]for[- ]review note posted)?[.!]?$/i,
  /^moved (?:the )?task to (?:in progress|review|done|to do)[.!]?$/i,
  /^ready[- ]for[- ]review note posted[.!]?$/i,
  /^workflow action (?:start|ready_for_review|review_done|triage_to_todo) (?:completed|done)[.!]?$/i,
];

function normalizeReply(value: string) {
  return value
    .replaceAll("\r\n", "\n")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSilentPmReplyText(value: string | null | undefined): boolean {
  const text = normalizeReply(value ?? "");
  if (!text) return false;
  // Do not require word boundaries: some gateways have concatenated the
  // sentinel twice without whitespace.
  if (text.toUpperCase().includes(LEGACY_PM_SILENT_REPLY_TOKEN)) return true;
  if (/^(?:NO_REPLY[\s.]*)+$/i.test(text)) return true;
  return WORKFLOW_ACK_ONLY.some((pattern) => pattern.test(text));
}

/** A provider-routing notice is operational telemetry, not a conversation reply. */
export function modelFallbackActivityText(value: string | null | undefined): string | null {
  const raw = (value ?? "").replaceAll("\r\n", "\n").trim();
  if (raw.includes("\n")) return null;
  const text = raw.replace(/\s+/g, " ");
  if (!text) return null;
  return /^(?:↪️?\s*)?Model Fallback:\s*\S.+$/i.test(text) ? text : null;
}

/** Internal OpenClaw progress is neither a user-visible reply nor a settle. */
export function isTransientPmProgressText(value: string | null | undefined): boolean {
  const text = normalizeReply(value ?? "");
  return Boolean(text) && TRANSIENT_PROGRESS.some((pattern) => pattern.test(text));
}

/** OpenClaw can surface terminal recovery failures as a final text frame. */
export function isPmTerminalFailureText(value: string | null | undefined): boolean {
  const text = normalizeReply(value ?? "");
  return Boolean(text) && TERMINAL_FAILURE.some((pattern) => pattern.test(text));
}
