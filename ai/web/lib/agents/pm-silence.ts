export const PM_SILENT_REPLY_TOKEN = "PM_SILENT_NO_CONTRIBUTION";

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
  const tokenPattern = new RegExp(`\\b${PM_SILENT_REPLY_TOKEN}\\b`, "i");
  if (tokenPattern.test(text)) return true;
  return WORKFLOW_ACK_ONLY.some((pattern) => pattern.test(text));
}
