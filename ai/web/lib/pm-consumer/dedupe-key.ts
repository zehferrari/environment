// Consumer-side dedupe key derivation (HOMELAB-46 Slice 4).
//
// HOMELAB-46 acceptance requires UNIQUE(dedupe_key) with a replay
// test: firing the same envelope twice must produce exactly one
// downstream wake. The producer side (Slices 1–3) stamps each
// envelope with a UUID `id` that is stable for that logical event —
// the dispatch boundary writes the same id whether the transport is
// the socket or the file-drop fallback. We derive dedupe_key from
// that id plus the kind + task.id so a malicious or buggy producer
// that recycled an id under a different (kind, task) shape cannot
// shadow a legitimate prior delivery.
//
// Slice 4 is deliberately consumer-side: extending the wire envelope
// with an explicit dedupeKey field would have reopened the Slice 1
// contract already accepted in commentId 12261 / 12265 / 12268.

import type { PmEvent } from "@/lib/pm-events";

export function dedupeKeyFor(event: PmEvent): string {
  return `${event.kind}:${event.task.id}:${event.id}`;
}
