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

  console.log("middleware-public-protocol-test: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
