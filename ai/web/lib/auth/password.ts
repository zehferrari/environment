import { hash, verify } from "@node-rs/argon2";

// Argon2id parameters — OWASP 2024 recommendation, conservative for v1.
// algorithm: 2 === Argon2id (per @node-rs/argon2 enum).
const ARGON2_OPTS = {
  algorithm: 2 as const,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTS);
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    return await verify(stored, plain);
  } catch {
    return false;
  }
}
