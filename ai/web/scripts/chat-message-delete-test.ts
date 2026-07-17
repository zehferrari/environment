import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const confirmedDeleteButton = readFileSync(
  join(root, "components/confirmed-delete-button.tsx"),
  "utf8",
);
const directChatMessages = readFileSync(
  join(root, "app/(app)/agents/[agent]/chat/chat-messages-container.tsx"),
  "utf8",
);
const directChatPage = readFileSync(
  join(root, "app/(app)/agents/[agent]/chat/page.tsx"),
  "utf8",
);
const directChatActions = readFileSync(
  join(root, "lib/agents/chat/direct/actions.ts"),
  "utf8",
);

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const actionCall = confirmedDeleteButton.indexOf("await action(fd);");
const optimisticCallback = confirmedDeleteButton.indexOf("onSuccess?.();");
const refresh = confirmedDeleteButton.indexOf("router.refresh();");
assert(
  actionCall > -1 && optimisticCallback > actionCall && refresh > optimisticCallback,
  "confirmed message deletion must update local UI and refresh authoritative server state after the action succeeds",
);

assert(
  directChatMessages.includes("setLiveMessages((current) => current.map((message) => (")
    && directChatMessages.includes("? { ...message, deletedAt }"),
  "direct chat must immediately replace a deleted bubble with its deleted divider",
);

const deletedAtSerializers = directChatPage.match(
  /deletedAt: m\.deletedAt\?\.toISOString\(\) \?\? null/g,
) ?? [];
const deletedBySerializers = directChatPage.match(/deletedBy: m\.deletedBy/g) ?? [];
const deletedByQueries = directChatPage.match(
  /deletedBy: \{ select: \{ username: true, name: true, kind: true \} \}/g,
) ?? [];
assert(
  deletedAtSerializers.length >= 2 && deletedBySerializers.length >= 2,
  "live and parent/archive direct-chat rows must preserve soft-delete metadata across a server refresh",
);
assert(
  deletedByQueries.length >= 3,
  "active, selected-archive, and parent-archive queries must load the actor who deleted each row",
);

assert(
  directChatActions.includes("data: { deletedAt: new Date(), deletedById: userId }")
    && directChatActions.includes('kind: "agent.direct_chat.delete"'),
  "direct chat deletion must remain a soft-delete with a human audit record",
);

console.log("chat message delete contract ok");
