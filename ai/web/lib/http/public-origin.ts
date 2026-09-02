export function normalizePublicOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function publicOriginFromHeaders(headers: Headers): string | null {
  // Multi-hop proxies can overwrite x-forwarded-proto with the final internal
  // HTTP hop. A configured public origin is both more trustworthy than Host
  // and the only reliable way to keep generated callback URLs on HTTPS.
  const configured = normalizePublicOrigin(
    process.env.APP_URL ?? process.env.AUTH_URL ?? process.env.NEXTAUTH_URL,
  );
  if (configured) return configured;

  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return null;
  const proto =
    headers.get("x-forwarded-proto") ??
    (host.includes("localhost") || host.startsWith("127.") ? "http" : "https");
  return normalizePublicOrigin(`${proto}://${host}`);
}

export function absolutePublicUrl(path: string, origin: string | null): string {
  if (!origin) return path;
  return new URL(path, origin).toString();
}

export function isLoopbackOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}
