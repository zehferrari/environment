"use client";

import { useCallback, useEffect, useState } from "react";
import {
  currentNativePmNotificationPermission,
  nativePmNotificationsSupported,
  readNativePmNotificationsEnabled,
  writeNativePmNotificationsEnabled,
  type NativePmNotificationPermission,
} from "@/lib/agents/pm-channel/native-pm-notifications";
import { registerPushSubscription, unregisterPushSubscription } from "@/lib/push/client";

type ToggleState = {
  supported: boolean;
  enabled: boolean;
  permission: NativePmNotificationPermission;
};

function readState(): ToggleState {
  const supported = nativePmNotificationsSupported();
  const permission = currentNativePmNotificationPermission();
  return {
    supported,
    permission,
    enabled: supported && permission === "granted" && readNativePmNotificationsEnabled(),
  };
}

export default function NativePmNotificationToggle({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<ToggleState>({ supported: false, enabled: false, permission: "unsupported" });

  useEffect(() => {
    setState(readState());
    const onStorage = (event: StorageEvent) => {
      if (event.key === "pm:native-notifications:v1:enabled") setState(readState());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggle = useCallback(async () => {
    if (!nativePmNotificationsSupported()) {
      setState(readState());
      return;
    }

    const current = readState();
    if (current.enabled) {
      writeNativePmNotificationsEnabled(false);
      setState(readState());
      // Also drop this device's closed-app push subscription.
      void unregisterPushSubscription();
      return;
    }

    let permission = currentNativePmNotificationPermission();
    if (permission === "default") {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = currentNativePmNotificationPermission();
      }
    }

    writeNativePmNotificationsEnabled(permission === "granted");
    setState(readState());
    if (permission === "granted") {
      // Best-effort: also subscribe for closed-app Web Push. No-ops when the
      // server has no VAPID key configured, so in-page alerts still work.
      void registerPushSubscription();
    }
  }, []);

  const disabled = !state.supported || state.permission === "denied";
  const status = !state.supported
    ? "unsupported"
    : state.permission === "denied"
      ? "blocked"
      : state.enabled
        ? "on"
        : "off";
  const label = state.enabled ? "Native alerts on" : state.permission === "denied" ? "Native alerts blocked" : "Enable native alerts";
  const title = state.enabled
    ? "Disable local desktop notifications for agent replies when this tab is not focused."
    : state.permission === "denied"
      ? "Browser notification permission is denied. Change it in browser settings to use local alerts."
      : "Ask this browser for permission to show local desktop notifications for agent replies when this tab is not focused.";

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled}
      aria-pressed={state.enabled}
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition ${
        state.enabled
          ? "border-accent bg-accent/10 text-accent"
          : "border-line bg-panel text-text-muted hover:border-accent hover:text-accent"
      } ${disabled ? "cursor-not-allowed opacity-60 hover:border-line hover:text-text-muted" : "cursor-pointer"}`}
    >
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      </svg>
      {compact ? <span className="uppercase tracking-wider">{status}</span> : <span>{label}</span>}
    </button>
  );
}
