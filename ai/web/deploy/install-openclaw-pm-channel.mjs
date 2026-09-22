#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  mkdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_AGENT_ROOT = "/srv/agents/openclaw";
const DEFAULT_REGISTRY = "/etc/openclaw/agents.json";
const DEFAULT_TOKEN_FILE = "/etc/openclaw/pm-channel-tokens.json";
const DEFAULT_CALLBACK_URL = "http://127.0.0.1:3000/api/openclaw/pm-channel/reply";
const DEFAULT_OPENCLAW_BIN = "/usr/local/bin/openclaw";
const DEFAULT_DEPLOY_PATH = "/usr/local/share/openclaw/plugins/pm-channel";
const PLUGIN_FILES = [
  "index.js",
  // index.js imports ./session-key.js — it MUST be staged together with
  // index.js or a divergence between the two bricks every agent gateway.
  "session-key.js",
  "session-cancellation.js",
  "runtime-compat.js",
  "task-tools.js",
  "task-attachments.js",
  "task-backend.js",
  "turn-effort.js",
  "turn-completion.js",
  "task-telemetry.js",
  "openclaw.plugin.json",
  "package.json",
  "README.md",
];
// Files found in older deployments that are not part of the plugin anymore
// (e.g. a stray reasoning-stream.js from Jun 18 that never lived in the
// repo). Removed at stage time so the deployed dir mirrors PLUGIN_FILES.
const STALE_PLUGIN_FILES = [
  "reasoning-stream.js",
];

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

async function writeJsonAtomic(file, value, mode, owner = null) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  if (owner) {
    await chown(tmp, owner.uid, owner.gid);
  }
  await rename(tmp, file);
  await chmod(file, mode);
  if (owner) {
    await chown(file, owner.uid, owner.gid);
  }
}

function uidFor(user) {
  return execFileSync("id", ["-u", user], { encoding: "utf8" }).trim();
}

function gidFor(group) {
  try {
    return Number(execFileSync("id", ["-g", group], { encoding: "utf8" }).trim());
  } catch {
    const entry = execFileSync("getent", ["group", group], { encoding: "utf8" }).trim();
    const gid = Number(entry.split(":")[2]);
    if (!Number.isFinite(gid)) throw new Error(`Unable to resolve group: ${group}`);
    return gid;
  }
}

