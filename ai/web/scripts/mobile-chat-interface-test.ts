import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const chatRooms = [
  "components/legacy-chat-room.tsx",
  "components/chat-room-decomposed.tsx",
];
const chatBubble = readFileSync(join(root, "components/chat-bubble.tsx"), "utf8");

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

for (const relativePath of chatRooms) {
  const source = readFileSync(join(root, relativePath), "utf8");

  assert(
    source.includes("max-sm:w-[85vw]")
      && source.includes("bg-black/45")
      && source.includes("max-sm:block")
      && source.includes("setArchiveSidebarOpen(false)"),
    `${relativePath} must render the archive sidebar as an 85vw mobile overlay with dismiss backdrop`,
  );
  assert(
    source.includes('event.key === "Escape"')
      && source.includes('window.addEventListener("keydown", closeOnEscape)'),
    `${relativePath} must close archive overlay on Escape`,
  );
  assert(
    source.includes("max-sm:h-[100dvh]")
      && source.includes("max-sm:min-h-0"),
    `${relativePath} must avoid the desktop minimum chat height on mobile`,
  );
  assert(
    source.includes("max-sm:bottom-[calc(env(safe-area-inset-bottom)+0.75rem)]")
      && source.includes("max-sm:max-h-[calc(100dvh-env(safe-area-inset-bottom)-1.5rem)]")
      && source.includes("overflow-y-auto"),
    `${relativePath} composer must stay inside the mobile visual viewport above keyboard/safe area`,
  );
}

assert(
  chatBubble.includes("max-sm:max-w-[80%]"),
  "chat bubbles must cap at 80% width on mobile",
);
assert(
  chatBubble.includes("longPressTimerRef")
    && chatBubble.includes("onPointerDown={startTouchLongPress}")
    && chatBubble.includes("pointerType")
    && chatBubble.includes("[&_*]:!opacity-100"),
  "chat bubbles must expose message actions via touch/pen long-press without changing desktop hover behavior",
);

console.log("mobile chat interface contract ok");
