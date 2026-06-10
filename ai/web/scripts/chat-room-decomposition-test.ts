import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const wrapper = readFileSync(join(root, "components/chat-room.tsx"), "utf8");
const decomposed = readFileSync(join(root, "components/chat-room-decomposed.tsx"), "utf8");

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  wrapper.includes('process.env.NEXT_PUBLIC_PM_DECOMPOSED_CHAT_ROOM === "1"'),
  "chat room wrapper must keep the decomposed path behind the explicit feature flag",
);
assert(
  wrapper.indexOf("<DecomposedChatRoom") < wrapper.indexOf("<LegacyChatRoom"),
  "wrapper must fall back to the legacy chat room when the feature flag is off",
);

for (const component of ["MessageList", "Composer", "StreamController"]) {
  assert(
    decomposed.includes(`const ${component} = React.memo(function ${component}`),
    `${component} must be extracted behind a memo boundary`,
  );
}

const composerStart = decomposed.indexOf("const Composer = React.memo(function Composer");
const streamStart = decomposed.indexOf("const StreamController = React.memo(function StreamController");
assert(composerStart > -1 && streamStart > -1, "composer and stream controller components must exist");
const composerSource = decomposed.slice(composerStart);
assert(
  !composerSource.includes("<StreamingAgentReply"),
  "Composer must not own streaming reply state or render StreamingAgentReply",
);
assert(
  decomposed.includes('performance.mark(`pm-chat-render:composer:'),
  "Composer render-count probe must be available for stream tick verification",
);
assert(
  decomposed.includes('performance.mark(`pm-chat-render:stream-controller:'),
  "StreamController render-count probe must be available for stream tick verification",
);

console.log("chat-room decomposition contract ok");
