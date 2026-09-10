export const EDITOR_SAVED_EVENT = "pm:editor-saved";
export type EditorSnapshot = Record<string, string[]>;
const checks = new Set<() => boolean>();
export function registerDirtyEditor(check: () => boolean) { checks.add(check); return () => { checks.delete(check); }; }
export function hasDirtyEditors() { return [...checks].some((check) => check()); }
export function snapshotEditor(data: FormData): EditorSnapshot {
  const values: EditorSnapshot = {};
  for (const [key, value] of data) {
    if (typeof value !== "string" || key.startsWith("$ACTION_") || key === "statusRevision") continue;
    (values[key] ??= []).push(value);
  }
  return Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
}
export function sameEditorSnapshot(a: EditorSnapshot, b: EditorSnapshot) { return JSON.stringify(a) === JSON.stringify(b); }
