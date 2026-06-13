import { type MessageActor } from "@/components/message-avatar";

const GROUP_WINDOW_MS = 5 * 60 * 1000;

export interface GroupableChatMessage {
  createdAt: Date | string;
  sender: MessageActor;
  targetLabel?: string | null;
  targetType?: string | null;
  targetValue?: string | null;
  deletedAt?: Date | string | null;
}

export interface MessageGroupState {
  isGroupStart: boolean;
  isGroupEnd: boolean;
  isGroupedContinuation: boolean;
}

export function messageParticipantKey(actor: MessageActor) {
  return actor.id ?? actor.agent?.slug ?? actor.username;
}

function messageTargetKey(message: GroupableChatMessage) {
  return [message.targetType ?? "", message.targetValue ?? "", message.targetLabel ?? ""].join("\u0000");
}

function messageTimestamp(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
}

function canGroupMessages(previous: GroupableChatMessage | undefined, next: GroupableChatMessage | undefined) {
  if (!previous || !next || previous.deletedAt || next.deletedAt) return false;
  if (messageParticipantKey(previous.sender) !== messageParticipantKey(next.sender)) return false;
  if (messageTargetKey(previous) !== messageTargetKey(next)) return false;

  const previousTime = messageTimestamp(previous.createdAt);
  const nextTime = messageTimestamp(next.createdAt);
  if (previousTime === null || nextTime === null) return false;

  return Math.abs(nextTime - previousTime) <= GROUP_WINDOW_MS;
}

export function getMessageGroupState(
  messages: readonly GroupableChatMessage[],
  index: number,
): MessageGroupState {
  const message = messages[index];
  if (!message || message.deletedAt) {
    return { isGroupStart: true, isGroupEnd: true, isGroupedContinuation: false };
  }

  const groupedWithPrevious = canGroupMessages(messages[index - 1], message);
  const groupedWithNext = canGroupMessages(message, messages[index + 1]);

  return {
    isGroupStart: !groupedWithPrevious,
    isGroupEnd: !groupedWithNext,
    isGroupedContinuation: groupedWithPrevious,
  };
}
