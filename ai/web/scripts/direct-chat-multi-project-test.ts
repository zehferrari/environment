import "./lib/next-als-polyfill";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PrismaClient } from "@prisma/client";
import { createWorkItemGrantToken } from "../lib/agents/workflow/token/work-item";
import { runRouteHandler } from "./lib/next-route-harness";
import {
  boundDirectChatProjectContexts,
  MAX_DIRECT_CHAT_PROJECT_CONTEXT_CHARS,
  MAX_DIRECT_CHAT_PROJECTS,
  normalizeDirectChatProjectIds,
} from "../lib/agents/chat/direct/projects";

const execFileP = promisify(execFile);

async function main() {
  assert.throws(
    () => normalizeDirectChatProjectIds(
      Array.from({ length: MAX_DIRECT_CHAT_PROJECTS + 1 }, (_, index) => `project-${index}`),
    ),
    new RegExp(`at most ${MAX_DIRECT_CHAT_PROJECTS} projects`, "i"),
    "the server-side normalizer rejects an unbounded project context request",
  );
  assert.deepEqual(
    normalizeDirectChatProjectIds(["alpha", "alpha", " beta "]),
    ["alpha", "beta"],
    "the limit applies after trimming and deduplication",
  );
  const boundedContexts = boundDirectChatProjectContexts(
    Array.from({ length: MAX_DIRECT_CHAT_PROJECTS }, (_, index) => (
      `project-${index}:` + "x".repeat(MAX_DIRECT_CHAT_PROJECT_CONTEXT_CHARS)
    )),
  );
  assert.ok(
    boundedContexts.join("\n\n").length <= MAX_DIRECT_CHAT_PROJECT_CONTEXT_CHARS,
    "all project environments share one aggregate prompt budget",
  );
  assert.ok(
    boundedContexts.every((context, index) => context.startsWith(`project-${index}:`)),
    "budgeting retains the identity header for every selected project",
  );

  process.env.AUTH_SECRET = "direct-chat-multi-project-test-secret";
  const tmp = await mkdtemp(path.join(tmpdir(), "direct-chat-multi-project-"));
  const originalDbUrl = process.env.DATABASE_URL;
  let db: PrismaClient | undefined;

  try {
    const migrationSql = await readFile(
      path.resolve("prisma/migrations/20260717140000_direct_chat_multi_project_context/migration.sql"),
      "utf8",
    );
    const legacyDb = path.join(tmp, "legacy.db");
    await execFileP("sqlite3", [legacyDb, [
      'PRAGMA foreign_keys = ON;',
      'CREATE TABLE "Project" ("id" TEXT NOT NULL PRIMARY KEY);',
      'CREATE TABLE "DirectAgentChatMessage" ("id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT, "allowWorkItemManagement" BOOLEAN NOT NULL DEFAULT false, "workItemGrantUsedAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);',
      'INSERT INTO "Project" ("id") VALUES (\'legacy-project\');',
      'INSERT INTO "DirectAgentChatMessage" ("id", "projectId", "allowWorkItemManagement", "workItemGrantUsedAt", "createdAt") VALUES (\'legacy-message\', \'legacy-project\', 1, \'2026-07-17T01:02:03.000Z\', \'2026-07-16T01:02:03.000Z\');',
      migrationSql,
    ].join("\n")]);
    const backfill = await execFileP("sqlite3", [
      "-separator", "|", legacyDb,
      'SELECT "messageId", "projectId", "allowWorkItemManagement", "workItemGrantUsedAt" FROM "DirectAgentChatMessageProject";',
    ]);
    assert.equal(
      backfill.stdout.trim(),
      "legacy-message|legacy-project|1|2026-07-17T01:02:03.000Z",
      "the checked-in migration backfills the legacy project grant exactly",
    );

    const chatInputSource = await readFile(path.resolve("components/chat-input.tsx"), "utf8");
    assert.match(chatInputSource, /selectedProjectIds[\s\S]*?useState/);
    assert.match(chatInputSource, /defaultValues=\{selectedProjectIds\}/);
    assert.match(chatInputSource, /onChangeMultiple=\{setSelectedProjectIds\}/);

    const dbUrl = `file:${path.join(tmp, "test.db")}`;
    await execFileP(
      "pnpm",
      ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"],
      { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
    );
    process.env.DATABASE_URL = dbUrl;

    const [{ db: prisma }, route, { NextRequest }] = await Promise.all([
      import("../lib/db"),
      import("../app/api/agent/projects/[projectId]/proposals/route"),
      import("next/server"),
    ]);
    db = prisma as PrismaClient;

    const owner = await db.user.create({
      data: {
        username: "multi-project-owner",
        email: "multi-project-owner@example.test",
        kind: "human",
        isOwner: true,
        mustRotatePassword: false,
      },
    });
    const agent = await db.agent.create({
      data: { slug: "multi-project-agent", name: "Multi Project Agent", role: "coding" },
    });
    await db.user.create({
      data: {
        username: agent.slug,
        email: "multi-project-agent@example.test",
        kind: "agent",
        agentId: agent.id,
        mustRotatePassword: false,
      },
    });
    const projects = await Promise.all(["alpha", "beta", "gamma"].map((suffix) => (
      db!.project.create({
        data: { slug: `multi-${suffix}`, name: `Multi ${suffix}` },
      })
    )));
    const [alpha, beta, gamma] = projects;
    const message = await db.directAgentChatMessage.create({
      data: {
        agentSlug: agent.slug,
        senderUserId: owner.id,
        projectId: alpha.id,
        body: "Create one Epic in Alpha and one in Beta",
        allowWorkItemManagement: true,
        projects: {
          create: [alpha.id, beta.id].map((projectId) => ({
            projectId,
            allowWorkItemManagement: true,
          })),
        },
      },
    });

    const callProposal = async (projectId: string, planId: string, grantMessageId = message.id) => {
      const request = new NextRequest(`http://127.0.0.1/api/agent/projects/${projectId}/proposals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grantMessageId,
          token: createWorkItemGrantToken(projectId, agent.slug, grantMessageId),
          planId,
          summary: `Create ${planId}`,
          operations: [{ op: "create_epic", ref: "tmp:epic", title: planId }],
        }),
      });
      const response = await runRouteHandler(() => route.POST(request, {
        params: Promise.resolve({ projectId }),
      }));
      return { status: response.status, body: await response.json() as { ok?: boolean; error?: string } };
    };

    const alphaResult = await callProposal(alpha.id, "alpha-epic");
    assert.equal(alphaResult.status, 201, `Alpha proposal failed: ${alphaResult.body.error ?? "unknown"}`);
    const afterAlpha = await db.directAgentChatMessageProject.findMany({
      where: { messageId: message.id },
      orderBy: { projectId: "asc" },
    });
    assert.ok(
      afterAlpha.find((grant) => grant.projectId === alpha.id)?.workItemGrantUsedAt,
      "using Alpha consumes Alpha's grant",
    );
    assert.equal(
      afterAlpha.find((grant) => grant.projectId === beta.id)?.workItemGrantUsedAt,
      null,
      "using Alpha leaves Beta's grant available",
    );

    const betaResult = await callProposal(beta.id, "beta-epic");
    assert.equal(betaResult.status, 201, `Beta proposal failed: ${betaResult.body.error ?? "unknown"}`);
    const betaGrant = await db.directAgentChatMessageProject.findUniqueOrThrow({
      where: { messageId_projectId: { messageId: message.id, projectId: beta.id } },
    });
    assert.ok(betaGrant.workItemGrantUsedAt, "Beta independently consumes its own grant");

    const gammaResult = await callProposal(gamma.id, "gamma-epic");
    assert.equal(gammaResult.status, 400, "an unlinked project cannot use the message grant");
    assert.match(gammaResult.body.error ?? "", /not bound to this project/i);

    const legacyMessage = await db.directAgentChatMessage.findUniqueOrThrow({
      where: { id: message.id },
      select: { workItemGrantUsedAt: true },
    });
    assert.equal(
      legacyMessage.workItemGrantUsedAt,
      null,
      "per-project consumption does not consume the compatibility grant field",
    );

    const raceGrant = await db.directAgentChatMessage.create({
      data: {
        agentSlug: agent.slug,
        senderUserId: owner.id,
        projectId: gamma.id,
        body: "Create exactly one Gamma Epic",
        allowWorkItemManagement: true,
        projects: {
          create: { projectId: gamma.id, allowWorkItemManagement: true },
        },
      },
    });
    const raceResults = await Promise.all([
      callProposal(gamma.id, "gamma-race-a", raceGrant.id),
      callProposal(gamma.id, "gamma-race-b", raceGrant.id),
    ]);
    assert.deepEqual(
      raceResults.map((result) => result.status).sort((a, b) => a - b),
      [201, 410],
      "concurrent distinct planIds cannot spend one project grant twice",
    );
    assert.equal(
      await db.workItemProposal.count({ where: { grantMessageId: raceGrant.id } }),
      1,
      "the losing concurrent replay rolls its proposal back",
    );

    const crossProjectRaceGrant = await db.directAgentChatMessage.create({
      data: {
        agentSlug: agent.slug,
        senderUserId: owner.id,
        projectId: alpha.id,
        body: "Create in Alpha or Beta exactly once",
        allowWorkItemManagement: true,
        projects: {
          create: [alpha.id, beta.id].map((projectId) => ({
            projectId,
            allowWorkItemManagement: true,
          })),
        },
      },
    });
    const crossProjectRaceResults = await Promise.all([
      callProposal(alpha.id, "cross-project-shared-plan", crossProjectRaceGrant.id),
      callProposal(beta.id, "cross-project-shared-plan", crossProjectRaceGrant.id),
    ]);
    assert.deepEqual(
      crossProjectRaceResults.map((result) => result.status).sort((a, b) => a - b),
      [201, 409],
      "the same planId cannot resolve idempotently across two projects",
    );

    // Rollout compatibility: a row created before the join-table migration (or
    // by an older writer during a rolling restart) can still spend the legacy
    // top-level grant. The migration itself backfills these rows into the join.
    const legacyGrant = await db.directAgentChatMessage.create({
      data: {
        agentSlug: agent.slug,
        senderUserId: owner.id,
        projectId: gamma.id,
        body: "Create one Epic in Gamma",
        allowWorkItemManagement: true,
      },
    });
    const legacyRequest = new NextRequest(`http://127.0.0.1/api/agent/projects/${gamma.id}/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grantMessageId: legacyGrant.id,
        token: createWorkItemGrantToken(gamma.id, agent.slug, legacyGrant.id),
        planId: "gamma-legacy-epic",
        operations: [{ op: "create_epic", ref: "tmp:epic", title: "Gamma legacy Epic" }],
      }),
    });
    const legacyResponse = await runRouteHandler(() => route.POST(legacyRequest, {
      params: Promise.resolve({ projectId: gamma.id }),
    }));
    assert.equal(legacyResponse.status, 201, "legacy single-project direct grants remain valid");
    assert.ok(
      (await db.directAgentChatMessage.findUniqueOrThrow({ where: { id: legacyGrant.id } })).workItemGrantUsedAt,
      "legacy fallback consumption stamps the top-level grant field",
    );

    console.log("direct-chat multi-project tests passed");
  } finally {
    await db?.$disconnect();
    process.env.DATABASE_URL = originalDbUrl;
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
