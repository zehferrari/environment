/**
 * Boot-time hook for the Next.js server process.
 *
 * The actual work runs only on the Node runtime — Edge bundle stays empty.
 * Pattern per Next.js 15 docs: split per-runtime to keep node-only deps
 * (Prisma, argon2, fs) out of the Edge bundle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation.node");
  }
}
