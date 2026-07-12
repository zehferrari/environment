import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { z } from "zod";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import {
  checkLoginRateLimit,
  clientIpFromRequest,
} from "@/lib/auth/rate-limit";

const CredentialsSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw, request) {
        const parsed = CredentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const { username, password } = parsed.data;

        // Rate limit before any DB lookup. Per-IP 10/5min + per-username
        // 5/5min, in-process sliding window (v1 single host). Blocks brute
        // force without leaking which axis tripped.
        const ip = clientIpFromRequest(request);
        const rl = checkLoginRateLimit(ip, username);
        if (!rl.ok) {
          console.warn(
            `[auth] login rate-limited reason=${rl.reason} ip=${ip ?? "unknown"} user=${username} retryAfter=${rl.retryAfterSec}s`,
          );
          return null;
        }

        const user = await db.user.findFirst({
          where: {
            OR: [{ username }, { email: username }],
          },
        });
        if (!user || user.status !== "active" || !user.passwordHash) return null;

        const ok = await verifyPassword(password, user.passwordHash);
        if (!ok) return null;

        return {
          id: user.id,
          name: user.username,
          email: user.email,
          // Coerce DB string into the ActorKind union — anything other
          // than the literal "agent" is treated as a human actor for
          // the purpose of workflow rule enforcement (HOMELAB-44).
          kind: user.kind === "agent" ? ("agent" as const) : ("human" as const),
          mustRotatePassword: user.mustRotatePassword,
          passwordSetAt: user.passwordSetAt?.toISOString() ?? null,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.uid = user.id;
        token.kind = user.kind;
        token.mustRotatePassword = user.mustRotatePassword;
        token.passwordSetAt = user.passwordSetAt ?? null;
      } else if (token.uid) {
        const current = await db.user.findUnique({
          where: { id: token.uid },
          select: { status: true, passwordSetAt: true },
        });
        const currentPasswordSetAt = current?.passwordSetAt?.toISOString() ?? null;
        if (!current || current.status !== "active" || currentPasswordSetAt !== (token.passwordSetAt ?? null)) {
          return {};
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token?.uid && session.user) {
        session.user.id = token.uid;
        session.user.kind = token.kind;
        session.user.mustRotatePassword = Boolean(token.mustRotatePassword);
      }
      return session;
    },
  },
});
