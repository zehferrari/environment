import { NextResponse, type NextRequest } from "next/server";
import { updateTask } from "@/lib/tasks/editor-actions";
import { updateEpic } from "@/lib/epics/actions";
import { publicOriginFromHeaders } from "@/lib/http/public-origin";

export async function POST(request: NextRequest, { params }: { params: Promise<{ kind: string; itemId: string }> }) {
  // Same-origin browser transport; the existing handlers retain authentication,
  // project visibility, owner-only fields and workflow authorization checks.
  const origin = request.headers.get("origin");
  if (request.headers.get("x-pm-editor") !== "1" || !origin || origin !== publicOriginFromHeaders(request.headers)) {
    return NextResponse.json({ ok: false, error: "Save request was rejected. Reload this page and try again." }, { status: 403 });
  }
  const { kind, itemId } = await params;
  if (kind !== "task" && kind !== "epic") return NextResponse.json({ ok: false, error: "Unknown record type." }, { status: 404 });
  try {
    const data = await request.formData();
    if (data.get(`${kind}Id`) !== itemId) return NextResponse.json({ ok: false, error: "Record identity mismatch." }, { status: 400 });
    if (kind === "task") await updateTask(data); else await updateEpic(data);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(`[pm] ${kind} editor save failed`, error);
    const message = error instanceof Error && error.name === "Error" && !/NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK/.test(error.message)
      ? error.message : "Save failed. Your edits are still here; check your session and try again.";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
