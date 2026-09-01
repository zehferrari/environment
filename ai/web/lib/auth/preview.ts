import { db } from "@/lib/db";
import {
  agentVisibilityForRole,
  isActiveOwnerPrincipal,
  resolveHumanRole,
  type HumanRole,
} from "@/lib/auth/roles";
import { PREVIEW_TOKEN_TTL_SECONDS } from "@/lib/auth/preview-cookie";

type PreviewTokenPayload = {
  version: 1;
  actorUserId: string;
  targetUserId: string;
  issuedAt: number;
  expiresAt: number;
};

export type PreviewTarget = {
  id: string;
  username: string;
  kind: "human";
  role: Exclude<HumanRole, "owner">;
  agentVisibility: ReturnType<typeof agentVisibilityForRole>;
  canAccessOwnerFeatures: false;
};

export type PreviewActor = {
  id: string;
  username: string;
  kind: "human";
  role: "owner";
};

function secret(): string {
  const value = process.env.AUTH_SECRET?.trim();
  if (!value) throw new Error("AUTH_SECRET is required for Owner preview tokens");
  return value;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signPayload(encodedPayload: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(),
    new TextEncoder().encode(encodedPayload),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

async function encodeToken(payload: PreviewTokenPayload): Promise<string> {
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${encodedPayload}.${await signPayload(encodedPayload)}`;
}

async function decodeToken(rawToken: string): Promise<PreviewTokenPayload | null> {
  const [encodedPayload, encodedSignature, extra] = rawToken.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) return null;
  const signature = decodeBase64Url(encodedSignature);
  const payloadBytes = decodeBase64Url(encodedPayload);
  if (!signature || !payloadBytes) return null;
  const signatureBytes = new Uint8Array(signature);

  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(),
    signatureBytes,
    new TextEncoder().encode(encodedPayload),
  );
  if (!valid) return null;

  try {
    const value = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<PreviewTokenPayload>;
    if (
      value.version !== 1
      || typeof value.actorUserId !== "string"
      || typeof value.targetUserId !== "string"
      || typeof value.issuedAt !== "number"
      || typeof value.expiresAt !== "number"
      || value.expiresAt <= Math.floor(Date.now() / 1000)
      || value.issuedAt > value.expiresAt
    ) return null;
    return value as PreviewTokenPayload;
  } catch {
    return null;
  }
}

async function eligibleTarget(targetUserId: string): Promise<PreviewTarget | null> {
  const target = await db.user.findUnique({
    where: { id: targetUserId },
    select: {
      id: true,
      username: true,
      kind: true,
      status: true,
      isOwner: true,
      rolePermission: { select: { name: true } },
    },
  });
  if (!target || target.status !== "active" || target.kind !== "human" || target.isOwner) return null;
  const role = resolveHumanRole(target);
  if (role !== "admin" && role !== "customer") return null;
  return {
    id: target.id,
    username: target.username,
    kind: "human",
    role,
    agentVisibility: agentVisibilityForRole(role),
    canAccessOwnerFeatures: false,
  };
}

/**
 * Validate an activation request without changing any database or session row.
 * The only state created by the route is the authenticated Owner's signed,
 * HttpOnly preview cookie.
 */
export async function issueOwnerPreviewToken(
  actorUserId: string,
  targetUserId: string,
): Promise<string | null> {
  const actor = await db.user.findUnique({
    where: { id: actorUserId },
    select: { id: true, kind: true, status: true, isOwner: true },
  });
  if (!isActiveOwnerPrincipal(actor) || !(await eligibleTarget(targetUserId))) return null;

  const issuedAt = Math.floor(Date.now() / 1000);
  return encodeToken({
    version: 1,
    actorUserId,
    targetUserId,
    issuedAt,
    expiresAt: issuedAt + PREVIEW_TOKEN_TTL_SECONDS,
  });
}

/** Resolve a signed preview through the selected user's live role/status row. */
export async function resolveOwnerPreviewTarget(
  actor: { id: string; kind: "human" | "agent"; role: HumanRole | null },
  rawToken: string,
): Promise<PreviewTarget | null> {
  if (actor.kind !== "human" || actor.role !== "owner") return null;
  const payload = await decodeToken(rawToken);
  if (!payload || payload.actorUserId !== actor.id) return null;
  return eligibleTarget(payload.targetUserId);
}
