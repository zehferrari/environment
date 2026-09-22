import type { FormalBlockerReport } from "@/lib/tasks/formal-blocker";

export const GIT_IDENTITY_ERROR_CODE = "git_identity_incomplete";
export const GIT_IDENTITY_ERROR =
  "[git_identity_incomplete] The effective project Git identity is incomplete; PM cannot create the submission commit. " +
  "Ask the project owner to configure defaultGitUserName and defaultGitUserEmail in PM Project, Workspace or System settings. " +
  "Local git config does not repair PM settings. Report this configuration dependency once; do not rebuild or resubmit until the effective identity is complete.";

export function hasCompleteGitIdentity(identity: { name: string | null; email: string | null }) {
  return Boolean(identity.name?.trim() && identity.email?.trim());
}

/** Recognize the exact PM failure, including reports made before typed errors. */
export function isGitIdentityBlocker(report: FormalBlockerReport | null | undefined) {
  return Boolean(report && !report.permission &&
    ["person", "dependency", "external_service"].includes(report.blockedOn) &&
    /(?:\[git_identity_incomplete\]|effective project Git identity is incomplete)/i.test(report.evidence) &&
    /defaultGitUserName|defaultGitUserEmail|PM.*(?:Git|identity)|project.*(?:Git|identity)/i.test(report.requestedAction));
}
