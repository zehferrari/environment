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

console.log("pm-unified-context-test: ok");
