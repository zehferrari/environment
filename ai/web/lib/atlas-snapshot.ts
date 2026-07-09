// Shared reader + types for the Atlas live-host snapshot feed
// (http://127.0.0.1:3013/agents/snapshot). The feed is produced on the same
// host by the monitor stack; both the Agents page and the System Activity
// page render from it, so the shape lives here once.

export type SnapshotAgent = {
  name?: string;
  role?: string;
  avatar?: string;
  avatar_url?: string;
  bot?: string;
  gateway_listeners?: number[];
  current_task?: { heading?: string; ticket?: string; status?: string } | null;
  session_idle_s?: number | null;
  model_primary?: string | null;
  busy_state?: { is_busy?: boolean; signals?: string[]; details?: Record<string, unknown> } | null;
  jira_tickets?: Array<{ key?: string; summary?: string; status?: string; updated?: string }>;
  last_activity?:
    | {
        ts?: number;
        role?: string;
        items?: Array<{ kind?: string; name?: string; preview?: string }>;
        error?: string | null;
        stop_reason?: string | null;
      }
    | string
    | null;
};

export type MonitorEvent = {
  key?: string;
  unit?: string;
  kind?: string;
  severity?: string;
  // Live feed emits epoch seconds; older payloads used ISO strings.
  first_seen?: number | string;
  missed_runs?: number;
  alert_sent?: boolean;
};

export type MonitorDecision = {
  incident_id?: string;
  decision?: string;
  reason?: string;
  summary?: string;
  actions_taken?: string[];
  telegram_sent?: boolean;
  // Live feed field is `timestamp` (ISO); `ts` kept for older payloads.
  timestamp?: string;
  ts?: string;
};

export type MonitorState = {
  last_tick?: {
    ts?: number | string;
    healthy?: boolean;
    summary?: string;
    issues?: number;
    actions?: string[];
  } | null;
  open_events?: MonitorEvent[];
  recent_decisions?: MonitorDecision[];
};

export type AtlasSnapshot = {
  ts?: number;
  host?: string;
  agents?: Record<string, SnapshotAgent>;
  system?: Record<string, { is_active?: string }>;
  monitor?: MonitorState;
};

export async function readAtlasSnapshot(): Promise<AtlasSnapshot | null> {
  try {
    const res = await fetch("http://127.0.0.1:3013/agents/snapshot", {
      cache: "no-store",
      next: { revalidate: 0 },
    });
    if (!res.ok) return null;
    return (await res.json()) as AtlasSnapshot;
  } catch {
    return null;
  }
}
