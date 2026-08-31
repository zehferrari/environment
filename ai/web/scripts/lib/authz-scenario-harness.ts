// ENV-169 — shared authorization scenario harness for the Client UI Epic's
// task 9: the Owner / Admin / Customer authorization and end-to-end test gate.
//
// What this module is — and where it stops:
//
//   * One throwaway SQLite database per run, provisioned with
//     `prisma migrate deploy` (NOT `db push`). Same load-bearing convention
//     as scripts/lib/workflow-scenario-harness.ts: the raw-SQL migrations
//     produce a database shaped like production, and authorization suites
//     must run against that shape.
//   * DATABASE_URL is repointed BEFORE any `@/lib/...` module import: every
//     production module below is obtained through `await import(...)` after
//     the sandbox exists (the `@/lib/db` singleton reads DATABASE_URL at
//     module-eval time). Type-only imports are erased at runtime and are the
//     one safe static exception.
//   * A fixed cast of fixtures: the three human roles with real
//     RolePermission rows, project grants through real ProjectMember rows,
//     two projects in two workspaces, agent principals with their User
//     rows, human- and agent-authored comments / activities / attachments /
//     chat rows / a published item, one private Task and one private Epic.
//   * In-process request helpers that drive REAL server code with no
//     re-implemented policy:
//       - `viewer(userId)` / `mustViewer(userId)` resolve the REAL Viewer via
//         getViewerByUserId (lib/auth/permissions) — role, status and
//         agentVisibility derive from the seeded rows, never from literals.
//       - `sessionCookie(userId)` mints a genuine Auth.js session JWT with
//         next-auth/jwt `encode` using the sandbox AUTH_SECRET and the
//         standard cookie salt — the same token middleware verifies with
//         `getToken`.
//       - `callMiddleware` invokes the exported `middleware` function with a
//         real NextRequest (request-boundary gating / login redirects).
//       - `callRoute` invokes a real App Router route handler in-process via
//         runRouteHandler, for routes that authenticate from the passed
//         request itself.
//   * In-process boundary inherited from the ENV-164..168 suites: App Router
//     handlers that resolve the viewer through auth()/cookies() need Next's
//     request AsyncLocalStorage, which does not exist under plain `tsx`.
//     Those surfaces are covered where their enforcement actually lives:
//     the same cores the routes call (accessible*Where, canAccessProject,
//     canManageAccessFor, agent-content-policy, ...), the real middleware at
//     the request boundary, and renderToStaticMarkup for the page surface.
//     No suite may re-implement policy to fake those routes.

import "./next-als-polyfill";

import type { NextRequest } from "next/server"; // type-only: erased at runtime
import type { Viewer } from "@/lib/auth/permissions"; // type-only: erased at runtime

import {
  createScenarioClock,
  createScenarioSandbox,
  MINUTE_MS,
  type ScenarioDb,
  type ScenarioSandbox,
} from "./workflow-scenario-harness";

// Re-exported so authorization suites have a single import surface for the
// shared conventions.
export {
  createScenarioReporter,
  createIdSeeder,
  MINUTE_MS,
  HOUR_MS,
  type ScenarioReporter,
} from "./workflow-scenario-harness";

/** Standard non-TLS Auth.js session cookie (what middleware reads on http). */
export const SESSION_COOKIE_NAME = "authjs.session-token";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24;

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

export interface AuthzUser {
  id: string;
  username: string;
  email: string;
  role: "owner" | "admin" | "customer";
}

export interface AuthzAgent {
  agentId: string;
  userId: string;
  slug: string;
  name: string;
  email: string;
}

export interface AuthzProjectRef {
  id: string;
  slug: string;
}

export interface AuthzWorkspaceRef {
  id: string;
  slug: string;
}

export interface AuthzRef {
  id: string;
}

