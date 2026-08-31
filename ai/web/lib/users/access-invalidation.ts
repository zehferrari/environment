import { revalidateTag } from "next/cache";
import { taskCacheTag } from "@/lib/tasks/cache";

export type AccessInvalidationRevalidateTag = (tag: string) => void;

/**
 * Immediate cache invalidation for an access-policy change (ENV-168).
 * Cached payloads and prefetched route data must not outlive a revocation:
 * the project-scoped fragment caches (epic lists a viewer can prefetch) are
 * tag-revalidated as part of the mutation instead of waiting for their
 * stale-while-revalidate window. Authorization itself never depends on this —
 * every request re-reads role/status/membership from the database — this
 * removes the stale *data* window, not the authorization gap.
 *
 * Next's revalidateTag needs the request async-local-storage store; standalone
 * `tsx` runners (tests, repository jobs) have none, so the missing-store
 * invariant is a no-op there — same rule as revalidateTaskShellIfAvailable in
 * lib/tasks/cache.ts.
 */
export function revalidateAccessCachesForProjects(
  projectIds: readonly string[],
  revalidate: AccessInvalidationRevalidateTag = revalidateTag,
): boolean {
  try {
    for (const projectId of new Set(projectIds)) {
      revalidate(taskCacheTag.projectEpics(projectId));
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/static generation store missing/i.test(message)) return false;
    throw error;
  }
}
