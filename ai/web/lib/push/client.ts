// Browser-side Web Push registration. Used by the notification toggle so that
// enabling alerts also subscribes this device for closed-app delivery. Every
// function is best-effort and safe to call when push is unsupported or the
// server has no VAPID key configured.

const SW_URL = "/sw.js";

export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function vapidKeyToBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) view[i] = raw.charCodeAt(i);
  return buffer;
}

async function getServerPublicKey(): Promise<string | null> {
  try {
    const res = await fetch("/api/push/public-key", { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { enabled?: boolean; publicKey?: string };
    return data.enabled && data.publicKey ? data.publicKey : null;
  } catch {
    return null;
  }
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  } catch (err) {
    console.warn("[push] service worker registration failed", err);
    return null;
  }
}

// Register the SW and subscribe this browser. Returns true when a live push
// subscription was sent to the server. A false return is non-fatal: in-page
// notifications still work, the device just won't get closed-app pushes.
export async function registerPushSubscription(): Promise<boolean> {
  if (!pushSupported()) return false;
  const publicKey = await getServerPublicKey();
  if (!publicKey) return false; // server has no VAPID key — closed-app push disabled

  const registration = await getRegistration();
  if (!registration) return false;
  await navigator.serviceWorker.ready;

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyToBuffer(publicKey),
      });
    } catch (err) {
      console.warn("[push] pushManager.subscribe failed", err);
      return false;
    }
  }

  try {
    const json = subscription.toJSON();
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    });
    return res.ok;
  } catch (err) {
    console.warn("[push] subscribe POST failed", err);
    return false;
  }
}

export async function unregisterPushSubscription(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe().catch(() => undefined);
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }).catch(() => undefined);
  } catch (err) {
    console.warn("[push] unsubscribe failed", err);
  }
}
