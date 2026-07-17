"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AgentImagesState, AgentImageKind, AgentImageMeta } from "@/lib/agents/management/profile-images";
import {
  PROFILE_IMAGE_AGE_GROUPS,
  PROFILE_IMAGE_CUSTOMIZATION_MODES,
  PROFILE_IMAGE_ETHNICITIES,
  PROFILE_IMAGE_GENDERS,
  normalizeProfileImageAgeGroup,
  normalizeProfileImageContextText,
  normalizeProfileImageCustomizationMode,
  normalizeProfileImageEthnicity,
  normalizeProfileImageGender,
  normalizeProfileImagePrompt,
} from "@/lib/agents/management/profile-image-options";
import { AGENT_PROFILE_IMAGE_THEMES, GENERATED_IMAGE_THEME, MANUAL_IMAGE_THEME, normalizeProfileImageTheme } from "@/lib/agents/management/profile-image-themes";

type SaveState =
  | { kind: "idle" }
  | { kind: "saving"; message: string }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

const KINDS: AgentImageKind[] = ["profile", "avatar"];

const LABELS: Record<AgentImageKind, string> = {
  profile: "Profile",
  avatar: "Avatar",
};

type PreviewMap = Partial<Record<AgentImageKind, string>>;
type FileMap = Partial<Record<AgentImageKind, File>>;
type StagedImagesState = {
  stageId: string;
  images: Record<AgentImageKind, AgentImageMeta>;
};

function isManual(theme: string) {
  return normalizeProfileImageTheme(theme) === MANUAL_IMAGE_THEME;
}

function imageChanged(
  kind: AgentImageKind,
  state: AgentImagesState,
  baseline: Record<AgentImageKind, number | null>,
) {
  const image = state.images[kind];
  return image.exists && image.mtimeMs !== baseline[kind];
}

