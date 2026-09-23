import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export type DevCommand = { executable: string; args: string[]; timeoutSeconds: number };
export type DevPublicationConfig = {
  environment: "development" | "test" | "staging";
  environmentId: string;
  target: string;
  repositoryPath: string;
  allowedOperations: Array<"publish" | "deploy">;
  publishTriggersDeployment: boolean;
  configurationFiles: Array<{ path: string; sha256: string }>;
  devOnCheckpoint: DevCommand | null;
  verify: DevCommand;
};

function command(raw: unknown, label: string): DevCommand {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label} must be a registered command.`);
  const value = raw as Record<string, unknown>;
  if (typeof value.executable !== "string" || !isAbsolute(value.executable) || !/^\/[A-Za-z0-9_./+-]+$/.test(value.executable)) {
    throw new Error(`${label} executable must be an absolute installed path; shell command strings are not accepted.`);
  }
  if (!Array.isArray(value.args) || value.args.length > 40 || value.args.some(arg => typeof arg !== "string" || arg.length > 2000)) throw new Error(`${label} args must be an array of strings.`);
  if (!Number.isInteger(value.timeoutSeconds) || Number(value.timeoutSeconds) < 1 || Number(value.timeoutSeconds) > 60) throw new Error(`${label} timeoutSeconds must be between 1 and 60; deployment readiness is retried by the runner.`);
  return { executable: value.executable, args: value.args as string[], timeoutSeconds: Number(value.timeoutSeconds) };
}

/** Owner-managed policy. Branch names alone never establish deployment safety. */
export function parseDevPublicationConfig(raw: string | null | undefined): DevPublicationConfig | null {
  if (!raw?.trim()) return null;
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw); } catch { throw new Error("Dev publication configuration must be valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Dev publication configuration must be an object.");
  if (!["development", "test", "staging"].includes(String(value.environment))) throw new Error("Dev publication requires a named non-production environment.");
  for (const field of ["environmentId", "target", "repositoryPath"] as const) {
    if (typeof value[field] !== "string" || !value[field].trim() || value[field].length > 1000) throw new Error(`${field} is required.`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(String(value.environmentId))) throw new Error("environmentId must be a stable shared-environment identifier.");
  if (!isAbsolute(String(value.repositoryPath))) throw new Error("Dev repositoryPath must be absolute.");
  if (typeof value.publishTriggersDeployment !== "boolean") throw new Error("Declare whether publication triggers a deployment pipeline.");
  if (!Array.isArray(value.configurationFiles) || value.configurationFiles.length > 30 || value.configurationFiles.some(file => !file || typeof file.path !== "string" || !/^[A-Za-z0-9_.\/-]+$/.test(file.path) || file.path.startsWith("/") || file.path.split("/").includes("..") || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new Error("configurationFiles must pin repository-relative deployment files with SHA-256 hashes.");
  if (value.publishTriggersDeployment && !value.configurationFiles.length) throw new Error("A deployment-triggering push must pin its pipeline configuration files.");
  if (!Array.isArray(value.allowedOperations) || !value.allowedOperations.includes("publish") || value.allowedOperations.some(op => !["publish", "deploy"].includes(op))) throw new Error("allowedOperations must explicitly contain publish and, when applicable, deploy.");
  const devOnCheckpoint = value.devOnCheckpoint == null ? null : command(value.devOnCheckpoint, "devOnCheckpoint");
  if ((value.publishTriggersDeployment || devOnCheckpoint) && !value.allowedOperations.includes("deploy")) throw new Error("Deployment effects require the deploy operation to be authorized.");
  return {
    environment: value.environment as DevPublicationConfig["environment"], environmentId: String(value.environmentId).trim(),
    target: String(value.target).trim(), repositoryPath: String(value.repositoryPath).trim(),
    allowedOperations: [...new Set(value.allowedOperations)] as DevPublicationConfig["allowedOperations"],
    publishTriggersDeployment: value.publishTriggersDeployment,
    configurationFiles: (value.configurationFiles as Array<{ path: string; sha256: string }>).map(file => ({ path: file.path, sha256: file.sha256 })),
    devOnCheckpoint, verify: command(value.verify, "verify"),
  };
}

export function devConfigFingerprint(config: DevPublicationConfig): string {
  return createHash("sha256").update(JSON.stringify({ ...config, allowedOperations: [...config.allowedOperations].sort() })).digest("hex");
}