export interface AuthzWorld {
  roles: { owner: string; admin: string; customer: string }; // RolePermission ids
  /** Global owner (isOwner + owner role). */
  owner: AuthzUser;
  /** Admin granted Project A only. */
  adminA: AuthzUser;
  /** Second admin, also scoped to Project A (cross-admin guardrail target). */
  adminB: AuthzUser;
  /** Customer granted Project A. */
  customerA: AuthzUser;
  /** Customer with no grants at all. */
  customerBare: AuthzUser;
  agents: { agentA: AuthzAgent; agentB: AuthzAgent };
  projects: { projectA: AuthzProjectRef; projectB: AuthzProjectRef };
  workspaces: { workspaceA: AuthzWorkspaceRef; workspaceB: AuthzWorkspaceRef };
  epics: { epicA: AuthzRef; privateEpicA: AuthzRef; epicB: AuthzRef };
  tasks: {
    taskA: AuthzRef;
    privateTaskA: AuthzRef;
    taskB: AuthzRef;
    /** 24 public Project A tasks with cycling statuses, for count/pagination. */
    bulkProjectA: AuthzRef[];
  };
  comments: {
    humanOnTaskA: AuthzRef;
    agentOnTaskA: AuthzRef;
    /** Agent-authored and addressed to the Customer — must still be excluded. */
    agentAddressedToCustomer: AuthzRef;
    /** isGenerated system comment authored via the agent user. */
    generatedOnTaskA: AuthzRef;
    /** Human-authored body that @mentions an agent — redaction path. */
    humanNamingAgent: AuthzRef;
    humanOnPrivateTaskA: AuthzRef;
    agentOnEpicA: AuthzRef;
    humanOnTaskB: AuthzRef;
    agentOnTaskB: AuthzRef;
  };
  activities: {
    humanOnTaskA: AuthzRef;
    agentOnTaskA: AuthzRef;
    humanOnProjectA: AuthzRef;
    agentOnProjectB: AuthzRef;
  };
  attachments: {
    humanOnTaskA: AuthzRef;
    agentOnTaskA: AuthzRef;
    humanOnProjectB: AuthzRef;
  };
  chat: {
    agentChatOnTaskA: AuthzRef;
    agentChatOnEpicA: AuthzRef;
    agentChatOnProjectB: AuthzRef;
    directFromAgent: AuthzRef;
  };
  published: { publishedProjectA: AuthzRef };
}

// ---------------------------------------------------------------------------
// Modules bundle (real production entry points, imported AFTER the sandbox)
// ---------------------------------------------------------------------------

export type AuthzModules = {
  permissions: typeof import("@/lib/auth/permissions");
  accessManagement: typeof import("@/lib/users/access-management");
  accessPolicy: typeof import("@/lib/users/access-policy");
  contentPolicy: typeof import("@/lib/users/agent-content-policy");
  actorVisibility: typeof import("@/lib/users/actor-visibility");
  redactAgents: typeof import("@/lib/users/redact-agents");
  workspacesService: typeof import("@/lib/workspaces/service");
  publishingService: typeof import("@/lib/publishing/service");
  viewerPolicyStream: typeof import("@/lib/viewer-policy-stream");
  roles: typeof import("@/lib/auth/roles");
};

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

export interface AuthzScenario {
  sandbox: ScenarioSandbox;
  db: ScenarioDb;
  world: AuthzWorld;
  modules: AuthzModules;
  /** REAL viewer resolution (getViewerByUserId) — null mirrors production. */
  viewer(userId: string): Promise<Viewer | null>;
  /** REAL viewer resolution that fails loudly on an unexpected null. */
  mustViewer(userId: string): Promise<Viewer>;
  /** Minted Auth.js session JWT as a full `cookie` header value. */
  sessionCookie(userId: string, kind?: "human" | "agent"): Promise<string>;
  /** Build a real NextRequest (session cookie attached when user provided). */
  requestAs(
    userId: string | null,
    url: string,
    init?: {
      method?: string;
      json?: unknown;
      headers?: Record<string, string>;
      /** Extra cookie appended AFTER the session cookie (e.g. preview). */
      extraCookie?: string;
    },
  ): Promise<NextRequest>;
  /** Invoke the real exported middleware with a NextRequest. */
  callMiddleware(req: NextRequest): Promise<{ status: number; location: string | null; headers: Headers }>;
  /** Invoke a real App Router route handler in-process. */
  callRoute(
    routeModule: Record<string, unknown>,
    handlerName: string,
    req: NextRequest,
    params?: Record<string, string>,
  ): Promise<Response>;
  dispose(): Promise<void>;
}

