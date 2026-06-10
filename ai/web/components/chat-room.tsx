"use client";

import LegacyChatRoom from "@/components/legacy-chat-room";
import DecomposedChatRoom from "@/components/chat-room-decomposed";

export default function ChatRoom(props: React.ComponentProps<typeof LegacyChatRoom>) {
  if (process.env.NEXT_PUBLIC_PM_DECOMPOSED_CHAT_ROOM === "1") {
    return <DecomposedChatRoom {...props} />;
  }

  return <LegacyChatRoom {...props} />;
}
