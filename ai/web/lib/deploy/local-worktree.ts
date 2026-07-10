import { parseProtectedBranches } from "@/lib/projects/protected-branches";

export const DEFAULT_LOCAL_WORKTREE_PROTECTED_BRANCHES = [
  "main",
  "master",
  "production",
  "prod",
  "staging",
  "stage",
  "develop",
  "dev",
] as const;

type ProjectBranchProtection = {
  deploymentProductionBranch: string | null;
  deploymentPrTargetBranch: string | null;
  agentChangeBlockedBranches: string | null;
};

export function localWorktreeProtectedBranches(project: ProjectBranchProtection): string[] {
  const branches = [
    ...DEFAULT_LOCAL_WORKTREE_PROTECTED_BRANCHES,
    project.deploymentProductionBranch,
    project.deploymentPrTargetBranch,
    ...parseProtectedBranches(project.agentChangeBlockedBranches),
  ];
  const seen = new Set<string>();
  return branches.filter((branch): branch is string => Boolean(branch)).filter((branch) => {
    const key = branch.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isLocalWorktreeProtected(branch: string, protectedBranches: string[]): boolean {
  return protectedBranches.some((item) => item.toLowerCase() === branch.toLowerCase());
}
