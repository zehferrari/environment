// ENV-168 — immediate propagation of role and access changes across
// sessions and caches (server-layer coverage, no dev server required).
//
// Proves:
//  1. Every access-management core bumps User.policyVersion in the same
//     transaction as its audit rows and publishes an access-change hub event
//     after commit (invite/grant, revoke, promote, demote; no-ops neither
//     bump nor publish).
//  2. The always-on viewer policy stream emits the connect epoch, emits
//     `policy-changed` carrying ONLY the new epoch integer on a mid-session
//     change, and closes terminally when the account itself is deactivated —
//     with NO board stream connected, which is exactly the non-board
//     task-detail-tab stale-render case from the task description.
//  3. A missed hub event is caught by the durable heartbeat epoch compare.
//  4. Live stream guards re-check scope on hub events and on the heartbeat
//     fallback, and close with one explicit `access-revoked` event on
//     revocation — while an authorized connection stays open.
//  5. New requests re-read authorization from the database
//     (getViewerByUserId reflects revocations/demotions immediately) and the
//     JWT stays identity-only (source audit on middleware.ts and
//     lib/auth/permissions.ts), plus route/client wiring source assertions.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PrismaClient } from "@prisma/client";
import type { Viewer } from "../lib/auth/permissions";

const execFileP = promisify(execFile);

async function dbPush(dbUrl: string): Promise<void> {
  await execFileP(
    "pnpm",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"],
    { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
  );
}

function viewerFor(user: { id: string; username: string }, role: "owner" | "admin" | "customer"): Viewer {
  return {
    id: user.id,
    username: user.username,
    kind: "human",
    role,
    agentVisibility: role === "owner" ? "full" : role === "admin" ? "masked" : "hidden",
    canAccessOwnerFeatures: role === "owner",
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(predicate(), `waitFor: ${label} not met before timeout`);
}

type SseFrame = { event: string; data: string };

function drainStream(stream: ReadableStream<Uint8Array>, frames: SseFrame[], setDone: () => void): Promise<void> {
  return (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = raw.split("\n");
        const eventLine = lines.find((l) => l.startsWith("event: "));
        const dataLine = lines.find((l) => l.startsWith("data: "));
        if (eventLine || dataLine) {
          frames.push({
            event: eventLine ? eventLine.slice(7) : "message",
            data: dataLine ? dataLine.slice(6) : "",
          });
        }
      }
    }
    setDone();
  })();
}

