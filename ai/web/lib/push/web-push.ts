// Server-side Web Push delivery. This is what lets an agent reply reach a
// human whose PM tab/app is fully closed — the in-page Notification API can
// only fire while a tab is open, which is the core gap vs Telegram.
//
// Configure with a VAPID keypair (generate once with
// `node -e "console.log(require('web-push').generateVAPIDKeys())"`):
//   PM_WEB_PUSH_VAPID_PUBLIC_KEY
//   PM_WEB_PUSH_VAPID_PRIVATE_KEY
//   PM_WEB_PUSH_CONTACT   (mailto:you@example.com or an https URL)
// When unset, webPushConfigured() is false and every send is a safe no-op.

import webpush from "web-push";
import { db } from "@/lib/db";

export interface WebPushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

let configured: boolean | null = null;

export function webPushConfigured(): boolean {
  if (configured !== null) return configured;
  const publicKey = process.env.PM_WEB_PUSH_VAPID_PUBLIC_KEY;
  const privateKey = process.env.PM_WEB_PUSH_VAPID_PRIVATE_KEY;
  const contact = process.env.PM_WEB_PUSH_CONTACT?.trim();
  if (!publicKey || !privateKey || !contact) {
    configured = false;
    return configured;
  }
  try {
    webpush.setVapidDetails(
      contact,
      publicKey,
      privateKey,
    );
    configured = true;
  } catch (err) {
    console.warn("[web-push] invalid VAPID configuration", err);
    configured = false;
  }
  return configured;
}

export function webPushPublicKey(): string | null {
  return process.env.PM_WEB_PUSH_VAPID_PUBLIC_KEY ?? null;
}

// Deliver a payload to every device the user has subscribed. Best-effort:
// never throws, and prunes endpoints the push service reports as gone
// (404 Not Found / 410 Gone) so dead subscriptions don't accumulate.
export async function sendWebPushToUser(userId: string, payload: WebPushPayload): Promise<{ sent: number; pruned: number }> {
  if (!webPushConfigured() || !userId) return { sent: 0, pruned: 0 };

  const subscriptions = await db.webPushSubscription.findMany({
    where: { userId },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (subscriptions.length === 0) return { sent: 0, pruned: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  const deadIds: string[] = [];

  await Promise.all(subscriptions.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
      );
      sent += 1;
    } catch (err) {
      const statusCode = (err as { statusCode?: number } | null)?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        deadIds.push(sub.id);
      } else {
        console.warn("[web-push] send failed", { endpoint: sub.endpoint.slice(0, 48), statusCode });
      }
    }
  }));

  if (deadIds.length > 0) {
    await db.webPushSubscription.deleteMany({ where: { id: { in: deadIds } } }).catch(() => undefined);
  }
  if (sent > 0) {
    await db.webPushSubscription
      .updateMany({ where: { userId }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  }

  return { sent, pruned: deadIds.length };
}
