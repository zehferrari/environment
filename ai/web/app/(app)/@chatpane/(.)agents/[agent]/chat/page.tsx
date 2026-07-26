import DirectAgentChatPage from "@/app/(app)/agents/[agent]/chat/page";
import ChatPopup from "@/components/chat-popup";

// Soft-navigating to an agent chat from any board intercepts here so the board
// stays mounted behind a floating, draggable chat window (ultra-wide) or a
// full-viewport chat overlay (below it). The canonical /agents/<slug>/chat page
// still renders on a hard load. `embedded=1` is injected only through this
// interceptor, so the reused page renders in its window-filling mode.
export default async function ChatPanePopup(props: {
  params: Promise<{ agent: string }>;
  searchParams: Promise<{ archive?: string }>;
}) {
  const searchParams = props.searchParams.then((sp) => ({ ...sp, embedded: "1" }));
  return (
    <ChatPopup>
      <DirectAgentChatPage params={props.params} searchParams={searchParams} />
    </ChatPopup>
  );
}
