import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const middleware = await readFile(path.join(process.cwd(), "middleware.ts"), "utf8");

  assert.match(
    middleware,
    /process\.env\.AUTH_URL \?\? process\.env\.NEXTAUTH_URL \?\? process\.env\.APP_URL/,
    "middleware derives the public protocol from the configured Auth.js origin",
  );
  assert.match(
    middleware,
    /secureCookie: publicProtocol\(req\) === "https"/,
    "secure Auth.js cookies are selected from the public protocol",
  );
  assert.match(
    middleware,
    /\$\{publicProtocol\(req\)\}:\/\/\$\{host\}/,
    "auth redirects retain the configured public protocol",
  );
  assert.match(
    middleware,
    /isTokenScopedTaskAttachmentUpload\(req, path\)/,
    "task-scoped agent attachment uploads bypass browser login and authenticate in their route",
  );

  const { middleware: handle } = await import("../middleware");
  const { NextRequest } = await import("next/server");
  const notePath = "http://localhost/api/agent/tasks/task-1/notes";
  const note = await handle(new NextRequest(notePath, { method: "POST" }));
  assert.equal(note.headers.get("x-middleware-next"), "1", "notes reach their token-authenticated handler without a browser session");
  for (const [url, method] of [[notePath, "GET"], [notePath + "/extra", "POST"], ["http://localhost/api/agent/tasks/task-1/other", "POST"]]) {
    const denied = await handle(new NextRequest(url, { method }));
    assert.equal(denied.status, 307, "unsupported methods and sibling paths retain browser auth");
  }
  console.log("middleware-public-protocol-test: ok (including exact task-note POST boundary)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
