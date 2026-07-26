// Shared result shape for the unified create-FAB server actions. Lives in its
// own (non-"use server") module so both the actions and the epic action can
// import the type without a circular server-action dependency.
export type CreateResult =
  | { ok: true; message: string; href: string }
  | { ok: false; error: string };
