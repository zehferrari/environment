import type { ReviewFindingInput } from "./orchestrator/types";

export function parseReviewFindings(value: unknown): { ok: true; items: ReviewFindingInput[] } | { ok: false; message: string } {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    return { ok: false, message: "Supply 1–20 structured findings (title, acceptanceCriteria, scopeReference). PM creates their pending correction subtasks before handing work back." };
  }
  const items: ReviewFindingInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, message: "Each finding must be an object." };
    for (const [key, limit] of [["title", 300], ["acceptanceCriteria", 2000], ["scopeReference", 1000]] as const) {
      if (typeof item[key] !== "string" || !item[key].trim() || item[key].length > limit) return { ok: false, message: `Each finding needs ${key} (1–${limit} characters).` };
    }
    items.push({ title: item.title.trim(), acceptanceCriteria: item.acceptanceCriteria.trim(), scopeReference: item.scopeReference.trim() });
  }
  if (new Set(items.map(i => i.title.toLowerCase())).size !== items.length) return { ok: false, message: "Consolidate duplicate finding titles before requesting changes." };
  return { ok: true, items };
}

export class ReviewCorrectionError extends Error {}
