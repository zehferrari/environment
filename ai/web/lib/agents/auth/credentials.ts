import { promises as fs } from "fs";
import { randomBytes } from "crypto";
import path from "path";

const DIR = process.env.AGENT_CREDENTIALS_DIR ?? "/etc/openclaw/pm-agent-credentials";

export type SeededAgentCredential = {
  agent: string;
  username: string;
  password: string;
  createdAt: string;
};

/**
 * Ensure a per-agent credential file exists at
 *   $AGENT_CREDENTIALS_DIR/<agent>.json (mode 0600).
 *
 * If the file already exists, returns the existing credential (parse it
 * out of the file). If not, generates a new strong password, writes it,
 * and returns the new credential.
 *
 * Never logged or committed. Read by the agent process out-of-band for
 * authenticated access.
 */
export async function ensureAgentCredential(agent: string): Promise<SeededAgentCredential> {
  await fs.mkdir(DIR, { recursive: true, mode: 0o700 }).catch(() => undefined);

  const file = path.join(DIR, `${agent}.json`);

  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as SeededAgentCredential;
    if (parsed?.password) return parsed;
  } catch {
    // fall through
  }

  const password = randomBytes(24).toString("base64url"); // ~32 chars
  const credential: SeededAgentCredential = {
    agent,
    username: agent,
    password,
    createdAt: new Date().toISOString(),
  };

  await fs.writeFile(file, JSON.stringify(credential, null, 2), { mode: 0o600 });
  return credential;
}
