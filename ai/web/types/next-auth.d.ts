import type { DefaultSession } from "next-auth";
import type { ActorKind } from "@/lib/workflow";

declare module "next-auth" {
  interface User {
    id: string;
    kind?: ActorKind;
    mustRotatePassword?: boolean;
  }
  interface Session {
    user: DefaultSession["user"] & {
      id?: string;
      kind?: ActorKind;
      mustRotatePassword?: boolean;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
    kind?: ActorKind;
    mustRotatePassword?: boolean;
  }
}
