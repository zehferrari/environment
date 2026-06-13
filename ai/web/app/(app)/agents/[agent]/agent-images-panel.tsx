"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AgentImagesState, AgentImageKind } from "@/lib/agents/profile-images";
import { MANUAL_IMAGE_THEME } from "@/lib/agents/profile-image-themes";

type SaveState =
  | { kind: "idle" }
  | { kind: "saving"; message: string }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

const LABELS: Record<AgentImageKind, string> = {
  profile: "Photoreal profile",
  avatar: "Plush avatar",
};

export default function AgentImagesPanel({
  agent,
  state,
  canEdit,
}: {
  agent: string;
  state: AgentImagesState;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [local, setLocal] = useState(state);
  const [status, setStatus] = useState<SaveState>({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  function upload(kind: AgentImageKind, file: File | null) {
    if (!file || !canEdit || !local.manual) return;
    setStatus({ kind: "saving", message: `Uploading ${LABELS[kind].toLowerCase()}…` });
    startTransition(async () => {
      const form = new FormData();
      form.set("image", file);
      const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/images/${kind}`, {
        method: "PUT",
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus({ kind: "error", message: body.error ?? `Upload failed (${res.status})` });
        return;
      }
      const image = await res.json();
      setLocal((current) => ({
        ...current,
        images: { ...current.images, [kind]: image },
      }));
      setStatus({ kind: "ok", message: `${LABELS[kind]} uploaded` });
      router.refresh();
    });
  }

  function remove(kind: AgentImageKind) {
    if (!canEdit || !local.manual) return;
    setStatus({ kind: "saving", message: `Removing ${LABELS[kind].toLowerCase()}…` });
    startTransition(async () => {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/images/${kind}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus({ kind: "error", message: body.error ?? `Remove failed (${res.status})` });
        return;
      }
      const image = await res.json();
      setLocal((current) => ({
        ...current,
        images: { ...current.images, [kind]: image },
      }));
      setStatus({ kind: "ok", message: `${LABELS[kind]} removed` });
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-sm">
        <span className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Character theme</span>
        <div className="mt-1 font-medium">{local.theme || MANUAL_IMAGE_THEME}</div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {(["profile", "avatar"] as const).map((kind) => (
          <ImageSlot
            key={kind}
            kind={kind}
            image={local.images[kind]}
            disabled={pending || !canEdit || !local.manual}
            manual={local.manual}
            onUpload={upload}
            onRemove={remove}
          />
        ))}
      </div>

      {!local.manual ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          This agent uses generated profile assets. Manual upload is available only when the agent was created with
          <span className="font-medium"> {MANUAL_IMAGE_THEME}</span>.
        </p>
      ) : !canEdit ? (
        <p className="text-xs text-[var(--color-warn)]">Read-only: agents can edit only themselves; zeh can edit all.</p>
      ) : null}

      {status.kind !== "idle" ? (
        <p className={`text-xs ${status.kind === "error" ? "text-[var(--color-crit)]" : "text-[var(--color-text-muted)]"}`}>
          {status.message}
        </p>
      ) : null}
    </div>
  );
}

function ImageSlot({
  kind,
  image,
  disabled,
  manual,
  onUpload,
  onRemove,
}: {
  kind: AgentImageKind;
  image: AgentImagesState["images"][AgentImageKind];
  disabled: boolean;
  manual: boolean;
  onUpload: (kind: AgentImageKind, file: File | null) => void;
  onRemove: (kind: AgentImageKind) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-3">
      <div className="aspect-square overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)]">
        {image.exists ? (
          <img src={image.url} alt={LABELS[kind]} className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full place-items-center px-3 text-center text-xs text-[var(--color-text-muted)]">
            No {LABELS[kind].toLowerCase()} image
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{LABELS[kind]}</div>
          <div className="text-xs text-[var(--color-text-muted)]">
            {image.exists && image.bytes ? `${Math.round(image.bytes / 1024)} KiB` : "PNG output"}
          </div>
        </div>
        {manual ? (
          <div className="flex gap-1.5">
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              disabled={disabled}
              onChange={(event) => {
                onUpload(kind, event.target.files?.[0] ?? null);
                event.currentTarget.value = "";
              }}
            />
            <button
              type="button"
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
              className="rounded-lg border border-[var(--color-line)] px-2 py-1 text-xs hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Upload
            </button>
            <button
              type="button"
              disabled={disabled || !image.exists}
              onClick={() => onRemove(kind)}
              className="rounded-lg border border-[var(--color-line)] px-2 py-1 text-xs text-[var(--color-crit)] hover:border-[var(--color-crit)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Remove
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
