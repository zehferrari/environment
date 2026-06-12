#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { chmod, chown, copyFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_AGENTS = ["asdrubal", "barekbaal", "karen", "carmen"];
const DEFAULT_AGENT_ROOT = "/srv/agents/openclaw";
const DEFAULT_REGISTRY = "/etc/openclaw/agents.json";
const DEFAULT_TOKEN_FILE = "/etc/openclaw/pm-channel-tokens.json";
const DEFAULT_CALLBACK_URL = "http://127.0.0.1:3000/api/openclaw/pm-channel/reply";
const DEFAULT_OPENCLAW_BIN = "/usr/local/bin/openclaw";
const DEFAULT_DEPLOY_PATH = "/usr/local/share/openclaw/plugins/pm-channel";
const DEFAULT_TOKEN_GROUP = "karen";
const PLUGIN_FILES = [
  "index.js",
  "openclaw.plugin.json",
  "package.json",
  "README.md",
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

function existingRealPath(file) {
  if (!existsSync(file)) return null;
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
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
    "--link",
    pluginPath,
  ], { stdio: "inherit" });
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

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const pluginPath = path.resolve(argValue("--plugin", path.join(repoRoot, "openclaw-pm-channel")));
const agentRoot = argValue("--agent-root", process.env.PM_OPENCLAW_AGENT_ROOT ?? DEFAULT_AGENT_ROOT);
const registryPath = argValue("--registry", process.env.OPENCLAW_AGENTS_JSON ?? DEFAULT_REGISTRY);
const tokenFile = argValue("--token-file", process.env.PM_OPENCLAW_CHANNEL_TOKEN_FILE ?? DEFAULT_TOKEN_FILE);
const callbackUrl = argValue("--callback-url", process.env.PM_OPENCLAW_CHANNEL_CALLBACK_URL ?? DEFAULT_CALLBACK_URL);
const openclawBin = argValue("--openclaw-bin", process.env.OPENCLAW_BIN ?? DEFAULT_OPENCLAW_BIN);
const deployPath = path.resolve(argValue("--deploy-path", process.env.PM_OPENCLAW_CHANNEL_DEPLOY_PATH ?? DEFAULT_DEPLOY_PATH));
const tokenGroup = argValue("--token-group", process.env.PM_OPENCLAW_CHANNEL_TOKEN_GROUP ?? DEFAULT_TOKEN_GROUP);
const requestedAgents = parseAgentList(argValue("--agents", process.env.PM_CHANNEL_AGENTS));
const registryAgents = agentsFromRegistry(registryPath);
const registryHomes = new Map(registryAgents.map((agent) => [agent.user, agent.home]));
const agents = requestedAgents.length ? requestedAgents : registryAgents.map((agent) => agent.user);
const uniqueAgents = [...new Set(agents.length ? agents : DEFAULT_AGENTS)];
const restart = hasFlag("--restart");

if (!existsSync(pluginPath)) {
  throw new Error(`Plugin path does not exist: ${pluginPath}`);
}

const installedPluginPath = await stagePlugin(pluginPath, deployPath);

const tokenMap = readJson(tokenFile, {});
for (const agent of uniqueAgents) {
  tokenMap[agent] ||= randomBytes(32).toString("hex");
}
await writeJsonAtomic(tokenFile, tokenMap, 0o640, { uid: 0, gid: gidFor(tokenGroup) });

for (const agent of uniqueAgents) {
  const home = registryHomes.get(agent) ?? `/home/${agent}`;
  const agentConfigPaths = [
    path.join(agentRoot, agent, "openclaw.json"),
    path.join(home, ".openclaw/openclaw.json"),
  ];
  const uniqueConfigPaths = [...new Set(agentConfigPaths.map(existingRealPath).filter(Boolean))];
  let configured = false;
  for (const configPath of uniqueConfigPaths) {
    if (!existsSync(configPath)) continue;
    configured = await configureAgentConfig({
      configPath,
      token: tokenMap[agent],
      callbackUrl,
      sourcePluginPath: pluginPath,
      installedPluginPath,
    }) || configured;
  }
  if (!configured) {
    console.warn(`[pm-channel] skipped ${agent}: missing OpenClaw config`);
    continue;
  }

  runOpenClawInstall(agent, home, installedPluginPath, openclawBin);
  if (restart) restartGateway(agent, home);
  console.log(`[pm-channel] configured ${agent}`);
}

console.log(`[pm-channel] plugin path: ${installedPluginPath}`);
console.log(`[pm-channel] token file: ${tokenFile}`);
console.log(`[pm-channel] agents: ${uniqueAgents.join(", ")}`);
