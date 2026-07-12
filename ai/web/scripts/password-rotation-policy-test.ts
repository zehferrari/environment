import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

async function main() {
  const [middleware, auth, sync, schema, migration] = await Promise.all([
    source("middleware.ts"),
    source("lib/auth.ts"),
    source("lib/agents/management/sync.ts"),
    source("prisma/schema.prisma"),
    source("prisma/migrations/20260712140000_disable_forced_password_rotation/migration.sql"),
  ]);

  assert.doesNotMatch(middleware, /mustRotatePassword/, "middleware never redirects an account for password rotation");
  assert.doesNotMatch(auth, /mustRotatePassword/, "login sessions do not carry a rotation requirement");
  assert.match(sync, /mustRotatePassword:\s*false/, "new agent accounts do not require a password rotation");
  assert.match(schema, /mustRotatePassword\s+Boolean\s+@default\(false\)/, "new user rows default to no rotation requirement");
  assert.match(migration, /false AS "mustRotatePassword"/, "migration clears legacy rotation requirements");

  console.log("password-rotation-policy-test: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
