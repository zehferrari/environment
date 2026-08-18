import { bootstrapOwner } from "@/lib/agents/auth/bootstrap-owner";
import { syncAgents } from "@/lib/agents/management/sync";
import { purgeBin } from "@/lib/bin/purge";
import { purgeProjectBin } from "@/lib/bin/purge-projects";
import { purgeDirectAgentChatBin } from "@/lib/bin/purge-chats";
import { autoArchiveDoneTasks } from "@/lib/archive/auto";
import { pollDeploymentPullRequests } from "@/lib/deploy/monitor";
import { pollDeploymentMerges } from "@/lib/deploy/merge-detect";
import { pollEpicTaskMerges } from "@/lib/deploy/epic-merge";
import {
  pmAsyncDispatchEnabled,
  runPmChannelWorkerDrain,
} from "@/lib/agents/pm-channel/jobs";
import { startPmChannelLocalStreamTransports } from "@/lib/agents/pm-channel/stream-local";
import { runProcedureRunner } from "@/lib/tasks/orchestrator/procedure-runner";
import "@/lib/tasks/orchestrator/handlers"; // registers step handlers

declare global {
  var __pmChannelWorkerPollStarted: boolean | undefined;
  var __deploymentWatcherPollStarted: boolean | undefined;
  var __procedureRunnerPollStarted: boolean | undefined;
}

function deploymentWatcherPollMs() {
  const value = Number.parseInt(process.env.PM_DEPLOYMENT_WATCHER_POLL_MS ?? "60000", 10);
  return Number.isFinite(value) && value > 0 ? Math.max(5000, Math.floor(value)) : 60000;
}

function startDeploymentWatcherPoll() {
  if (globalThis.__deploymentWatcherPollStarted) return;
  globalThis.__deploymentWatcherPollStarted = true;
  const pollMs = deploymentWatcherPollMs();
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await pollDeploymentPullRequests();
      if (result.checked > 0) {
        console.log("[pm] deployment watcher:", JSON.stringify(result));
      }
    } catch (err) {
      console.error("[pm] deployment watcher failed:", err);
    }
    // Provider-agnostic git merge detection: flip approved/opted-in work to
    // Successfully Deployed once its COMMIT_PREFIX lands on the production branch.
    try {
      const merges = await pollDeploymentMerges();
      if (merges.deployed > 0) {
        console.log("[pm] deployment merge detect:", JSON.stringify(merges));
      }
    } catch (err) {
      console.error("[pm] deployment merge detect failed:", err);
    }
    // Epic integration: enqueue a pm-epic-merge-runner spool job for each Done
    // Epic-child task whose branch is not yet merged into the Epic branch
    // (EPICS ONLY). The runner does the git work outside pm.service's sandbox;
    // a conflict bounces the task back to Review.
    try {
      const epicMerges = await pollEpicTaskMerges();
      if (epicMerges.enqueued > 0) {
        console.log("[pm] epic branch merge enqueue:", JSON.stringify(epicMerges));
      }
    } catch (err) {
      console.error("[pm] epic branch merge failed:", err);
    } finally {
      running = false;
    }
  };
  setInterval(tick, pollMs).unref();
  setTimeout(tick, 0).unref();
  console.log("[pm] deployment watcher enabled:", JSON.stringify({ pollMs }));
}

function pmChannelWorkerPollMs() {
  const value = Number.parseInt(process.env.PM_CHANNEL_WORKER_POLL_MS ?? "1000", 10);
  return Number.isFinite(value) && value > 0 ? Math.max(250, Math.floor(value)) : 1000;
}

function procedureRunnerPollMs() {
  const value = Number.parseInt(process.env.PM_PROCEDURE_RUNNER_POLL_MS ?? "2000", 10);
  return Number.isFinite(value) && value > 0 ? Math.max(500, Math.floor(value)) : 2000;
}

function startProcedureRunnerPoll() {
  if (globalThis.__procedureRunnerPollStarted) return;
  globalThis.__procedureRunnerPollStarted = true;

  const workerId = process.env.PM_PROCEDURE_RUNNER_WORKER_ID ?? `pm-procedure:${process.pid}`;
  const pollMs = procedureRunnerPollMs();
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runProcedureRunner({ workerId });
      if (result.claimed > 0) {
        console.log("[pm] procedure runner:", JSON.stringify({ workerId, ...result }));
      }
    } catch (err) {
      console.error("[pm] procedure runner poll failed:", err);
    } finally {
      running = false;
    }
  };

  setInterval(tick, pollMs).unref();
  setTimeout(tick, 0).unref();
  console.log("[pm] procedure runner poll enabled:", JSON.stringify({ workerId, pollMs }));
}

