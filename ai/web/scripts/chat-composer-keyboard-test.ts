import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const chatRooms = [
  "components/legacy-chat-room.tsx",
  "components/chat-room-decomposed.tsx",
];
const maximizableTextarea = readFileSync(join(root, "components/maximizable-textarea.tsx"), "utf8");

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

for (const relativePath of chatRooms) {
  const source = readFileSync(join(root, relativePath), "utf8");

  assert(
    source.includes('e.key === "Enter" && !e.shiftKey')
      && source.includes("formRef.current?.requestSubmit()"),
    `${relativePath} must submit on bare Enter while leaving Shift+Enter to insert a newline`,
  );
  assert(
    source.includes("if (canSend) formRef.current?.requestSubmit()"),
    `${relativePath} must guard Enter-submit when the composer is empty`,
  );
  assert(
    source.includes("composerDraftStorageKey")
      && source.includes("window.localStorage")
      && source.includes("selectedTargets")
      && source.includes("composerDraftSnapshotsRef"),
    `${relativePath} must persist composer drafts per thread/target`,
  );
  assert(
    source.includes("setSelectedFiles(fileListFromInput(event.currentTarget))")
      && source.includes("formData.append(\"attachments\", file)")
      && source.includes("Ready to attach:"),
    `${relativePath} must keep optimistic attachment state visible and submit controlled files`,
  );
  assert(
    !source.includes("setSelectedFilesCount")
      && !source.includes('name="attachments"\n                      multiple'),
    `${relativePath} must not rely on a remounted/uncontrolled file input as attachment state`,
  );
  assert(
    source.includes("window.requestAnimationFrame(() => textareaRef.current?.focus())")
      && !source.includes("resetComposerAfterSend = () => {\n    setMessageText(\"\");\n    setSelectedFiles([]);\n    composerDraftSnapshotsRef.current.delete(composerDraftKeyRef.current);\n    writeStoredComposerDraft(composerDraftKeyRef.current, \"\");\n    setComposerOpen(false);"),
    `${relativePath} must keep focus in the composer after successful send`,
  );
}

assert(
  maximizableTextarea.includes("onKeyDown={props.onKeyDown}"),
  "expanded composer textarea must preserve Enter/Shift+Enter keyboard behavior",
);

console.log("chat composer keyboard contract ok");
