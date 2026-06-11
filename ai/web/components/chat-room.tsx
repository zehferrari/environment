"use client";

import LegacyChatRoom from "@/components/legacy-chat-room";
import DecomposedChatRoom from "@/components/chat-room-decomposed";

type ChatRoomProps = React.ComponentProps<typeof LegacyChatRoom> & { currentUsername?: string | null };

export default function ChatRoom(props: ChatRoomProps) {
  // The decomposed room is the feature-complete task/epic chat surface
  // (optimistic send, failed→resend, jump-to-unread, native notifications,
  // draft persistence). It is the default; set NEXT_PUBLIC_PM_DECOMPOSED_CHAT_ROOM=0
  // to fall back to the legacy room as an escape hatch.
  if (process.env.NEXT_PUBLIC_PM_DECOMPOSED_CHAT_ROOM === "0") {
    return <LegacyChatRoom {...props} />;
  }

  return <DecomposedChatRoom {...props} />;
}
