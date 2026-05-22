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

export type PmEvent =
  | TaskAssignedEvent
  | TaskCommentedEvent
  | TaskMentionedEvent
  | TaskAckReadyEvent;

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
