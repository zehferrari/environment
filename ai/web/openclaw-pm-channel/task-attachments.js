// Task attachment credentials remain bound to the active ingress generation.
export async function uploadPmTaskAttachment({ turn, findTurn, mediaUrl, loadMedia, fetchImpl = fetch }) {
  const assertCurrent = () => {
    if (!turn || findTurn() !== turn || turn.abortedAt || turn.completedAction) throw new Error("PM attachment turn is no longer active");
    if (!turn.taskRuntime || !["task-chat", "task-comment"].includes(turn.replyTarget?.kind) || turn.taskRuntime.taskId !== turn.replyTarget.taskId || turn.taskRuntime.messageId !== turn.replyTarget.messageId) throw new Error("PM attachments require an active scoped task turn");
  };
  assertCurrent();
  const grant = turn.taskRuntime;
  const url = new URL(grant.workflowUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:' || url.pathname !== `/api/agent/tasks/${grant.taskId}/workflow`) throw new Error("Invalid PM attachment endpoint");
  url.pathname = `/api/agent/tasks/${grant.taskId}/attachments`;
  url.search = "";
  const media = await loadMedia(mediaUrl);
  assertCurrent();
  if (!media.buffer?.length || media.buffer.length > 10 * 1024 * 1024) throw new Error("PM attachment must be non-empty and at most 10 MiB");
  const filename = String(media.fileName || "attachment").split(/[\\/]/).pop() || "attachment";
  const form = new FormData();
  form.set("messageId", grant.messageId);
  form.set("token", grant.token);
  form.set("file", new Blob([media.buffer], { type: media.contentType || "application/octet-stream" }), filename);
  const response = await fetchImpl(url.toString(), { method: "POST", body: form });
  const body = await response.json();
  if (!response.ok || !body?.attachment?.id) throw new Error(`PM attachment upload failed (HTTP ${response.status})`);
  assertCurrent();
  return { id: body.attachment.id, filename, downloadUrl: `/api/attachments/${encodeURIComponent(body.attachment.id)}` };
}
