import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertOneTarget } from "../lib/attachments/storage";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

assert.doesNotThrow(
  () => assertOneTarget({ projectId: "project-1", taskId: null, epicId: null }),
  "a project-owned attachment must not require a task or epic",
);
assert.doesNotThrow(
  () => assertOneTarget({ projectId: "project-1", taskId: "task-1", epicId: null }),
  "a task-owned attachment must remain valid",
);
assert.doesNotThrow(
  () => assertOneTarget({ projectId: "project-1", taskId: null, epicId: "epic-1" }),
  "an epic-owned attachment must remain valid",
);
assert.throws(
  () => assertOneTarget({ projectId: "project-1", taskId: "task-1", epicId: "epic-1" }),
  /cannot reference both/,
  "an attachment must never target both a task and an epic",
);

const actions = read("lib/attachments/actions.ts");
const service = read("lib/attachments/service.ts");
const library = read("app/(app)/projects/[slug]/library/page.tsx");
const downloadRoute = read("app/api/attachments/[id]/route.ts");
const agentUploadRoute = read("app/api/agent/tasks/[taskId]/attachments/route.ts");
const activity = read("lib/activity.ts");

for (const [kind, source] of [["project.attachment.add", service], ["project.attachment.delete", actions]] as const) {
  assert(source.includes(`"${kind}"`), `attachment persistence must emit ${kind}`);
  assert(activity.includes(`case "${kind}"`), `activity formatter must describe ${kind}`);
}
assert(
  actions.includes("revalidatePath(`/projects/${slug}/library`)") &&
    actions.split("revalidatePath(`/projects/${slug}/library`)").length - 1 === 2,
  "upload and delete must both invalidate the project Library",
);
assert(
  library.includes("{ taskId: null, epicId: null }"),
  "the project Library must include project-owned attachments",
);
assert(
  downloadRoute.includes("accessibleAttachmentWhere(viewer, { id: attachmentId })"),
  "signed-in project members must be able to download project-owned attachments",
);
assert(
  agentUploadRoute.includes("verifyTaskWorkflowToken") &&
    agentUploadRoute.includes("hasAuthorizedTaskAgentOrigin") &&
    agentUploadRoute.includes('task.status === "In Progress"') &&
    agentUploadRoute.includes('task.status === "Review"') &&
    agentUploadRoute.includes("storeAttachment"),
  "agent upload must be task-token scoped, role/status fenced, and share attachment persistence",
);

console.log("attachment target contract ok");