export default function AgentImagesPanel({
  agent,
  state,
  canEdit,
  defaultPrompt,
}: {
  agent: string;
  state: AgentImagesState;
  canEdit: boolean;
  defaultPrompt: string;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(state);
  const [draftSource, setDraftSource] = useState(state.theme || GENERATED_IMAGE_THEME);
  const [candidateSource, setCandidateSource] = useState(state.theme || GENERATED_IMAGE_THEME);
  const [draftMode, setDraftMode] = useState(state.customizationMode);
  const [candidateMode, setCandidateMode] = useState(state.customizationMode);
  const [draftGender, setDraftGender] = useState(state.gender);
  const [candidateGender, setCandidateGender] = useState(state.gender);
  const [draftAgeGroup, setDraftAgeGroup] = useState(state.ageGroup);
  const [candidateAgeGroup, setCandidateAgeGroup] = useState(state.ageGroup);
  const [draftEthnicity, setDraftEthnicity] = useState(state.ethnicity);
  const [candidateEthnicity, setCandidateEthnicity] = useState(state.ethnicity);
  const [draftUsername, setDraftUsername] = useState(state.username || agent);
  const [candidateUsername, setCandidateUsername] = useState(state.username || agent);
  const [draftFullName, setDraftFullName] = useState(state.fullName);
  const [candidateFullName, setCandidateFullName] = useState(state.fullName);
  const [draftBio, setDraftBio] = useState(state.bio);
  const [candidateBio, setCandidateBio] = useState(state.bio);
  const [draftPrompt, setDraftPrompt] = useState(state.prompt || defaultPrompt);
  const [candidatePrompt, setCandidatePrompt] = useState(state.prompt || defaultPrompt);
  const [savePromptAsDefault, setSavePromptAsDefault] = useState(false);
  const [draftFiles, setDraftFiles] = useState<FileMap>({});
  const [previews, setPreviews] = useState<PreviewMap>({});
  const [staged, setStaged] = useState<StagedImagesState | null>(null);
  const [removed, setRemoved] = useState<Set<AgentImageKind>>(new Set());
  const [baseline, setBaseline] = useState<Record<AgentImageKind, number | null>>({
    profile: state.images.profile.mtimeMs,
    avatar: state.images.avatar.mtimeMs,
  });
  const [generating, setGenerating] = useState(false);
  const [generationKind, setGenerationKind] = useState<"profile" | "avatar" | null>(null);
  const [status, setStatus] = useState<SaveState>({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  const normalizedDraftSource = normalizeProfileImageTheme(draftSource);
  const normalizedCandidateSource = normalizeProfileImageTheme(candidateSource);
  const normalizedDraftMode = normalizeProfileImageCustomizationMode(draftMode);
  const normalizedCandidateMode = normalizeProfileImageCustomizationMode(candidateMode);
  const normalizedDraftGender = normalizeProfileImageGender(draftGender);
  const normalizedCandidateGender = normalizeProfileImageGender(candidateGender);
  const normalizedDraftAgeGroup = normalizeProfileImageAgeGroup(draftAgeGroup);
  const normalizedCandidateAgeGroup = normalizeProfileImageAgeGroup(candidateAgeGroup);
  const normalizedDraftEthnicity = normalizeProfileImageEthnicity(draftEthnicity);
  const normalizedCandidateEthnicity = normalizeProfileImageEthnicity(candidateEthnicity);
  const normalizedDraftUsername = normalizeProfileImageContextText(draftUsername) || agent;
  const normalizedCandidateUsername = normalizeProfileImageContextText(candidateUsername) || agent;
  const normalizedDraftFullName = normalizeProfileImageContextText(draftFullName);
  const normalizedCandidateFullName = normalizeProfileImageContextText(candidateFullName);
  const normalizedDraftBio = normalizeProfileImageContextText(draftBio, 500);
  const normalizedCandidateBio = normalizeProfileImageContextText(candidateBio, 500);
  const normalizedDraftPrompt = normalizeProfileImagePrompt(draftPrompt, defaultPrompt);
  const normalizedCandidatePrompt = normalizeProfileImagePrompt(candidatePrompt, defaultPrompt);
  const savedPrompt = normalizeProfileImagePrompt(saved.prompt, defaultPrompt);
  const draftGenerated = normalizedDraftSource !== MANUAL_IMAGE_THEME;
  const draftCustom = draftGenerated && normalizedDraftMode === "Custom";
  const candidateGenerated = normalizedCandidateSource !== MANUAL_IMAGE_THEME;
  const candidateCustom = candidateGenerated && normalizedCandidateMode === "Custom";

  const imageOptionsChanged =
    normalizedDraftSource !== saved.theme ||
    (draftGenerated && normalizedDraftMode !== saved.customizationMode) ||
    (draftCustom &&
      (normalizedDraftGender !== saved.gender ||
        normalizedDraftAgeGroup !== saved.ageGroup ||
        normalizedDraftEthnicity !== saved.ethnicity ||
        normalizedDraftUsername !== (saved.username || agent) ||
        normalizedDraftFullName !== saved.fullName ||
        normalizedDraftBio !== saved.bio ||
        normalizedDraftPrompt !== savedPrompt));
  const candidateChanged =
    normalizedCandidateSource !== normalizedDraftSource ||
    (candidateGenerated && normalizedCandidateMode !== normalizedDraftMode) ||
    (candidateCustom &&
      (normalizedCandidateGender !== normalizedDraftGender ||
        normalizedCandidateAgeGroup !== normalizedDraftAgeGroup ||
        normalizedCandidateEthnicity !== normalizedDraftEthnicity ||
        normalizedCandidateUsername !== normalizedDraftUsername ||
        normalizedCandidateFullName !== normalizedDraftFullName ||
        normalizedCandidateBio !== normalizedDraftBio ||
        normalizedCandidatePrompt !== normalizedDraftPrompt));
  const draftManual = isManual(normalizedDraftSource);
  const hasImageDrafts = KINDS.some((kind) => draftFiles[kind] || removed.has(kind));
  const stagedProfileReady = Boolean(staged?.images.profile?.exists);
  const stagedAvatarReady = Boolean(staged?.images.avatar?.exists);
  const stagedReady = Boolean(staged && stagedProfileReady);
  const waitingForStagedImages = Boolean(staged && !stagedReady);
  const dirty = imageOptionsChanged || hasImageDrafts || savePromptAsDefault || stagedReady;

  useEffect(() => {
    setSaved(state);
    setDraftSource(state.theme || GENERATED_IMAGE_THEME);
    setCandidateSource(state.theme || GENERATED_IMAGE_THEME);
    setDraftMode(state.customizationMode);
    setCandidateMode(state.customizationMode);
    setDraftGender(state.gender);
    setCandidateGender(state.gender);
    setDraftAgeGroup(state.ageGroup);
    setCandidateAgeGroup(state.ageGroup);
    setDraftEthnicity(state.ethnicity);
    setCandidateEthnicity(state.ethnicity);
    setDraftUsername(state.username || agent);
    setCandidateUsername(state.username || agent);
    setDraftFullName(state.fullName);
    setCandidateFullName(state.fullName);
    setDraftBio(state.bio);
    setCandidateBio(state.bio);
    setDraftPrompt(state.prompt || defaultPrompt);
    setCandidatePrompt(state.prompt || defaultPrompt);
    setSavePromptAsDefault(false);
    setStaged(null);
    setGenerationKind(null);
    setBaseline({ profile: state.images.profile.mtimeMs, avatar: state.images.avatar.mtimeMs });
  }, [agent, defaultPrompt, state]);

  useEffect(() => {
    return () => {
      for (const url of Object.values(previews)) URL.revokeObjectURL(url);
    };
  }, [previews]);

  useEffect(() => {
    if (!generating) return;
    const poll = async () => {
      try {
        const res = staged
          ? await fetch(`/api/agents/${encodeURIComponent(agent)}/images/staged/${encodeURIComponent(staged.stageId)}`, { cache: "no-store" })
          : await fetch(`/api/agents/${encodeURIComponent(agent)}/images`, { cache: "no-store" });
        if (!res.ok) return;
        if (staged) {
          const next = (await res.json()) as StagedImagesState;
          setStaged(next);
          const complete =
            generationKind === "profile"
              ? next.images.profile?.exists
              : generationKind === "avatar"
                ? next.images.avatar?.exists
                : KINDS.every((kind) => next.images[kind]?.exists);
          if (complete) {
            setGenerating(false);
            setGenerationKind(null);
            setStatus({
              kind: "ok",
              message: next.images.avatar?.exists
                ? "Generated preview images are ready. Press Save to use them."
                : "Profile is ready. Generate an Avatar or press Save to reuse Profile as Avatar.",
            });
          }
          return;
        }
        const next = (await res.json()) as AgentImagesState;
        setSaved(next);
        if (KINDS.every((kind) => imageChanged(kind, next, baseline))) {
          setGenerating(false);
          setGenerationKind(null);
          setStatus({ kind: "ok", message: "Generated profile images are ready" });
          router.refresh();
        }
      } catch {
        // Polling is best-effort; the next interval can recover.
      }
    };
    poll();
    const id = window.setInterval(poll, 3500);
    return () => window.clearInterval(id);
  }, [agent, baseline, generating, generationKind, router, staged]);

  function clearDraftImages() {
    for (const url of Object.values(previews)) URL.revokeObjectURL(url);
    setPreviews({});
    setDraftFiles({});
    setRemoved(new Set());
  }

  function applySelection() {
    if (!candidateChanged) return;
    const custom = normalizedCandidateSource !== MANUAL_IMAGE_THEME && normalizedCandidateMode === "Custom";
    const nextSource = normalizedCandidateSource;
    const nextMode = normalizedCandidateMode;
    const nextGender = custom ? normalizedCandidateGender : "Random";
    const nextAgeGroup = custom ? normalizedCandidateAgeGroup : "Random";
    const nextEthnicity = custom ? normalizedCandidateEthnicity : "Random";
    const nextUsername = custom ? normalizedCandidateUsername : agent;
    const nextFullName = custom ? normalizedCandidateFullName : "";
    const nextBio = custom ? normalizedCandidateBio : "";
    const nextPrompt = custom ? normalizedCandidatePrompt : defaultPrompt;

    setDraftSource(nextSource);
    setCandidateSource(nextSource);
    setDraftMode(nextMode);
    setCandidateMode(nextMode);
    setDraftGender(nextGender);
    setCandidateGender(nextGender);
    setDraftAgeGroup(nextAgeGroup);
    setCandidateAgeGroup(nextAgeGroup);
    setDraftEthnicity(nextEthnicity);
    setCandidateEthnicity(nextEthnicity);
    setDraftUsername(nextUsername);
    setCandidateUsername(nextUsername);
    setDraftFullName(nextFullName);
    setCandidateFullName(nextFullName);
    setDraftBio(nextBio);
    setCandidateBio(nextBio);
    setDraftPrompt(nextPrompt);
    setCandidatePrompt(nextPrompt);
    clearDraftImages();
    setStaged(null);
    setGenerating(false);
    setGenerationKind(null);
    setStatus({ kind: "idle" });

    if (nextSource === MANUAL_IMAGE_THEME) return;

    const previousBaseline = {
      profile: saved.images.profile.mtimeMs,
      avatar: saved.images.avatar.mtimeMs,
    };
    setStatus({ kind: "saving", message: "Requesting generated preview images..." });
    startTransition(async () => {
      try {
        const themeRes = await fetch(`/api/agents/${encodeURIComponent(agent)}/images/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            theme: nextSource,
            kind: "profile",
            customizationMode: nextMode,
            gender: nextGender,
            ageGroup: nextAgeGroup,
            ethnicity: nextEthnicity,
            prompt: nextPrompt,
            username: nextUsername,
            fullName: nextFullName,
            bio: nextBio,
          }),
        });
        const themeBody = await themeRes.json().catch(() => ({}));
        if (!themeRes.ok) throw new Error(themeBody.message ?? themeBody.error ?? `Image preview request failed (${themeRes.status})`);

        setStaged(themeBody.staged ?? { stageId: themeBody.stageId, images: {} });
        setBaseline(previousBaseline);
        setGenerating(Boolean(themeBody.imageRequest?.requested));
        setGenerationKind(themeBody.imageRequest?.requested ? "profile" : null);
        setStatus({
          kind: "saving",
          message: themeBody.imageRequest?.requested
            ? "Generating Profile preview..."
            : themeBody.imageRequest?.reason ?? "Image preview generation was not queued",
        });
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Image generation request failed",
        });
      }
    });
  }

  function chooseFile(kind: AgentImageKind, file: File | null) {
    if (!file) return;
    if (!canEdit || !draftManual) return;
    const url = URL.createObjectURL(file);
    setPreviews((current) => {
      if (current[kind]) URL.revokeObjectURL(current[kind]!);
      return { ...current, [kind]: url };
    });
    setDraftFiles((current) => ({ ...current, [kind]: file }));
    setRemoved((current) => {
      const next = new Set(current);
      next.delete(kind);
      return next;
    });
    setStatus({ kind: "idle" });
  }

  function removeDraft(kind: AgentImageKind) {
    if (!canEdit || !draftManual) return;
    setPreviews((current) => {
      if (current[kind]) URL.revokeObjectURL(current[kind]!);
      const next = { ...current };
      delete next[kind];
      return next;
    });
    setDraftFiles((current) => {
      const next = { ...current };
      delete next[kind];
      return next;
    });
    if (saved.images[kind].exists && !imageOptionsChanged) {
      setRemoved((current) => new Set([...current, kind]));
    }
  }

  function removeAvatarImage() {
    if (!canEdit || pending || generating) return;
    if (draftManual) {
      removeDraft("avatar");
      return;
    }
    setRemoved((current) => new Set([...current, "avatar"]));
    setStatus({ kind: "ok", message: "Avatar will use the Profile image after Save." });
  }

  function revert() {
    clearDraftImages();
    setDraftSource(saved.theme || GENERATED_IMAGE_THEME);
    setCandidateSource(saved.theme || GENERATED_IMAGE_THEME);
    setDraftMode(saved.customizationMode);
    setCandidateMode(saved.customizationMode);
    setDraftGender(saved.gender);
    setCandidateGender(saved.gender);
    setDraftAgeGroup(saved.ageGroup);
    setCandidateAgeGroup(saved.ageGroup);
    setDraftEthnicity(saved.ethnicity);
    setCandidateEthnicity(saved.ethnicity);
    setDraftUsername(saved.username || agent);
    setCandidateUsername(saved.username || agent);
    setDraftFullName(saved.fullName);
    setCandidateFullName(saved.fullName);
    setDraftBio(saved.bio);
    setCandidateBio(saved.bio);
    setDraftPrompt(saved.prompt || defaultPrompt);
    setCandidatePrompt(saved.prompt || defaultPrompt);
    setSavePromptAsDefault(false);
    setStaged(null);
    setGenerating(false);
    setGenerationKind(null);
    setStatus({ kind: "idle" });
  }

  function regenerate() {
    if (!canEdit || pending || draftManual) return;
    const nextMode = normalizeProfileImageCustomizationMode(draftMode);
    const nextCustom = nextMode === "Custom";
    const nextGender = nextCustom ? normalizeProfileImageGender(draftGender) : "Random";
    const nextAgeGroup = nextCustom ? normalizeProfileImageAgeGroup(draftAgeGroup) : "Random";
    const nextEthnicity = nextCustom ? normalizeProfileImageEthnicity(draftEthnicity) : "Random";
    const nextPrompt = nextCustom ? normalizeProfileImagePrompt(draftPrompt, defaultPrompt) : defaultPrompt;
    const nextUsername = nextCustom ? normalizeProfileImageContextText(draftUsername) || agent : agent;
    const nextFullName = nextCustom ? normalizeProfileImageContextText(draftFullName) : "";
    const nextBio = nextCustom ? normalizeProfileImageContextText(draftBio, 500) : "";
    const previousBaseline = {
      profile: saved.images.profile.mtimeMs,
      avatar: saved.images.avatar.mtimeMs,
    };
    clearDraftImages();
    setStaged(null);
    setStatus({ kind: "saving", message: "Requesting new preview images with the same settings..." });
    startTransition(async () => {
      try {
        const themeRes = await fetch(`/api/agents/${encodeURIComponent(agent)}/images/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            theme: normalizeProfileImageTheme(draftSource),
            kind: "profile",
            customizationMode: nextMode,
            gender: nextGender,
            ageGroup: nextAgeGroup,
            ethnicity: nextEthnicity,
            prompt: nextPrompt,
            username: nextUsername,
            fullName: nextFullName,
            bio: nextBio,
          }),
        });
        const themeBody = await themeRes.json().catch(() => ({}));
        if (!themeRes.ok) throw new Error(themeBody.message ?? themeBody.error ?? `Image generation request failed (${themeRes.status})`);
        setStaged(themeBody.staged ?? { stageId: themeBody.stageId, images: {} });
        setBaseline(previousBaseline);
        setGenerating(Boolean(themeBody.imageRequest?.requested));
        setGenerationKind(themeBody.imageRequest?.requested ? "profile" : null);
        setStatus({
          kind: "saving",
          message: themeBody.imageRequest?.requested
            ? "Generating Profile preview..."
            : themeBody.imageRequest?.reason ?? "Image generation was not queued",
        });
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Image generation request failed",
        });
      }
    });
  }

  function regeneratePlush() {
    if (!canEdit || pending || draftManual || generating) return;
    const sourceStageId = staged?.images.profile?.exists ? staged.stageId : undefined;
    if (!sourceStageId && !saved.images.profile.exists) {
      setStatus({ kind: "error", message: "Generate or upload a Profile before creating the Avatar." });
      return;
    }
    const nextMode = normalizeProfileImageCustomizationMode(draftMode);
    const nextCustom = nextMode === "Custom";
    const nextGender = nextCustom ? normalizeProfileImageGender(draftGender) : "Random";
    const nextAgeGroup = nextCustom ? normalizeProfileImageAgeGroup(draftAgeGroup) : "Random";
    const nextEthnicity = nextCustom ? normalizeProfileImageEthnicity(draftEthnicity) : "Random";
    const nextPrompt = nextCustom ? normalizeProfileImagePrompt(draftPrompt, defaultPrompt) : defaultPrompt;
    const nextUsername = nextCustom ? normalizeProfileImageContextText(draftUsername) || agent : agent;
    const nextFullName = nextCustom ? normalizeProfileImageContextText(draftFullName) : "";
    const nextBio = nextCustom ? normalizeProfileImageContextText(draftBio, 500) : "";
    const previousBaseline = {
      profile: saved.images.profile.mtimeMs,
      avatar: saved.images.avatar.mtimeMs,
    };
    clearDraftImages();
    setStatus({ kind: "saving", message: "Requesting new Avatar preview from the current Profile..." });
    startTransition(async () => {
      try {
        const themeRes = await fetch(`/api/agents/${encodeURIComponent(agent)}/images/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            theme: normalizeProfileImageTheme(draftSource),
            kind: "avatar",
            sourceStageId,
            customizationMode: nextMode,
            gender: nextGender,
            ageGroup: nextAgeGroup,
            ethnicity: nextEthnicity,
            prompt: nextPrompt,
            username: nextUsername,
            fullName: nextFullName,
            bio: nextBio,
          }),
        });
        const themeBody = await themeRes.json().catch(() => ({}));
        if (!themeRes.ok) throw new Error(themeBody.message ?? themeBody.error ?? `Avatar generation request failed (${themeRes.status})`);
        setStaged(themeBody.staged ?? { stageId: themeBody.stageId, images: {} });
        setBaseline(previousBaseline);
        setGenerating(Boolean(themeBody.imageRequest?.requested));
        setGenerationKind(themeBody.imageRequest?.requested ? "avatar" : null);
        setStatus({
          kind: "saving",
          message: themeBody.imageRequest?.requested
            ? "Generating Avatar preview..."
            : themeBody.imageRequest?.reason ?? "Avatar generation was not queued",
        });
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Avatar generation request failed",
        });
      }
    });
  }

  function save() {
    if (!canEdit || pending || !dirty) return;
    const nextSource = normalizeProfileImageTheme(draftSource);
    const nextMode = normalizeProfileImageCustomizationMode(draftMode);
    const nextCustom = nextSource !== MANUAL_IMAGE_THEME && nextMode === "Custom";
    const nextGender = nextCustom ? normalizeProfileImageGender(draftGender) : "Random";
    const nextAgeGroup = nextCustom ? normalizeProfileImageAgeGroup(draftAgeGroup) : "Random";
    const nextEthnicity = nextCustom ? normalizeProfileImageEthnicity(draftEthnicity) : "Random";
    const nextPrompt = nextCustom ? normalizeProfileImagePrompt(draftPrompt, defaultPrompt) : defaultPrompt;
    const nextUsername = nextCustom ? normalizeProfileImageContextText(draftUsername) || agent : agent;
    const nextFullName = nextCustom ? normalizeProfileImageContextText(draftFullName) : "";
    const nextBio = nextCustom ? normalizeProfileImageContextText(draftBio, 500) : "";
    const previousBaseline = {
      profile: saved.images.profile.mtimeMs,
      avatar: saved.images.avatar.mtimeMs,
    };
    setStatus({
      kind: "saving",
      message: nextSource === MANUAL_IMAGE_THEME ? "Saving profile images..." : "Saving settings and requesting new images...",
    });
    startTransition(async () => {
      try {
        const themeRes = await fetch(`/api/agents/${encodeURIComponent(agent)}/images/theme`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            theme: nextSource,
            customizationMode: nextMode,
            gender: nextGender,
            ageGroup: nextAgeGroup,
            ethnicity: nextEthnicity,
            prompt: nextPrompt,
            username: nextUsername,
            fullName: nextFullName,
            bio: nextBio,
            savePromptAsDefault,
            stagedImageId: nextSource !== MANUAL_IMAGE_THEME && stagedReady ? staged?.stageId : undefined,
            useProfileAsAvatar: nextSource !== MANUAL_IMAGE_THEME && (removed.has("avatar") || (stagedReady && !stagedAvatarReady)),
            regenerate: false,
          }),
        });
        const themeBody = await themeRes.json().catch(() => ({}));
        if (!themeRes.ok) throw new Error(themeBody.message ?? themeBody.error ?? `Image settings save failed (${themeRes.status})`);

        if (nextSource !== MANUAL_IMAGE_THEME) {
          clearDraftImages();
          setDraftSource(nextSource);
          setCandidateSource(nextSource);
          setDraftMode(nextMode);
          setCandidateMode(nextMode);
          setDraftGender(nextGender);
          setCandidateGender(nextGender);
          setDraftAgeGroup(nextAgeGroup);
          setCandidateAgeGroup(nextAgeGroup);
          setDraftEthnicity(nextEthnicity);
          setCandidateEthnicity(nextEthnicity);
          setDraftUsername(nextUsername);
          setCandidateUsername(nextUsername);
          setDraftFullName(nextFullName);
          setCandidateFullName(nextFullName);
          setDraftBio(nextBio);
          setCandidateBio(nextBio);
          setDraftPrompt(nextPrompt);
          setCandidatePrompt(nextPrompt);
          setSavePromptAsDefault(false);
          setStaged(null);
          setBaseline(previousBaseline);
          setSaved(themeBody.state ?? saved);
          setGenerating(Boolean(themeBody.imageRequest?.requested));
          setGenerationKind(null);
          setStatus({
            kind: "ok",
            message: stagedReady ? "Generated images saved" : "Image settings saved",
          });
          router.refresh();
          return;
        }

        for (const kind of KINDS) {
          if (removed.has(kind)) {
            const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/images/${kind}`, { method: "DELETE" });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error ?? `Remove failed (${res.status})`);
          }
          if (draftFiles[kind]) {
            const form = new FormData();
            form.set("image", draftFiles[kind]!);
            const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/images/${kind}`, {
              method: "PUT",
              body: form,
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error ?? `Upload failed (${res.status})`);
          }
        }

        const stateRes = await fetch(`/api/agents/${encodeURIComponent(agent)}/images`, { cache: "no-store" });
        if (stateRes.ok) setSaved((await stateRes.json()) as AgentImagesState);
        clearDraftImages();
        setSavePromptAsDefault(false);
        setStaged(null);
        setGenerationKind(null);
        setStatus({ kind: "ok", message: "Profile images saved" });
        router.refresh();
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Save failed",
        });
      }
    });
  }

  return (
    <div className="grid gap-card lg:grid-cols-[592px_minmax(0,1fr)] lg:items-start">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-2 lg:content-start">
        {KINDS.map((kind) => (
          <ImageSlot
            key={kind}
            kind={kind}
            saved={saved}
            baseline={baseline}
            previewUrl={previews[kind]}
            stagedImage={staged?.images[kind]}
            stagedActive={Boolean(staged)}
            removed={removed.has(kind)}
            manual={draftManual}
            imageOptionsChanged={imageOptionsChanged}
            generating={generating}
            waitingForSource={kind === "avatar" && generationKind === "profile" && generating}
            disabled={pending || !canEdit}
            canRegenerate={
              kind === "profile"
                ? !draftManual
                : !draftManual && !generating && (stagedProfileReady || (!staged && saved.images.profile.exists))
            }
            onRegenerate={kind === "profile" ? regenerate : kind === "avatar" ? regeneratePlush : undefined}
            canRemoveImage={kind === "avatar" && (Boolean(staged?.images.avatar?.exists) || (!staged && saved.images.avatar.exists))}
            onRemoveImage={kind === "avatar" ? removeAvatarImage : undefined}
            onUpload={chooseFile}
            onRemove={removeDraft}
          />
        ))}

        {!canEdit ? (
          <p className="text-caption text-warn sm:col-span-2">Read-only: agents can edit only themselves; the Mission Control owner can edit all.</p>
        ) : draftManual ? (
          <p className="text-caption text-text-muted sm:col-span-2">
            Manual uploads are staged locally until Save. Saved files are normalized to 256x256 PNGs.
          </p>
        ) : (
          <p className="text-caption text-text-muted sm:col-span-2">
            Generated images replace files after Save. Confy creates 256x256 close-up profile portraits; Avatar is optional.
          </p>
        )}
      </div>

      <div className="space-y-3 rounded-card border border-line bg-panel-soft p-3">
        <div className="grid gap-3 lg:grid-cols-[minmax(11rem,0.4fr)_minmax(0,1fr)_auto]">
          <div>
            <label className="mb-1 block text-caption font-semibold uppercase tracking-wider text-text-muted">
              Image source
            </label>
            <select
              disabled={!canEdit || pending}
              value={candidateSource}
              onChange={(event) => {
                setCandidateSource(normalizeProfileImageTheme(event.target.value));
                setStatus({ kind: "idle" });
              }}
              className="w-full rounded-card border border-line bg-bg px-3 py-2 text-body outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {AGENT_PROFILE_IMAGE_THEMES.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>

          {!isManual(candidateSource) ? (
            <div>
              <span className="mb-1 block text-caption font-semibold uppercase tracking-wider text-text-muted">
                Customization
              </span>
              <div className="flex flex-wrap gap-3 rounded-card border border-line bg-bg px-3 py-2 text-body">
                {PROFILE_IMAGE_CUSTOMIZATION_MODES.map((mode) => (
                  <label key={mode} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="profile-image-customization"
                      disabled={!canEdit || pending}
                      checked={candidateMode === mode}
                      onChange={() => {
                        setCandidateMode(mode);
                        if (mode === "Random") {
                          setCandidateGender("Random");
                          setCandidateAgeGroup("Random");
                          setCandidateEthnicity("Random");
                        }
                        setStatus({ kind: "idle" });
                      }}
                      className="h-4 w-4 accent-accent"
                    />
                    <span>{mode}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : <div />}

          <div className="flex items-end gap-2">
            <button
              type="button"
              disabled={!canEdit || pending || !candidateChanged}
              onClick={applySelection}
              className="rounded-card border border-line bg-bg px-card py-control-y text-body font-medium disabled:cursor-not-allowed disabled:opacity-40"
            >
              Select
            </button>
            <button
              type="button"
              disabled={!canEdit || pending || !dirty || waitingForStagedImages}
              onClick={save}
              className="rounded-card bg-accent px-card py-control-y text-body font-medium text-bg disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              disabled={pending || !dirty}
              onClick={revert}
              className="rounded-card border border-line bg-bg px-card py-control-y text-body font-medium disabled:cursor-not-allowed disabled:opacity-40"
            >
              Revert
            </button>
          </div>
        </div>

        {!isManual(candidateSource) && candidateMode === "Custom" ? (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <OptionSelect label="Gender" value={candidateGender} options={PROFILE_IMAGE_GENDERS} disabled={!canEdit || pending} onChange={(value) => setCandidateGender(normalizeProfileImageGender(value))} />
              <OptionSelect label="Age group" value={candidateAgeGroup} options={PROFILE_IMAGE_AGE_GROUPS} disabled={!canEdit || pending} onChange={(value) => setCandidateAgeGroup(normalizeProfileImageAgeGroup(value))} />
              <OptionSelect label="Ethnicity" value={candidateEthnicity} options={PROFILE_IMAGE_ETHNICITIES} disabled={!canEdit || pending} onChange={(value) => setCandidateEthnicity(normalizeProfileImageEthnicity(value))} />
            </div>
            <label className="block">
              <span className="mb-1 block text-caption font-semibold uppercase tracking-wider text-text-muted">Bio</span>
              <textarea
                disabled={!canEdit || pending}
                value={candidateBio}
                onChange={(event) => setCandidateBio(event.target.value)}
                rows={2}
                className="w-full resize-y rounded-card border border-line bg-bg px-3 py-2 text-body leading-5 outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-caption font-semibold uppercase tracking-wider text-text-muted">Confy prompt</span>
              <textarea
                disabled={!canEdit || pending}
                value={candidatePrompt}
                onChange={(event) => setCandidatePrompt(event.target.value)}
                rows={4}
                className="w-full resize-y rounded-card border border-line bg-bg px-3 py-2 text-body leading-5 outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
              />
            </label>
            <label className="flex items-center gap-2 text-caption text-text-muted">
              <input
                type="checkbox"
                disabled={!canEdit || pending}
                checked={savePromptAsDefault}
                onChange={(event) => setSavePromptAsDefault(event.currentTarget.checked)}
                className="h-4 w-4 accent-accent"
              />
              <span>Use this prompt as the default in the future</span>
            </label>
          </div>
        ) : null}

        {status.kind !== "idle" ? (
          <p className={`text-caption ${status.kind === "error" ? "text-crit" : "text-text-muted"}`}>
            {status.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function OptionSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-caption font-semibold uppercase tracking-wider text-text-muted">{label}</span>
      <select
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-card border border-line bg-bg px-3 py-2 text-body outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function ImageSlot({
  kind,
  saved,
  baseline,
  previewUrl,
  stagedImage,
  stagedActive,
  removed,
  manual,
  imageOptionsChanged,
  generating,
  waitingForSource,
  disabled,
  canRegenerate,
  onRegenerate,
  canRemoveImage,
  onRemoveImage,
  onUpload,
  onRemove,
}: {
  kind: AgentImageKind;
  saved: AgentImagesState;
  baseline: Record<AgentImageKind, number | null>;
  previewUrl?: string;
  stagedImage?: AgentImageMeta;
  stagedActive: boolean;
  removed: boolean;
  manual: boolean;
  imageOptionsChanged: boolean;
  generating: boolean;
  waitingForSource: boolean;
  disabled: boolean;
  canRegenerate?: boolean;
  onRegenerate?: () => void;
  canRemoveImage?: boolean;
  onRemoveImage?: () => void;
  onUpload: (kind: AgentImageKind, file: File | null) => void;
  onRemove: (kind: AgentImageKind) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const image = saved.images[kind];
  const readyGenerated = generating && imageChanged(kind, saved, baseline);
  const showSaved = !stagedActive && !imageOptionsChanged && !removed && !previewUrl && (!generating || readyGenerated);
  const src = removed ? null : previewUrl ?? (stagedImage?.exists ? stagedImage.url : null) ?? (showSaved && image.exists ? image.url : null);
  const loading = !src && (generating || (imageOptionsChanged && kind === "profile"));
  const regenerateLabel =
    kind === "profile"
      ? "Generate Profile preview with the current settings"
      : "Generate Avatar from the current Profile";

  return (
    <div className="w-full max-w-[280px] rounded-card border border-line bg-panel p-3">
      <div className="relative aspect-square w-full overflow-hidden rounded-lg border border-line bg-panel-soft">
        {onRegenerate && canRegenerate ? (
          <button
            type="button"
            disabled={disabled || generating}
            onClick={onRegenerate}
            title={regenerateLabel}
            aria-label={regenerateLabel}
            className="absolute right-2 top-2 z-10 grid h-8 w-8 place-items-center rounded-full border border-line bg-bg/90 text-text shadow-sm backdrop-blur transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 0 1-15.5 6.3" />
              <path d="M3 12a9 9 0 0 1 15.5-6.3" />
              <path d="M18 3v4h-4" />
              <path d="M6 21v-4h4" />
            </svg>
          </button>
        ) : null}
        {kind === "avatar" && src && canRemoveImage && onRemoveImage ? (
          <button
            type="button"
            disabled={disabled || generating}
            onClick={onRemoveImage}
            title="Remove Avatar and use Profile after Save"
            aria-label="Remove Avatar and use Profile after Save"
            className="absolute left-2 top-2 z-10 grid h-8 w-8 place-items-center rounded-full border border-line bg-bg/90 text-crit shadow-sm backdrop-blur transition hover:border-crit disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M8 6V4h8v2" />
              <path d="M19 6l-1 14H6L5 6" />
              <path d="M10 11v5" />
              <path d="M14 11v5" />
            </svg>
          </button>
        ) : null}
        {src ? (
          <img src={src} alt={LABELS[kind]} className="h-full w-full object-cover" />
        ) : loading && waitingForSource ? (
          <div className="grid h-full place-items-center text-text-muted">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 2h12" />
              <path d="M6 22h12" />
              <path d="M8 2v5a4 4 0 0 0 1.2 2.8L12 12l2.8-2.2A4 4 0 0 0 16 7V2" />
              <path d="M8 22v-5a4 4 0 0 1 1.2-2.8L12 12l2.8 2.2A4 4 0 0 1 16 17v5" />
              <path d="M10 6h4" />
              <path d="M10 18h4" />
            </svg>
          </div>
        ) : loading ? (
          <div className="grid h-full place-items-center text-caption text-text-muted">
            <span className="h-7 w-7 animate-spin rounded-full border-2 border-line border-t-accent" />
          </div>
        ) : (
          <div className="grid h-full place-items-center px-3 text-center text-caption text-text-muted">
            No {LABELS[kind].toLowerCase()} image
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <div>
          <div className="text-body font-medium">{LABELS[kind]}</div>
          <div className="text-caption text-text-muted">
            {previewUrl || stagedImage?.exists ? "Staged" : removed ? "Removed on save" : image.exists && image.bytes ? `${Math.round(image.bytes / 1024)} KiB` : "256 PNG"}
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
              className="rounded-lg border border-line px-2 py-1 text-caption hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              Upload
            </button>
            <button
              type="button"
              disabled={disabled || (!image.exists && !previewUrl)}
              onClick={() => onRemove(kind)}
              className="rounded-lg border border-line px-2 py-1 text-caption text-crit hover:border-crit disabled:cursor-not-allowed disabled:opacity-40"
            >
              Remove
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
