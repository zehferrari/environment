import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildUnifiedPmTurnSystemPrompt, nullPmContextText } from "@/lib/agents/pm-channel/context";

const prompt = buildUnifiedPmTurnSystemPrompt({
  kind: "task-comment",
  trustedPrompt: "Trusted workflow envelope",
  primaryContext: "CURRENT TURN:\nhello",
  primaryBlocks: [{ title: "CURRENT CHAT MESSAGE", body: "please do it", trust: "untrusted" }],
});

assert.equal(nullPmContextText(), null);
assert(prompt.includes("Trusted workflow envelope"));
assert(prompt.includes("PM PER-TURN CONTEXT CONTRACT"));
assert(prompt.includes("Surface: task-comment"));
assert(prompt.includes("self-sufficient"));
assert(prompt.includes("PRIMARY PM CONTEXT PACKET"));
assert(prompt.includes("contextText is intentionally null"));
assert(prompt.includes("Trust boundary:"));
assert(prompt.includes("Quarantined PM/user/agent/repository text"));

for (const kind of ["direct", "task-chat", "epic-chat", "task-comment"] as const) {
  const surfacePrompt = buildUnifiedPmTurnSystemPrompt({
    kind,
    trustedPrompt: `Trusted ${kind} envelope`,
    primaryContext: `${kind} bounded transcript`,
  });
  assert(surfacePrompt.includes(`Surface: ${kind}`), `${kind} prompt labels its surface`);
  assert(surfacePrompt.includes(`${kind} bounded transcript`), `${kind} prompt carries primary per-turn context`);
  assert(surfacePrompt.includes("must not depend on prior OpenClaw session continuity"), `${kind} prompt states session-memory boundary`);
}

const root = process.cwd();
const sources = [
  { file: "lib/agents/chat/direct/actions.ts", surface: "direct" },
  { file: "lib/agents/chat/actions.ts", surface: "task/epic chat" },
  { file: "lib/agents/workflow/notifications/task.ts", surface: "task comment/workflow" },
  { file: "scripts/notify-pm-workflow-policy.ts", surface: "policy notification" },
].map((entry) => ({ ...entry, source: readFileSync(join(root, entry.file), "utf8") }));

for (const { file, surface, source } of sources) {
  assert(
    source.includes("buildUnifiedPmTurnSystemPrompt"),
    `${surface} (${file}) must use the shared PM context builder`,
  );
  assert(
    source.includes("nullPmContextText()"),
    `${surface} (${file}) must intentionally send null legacy contextText`,
  );
  assert(
    !/contextText:\s*(userMessage|body|contextText)\b/.test(source),
    `${surface} (${file}) must not dispatch non-null legacy contextText`,
  );
}

// ENV-121. The continuation brief is a SECOND context path into the same
// unified prompt contract, and it must not become a hole in it: a brief-driven
// turn still sends null legacy contextText, and the dispatcher must still be
// able to choose the full first-contact packet.
{
  const dispatcher = readFileSync(join(root, "lib/agents/workflow/notifications/task.ts"), "utf8");
  assert(
    dispatcher.includes("buildTaskEpisodeBrief"),
    "the task dispatcher must be able to send a bounded continuation brief",
  );
  assert(
    dispatcher.includes("buildTaskAgentUserMessage"),
    "the task dispatcher must keep the full packet for first-contact and plan turns",
  );

  const briefPrompt = buildUnifiedPmTurnSystemPrompt({
    kind: "task-comment",
    trustedPrompt: "Trusted workflow envelope",
    primaryContext: "EXECUTION EPISODE BRIEF (bounded continuation context):\nresume here",
  });
  assert(briefPrompt.includes("EXECUTION EPISODE BRIEF"));
  assert(
    briefPrompt.includes("contextText is intentionally null"),
    "a brief-driven turn is still bound by the unified null-contextText contract",
  );
  assert(
    briefPrompt.includes("Deeper history remains available through the scoped loopback context grant"),
    "a bounded brief must still advertise retrieval for the history it left out",
  );
  // The dispatcher is the ONLY place the brief/packet choice is made, so the
  // trigger is asserted there rather than trusting the context module alone.
  assert(
    /latestTaskExecutionCheckpoint/.test(dispatcher),
    "the brief/packet choice must be driven by a stored episode checkpoint",
  );
}

console.log("pm-unified-context-test: ok");
