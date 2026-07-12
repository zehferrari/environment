import type { DefaultSession } from "next-auth";
import type { ActorKind } from "@/lib/workflow";

declare module "next-auth" {
  interface User {
    id: string;
    kind?: ActorKind;
    passwordSetAt?: string | null;
  }
  interface Session {
    user: DefaultSession["user"] & {
      id?: string;
      kind?: ActorKind;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
    kind?: ActorKind;
    passwordSetAt?: string | null;
  }
}
