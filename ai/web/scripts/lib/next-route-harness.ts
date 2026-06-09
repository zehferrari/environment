// Smallest practical harness for exercising a Next.js App Router route handler
// at the route boundary inside a plain `tsx` script (no dev server).
//
// `./next-als-polyfill` MUST be imported first (before the Next internal below):
// it installs `globalThis.AsyncLocalStorage`, which Next's async-local-storage
// module captures at eval time. The separate-module boundary guarantees that
// side effect runs before `work-async-storage.external` is evaluated.
//
// `runRouteHandler` runs the handler inside a minimal `workAsyncStorage` store
// so `revalidatePath`/`revalidateTag` calls inside the route become no-ops
// instead of throwing the "static generation store missing" invariant.
import "./next-als-polyfill";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";

export async function runRouteHandler<T>(handler: () => Promise<T>): Promise<T> {
  const store = {
    route: "/__test__",
    incrementalCache: {},
  } as unknown as Parameters<typeof workAsyncStorage.run>[0];
  return workAsyncStorage.run(store, handler);
}
