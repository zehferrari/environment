import { db } from "@/lib/db";

export type ValidationCommand = {
  name: string;
  executable: string;
  args: string[];
  timeoutSeconds: number;
  required: boolean;
};

export type ValidationProfileSnapshot = {
  id: string | null;
  version: number;
  commands: ValidationCommand[];
};

const SAFE_EXECUTABLE = /^[A-Za-z0-9_./+-]+$/;

export function parseValidationCommands(value: string): ValidationCommand[] {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("Validation profile commands must be valid JSON.");
  }
  if (!Array.isArray(raw) || raw.length > 20) {
    throw new Error("Validation profile commands must be an array of at most 20 checks.");
  }
  const names = new Set<string>();
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Validation check ${index + 1} must be an object.`);
    }
    const item = entry as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const executable = typeof item.executable === "string" ? item.executable.trim() : "";
    if (!name || name.length > 100 || names.has(name)) {
      throw new Error(`Validation check ${index + 1} has a missing, duplicate, or overlong name.`);
    }
    names.add(name);
    if (!executable || executable.length > 300 || !SAFE_EXECUTABLE.test(executable)) {
      throw new Error(`Validation check ${name} has an invalid executable.`);
    }
    if (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string" || arg.length > 1000)) {
      throw new Error(`Validation check ${name} args must be an array of strings.`);
    }
    const timeoutSeconds = typeof item.timeoutSeconds === "number"
      ? Math.min(3600, Math.max(1, Math.round(item.timeoutSeconds)))
      : 600;
    return {
      name,
      executable,
      args: item.args as string[],
      timeoutSeconds,
      required: item.required !== false,
    };
  });
}

export async function resolveValidationProfileSnapshot(
  projectId: string,
): Promise<ValidationProfileSnapshot> {
  const profile = await db.projectValidationProfile.findUnique({
    where: { projectId },
    select: { id: true, version: true, enabled: true, commands: true },
  });
  if (!profile?.enabled) return { id: null, version: 0, commands: [] };
  return {
    id: profile.id,
    version: profile.version,
    commands: parseValidationCommands(profile.commands),
  };
}