function parseAgentList(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function agentsFromRegistry(registryPath) {
  try {
    const registry = readJson(registryPath, null);
    if (!registry || !Array.isArray(registry.agents)) return [];
    return registry.agents
      .filter((agent) => agent && agent.enabled === true && typeof agent.user === "string")
      .map((agent) => ({
        user: agent.user.trim(),
        home: typeof agent.home === "string" && agent.home.trim()
          ? agent.home.trim()
          : `/home/${agent.user.trim()}`,
      }))
      .filter((agent) => agent.user);
  } catch {
    return [];
  }
}

async function stagePlugin(sourcePath, deployPath) {
  await mkdir(deployPath, { recursive: true });
  await chown(deployPath, 0, 0);
  await chmod(deployPath, 0o755);
  for (const file of PLUGIN_FILES) {
    const source = path.join(sourcePath, file);
    const target = path.join(deployPath, file);
    if (!existsSync(source)) {
      throw new Error(`Plugin file does not exist: ${source}`);
    }
    await copyFile(source, target);
    await chown(target, 0, 0);
    await chmod(target, 0o644);
  }
  for (const file of STALE_PLUGIN_FILES) {
    const target = path.join(deployPath, file);
    if (existsSync(target)) {
      await rm(target, { force: true });
      console.log(`[pm-channel] removed stale plugin file: ${target}`);
    }
  }
  return deployPath;
}

function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

async function configureAgentConfig({
  configPath,
  token,
  callbackUrl,
  sourcePluginPath,
  installedPluginPath,
}) {
  const config = readJson(configPath, null);
  if (!config) return false;

  const configStat = await stat(configPath);
  const currentMode = configStat.mode & 0o777;
  const owner = { uid: configStat.uid, gid: configStat.gid };

  config.channels = config.channels && typeof config.channels === "object" ? config.channels : {};
  config.channels.pm = {
    ...(config.channels.pm && typeof config.channels.pm === "object" ? config.channels.pm : {}),
    enabled: true,
    token,
    callbackToken: token,
    callbackUrl,
    agentId: config.channels.pm?.agentId ?? "main",
  };
  config.plugins = config.plugins && typeof config.plugins === "object" ? config.plugins : {};
  config.plugins.entries = config.plugins.entries && typeof config.plugins.entries === "object"
    ? config.plugins.entries
    : {};
  config.plugins.entries.pm = {
    ...(config.plugins.entries.pm && typeof config.plugins.entries.pm === "object"
      ? config.plugins.entries.pm
      : {}),
    enabled: true,
  };
  config.plugins.load = config.plugins.load && typeof config.plugins.load === "object"
    ? config.plugins.load
    : {};
  const existingPaths = Array.isArray(config.plugins.load.paths) ? config.plugins.load.paths : [];
  const cleanedPaths = existingPaths.filter((entry) =>
    typeof entry === "string"
      && !samePath(entry, sourcePluginPath)
      && !samePath(entry, installedPluginPath)
  );
  cleanedPaths.push(installedPluginPath);
  config.plugins.load.paths = cleanedPaths;

  await writeJsonAtomic(configPath, config, currentMode, owner);
  return true;
}

function runOpenClawInstall(agent, home, pluginPath, openclawBin) {
  const uid = uidFor(agent);
  execFileSync("sudo", [
    "-n",
    "-u",
    agent,
    "env",
    `HOME=${home}`,
    `XDG_RUNTIME_DIR=/run/user/${uid}`,
    openclawBin,
    "plugins",
    "install",
    // This installer explicitly trusts the repo-managed, root-owned plugin.
    "--force",
    "--accept-capabilities",
    "--link",
    pluginPath,
  ], { stdio: "inherit" });
}

async function copyCanonicalConfigToHome(agent, home, canonicalConfigPath) {
  const homeConfigPath = path.join(home, ".openclaw/openclaw.json");
  const canonical = readJson(canonicalConfigPath, null);
  if (!canonical) throw new Error(`Missing or invalid canonical config: ${canonicalConfigPath}`);
  await writeJsonAtomic(
    homeConfigPath,
    canonical,
    0o600,
    { uid: Number(uidFor(agent)), gid: Number(gidFor(agent)) },
  );
}

async function reconcileAgentConfigCopy(agent, home, canonicalConfigPath) {
  const homeConfigPath = path.join(home, ".openclaw/openclaw.json");
  if (!existsSync(canonicalConfigPath) || !existsSync(homeConfigPath)) return;

  // `openclaw plugins install --link` may add current schema/plugin metadata
  // through an atomic write to the regular home config. Promote that validated
  // result back to the PM-owned canonical file, then republish the canonical
  // bytes as a regular 0600 runtime copy.
  const runtimeConfig = readJson(homeConfigPath, null);
  if (!runtimeConfig) {
    throw new Error(`OpenClaw wrote an invalid config: ${homeConfigPath}`);
  }
  const canonicalStat = await stat(canonicalConfigPath);
  await writeJsonAtomic(
    canonicalConfigPath,
    runtimeConfig,
    canonicalStat.mode & 0o777,
    { uid: canonicalStat.uid, gid: canonicalStat.gid },
  );
  await copyCanonicalConfigToHome(agent, home, canonicalConfigPath);
}

function restartGateway(agent, home) {
  const uid = uidFor(agent);
  execFileSync("sudo", [
    "-n",
    "-u",
    agent,
    "env",
    `HOME=${home}`,
    `XDG_RUNTIME_DIR=/run/user/${uid}`,
    "systemctl",
    "--user",
    "restart",
    "openclaw-gateway.service",
  ], { stdio: "inherit" });
}

function gatewayActiveState(agent, home) {
  const uid = uidFor(agent);
  try {
    return execFileSync("sudo", [
      "-n",
      "-u",
      agent,
      "env",
      `HOME=${home}`,
      `XDG_RUNTIME_DIR=/run/user/${uid}`,
      "systemctl",
      "--user",
      "is-active",
      "openclaw-gateway.service",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "inactive";
  }
}

async function waitForGatewayActive(agent, home) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const state = gatewayActiveState(agent, home);
    if (state === "active") return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${agent}: openclaw-gateway.service did not become active after restart`);
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const pluginPath = path.resolve(argValue("--plugin", path.join(repoRoot, "openclaw-pm-channel")));
const agentRoot = argValue("--agent-root", process.env.PM_OPENCLAW_AGENT_ROOT ?? DEFAULT_AGENT_ROOT);
const registryPath = argValue("--registry", process.env.OPENCLAW_AGENTS_JSON ?? DEFAULT_REGISTRY);
const tokenFile = argValue("--token-file", process.env.PM_OPENCLAW_CHANNEL_TOKEN_FILE ?? DEFAULT_TOKEN_FILE);
const callbackUrl = argValue("--callback-url", process.env.PM_OPENCLAW_CHANNEL_CALLBACK_URL ?? DEFAULT_CALLBACK_URL);
const openclawBin = argValue("--openclaw-bin", process.env.OPENCLAW_BIN ?? DEFAULT_OPENCLAW_BIN);
const deployPath = path.resolve(argValue("--deploy-path", process.env.PM_OPENCLAW_CHANNEL_DEPLOY_PATH ?? DEFAULT_DEPLOY_PATH));
const tokenGroup = argValue("--token-group", process.env.PM_OPENCLAW_CHANNEL_TOKEN_GROUP ?? process.env.PM_APP_GROUP ?? "");
const requestedAgents = parseAgentList(argValue("--agents", process.env.PM_CHANNEL_AGENTS));
const registryAgents = agentsFromRegistry(registryPath);
const registryHomes = new Map(registryAgents.map((agent) => [agent.user, agent.home]));
const agents = requestedAgents.length ? requestedAgents : registryAgents.map((agent) => agent.user);
const uniqueAgents = [...new Set(agents)];
const restart = hasFlag("--restart");

if (!existsSync(pluginPath)) {
  throw new Error(`Plugin path does not exist: ${pluginPath}`);
}
if (!tokenGroup) {
  throw new Error("PM channel token group is not configured. Set PM_OPENCLAW_CHANNEL_TOKEN_GROUP or pass --token-group.");
}
if (uniqueAgents.length === 0) {
  throw new Error("No enabled agents were found in the registry. Set PM_CHANNEL_AGENTS or pass --agents.");
}

const installedPluginPath = await stagePlugin(pluginPath, deployPath);

const tokenMap = readJson(tokenFile, {});
for (const agent of uniqueAgents) {
  tokenMap[agent] ||= randomBytes(32).toString("hex");
}
await writeJsonAtomic(tokenFile, tokenMap, 0o640, { uid: 0, gid: gidFor(tokenGroup) });

for (const agent of uniqueAgents) {
  const home = registryHomes.get(agent) ?? `/home/${agent}`;
  const canonicalConfigPath = path.join(agentRoot, agent, "openclaw.json");
  const homeConfigPath = path.join(home, ".openclaw/openclaw.json");
  const configPath = existsSync(canonicalConfigPath) ? canonicalConfigPath : homeConfigPath;
  const configured = existsSync(configPath) && await configureAgentConfig({
    configPath,
    token: tokenMap[agent],
    callbackUrl,
    sourcePluginPath: pluginPath,
    installedPluginPath,
  });
  if (!configured) {
    console.warn(`[pm-channel] skipped ${agent}: missing OpenClaw config`);
    continue;
  }

  if (existsSync(canonicalConfigPath)) {
    await copyCanonicalConfigToHome(agent, home, canonicalConfigPath);
  }
  runOpenClawInstall(agent, home, installedPluginPath, openclawBin);
  await reconcileAgentConfigCopy(
    agent,
    home,
    canonicalConfigPath,
  );
  if (restart) {
    restartGateway(agent, home);
    await waitForGatewayActive(agent, home);
  }
  console.log(`[pm-channel] configured ${agent}`);
}

console.log(`[pm-channel] plugin path: ${installedPluginPath}`);
console.log(`[pm-channel] token file: ${tokenFile}`);
console.log(`[pm-channel] agents: ${uniqueAgents.join(", ")}`);
