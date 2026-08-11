import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "../app/api/auth/session-expired/route";
import { isAuthSessionCookieName } from "../lib/auth/session-recovery";

async function main() {
  assert.equal(isAuthSessionCookieName("authjs.session-token"), true);
  assert.equal(isAuthSessionCookieName("__Secure-authjs.session-token"), true);
  assert.equal(isAuthSessionCookieName("__Secure-authjs.session-token.0"), true);
  assert.equal(isAuthSessionCookieName("__Secure-authjs.session-token.12"), true);
  assert.equal(isAuthSessionCookieName("__Secure-authjs.session-token.bad"), false);
  assert.equal(isAuthSessionCookieName("authjs.callback-url"), false);

  const originalAuthUrl = process.env.AUTH_URL;
  process.env.AUTH_URL = "https://agents.vixi.au";
  const request = new NextRequest("http://127.0.0.1:3000/api/auth/session-expired", {
    headers: {
      cookie: [
        "authjs.session-token=legacy",
        "__Secure-authjs.session-token.0=stale-a",
        "__Secure-authjs.session-token.1=stale-b",
        "unrelated=keep",
      ].join("; "),
      host: "agents.vixi.au",
      "x-forwarded-host": "agents.vixi.au",
      // The innermost proxy speaks HTTP on thinkpad; AUTH_URL remains the
      // canonical public origin after TLS terminated on moonlight.
      "x-forwarded-proto": "http",
    },
  });
  const response = GET(request);
  if (originalAuthUrl === undefined) delete process.env.AUTH_URL;
  else process.env.AUTH_URL = originalAuthUrl;
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "https://agents.vixi.au/login?expired=1");
  assert.equal(response.headers.get("cache-control"), "no-store");

  const setCookie = response.headers.getSetCookie().join("\n");
  assert.match(setCookie, /authjs\.session-token=;/);
  assert.match(setCookie, /__Secure-authjs\.session-token=;[^\n]*Secure/);
  assert.match(setCookie, /__Secure-authjs\.session-token\.0=;[^\n]*Secure/);
  assert.match(setCookie, /__Secure-authjs\.session-token\.1=;[^\n]*Secure/);
  assert.doesNotMatch(setCookie, /unrelated=/);

  const middleware = await readFile(path.join(process.cwd(), "middleware.ts"), "utf8");
  assert.match(middleware, /"\/manifest\.webmanifest"/);
  assert.match(middleware, /"\/icons"/);

  const permissions = await readFile(path.join(process.cwd(), "lib/auth/permissions.ts"), "utf8");
  assert.match(
    permissions,
    /if \(!viewer\) redirect\(SESSION_RECOVERY_PATH\)/,
    "invalid server-side sessions use the cookie-clearing recovery route",
  );

  console.log("auth-session-recovery-test: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
