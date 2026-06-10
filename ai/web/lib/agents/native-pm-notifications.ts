export const PM_NATIVE_NOTIFICATIONS_STORAGE_KEY = "pm:native-notifications:v1:enabled";
export const PM_NATIVE_NOTIFICATIONS_SEEN_PREFIX = "pm:native-notifications:v1:seen:";

export type NativePmNotificationPermission = NotificationPermission | "unsupported";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type NotificationWindow = Window & { Notification: typeof Notification };

type VisibilityLike = {
  visibilityState?: DocumentVisibilityState;
  hasFocus?: () => boolean;
};

export type NativePmNotificationDecisionInput = {
  supported: boolean;
  enabled: boolean;
  permission: NativePmNotificationPermission;
  visibilityState?: DocumentVisibilityState;
  hasFocus: boolean;
  targetKind: "direct" | "task-chat" | "task-comment" | "epic-chat";
  status: "done" | "error";
  text: string;
};

export function nativePmNotificationsSupported(win: Window | undefined = typeof window === "undefined" ? undefined : window) {
  return Boolean(win && "Notification" in win);
}

function notificationWindow(win: Window | undefined): NotificationWindow | undefined {
  return nativePmNotificationsSupported(win) ? (win as NotificationWindow) : undefined;
}

export function readNativePmNotificationsEnabled(storage: StorageLike | undefined = safeLocalStorage()) {
  if (!storage) return false;
  try {
    return storage.getItem(PM_NATIVE_NOTIFICATIONS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeNativePmNotificationsEnabled(enabled: boolean, storage: StorageLike | undefined = safeLocalStorage()) {
  if (!storage) return;
  try {
    if (enabled) storage.setItem(PM_NATIVE_NOTIFICATIONS_STORAGE_KEY, "1");
    else storage.removeItem(PM_NATIVE_NOTIFICATIONS_STORAGE_KEY);
  } catch {
    // Best-effort only; private/sandboxed modes can reject localStorage.
  }
}

export function currentNativePmNotificationPermission(
  win: Window | undefined = typeof window === "undefined" ? undefined : window,
): NativePmNotificationPermission {
  const notifications = notificationWindow(win);
  if (!notifications) return "unsupported";
  return notifications.Notification.permission;
}

export function shouldSendNativePmNotification(input: NativePmNotificationDecisionInput) {
  if (!input.supported) return false;
  if (!input.enabled) return false;
  if (input.permission !== "granted") return false;
  if (input.status !== "done") return false;
  if (!input.text.trim()) return false;
  if (input.targetKind === "task-comment") return false;
  if (input.visibilityState === "visible" && input.hasFocus) return false;
  return true;
}

export function compactNativePmNotificationBody(text: string, maxLength = 160) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function nativePmNotificationSeen(tag: string, storage: StorageLike | undefined = safeSessionStorage()) {
  if (!storage) return false;
  try {
    return storage.getItem(`${PM_NATIVE_NOTIFICATIONS_SEEN_PREFIX}${tag}`) === "1";
  } catch {
    return false;
  }
}

export function markNativePmNotificationSeen(tag: string, storage: StorageLike | undefined = safeSessionStorage()) {
  if (!storage) return;
  try {
    storage.setItem(`${PM_NATIVE_NOTIFICATIONS_SEEN_PREFIX}${tag}`, "1");
  } catch {
    // Best-effort duplicate suppression only.
  }
}

export function sendNativePmReplyNotification(args: {
  targetKind: NativePmNotificationDecisionInput["targetKind"];
  agentLabel: string;
  text: string;
  tag: string;
  win?: Window;
  doc?: VisibilityLike;
}) {
  const win = args.win ?? (typeof window === "undefined" ? undefined : window);
  const doc = args.doc ?? (typeof document === "undefined" ? undefined : document);
  const supported = nativePmNotificationsSupported(win);
  const permission = currentNativePmNotificationPermission(win);
  const enabled = readNativePmNotificationsEnabled();
  const hasFocus = doc?.hasFocus?.() ?? false;

  if (nativePmNotificationSeen(args.tag)) return false;
  if (!shouldSendNativePmNotification({
    supported,
    enabled,
    permission,
    visibilityState: doc?.visibilityState,
    hasFocus,
    targetKind: args.targetKind,
    status: "done",
    text: args.text,
  })) {
    return false;
  }

  const notifications = notificationWindow(win);
  if (!notifications) return false;

  try {
    const notification = new notifications.Notification(`@${args.agentLabel} replied`, {
      body: compactNativePmNotificationBody(args.text),
      tag: args.tag,
    });
    notification.onclick = () => {
      try { win?.focus(); } catch { /* ignore */ }
      notification.close();
    };
    markNativePmNotificationSeen(args.tag);
    return true;
  } catch {
    return false;
  }
}

function safeLocalStorage(): StorageLike | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage;
}

function safeSessionStorage(): StorageLike | undefined {
  if (typeof window === "undefined") return undefined;
  return window.sessionStorage;
}
