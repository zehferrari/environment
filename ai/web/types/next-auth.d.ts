import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    id: string;
    kind?: string;
    mustRotatePassword?: boolean;
  }
  interface Session {
    user: DefaultSession["user"] & {
      id?: string;
      kind?: string;
      mustRotatePassword?: boolean;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
    kind?: string;
    mustRotatePassword?: boolean;
  }
}
