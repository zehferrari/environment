import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createTaskMediaLoader } from "../openclaw-pm-channel/task-media.js";
import { createTaskTools } from "../openclaw-pm-channel/task-tools.js";

// Exercise the installed public SDK's actual path policy, not a mocked reader.
const sdk = process.env.OPENCLAW_PACKAGE_ROOT || "/usr/local/lib/node_modules/openclaw";
const { buildOutboundMediaLoadOptions, getAgentScopedMediaLocalRoots } = await import(pathToFileURL(path.join(sdk, "dist/plugin-sdk/media-runtime.js")));
const media = await import(pathToFileURL(path.join(sdk, "dist/plugin-sdk/web-media.js")));
const dir = await mkdtemp("/tmp/pm-media-policy-");
try {
  const workspace = path.join(dir, "agent-workspace");
  await mkdir(workspace);
  const evidence = path.join(workspace, "verification.txt");
  await writeFile(evidence, "checks passed\n");
  const outside = path.join(dir, "other-agent.txt");
  await writeFile(outside, "private\n");
  await symlink(outside, path.join(workspace, "escape.txt"));
  const cfg = { agents: { defaults: { workspace } } };
  const loadMedia = createTaskMediaLoader({ cfg, agentId: "main", getRoots: getAgentScopedMediaLocalRoots, buildOptions: buildOutboundMediaLoadOptions, media });
  assert.equal((await loadMedia(evidence)).buffer.toString(), "checks passed\n");
  await assert.rejects(loadMedia(outside), /configured agent workspace/);
  await assert.rejects(loadMedia(path.join(workspace, "escape.txt")));
  let uploaded = 0;
  const target = { kind: "task-comment", taskId: "t", messageId: "m", agentSlug: "worker" };
  const turn = { acceptedId: "generation", replyTarget: target, taskRuntime: { version: 1, ...target, token: "test", actions: ["attach_file"], workflowUrl: "http://127.0.0.1:3000/api/agent/tasks/t/workflow", contextUrl: "http://127.0.0.1:3000/api/agents/context/task/t?grant=test" } };
  const [tool] = createTaskTools({ context: { messageChannel: "pm", sessionKey: "s" }, findTurn: () => turn, loadMedia,
    fetchImpl: async (_url, options) => {
      assert.equal(await options.body.get("file").text(), "checks passed\n");
      uploaded++;
      return Response.json({ attachment: { id: "attachment" } });
    },
  });
  await tool.execute("upload", { path: evidence });
  assert.equal(uploaded, 1);
  await assert.rejects(tool.execute("outside", { path: outside }));
  turn.abortedAt = Date.now();
  await assert.rejects(tool.execute("late", { path: evidence }), /canceled/);
  assert.equal(uploaded, 1, "denied paths and stale generations never upload");
  console.log("PASS real SDK: workspace evidence uploads; unrelated paths, symlink escapes and canceled turns are denied");
} finally { await rm(dir, { recursive: true, force: true }); }
