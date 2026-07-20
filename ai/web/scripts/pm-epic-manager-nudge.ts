// Directed epic-chat nudge to one agent (usually the acting manager),
// dispatched through the native PM channel so the turn carries a fresh Epic
// manager workflow grant. Grant authorization comes from the durable
// `epic.workflow.notify` audit row written by sendEpicWorkflowNotification,
// so the sender is the monitor agent (owner fallback) — no owner
// impersonation.
//
// Usage:
//   tsx scripts/pm-epic-manager-nudge.ts --epic-id <id> --agent <slug> --message <text>
//
// Run as the PM app user with the production env loaded (/etc/default/pm +
// /etc/default/pm-active-worktree).
import { db } from "@/lib/db";
import { sendEpicWorkflowNotification } from "@/lib/agents/workflow/notifications/epic";

type Args = { epicId?: string; agent?: string; message?: string };

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--epic-id" && next) {
      out.epicId = next;
      i += 1;
    } else if (arg === "--agent" && next) {
      out.agent = next;
      i += 1;
    } else if (arg === "--message" && next) {
      out.message = next;
      i += 1;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.epicId || !args.agent || !args.message?.trim()) {
    throw new Error("Usage: pm-epic-manager-nudge --epic-id <id> --agent <slug> --message <text>");
  }

  const sender = await db.user.findFirst({
    where: {
      status: "active",
      kind: "agent",
      agent: { is: { role: "monitor", deactivatedAt: null } },
    },
    select: { id: true, username: true },
  }) ?? await db.user.findFirst({
    where: { kind: "human", status: "active", isOwner: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, username: true },
  });
  if (!sender) throw new Error("No active sender (monitor or owner) found");

  const senderIsAgent = Boolean(await db.user.findFirst({
    where: { id: sender.id, kind: "agent" },
    select: { id: true },
  }));

  const result = await sendEpicWorkflowNotification({
    epicId: args.epicId,
    targetAgentSlug: args.agent,
    actor: {
      id: sender.id,
      username: sender.username,
      kind: senderIsAgent ? "agent" : "human",
    },
    reason: "manager_nudge",
    body: [
      `PM workflow notification for @${args.agent}:`,
      "",
      args.message.trim(),
    ].join("\n"),
  });

  console.log(JSON.stringify({
    ok: result.ok,
    epicId: args.epicId,
    agent: args.agent,
    messageId: "messageId" in result ? result.messageId : null,
    error: "error" in result ? result.error : null,
    delivery: "delivery" in result && result.delivery
      ? { status: result.delivery.status ?? null, driver: result.delivery.driver, error: result.delivery.error ?? null }
      : null,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
