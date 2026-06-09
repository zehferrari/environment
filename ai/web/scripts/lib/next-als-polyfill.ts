// Side-effect only: install `globalThis.AsyncLocalStorage` before any Next.js
// internal is imported. Next captures this global at module-eval time; outside
// the Next runtime it is absent, so its async-local-storage shim degrades to a
// throwing fake. This module imports no Next code, so importing it before any
// Next internal guarantees the global is set first.
import { AsyncLocalStorage } from "node:async_hooks";

const globalWithAls = globalThis as unknown as { AsyncLocalStorage?: unknown };
if (!globalWithAls.AsyncLocalStorage) {
  globalWithAls.AsyncLocalStorage = AsyncLocalStorage;
}