async function main(): Promise<void> {
  const tmp = await mkdtemp(path.join(tmpdir(), "access-revocation-"));
  const originalDbUrl = process.env.DATABASE_URL;
  let db: PrismaClient | undefined;

  try {
    const dbUrl = `file:${path.join(tmp, "test.db")}`;
    await dbPush(dbUrl);
    process.env.DATABASE_URL = dbUrl;

    const dbMod = await import("../lib/db");
    const {
      inviteHumanUserCore,
      setHumanUserRoleCore,
      updateHumanAccessCore,
    } = await import("../lib/users/access-management");
    const { subscribeAccessChanges, accessChangeListenerCount } = await import("../lib/users/access-change-hub");
    const { attachRevocationGuard } = await import("../lib/users/access-revocation-guard");
    const { createViewerPolicyStream } = await import("../lib/viewer-policy-stream");
    const permissions = await import("../lib/auth/permissions");
    db = dbMod.db as PrismaClient;
    const prisma = db;

    const customerRoleData = {
      connectOrCreate: {
        where: { name: "customer" },
        create: { name: "customer", description: "Customer-facing project member" },
      },
    };

    const [p1, p2] = await Promise.all(
      [1, 2].map((n) =>
        prisma.project.create({ data: { slug: `ar-project-${n}`, name: `AR Project ${n}` } }),
      ),
    );
    const ownerUser = await prisma.user.create({
      data: {
        username: "ar-owner", email: "ar-owner@example.test", kind: "human",
        isOwner: true, mustRotatePassword: false,
      },
    });
    const customerUser = await prisma.user.create({
      data: {
        username: "ar-customer", email: "ar-customer@example.test", kind: "human",
        mustRotatePassword: false, rolePermission: customerRoleData,
        projectMembers: { create: [{ projectId: p1.id }] },
      },
    });

    const owner = viewerFor(ownerUser, "owner");

    // ---------- 1. Bump + publish on every mutation path ----------
    type HubEvent = { userId: string; projectId: string | null; policyVersion: number };
    const customerEvents: HubEvent[] = [];
    const unsubscribeCustomer = subscribeAccessChanges(customerUser.id, (event) => {
      customerEvents.push(event as HubEvent);
    });

    // invite: initial grant — epoch 1 in-transaction (not the default 0)
    const invite = await inviteHumanUserCore(owner, {
      username: "ar-invited", email: "ar-invited@example.test", displayName: null,
      role: "customer", projectIds: [p2.id],
    });
    const invitedRow = await prisma.user.findUniqueOrThrow({
      where: { id: invite.userId },
      select: { policyVersion: true },
    });
    assert.equal(invitedRow.policyVersion, 1, "invite bumps the new user epoch to 1 in-transaction");

    const epochOf = async (): Promise<number> =>
      (await prisma.user.findUniqueOrThrow({
        where: { id: customerUser.id },
        select: { policyVersion: true },
      })).policyVersion;

    // grant (access edit adds a project)
    const eventsAfterInvite = customerEvents.length;
    await updateHumanAccessCore(owner, { userId: customerUser.id, projectIds: [p1.id, p2.id] });
    assert.equal(customerEvents.length, eventsAfterInvite + 1, "grant publishes one access-change event");
    assert.equal(customerEvents[customerEvents.length - 1]?.policyVersion, 1, "grant event carries the post-commit epoch");
    assert.equal(customerEvents[customerEvents.length - 1]?.projectId, p2.id, "single-project grant hints that project");
    assert.equal(await epochOf(), 1, "grant bumps the target epoch in-transaction");

    // revoke (access edit removes a project)
    await updateHumanAccessCore(owner, { userId: customerUser.id, projectIds: [p1.id] });
    assert.equal(customerEvents.length, eventsAfterInvite + 2, "revoke publishes one access-change event");
    assert.equal(customerEvents[customerEvents.length - 1]?.policyVersion, 2, "revoke event carries the post-commit epoch");
    assert.equal(customerEvents[customerEvents.length - 1]?.projectId, p2.id, "single-project revoke hints the revoked project");

    // promote: customer -> admin
    await setHumanUserRoleCore(owner, { userId: customerUser.id, role: "admin" });
    assert.equal(customerEvents.length, eventsAfterInvite + 3, "promote publishes one access-change event");
    assert.equal(customerEvents[customerEvents.length - 1]?.policyVersion, 3);
    assert.equal(customerEvents[customerEvents.length - 1]?.projectId, null, "role changes carry no project hint");
    const afterPromote = await permissions.getViewerByUserId(customerUser.id);
    assert.equal(afterPromote?.role, "admin", "new requests re-read the role from the database, not the JWT");

    // demote: admin -> customer via the combined edit form path
    await updateHumanAccessCore(owner, { userId: customerUser.id, projectIds: [p1.id], role: "customer" });
    assert.equal(customerEvents.length, eventsAfterInvite + 4, "demote publishes one access-change event");
    assert.equal(customerEvents[customerEvents.length - 1]?.policyVersion, 4);
    assert.equal(customerEvents[customerEvents.length - 1]?.projectId, null, "role-only changes carry no project hint");
    const afterDemote = await permissions.getViewerByUserId(customerUser.id);
    assert.equal(afterDemote?.role, "customer");

    // no-op edit: neither bumps nor publishes
    const noopEvents = customerEvents.length;
    const noopEpoch = await epochOf();
    await updateHumanAccessCore(owner, { userId: customerUser.id, projectIds: [p1.id] });
    assert.equal(customerEvents.length, noopEvents, "no-op edit publishes nothing");
    assert.equal(await epochOf(), noopEpoch, "no-op edit does not bump the epoch");

    // ---------- 2. Policy stream: epoch-only mid-session propagation
    // with NO board stream connected (the non-board task-detail tab case) --
    const readEpoch = async (): Promise<number | null> => {
      const row = await prisma.user.findUnique({
        where: { id: customerUser.id },
        select: { policyVersion: true },
      });
      return row?.policyVersion ?? null;
    };

    const policyEvents: SseFrame[] = [];
    let policyStreamDone = false;
    const epochBeforeRevoke = await epochOf();
    const policyStream = createViewerPolicyStream({
      viewerId: customerUser.id,
      initialEpoch: epochBeforeRevoke,
      readEpoch,
      resolveViewer: () => permissions.getViewerByUserId(customerUser.id),
      heartbeatMs: 60,
    });
    void drainStream(policyStream, policyEvents, () => { policyStreamDone = true; });

    await waitFor(() => policyEvents.length > 0, 5000, "connect epoch frame");
    assert.equal(policyEvents[0]?.event, "policy-version", "stream emits the connect epoch first");
    assert.match(policyEvents[0]?.data ?? "", /^\d+$/, "connect payload is the epoch integer only");

    // mid-session full revocation while this tab holds NO board connection
    await updateHumanAccessCore(owner, { userId: customerUser.id, projectIds: [] });
    await waitFor(
      () => policyEvents.some((f) => f.event === "policy-changed"),
      5000,
      "policy-changed after mid-session revocation",
    );
    const changed = policyEvents.find((f) => f.event === "policy-changed");
    assert.match(changed?.data ?? "", /^\d+$/, "policy-changed payload is the epoch integer only — no role/scope/project content");
    assert.equal(Number(changed?.data), epochBeforeRevoke + 1, "epoch advanced after the revoke");

    // ---------- 3. Missed hub event caught by the durable heartbeat ----
    await prisma.user.update({
      where: { id: customerUser.id },
      data: { policyVersion: { increment: 1 } }, // no publish: simulates a missed hub event
    });
    await waitFor(
      () => policyEvents.filter((f) => f.event === "policy-changed").length >= 2,
      5000,
      "heartbeat detects the missed epoch change",
    );
    const heartbeatCatch = policyEvents.filter((f) => f.event === "policy-changed")[1];
    assert.equal(Number(heartbeatCatch?.data), epochBeforeRevoke + 2, "heartbeat re-read detects the missed change");

    // ---------- 4. Terminal authz close when the account deactivates ----
    await prisma.user.update({ where: { id: customerUser.id }, data: { status: "deactivated" } });
    await waitFor(() => policyStreamDone, 5000, "policy stream closes terminally on account deactivation");

    // ---------- 5. Board stream guard: access-revoked close ----------
    await prisma.user.update({ where: { id: customerUser.id }, data: { status: "active" } });

    // (a) revoked-but-active viewer (no memberships): first guard re-check
    //     (heartbeat fallback, no hub event yet) closes with the event.
    const guardAEvents: Array<{ event: string; data: unknown }> = [];
    let guardAClosed = false;
    const guardA = attachRevocationGuard({
      userId: customerUser.id,
      send: (event, data) => guardAEvents.push({ event, data }),
      close: () => { guardAClosed = true; },
      stillAuthorized: async (fresh) =>
        Boolean(fresh && (await permissions.canAccessProject(fresh, { id: p1.id }))),
      heartbeatMs: 60,
    });
    await waitFor(() => guardAClosed, 5000, "revoked viewer guard closes");
    const guardALast = guardAEvents[guardAEvents.length - 1];
    assert.equal(guardALast?.event, "access-revoked", "guard emits the explicit access-revoked event");
    assert.deepEqual(guardALast?.data, { type: "access-revoked" });
    guardA.stop(); // no-op when already revoked; keeps handles deterministic

    // (b) authorized viewer survives a hub event, then a hub-driven revoke
    //     closes the stream immediately.
    await updateHumanAccessCore(owner, { userId: customerUser.id, projectIds: [p1.id] }); // re-grant
    const guardBEvents: Array<{ event: string; data: unknown }> = [];
    let guardBClosed = false;
    let guardBTicks = 0;
    const guardB = attachRevocationGuard({
      userId: customerUser.id,
      send: (event, data) => guardBEvents.push({ event, data }),
      close: () => { guardBClosed = true; },
      stillAuthorized: async (fresh) => {
        guardBTicks += 1;
        return Boolean(fresh && (await permissions.canAccessProject(fresh, { id: p1.id })));
      },
      heartbeatMs: 200,
    });
    await waitFor(() => guardBTicks >= 1, 5000, "authorized guard first re-check");
    assert.equal(guardBClosed, false, "authorized connection stays open");
    await updateHumanAccessCore(owner, { userId: customerUser.id, projectIds: [] }); // hub-driven revoke
    await waitFor(() => guardBClosed, 5000, "guard closes on hub-driven revocation");
    assert.equal(guardBEvents[guardBEvents.length - 1]?.event, "access-revoked");
    guardB.stop();

    // ---------- 6. New-request freshness + source audits ----------
    const freshViewer = await permissions.getViewerByUserId(customerUser.id);
    assert.ok(freshViewer, "revoked-but-active account still resolves as a viewer");
    assert.equal(
      await permissions.canAccessProject(freshViewer, { id: p1.id }),
      false,
      "next request denies the revoked project",
    );

    const middlewareSrc = await readFile(path.join(process.cwd(), "middleware.ts"), "utf8");
    assert.match(middlewareSrc, /getToken/, "middleware verifies the JWT signature");
    assert.doesNotMatch(
      middlewareSrc,
      /rolePermission|isOwner|hasOwnerRole|hasAdminRole/,
      "middleware never gates on role/owner claims — session existence only",
    );
    const permissionsSrc = await readFile(path.join(process.cwd(), "lib/auth/permissions.ts"), "utf8");
    assert.match(permissionsSrc, /session\?\.user\?\.id/, "getViewer uses the session for identity only");
    assert.match(
      permissionsSrc,
      /if \(!user \|\| user\.status !== "active"\) return null;/,
      "getViewer re-checks account status per request",
    );
    assert.doesNotMatch(
      permissionsSrc,
      /session\?\.user\?\.(role|status|isOwner|members)/,
      "no authorization derives from JWT claims",
    );

    const guardedRoutes = [
      "app/api/projects/[slug]/board/stream/route.ts",
      "app/api/workspaces/[slug]/board/stream/route.ts",
      "app/api/workspaces/board/stream/route.ts",
      "app/api/agents/presence/route.ts",
    ];
    for (const rel of guardedRoutes) {
      const src = await readFile(path.join(process.cwd(), rel), "utf8");
      assert.match(src, /attachRevocationGuard/, `${rel} re-evaluates scope on live connections (ENV-168)`);
    }
    const layoutSrc = await readFile(path.join(process.cwd(), "app/(app)/layout.tsx"), "utf8");
    const providerOpen = layoutSrc.indexOf("<ViewerPolicyProvider>");
    const ownerGate = layoutSrc.indexOf("canAccessOwnerFeatures");
    assert.ok(
      providerOpen !== -1 && (ownerGate === -1 || providerOpen < ownerGate),
      "viewer policy provider is mounted outside the owner-features conditional — every viewer, every route",
    );
    const degradedClients = [
      "app/(app)/projects/[slug]/board-client.tsx",
      "app/(app)/projects/[slug]/epics/[epicId]/epic-tasks-client.tsx",
      "components/agent-presence-provider.tsx",
    ];
    for (const rel of degradedClients) {
      const src = await readFile(path.join(process.cwd(), rel), "utf8");
      assert.match(src, /access-revoked/, `${rel} handles the terminal access-revoked event`);
    }
    const pmProviderSrc = await readFile(path.join(process.cwd(), "components/persistent-pm-stream-provider.tsx"), "utf8");
    assert.match(pmProviderSrc, /authzTerminal/, "pm stream stops retrying on terminal 401/403");
    const policyProviderSrc = await readFile(path.join(process.cwd(), "components/viewer-policy-provider.tsx"), "utf8");
    assert.match(policyProviderSrc, /EventSource\.CLOSED/, "policy provider stops EventSource reconnects on terminal authz close");
    const policyRouteSrc = await readFile(path.join(process.cwd(), "app/api/viewer/policy/stream/route.ts"), "utf8");
    assert.match(policyRouteSrc, /status: 401/, "policy stream returns terminal 401 when the session does not resolve");
    assert.doesNotMatch(
      policyRouteSrc,
      /rolePermission|projectMember|members:/,
      "policy route never queries or emits role/scope/project content",
    );
    assert.doesNotMatch(
      policyRouteSrc,
      /stream\.cancel\(\)/,
      "route never manually cancels the Response stream — the runtime's pipeTo teardown owns cancellation (ENV-168 review defect)",
    );

    // ---------- 7. Route handler: Response locking + abort teardown ----------
    // ENV-168 review-defect regression: the route once cancelled the
    // Response-locked stream from a req.signal abort listener — a rejected
    // promise on every client disconnect. This exercises the REAL route
    // handler in-process (auth injected via the documented test seam), locks
    // the body the way the runtime does, aborts the request, then runs the
    // runtime's pipeTo teardown (reader.cancel) and asserts a clean close:
    // no unhandled rejection, hub subscription released, no later activity.
    const routeMod = await import("../app/api/viewer/policy/stream/route");

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandledRejection);

    const baselineListeners = accessChangeListenerCount(customerUser.id);
    const routeEpochBefore = await epochOf();
    const abortController = new AbortController();
    const routeReq = new Request("http://localhost/api/viewer/policy/stream", {
      signal: abortController.signal,
    });
    const routeRes = await routeMod.GET(routeReq, undefined, {
      getViewer: () => Promise.resolve(viewerFor(customerUser, "customer")),
      heartbeatMs: 40,
    });
    assert.equal(routeRes.status, 200, "route resolves an authenticated viewer to 200");
    assert.equal(
      routeRes.headers.get("content-type"),
      "text/event-stream; charset=utf-8",
      "route returns the SSE content type",
    );
    const routeBody = routeRes.body;
    assert.ok(routeBody, "route body is the policy stream");
    assert.equal(
      accessChangeListenerCount(customerUser.id),
      baselineListeners + 1,
      "route stream subscribes to the access-change hub",
    );

    const routeReader = routeBody.getReader(); // the runtime's reader — this locks the stream
    assert.equal(
      routeBody.locked,
      true,
      "the Response reader locks the stream (the review defect's precondition)",
    );

    // connect frame carries the current durable epoch
    const routeDecoder = new TextDecoder();
    let routeBuffer = "";
    const routeDeadline = Date.now() + 5000;
    while (!routeBuffer.includes("\n\n") && Date.now() < routeDeadline) {
      const next = await routeReader.read();
      if (next.done) break;
      routeBuffer += routeDecoder.decode(next.value, { stream: true });
    }
    const connectFrame = routeBuffer.match(/^event: policy-version\ndata: (\d+)\n\n/);
    assert.ok(connectFrame, `connect epoch frame well-formed: ${JSON.stringify(routeBuffer)}`);
    assert.equal(
      Number(connectFrame[1]),
      routeEpochBefore,
      "connect epoch is the current durable policyVersion",
    );

    // client disconnect: abort the request. The fixed route registers nothing
    // on abort; the old listener cancelled the locked stream here and
    // surfaced an unhandled TypeError.
    abortController.abort();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(
      unhandled.length,
      0,
      "aborting the request raises no unhandled rejection from the route handler",
    );

    // Next's pipeTo teardown on abort cancels the source reader, which must
    // run createViewerPolicyStream's cancel() → closeStream(): heartbeat
    // cleared, hub subscription released.
    await routeReader.cancel();
    assert.equal(
      accessChangeListenerCount(customerUser.id),
      baselineListeners,
      "runtime teardown releases the route stream's hub subscription",
    );

    // quiet window: a moving epoch across several fast-heartbeat intervals
    // must produce no activity — no leaked heartbeat, no rejection.
    await prisma.user.update({
      where: { id: customerUser.id },
      data: { policyVersion: { increment: 1 } },
    });
    await new Promise((resolve) => setTimeout(resolve, 240));
    assert.equal(unhandled.length, 0, "no leaked heartbeat activity after teardown");

    process.off("unhandledRejection", onUnhandledRejection);

    unsubscribeCustomer();
    console.log("access-revocation-test: ok");
  } finally {
    await db?.$disconnect();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
    await rm(tmp, { recursive: true, force: true });
  }
}

void main();