/**
 * Every string a Customer-visible payload must never contain. Derived from
 * the seeded agent fixtures so suites cannot drift from the harness cast.
 */
export function agentIdentifierSentinels(world: AuthzWorld): string[] {
  return [
    world.agents.agentA.slug,
    world.agents.agentB.slug,
    world.agents.agentA.name,
    world.agents.agentB.name,
    world.agents.agentA.userId,
    world.agents.agentB.userId,
    world.agents.agentA.email,
    world.agents.agentB.email,
    "az-agent-report.bin",
    "agent-sha-2",
  ];
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export async function setupAuthzScenario(): Promise<AuthzScenario> {
  const sandbox = await createScenarioSandbox({ name: "authz-scenario" });
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const clock = createScenarioClock();

  const { db } = await import("@/lib/db");
  const [
    permissions,
    accessManagement,
    accessPolicy,
    contentPolicy,
    actorVisibility,
    redactAgents,
    workspacesService,
    publishingService,
    viewerPolicyStream,
    roles,
  ] = await Promise.all([
    import("@/lib/auth/permissions"),
    import("@/lib/users/access-management"),
    import("@/lib/users/access-policy"),
    import("@/lib/users/agent-content-policy"),
    import("@/lib/users/actor-visibility"),
    import("@/lib/users/redact-agents"),
    import("@/lib/workspaces/service"),
    import("@/lib/publishing/service"),
    import("@/lib/viewer-policy-stream"),
    import("@/lib/auth/roles"),
  ]);
  const modules: AuthzModules = {
    permissions,
    accessManagement,
    accessPolicy,
    contentPolicy,
    actorVisibility,
    redactAgents,
    workspacesService,
    publishingService,
    viewerPolicyStream,
    roles,
  };

  // ----- Roles -------------------------------------------------------------
  const roleOwner = await db.rolePermission.upsert({
    where: { name: "owner" },
    create: { name: "owner", description: "Mission Control Owner" },
    update: {},
  });
  const roleAdmin = await db.rolePermission.upsert({
    where: { name: "admin" },
    create: { name: "admin", description: "Scoped human administrator" },
    update: {},
  });
  const roleCustomer = await db.rolePermission.upsert({
    where: { name: "customer" },
    create: { name: "customer", description: "Customer-facing project member" },
    update: {},
  });

  // ----- Humans ------------------------------------------------------------
  const mkHuman = async (
    username: string,
    role: "owner" | "admin" | "customer",
    isOwner: boolean,
  ): Promise<AuthzUser> => {
    const user = await db.user.create({
      data: {
        username,
        email: `${username}@example.invalid`,
        kind: "human",
        status: "active",
        isOwner,
        mustRotatePassword: false,
        rolePermission: { connect: { name: role } },
      },
    });
    return { id: user.id, username: user.username, email: user.email, role };
  };

  const owner = await mkHuman("az-owner", "owner", true);
  const adminA = await mkHuman("az-admin-a", "admin", false);
  const adminB = await mkHuman("az-admin-b", "admin", false);
  const customerA = await mkHuman("az-customer-a", "customer", false);
  const customerBare = await mkHuman("az-customer-bare", "customer", false);

  // ----- Agent principals + their User rows --------------------------------
  const mkAgent = async (slug: string, name: string): Promise<AuthzAgent> => {
    const agent = await db.agent.create({ data: { slug, name, role: "coding" } });
    const user = await db.user.create({
      data: {
        username: slug,
        email: `${slug}@example.invalid`,
        kind: "agent",
        status: "active",
        mustRotatePassword: false,
        agentId: agent.id,
      },
    });
    return { agentId: agent.id, userId: user.id, slug, name, email: `${slug}@example.invalid` };
  };
  const agentA = await mkAgent("az-agent-a", "AZ Agent A");
  const agentB = await mkAgent("az-agent-b", "AZ Agent B");

  // ----- Projects, workspaces, grants --------------------------------------
  const projectA = await db.project.create({ data: { slug: "az-project-a", name: "AZ Project A" } });
  const projectB = await db.project.create({ data: { slug: "az-project-b", name: "AZ Project B" } });
  const workspaceA = await db.workspace.create({ data: { slug: "az-workspace-a", name: "AZ Workspace A" } });
  const workspaceB = await db.workspace.create({ data: { slug: "az-workspace-b", name: "AZ Workspace B" } });
  await db.workspaceProject.create({ data: { workspaceId: workspaceA.id, projectId: projectA.id } });
  await db.workspaceProject.create({ data: { workspaceId: workspaceB.id, projectId: projectB.id } });
  await db.workspaceAgentPool.create({ data: { workspaceId: workspaceA.id, agentId: agentA.agentId } });
  await db.workspaceAgentPool.create({ data: { workspaceId: workspaceB.id, agentId: agentB.agentId } });

  const mkMember = (projectId: string, userId: string) =>
    db.projectMember.create({ data: { projectId, userId, role: "member" } });
  await mkMember(projectA.id, adminA.id);
  await mkMember(projectA.id, adminB.id);
  await mkMember(projectA.id, customerA.id);

  // ----- Epics / Tasks ------------------------------------------------------
  const epicA = await db.epic.create({
    data: {
      projectId: projectA.id,
      title: "AZ Epic A",
      status: "In Progress",
      actingManagerId: owner.id,
      reporterId: owner.id,
    },
  });
  const privateEpicA = await db.epic.create({
    data: {
      projectId: projectA.id,
      title: "AZ Private Epic",
      status: "In Progress",
      private: true,
      actingManagerId: owner.id,
    },
  });
  const epicB = await db.epic.create({
    data: {
      projectId: projectB.id,
      title: "AZ Epic B",
      status: "In Progress",
      actingManagerId: owner.id,
    },
  });

  const taskA = await db.task.create({
    data: {
      projectId: projectA.id,
      epicId: epicA.id,
      title: "AZ Task A",
      status: "In Progress",
      reporterId: owner.id,
      assigneeId: agentA.userId, // agent assignee: masking/exclusion target
    },
  });
  const privateTaskA = await db.task.create({
    data: { projectId: projectA.id, epicId: epicA.id, title: "AZ Private Task", status: "To Do", private: true },
  });
  const taskB = await db.task.create({
    data: {
      projectId: projectB.id,
      epicId: epicB.id,
      title: "AZ Task B",
      status: "In Progress",
      reporterId: owner.id,
    },
  });
  const bulkStatuses = ["Backlog", "To Do", "In Progress", "Review", "Done"] as const;
  const bulkProjectA: AuthzRef[] = [];
  for (let n = 1; n <= 24; n += 1) {
    const t = await db.task.create({
      data: {
        projectId: projectA.id,
        epicId: epicA.id,
        title: `AZ Bulk Task ${String(n).padStart(2, "0")}`,
        status: bulkStatuses[n % bulkStatuses.length],
        reporterId: owner.id,
      },
    });
    bulkProjectA.push({ id: t.id });
  }

  // ----- Comments (human, agent, generated, addressed-to-customer) ----------
  const at = (minutes: number) => clock.at(minutes * MINUTE_MS);
  const humanOnTaskA = await db.comment.create({
    data: {
      taskId: taskA.id,
      userId: owner.id,
      body: "Human coordination note from az-owner for AZ Task A.",
      commentKind: "human",
      createdAt: at(1),
    },
  });
  const agentOnTaskA = await db.comment.create({
    data: {
      taskId: taskA.id,
      userId: agentA.userId,
      authorAgentSlug: agentA.slug,
      body: "az-agent-a: internal build status for AZ Task A.",
      commentKind: "agent_reply",
      createdAt: at(2),
    },
  });
  const agentAddressedToCustomer = await db.comment.create({
    data: {
      taskId: taskA.id,
      userId: agentA.userId,
      authorAgentSlug: agentA.slug,
      body: "@az-customer-a your requested update: az-agent-a finished the deploy steps.",
      commentKind: "agent_reply",
      createdAt: at(3),
    },
  });
  const generatedOnTaskA = await db.comment.create({
    data: {
      taskId: taskA.id,
      userId: agentA.userId,
      authorAgentSlug: agentA.slug,
      body: "PM workflow notification: AZ Task A moved to In Progress by az-agent-a.",
      commentKind: "workflow_action",
      isGenerated: true,
      createdAt: at(4),
    },
  });
  const humanNamingAgent = await db.comment.create({
    data: {
      taskId: taskA.id,
      userId: adminA.id,
      body: "Thanks @az-agent-a — az-agent-a handled the rebases for AZ Task A.",
      commentKind: "human",
      createdAt: at(5),
    },
  });
  const humanOnPrivateTaskA = await db.comment.create({
    data: {
      taskId: privateTaskA.id,
      userId: owner.id,
      body: "Owner-only note on the private task.",
      commentKind: "human",
      createdAt: at(6),
    },
  });
  const agentOnEpicA = await db.comment.create({
    data: {
      epicId: epicA.id,
      userId: agentA.userId,
      authorAgentSlug: agentA.slug,
      body: "az-agent-a: epic-level coordination for AZ Epic A.",
      commentKind: "agent_reply",
      createdAt: at(7),
    },
  });
  const humanOnTaskB = await db.comment.create({
    data: {
      taskId: taskB.id,
      userId: owner.id,
      body: "Human note inside AZ Project B.",
      commentKind: "human",
      createdAt: at(8),
    },
  });
  const agentOnTaskB = await db.comment.create({
    data: {
      taskId: taskB.id,
      userId: agentB.userId,
      authorAgentSlug: agentB.slug,
      body: "az-agent-b: internal status in AZ Project B.",
      commentKind: "agent_reply",
      createdAt: at(9),
    },
  });

  // ----- Activities ----------------------------------------------------------
  const humanActivityTaskA = await db.activityLog.create({
    data: {
      projectId: projectA.id,
      taskId: taskA.id,
      userId: owner.id,
      kind: "task.move",
      payload: JSON.stringify({ from: "To Do", to: "In Progress" }),
      createdAt: at(10),
    },
  });
  const agentActivityTaskA = await db.activityLog.create({
    data: {
      projectId: projectA.id,
      taskId: taskA.id,
      userId: agentA.userId,
      kind: "task.move",
      payload: JSON.stringify({ from: "Backlog", to: "To Do", actor: agentA.slug }),
      createdAt: at(11),
    },
  });
  const humanActivityProjectA = await db.activityLog.create({
    data: {
      projectId: projectA.id,
      userId: adminA.id,
      kind: "project.update",
      payload: JSON.stringify({ summary: "az-admin-a updated project settings" }),
      createdAt: at(12),
    },
  });
  const agentActivityProjectB = await db.activityLog.create({
    data: {
      projectId: projectB.id,
      taskId: taskB.id,
      userId: agentB.userId,
      kind: "task.move",
      payload: JSON.stringify({ from: "To Do", to: "In Progress", actor: agentB.slug }),
      createdAt: at(13),
    },
  });

  // ----- Attachments ---------------------------------------------------------
  const humanAttachmentTaskA = await db.attachment.create({
    data: {
      projectId: projectA.id,
      taskId: taskA.id,
      uploaderId: owner.id,
      filename: "az-human-brief.pdf",
      storagePath: "attachments/az-human-brief.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1111,
      sha256: "human-sha-1",
    },
  });
  const agentAttachmentTaskA = await db.attachment.create({
    data: {
      projectId: projectA.id,
      taskId: taskA.id,
      uploaderId: agentA.userId,
      filename: "az-agent-report.bin",
      storagePath: "attachments/az-agent-report.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 2222,
      sha256: "agent-sha-2",
    },
  });
  const humanAttachmentProjectB = await db.attachment.create({
    data: {
      projectId: projectB.id,
      uploaderId: owner.id,
      filename: "az-b-doc.pdf",
      storagePath: "attachments/az-b-doc.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3333,
      sha256: "human-sha-3",
    },
  });

  // ----- Agent chat surfaces ---------------------------------------------------
  const agentChatOnTaskA = await db.agentChatMessage.create({
    data: {
      projectId: projectA.id,
      taskId: taskA.id,
      agentSlug: agentA.slug,
      senderUserId: agentA.userId,
      body: "az-agent-a: chat reply inside AZ Task A.",
      originChannel: "chat",
      createdAt: at(14),
    },
  });
  const agentChatOnEpicA = await db.agentChatMessage.create({
    data: {
      projectId: projectA.id,
      epicId: epicA.id,
      agentSlug: agentA.slug,
      senderUserId: agentA.userId,
      body: "az-agent-a: epic chat coordination.",
      originChannel: "chat",
      createdAt: at(15),
    },
  });
  const agentChatOnProjectB = await db.agentChatMessage.create({
    data: {
      projectId: projectB.id,
      agentSlug: agentB.slug,
      senderUserId: agentB.userId,
      body: "az-agent-b: project B chat.",
      originChannel: "chat",
      createdAt: at(16),
    },
  });
  const directFromAgent = await db.directAgentChatMessage.create({
    data: {
      agentSlug: agentA.slug,
      senderUserId: agentA.userId,
      projectId: projectA.id,
      body: "az-agent-a: direct update for the adjacent thread.",
      createdAt: at(17),
    },
  });

  // ----- Customer-safe published item -----------------------------------------
  const publishedProjectA = await db.publishedItem.create({
    data: {
      projectId: projectA.id,
      taskId: taskA.id,
      authorId: adminA.id,
      title: "AZ Published Update",
      body: "Customer-safe update published by az-admin-a: build delivered.",
    },
  });

  const world: AuthzWorld = {
    roles: { owner: roleOwner.id, admin: roleAdmin.id, customer: roleCustomer.id },
    owner,
    adminA,
    adminB,
    customerA,
    customerBare,
    agents: { agentA, agentB },
    projects: {
      projectA: { id: projectA.id, slug: projectA.slug },
      projectB: { id: projectB.id, slug: projectB.slug },
    },
    workspaces: {
      workspaceA: { id: workspaceA.id, slug: workspaceA.slug },
      workspaceB: { id: workspaceB.id, slug: workspaceB.slug },
    },
    epics: {
      epicA: { id: epicA.id },
      privateEpicA: { id: privateEpicA.id },
      epicB: { id: epicB.id },
    },
    tasks: { taskA: { id: taskA.id }, privateTaskA: { id: privateTaskA.id }, taskB: { id: taskB.id }, bulkProjectA },
    comments: {
      humanOnTaskA: { id: humanOnTaskA.id },
      agentOnTaskA: { id: agentOnTaskA.id },
      agentAddressedToCustomer: { id: agentAddressedToCustomer.id },
      generatedOnTaskA: { id: generatedOnTaskA.id },
      humanNamingAgent: { id: humanNamingAgent.id },
      humanOnPrivateTaskA: { id: humanOnPrivateTaskA.id },
      agentOnEpicA: { id: agentOnEpicA.id },
      humanOnTaskB: { id: humanOnTaskB.id },
      agentOnTaskB: { id: agentOnTaskB.id },
    },
    activities: {
      humanOnTaskA: { id: humanActivityTaskA.id },
      agentOnTaskA: { id: agentActivityTaskA.id },
      humanOnProjectA: { id: humanActivityProjectA.id },
      agentOnProjectB: { id: agentActivityProjectB.id },
    },
    attachments: {
      humanOnTaskA: { id: humanAttachmentTaskA.id },
      agentOnTaskA: { id: agentAttachmentTaskA.id },
      humanOnProjectB: { id: humanAttachmentProjectB.id },
    },
    chat: {
      agentChatOnTaskA: { id: agentChatOnTaskA.id },
      agentChatOnEpicA: { id: agentChatOnEpicA.id },
      agentChatOnProjectB: { id: agentChatOnProjectB.id },
      directFromAgent: { id: directFromAgent.id },
    },
    published: { publishedProjectA: { id: publishedProjectA.id } },
  };

  // ----- Request helpers ---------------------------------------------------------

  const viewer = (userId: string) => permissions.getViewerByUserId(userId);

  const mustViewer = async (userId: string): Promise<Viewer> => {
    const resolved = await permissions.getViewerByUserId(userId);
    if (!resolved) {
      throw new Error(`authz-scenario-harness: getViewerByUserId returned null for user ${userId}`);
    }
    return resolved;
  };

  const sessionCookie = async (userId: string, kind: "human" | "agent" = "human"): Promise<string> => {
    const secret = process.env.AUTH_SECRET as string;
    if (!secret) throw new Error("authz-scenario-harness: AUTH_SECRET missing after sandbox boot");
    const { encode } = await import("next-auth/jwt");
    const jwt = await encode({
      // Identity-only claims — mirrors the auth() jwt callback contract:
      // role/status/agentVisibility are re-read from the database, never
      // taken from the token.
      token: { uid: userId, kind, passwordSetAt: null },
      secret,
      salt: SESSION_COOKIE_NAME,
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return `${SESSION_COOKIE_NAME}=${jwt}`;
  };

  const requestAs: AuthzScenario["requestAs"] = async (userId, url, init) => {
    const { NextRequest: NR } = await import("next/server");
    const headers = new Headers(init?.headers);
    const cookies: string[] = [];
    if (userId) cookies.push(await sessionCookie(userId));
    if (init?.extraCookie) cookies.push(init.extraCookie);
    if (cookies.length > 0) headers.set("cookie", cookies.join("; "));
    const hasBody = init?.json !== undefined;
    if (hasBody) headers.set("content-type", "application/json");
    return new NR(url, {
      method: init?.method ?? "GET",
      headers,
      body: hasBody ? JSON.stringify(init?.json) : undefined,
    });
  };

  const callMiddleware: AuthzScenario["callMiddleware"] = async (req) => {
    const mw = await import("../../middleware");
    const handler = mw.middleware as (request: NextRequest) => Promise<Response>;
    const res = await handler(req);
    return { status: res.status, location: res.headers.get("location"), headers: res.headers };
  };

  const callRoute: AuthzScenario["callRoute"] = async (routeModule, handlerName, req, params) => {
    const { runRouteHandler } = await import("./next-route-harness");
    const handler = routeModule[handlerName] as
      | ((request: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>)
      | undefined;
    if (typeof handler !== "function") {
      throw new Error(`authz-scenario-harness: route handler "${handlerName}" not found on module`);
    }
    return runRouteHandler(() => handler(req, { params: Promise.resolve(params ?? {}) }));
  };

  const dispose = async (): Promise<void> => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    try {
      await db.$disconnect();
    } catch {
      // Best-effort teardown; the temp dir removal below is what matters.
    }
    await sandbox.dispose();
  };

  return {
    sandbox,
    db,
    world,
    modules,
    viewer,
    mustViewer,
    sessionCookie,
    requestAs,
    callMiddleware,
    callRoute,
    dispose,
  };
}