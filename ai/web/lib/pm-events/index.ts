// Typed PM event envelopes (HOMELAB-46 Slice 1).
//
// These are the wire-level events the PM webapp emits to the dispatch
// boundary in lib/pm-dispatch. Builders are pure: callers (workflow
// rules, task mutation routes, comment posts) hand in already-resolved
// domain data and get back an immutable envelope ready to enqueue.
//
// HOMELAB-44 workflow enforcement is unchanged: events are produced
// *after* the rule check has accepted the mutation and the row has
// been persisted. Producing an envelope never causes a state change.

export const SCHEMA_VERSION = 1 as const;

export const EVENT_KINDS = [
  "task.assigned",
  "task.commented",
  "task.mentioned",
  "task.ack_ready",
  // HOMELAB-48: directed chat-to-agent. Carries the chat message id +
  // the agent the message is addressed to, plus (when granted) the
  // contract the agent uses to write back a new description. Routed by
  // payload.targetAgentSlug, NOT by task.assignee — chats can target
  // any active agent regardless of who owns the task.
  "task.agent_chat",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export function isEventKind(value: unknown): value is EventKind {
  return (
    typeof value === "string" &&
    (EVENT_KINDS as readonly string[]).includes(value)
  );
}

export interface EventActor {
  id: string;
  kind: "human" | "agent";
  name?: string;
}

export interface EventTaskRef {
  id: string;
  key: string;
  projectKey: string;
  title: string;
}

interface EventEnvelopeBase<K extends EventKind, P> {
  schema: typeof SCHEMA_VERSION;
  id: string;
  kind: K;
  occurredAt: string;
  actor: EventActor;
  task: EventTaskRef;
  payload: P;
}

export interface TaskAssignedPayload {
  assignee: { id: string; kind: "human" | "agent"; name?: string } | null;
  previousAssignee:
    | { id: string; kind: "human" | "agent"; name?: string }
    | null;
}

export interface TaskCommentedPayload {
  commentId: string;
  bodyMarkdown: string;
  mentions: ReadonlyArray<{ id: string; kind: "human" | "agent" }>;
}

export interface TaskMentionedPayload {
  commentId: string;
  mentioned: { id: string; kind: "human" | "agent" };
  bodyMarkdown: string;
}

export interface TaskAckReadyPayload {
  reason: "auto-transition" | "explicit";
  fromStatus: string;
  toStatus: string;
}

// HOMELAB-48 — addressed chat to an agent on a task. Payload is
// self-describing so the consumer side does not need PM-side schema
// changes per chat variant: when allowDescriptionEdit is true, the
// `replyEndpoint` tells the agent runtime which URL + method to POST
// against with a signed one-shot token, and `systemPrompt` carries the
// callback contract that the runtime should pass to its LLM verbatim.
export interface TaskAgentChatPayload {
  chatMessageId: string;
  targetAgentSlug: string;
  openclawSessionKey?: string;
  userMessage: string;
  allowDescriptionEdit: boolean;
  currentDescription: string | null;
  // Strict instruction the agent's LLM should follow. PM constructs
  // this server-side from a known template so the contract stays in
  // PM, not in agent-runtime code.
  systemPrompt: string;
  // Present iff allowDescriptionEdit is true. Tells the runtime where
  // to write the description back and which messageId to pin the call
  // to (one-shot grant, validated server-side).
  replyEndpoint: {
    method: "POST";
    path: string; // e.g. /api/tasks/<taskId>/description
    bodyShape: {
      messageId: string;
      token: string;
      // The runtime supplies the agent's reply text as `description`.
      description: "<agent reply text>";
    };
  } | null;
  // Token-scoped endpoint for storing an ordinary conversational reply
  // back into the origin channel. Hand-written task chat messages reply
  // to task chat; task comments mirrored into agent chat reply to task
  // comments.
  chatReplyEndpoint?: {
    method: "POST";
    path: string; // e.g. /api/tasks/<taskId>/chat/reply
    bodyShape: {
      messageId: string;
      token: string;
      body: "<agent reply text>";
    };
  } | null;
}

export type TaskAssignedEvent = EventEnvelopeBase<
  "task.assigned",
  TaskAssignedPayload
>;
export type TaskCommentedEvent = EventEnvelopeBase<
  "task.commented",
  TaskCommentedPayload
>;
export type TaskMentionedEvent = EventEnvelopeBase<
  "task.mentioned",
  TaskMentionedPayload
>;
export type TaskAckReadyEvent = EventEnvelopeBase<
  "task.ack_ready",
  TaskAckReadyPayload
>;
export type TaskAgentChatEvent = EventEnvelopeBase<
  "task.agent_chat",
  TaskAgentChatPayload
>;

export type PmEvent =
  | TaskAssignedEvent
  | TaskCommentedEvent
  | TaskMentionedEvent
  | TaskAckReadyEvent
  | TaskAgentChatEvent;

interface BuilderCommon {
  id: string;
  occurredAt: string;
  actor: EventActor;
  task: EventTaskRef;
}

function envelope<K extends EventKind, P>(
  kind: K,
  common: BuilderCommon,
  payload: P,
): EventEnvelopeBase<K, P> {
  return {
    schema: SCHEMA_VERSION,
    id: common.id,
    kind,
    occurredAt: common.occurredAt,
    actor: common.actor,
    task: common.task,
    payload,
  };
}

export function buildTaskAssigned(
  common: BuilderCommon,
  payload: TaskAssignedPayload,
): TaskAssignedEvent {
  return envelope("task.assigned", common, payload);
}

export function buildTaskCommented(
  common: BuilderCommon,
  payload: TaskCommentedPayload,
): TaskCommentedEvent {
  return envelope("task.commented", common, payload);
}

export function buildTaskMentioned(
  common: BuilderCommon,
  payload: TaskMentionedPayload,
): TaskMentionedEvent {
  return envelope("task.mentioned", common, payload);
}

export function buildTaskAckReady(
  common: BuilderCommon,
  payload: TaskAckReadyPayload,
): TaskAckReadyEvent {
  return envelope("task.ack_ready", common, payload);
}

export function buildTaskAgentChat(
  common: BuilderCommon,
  payload: TaskAgentChatPayload,
): TaskAgentChatEvent {
  return envelope("task.agent_chat", common, payload);
}

// Defensive parser for events arriving from the wire (file-drop /
// socket). Shallow structural checks only — per-consumer handlers in
// later slices own deep payload validation.
export function parsePmEvent(value: unknown): PmEvent {
  if (!value || typeof value !== "object") {
    throw new Error("pm-event: not an object");
  }
  const v = value as Record<string, unknown>;
  if (v.schema !== SCHEMA_VERSION) {
    throw new Error(`pm-event: unsupported schema ${String(v.schema)}`);
  }
  if (!isEventKind(v.kind)) {
    throw new Error(`pm-event: unknown kind ${String(v.kind)}`);
  }
  if (typeof v.id !== "string" || !v.id) {
    throw new Error("pm-event: missing id");
  }
  if (typeof v.occurredAt !== "string") {
    throw new Error("pm-event: missing occurredAt");
  }
  if (!v.actor || typeof v.actor !== "object") {
    throw new Error("pm-event: missing actor");
  }
  if (!v.task || typeof v.task !== "object") {
    throw new Error("pm-event: missing task");
  }
  if (!("payload" in v)) {
    throw new Error("pm-event: missing payload");
  }
  return v as unknown as PmEvent;
}