function startPmChannelWorkerPoll() {
  if (!pmAsyncDispatchEnabled() || globalThis.__pmChannelWorkerPollStarted) return;
  globalThis.__pmChannelWorkerPollStarted = true;

  const workerId = process.env.PM_CHANNEL_WORKER_ID ?? `pm-inproc:${process.pid}`;
  const pollMs = pmChannelWorkerPollMs();
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runPmChannelWorkerDrain(workerId);
      if (result.claimed > 0) {
        console.log("[pm] channel worker drain:", JSON.stringify({ workerId, ...result }));
      }
    } catch (err) {
      console.error("[pm] channel worker poll failed:", err);
    } finally {
      running = false;
    }
  };

  setInterval(tick, pollMs).unref();
  setTimeout(tick, 0).unref();
  console.log("[pm] channel worker poll enabled:", JSON.stringify({ workerId, pollMs }));
}

try {
  const ownerBootstrap = await bootstrapOwner();
  const result = await syncAgents();
  console.log("[pm] boot sync:", JSON.stringify({ ownerBootstrap, result }));
} catch (err) {
  console.error("[pm] boot sync failed:", err);
}

try {
  const streamTransports = await startPmChannelLocalStreamTransports();
  console.log("[pm] channel stream transports:", JSON.stringify(streamTransports));
} catch (err) {
  console.error("[pm] channel stream transport startup failed:", err);
}

startPmChannelWorkerPoll();
startDeploymentWatcherPoll();
startProcedureRunnerPoll();

const intervalMin = Number(process.env.AGENT_SYNC_INTERVAL_MIN ?? "5");
const intervalMs = Math.max(1, intervalMin) * 60_000;
setInterval(async () => {
  try {
    const result = await syncAgents();
    console.log("[pm] periodic sync:", JSON.stringify(result));
  } catch (err) {
    console.error("[pm] periodic sync failed:", err);
  }
}, intervalMs).unref();

// Hourly maintenance (HOMELAB-48): archive aged Done tasks, then hard-delete
// bin rows whose deletedAt is older than the configured bin TTL. Runs once at
// boot so a long downtime doesn't park stale rows past their TTL.
const purgeIntervalMin = Number(process.env.PM_BIN_PURGE_INTERVAL_MIN ?? "60");
const purgeIntervalMs = Math.max(1, purgeIntervalMin) * 60_000;
try {
  const r = await autoArchiveDoneTasks();
  console.log("[pm] boot auto archive:", JSON.stringify(r));
} catch (err) {
  console.error("[pm] boot auto archive failed:", err);
}
try {
  const r = await purgeBin();
  console.log("[pm] boot bin purge:", JSON.stringify(r));
} catch (err) {
  console.error("[pm] boot bin purge failed:", err);
}
try {
  const r = await purgeProjectBin();
  console.log("[pm] boot project bin purge:", JSON.stringify(r));
} catch (err) {
  console.error("[pm] boot project bin purge failed:", err);
}
try {
  const r = await purgeDirectAgentChatBin();
  console.log("[pm] boot direct chat bin purge:", JSON.stringify(r));
} catch (err) {
  console.error("[pm] boot direct chat bin purge failed:", err);
}
setInterval(async () => {
  try {
    const r = await autoArchiveDoneTasks();
    console.log("[pm] periodic auto archive:", JSON.stringify(r));
  } catch (err) {
    console.error("[pm] periodic auto archive failed:", err);
  }
  try {
    const r = await purgeBin();
    console.log("[pm] periodic bin purge:", JSON.stringify(r));
  } catch (err) {
    console.error("[pm] periodic bin purge failed:", err);
  }
  try {
    const r = await purgeProjectBin();
    console.log("[pm] periodic project bin purge:", JSON.stringify(r));
  } catch (err) {
    console.error("[pm] periodic project bin purge failed:", err);
  }
  try {
    const r = await purgeDirectAgentChatBin();
    console.log("[pm] periodic direct chat bin purge:", JSON.stringify(r));
  } catch (err) {
    console.error("[pm] periodic direct chat bin purge failed:", err);
  }
}, purgeIntervalMs).unref();
