"use client";

import LegacyChatRoom from "@/components/legacy-chat-room";
import DecomposedChatRoom from "@/components/chat-room-decomposed";

type ChatRoomProps = React.ComponentProps<typeof LegacyChatRoom> & { currentUsername?: string | null };

export default function ChatRoom(props: ChatRoomProps) {
  if (process.env.NEXT_PUBLIC_PM_DECOMPOSED_CHAT_ROOM === "1") {
    return <DecomposedChatRoom {...props} />;
  }

  return <LegacyChatRoom {...props} />;
}
