// ENV-124 Group B — what an APPROVED Action Plan turns into (Epic cases C6, C7).
//
// Two of the Epic's twelve regression cases are about the same moment: the
// instant a plan is approved, PM has to materialise it into durable rows.
//
//   C6  an approved SEQUENTIAL plan creates progress CHECKLIST entries
//   C7  an approved PARALLEL plan creates DELEGATABLE SUBTASKS
//
// The Epic attaches two contracts to that moment, and both are asserted here
// rather than assumed:
//
//   Epic item 4 (WFI-008) — the steps must come from STRUCTURED DATA, never
//     from scraping the rendered Markdown of the agent's reply. The parser is
//     retained only as a test oracle, so "structured wins" is proved by arming
//     path: every plan posted below carries a Markdown body whose
//     "Implementation Steps" section lists DECOY lines the scraper does pick
//     up, while the structured payload carries the real ones. The checklist
//     that comes out must contain the structured titles and none of the
//     decoys. Nothing weaker distinguishes "reads structured steps" from
//     "happens to parse the same words".
//
//   Epic item 5 — a progress checklist entry and a delegatable subtask must be
//     SEPARATE things. They are: a checklist entry is a SubTask row (text +
//     completion, no assignee, no status, no board presence) and a delegatable
//     subtask is a child Task row (assignee, status, board presence). The two
//     are distinguishable in durable state by table, and by the fact that
//     `SubTask.kind` is a PHASE axis (implementation | review) that has no
//     "delegatable" member at all.
//
// Everything is driven through the real writers: the plan is posted with the
// production PM-channel reply path (persistTaskReply, the same entry point the
// reply route uses) and approved through the real
// /api/agent/tasks/[taskId]/workflow route with action=approve_plan. No
// approval logic is re-implemented here — a regression that only fails through
// a helper written for the test is not a regression anybody would have shipped.
//
// Complements scripts/action-plan-structured-test.ts (ENV-119), which unit-
// tests the store's validation, persistence and idempotency in isolation. This
// suite never re-asserts those; it asserts the END-TO-END approval outcome and
// the two Epic contracts above, which that suite does not cover.
//
// Exit 0 on success, non-zero on the first failed assertion.

import "./lib/next-als-polyfill";

import {
  bootScenarioDb,
  createScenarioReporter,
  createScenarioSandbox,
  dispatchWorkflowTurn,
  seedTask,
  seedWorld,
  type ScenarioCase,
  type ScenarioWorld,
} from "./lib/workflow-scenario-harness";

const SUITE = "workflow-regression-plan-steps";
const AGENT_SLUG = "planbot"; // the assignee: posts the plan, owns the checklist
const LEAD_SLUG = "planlead"; // the acting manager: the only actor who may approve
const HELPER_SLUG = "planhelper"; // the delegate a parallel step names

const report = createScenarioReporter(SUITE);

async function main(): Promise<void> {
  // MUST come before any `@/lib/...` import: `@/lib/db` binds DATABASE_URL at
  // module-eval time, so a static import would bind the live pm.db.
  const sandbox = await createScenarioSandbox({ name: SUITE });

  try {
    const boot = await bootScenarioDb();
    const { db } = boot;

    const { getActionPlanForTask } = await import("@/lib/tasks/action-plan-store");
    const { extractActionPlanSteps } = await import("@/lib/tasks/action-plan-subtasks");
    const { SUBTASK_KINDS, normalizeSubTaskKind } = await import("@/lib/tasks/subtasks");
    const { persistTaskReply } = await import("@/lib/agents/pm-channel/persist-task-reply");
    const { loadWorkflowInvariantSnapshot } = await import("@/lib/workflow-invariants-db");
    const { workflowInvariantById } = await import("@/lib/workflow-invariants");
    const world = await seedWorld(db, {
      agentSlug: AGENT_SLUG,
      agentName: "Plan Bot",
      projectSlug: "regression-plan-steps",
      withEpic: true,
    });

    // ------------------------------------------------------------------
    // Cast beyond the harness default.
    //
    // approve_plan is deliberately NOT self-service: the route gates it on
    // canApproveActionPlanForActor, so the approver has to be the reporter or
    // the resolved review owner. A second agent holding the acting-manager
    // seat is how that reads in production, and using it here means the case
    // exercises the real permission path instead of routing around it.
    //
    // ProjectMember rows matter for a different reason: persistActionPlan
    // validates every step assigneeId against the project's active
    // principals, so a delegatable step is only postable for a real member.
    // ------------------------------------------------------------------
    async function seedAgentPrincipal(slug: string, name: string) {
      const agent = await db.agent.create({ data: { slug, name, role: "coding" } });
      const user = await db.user.create({
        data: {
          username: slug,
          email: `${slug}@example.invalid`,
          kind: "agent",
          agentId: agent.id,
        },
      });
      await db.projectMember.create({
        data: { projectId: world.projectId, userId: user.id, role: "developer" },
      });
      return { agentId: agent.id, userId: user.id };
    }

    const lead = await seedAgentPrincipal(LEAD_SLUG, "Plan Lead");
    const helper = await seedAgentPrincipal(HELPER_SLUG, "Plan Helper");
    await db.projectMember.create({
      data: { projectId: world.projectId, userId: world.agentUserId, role: "developer" },
    });

    /** A world view whose "acting agent" is the approver, for the poster. */
    const leadWorld: ScenarioWorld = {
      ...world,
      agentSlug: LEAD_SLUG,
      agentUserId: lead.userId,
    };

    // A plan-shaped reply body whose Markdown DOES feed the legacy scraper.
    // The bullets are decoys: if anything downstream reads prose, they show up
    // in the checklist and the case fails.
    function decoyPlanBody(decoys: string[]): string {
      return [
        "## Section A - Full Response",
        "",
        "Here is the plan for this task.",
        "",
        "### Implementation Steps",
        ...decoys.map((line) => `- ${line}`),
        "",
        "## Section B - Short Summary",
        "",
        "Plan posted for approval.",
      ].join("\n");
    }

    /**
     * Post an Action Plan the way the assignee does in production: one
     * PM-channel reply carrying BOTH the Markdown body and the structured
     * `actionPlan` payload. Returns the persisted reply body so the test can
     * run the production scraper over exactly what landed in the database.
     */
    async function postPlanAsAssignee(args: {
      taskId: string;
      body: string;
      plan: {
        summary: string;
        steps: Array<{
          id: string;
          title: string;
          acceptanceCriteria: string[];
          kind: "sequential" | "parallel";
          assigneeId?: string | null;
        }>;
      };
    }) {
      // The message the agent is replying TO. Seeded directly because it is
      // scenery, not the code under test; the reply itself goes through the
      // production writer.
      const room = await db.agentChatMessage.create({
        data: {
          projectId: world.projectId,
          taskId: args.taskId,
          agentSlug: "room",
          senderUserId: world.ownerId,
          body: "Post your Action Plan for this task.",
          originChannel: "chat",
        },
        select: { id: true },
      });
      const result = await persistTaskReply(
        {
          kind: "task-chat",
          agentSlug: AGENT_SLUG,
          taskId: args.taskId,
          messageId: room.id,
          projectSlug: null,
        },
        args.body,
        args.plan,
      );
      // Read back the EXACT row the legacy fallback would consume: same
      // filters as lib/tasks/action-plan-subtasks.ts (assignee-authored, chat
      // channel, not a PM notification, newest first). Anything looser would
      // scrape a message production would never have looked at.
      const persisted = await db.agentChatMessage.findFirstOrThrow({
        where: {
          taskId: args.taskId,
          archiveId: null,
          deletedAt: null,
          originChannel: "chat",
          senderUserId: world.agentUserId,
          body: { not: { startsWith: "PM workflow notification for @" } },
        },
        orderBy: { createdAt: "desc" },
        select: { body: true },
      });
      return { result, persistedBody: persisted.body };
    }

    /** Checklist rows (SubTask) in board order. */
    async function checklistOf(taskId: string) {
      return db.subTask.findMany({
        where: { taskId },
        orderBy: { rank: "asc" },
        select: { id: true, text: true, kind: true, completedAt: true, rank: true },
      });
    }

    /** Delegatable subtasks (child Task rows) in creation order. */
    async function childTasksOf(taskId: string) {
      return db.task.findMany({
        where: { parentTaskId: taskId, deletedAt: null },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          title: true,
          status: true,
          assigneeId: true,
          epicId: true,
          description: true,
        },
      });
    }

    // ==================================================================
    // C6 — an approved SEQUENTIAL plan creates progress checklist entries.
    //
    // The historical shape: the checklist was reconstructed by regexing the
    // agent's rendered Markdown, so the board's idea of "the steps" was
    // whatever the formatter happened to emit that day. The contract now is
    // that the approved plan's ActionPlanStep rows ARE the steps, and the
    // Markdown is presentation only.
    // ==================================================================
    {
      // Annotated: `c.assert` is a TS assertion function, and TS2775 requires
      // the binding it is called on to carry an explicit type.
      const c: ScenarioCase = report.case("C6", "an approved sequential plan creates the progress checklist from structured steps");

      const task = await seedTask(db, world, {
        title: "C6 sequential plan",
        status: "To Do",
        approved: false,
        underEpic: true,
      });
      // The acting manager is the approver (see the cast note above).
      await db.task.update({ where: { id: task.id }, data: { actingManagerId: lead.userId } });

      const STEP_TITLES = [
        "Add the ActionPlanStep migration",
        "Read approved steps in the approval writer",
        "Cover the approval path with a regression case",
      ];
      const DECOYS = [
        "Scrape this decoy line out of the rendered Markdown",
        "And this second decoy line the parser also accepts",
        "And a third decoy the prose path would have used",
      ];

      const posted = await postPlanAsAssignee({
        taskId: task.id,
        body: decoyPlanBody(DECOYS),
        plan: {
          summary: "C6 structured sequential plan",
          steps: STEP_TITLES.map((title, index) => ({
            id: `c6-s${index + 1}`,
            title,
            acceptanceCriteria: [`${title} is verifiable`],
            kind: "sequential" as const,
          })),
        },
      });
      c.assertEqual(posted.result.status, 200, "the plan reply was accepted by the production writer");

      // The prose path is genuinely ARMED: production's own scraper finds the
      // decoys in exactly the row the legacy fallback would have read. Without
      // this, "no Markdown scraping" would be unfalsifiable.
      const scraped = extractActionPlanSteps(posted.persistedBody);
      c.assertEqual(scraped.length, DECOYS.length, "the legacy scraper does find steps in this body");
      for (const decoy of DECOYS) {
        c.assert(scraped.includes(decoy), `the scraper picked up the decoy line "${decoy}"`);
      }
      for (const title of STEP_TITLES) {
        c.assert(
          !scraped.includes(title),
          "the decoys and the structured titles are disjoint, so the checklist's origin is unambiguous",
        );
      }

      // The plan is structured data BEFORE approval: machine-readable ids,
      // ranks, kinds and acceptance criteria, not a blob of Markdown.
      const plan = await getActionPlanForTask(task.id);
      c.assert(plan, "the posted plan persisted as an ActionPlan row");
      c.assertEqual(plan!.steps.length, 3, "all three steps persisted as ActionPlanStep rows");
      c.assertEqual(plan!.approvedOn, null, "and the plan is not approved yet");
      c.assertEqual(plan!.steps[0].stepId, "c6-s1", "step identity is the agent's own id, not a line number");
      c.assertEqual(plan!.steps[0].rank, 1, "ordering is an explicit column");
      c.assertEqual(plan!.steps[2].rank, 3, "…and it is dense and ordered");
      c.assertEqual(plan!.steps[0].kind, "sequential", "the step kind is a typed column");
      c.assertEqual(
        plan!.steps[1].acceptanceCriteria[0],
        `${STEP_TITLES[1]} is verifiable`,
        "acceptance criteria survive as structured data, which prose could not carry",
      );

      // ---- approval through the REAL route ----
      const approval = await dispatchWorkflowTurn({
        boot,
        world: leadWorld,
        taskId: task.id,
        reason: "action_plan_review_requested",
        body: "Review the posted Action Plan.",
      });
      const approved = await approval.post("approve_plan");
      c.assertEqual(approved.status, 200, "the acting manager may approve the plan");
      c.assertEqual(approved.body.approved, true, "the route reports the plan approved");

      const approvedTask = await db.task.findUniqueOrThrow({
        where: { id: task.id },
        select: { approvedOn: true },
      });
      c.assert(approvedTask.approvedOn, "approval is durable on the task");
      const approvalActivity = await db.activityLog.count({
        where: { taskId: task.id, kind: "task.action_plan.approve" },
      });
      c.assertEqual(approvalActivity, 1, "the real approval path ran exactly once and is auditable");

      // ---- the checklist the approval produced ----
      const checklist = await checklistOf(task.id);
      c.assertEqual(checklist.length, 3, "approval created one checklist entry per structured step");
      for (const [index, title] of STEP_TITLES.entries()) {
        c.assertEqual(
          checklist[index].text,
          title,
          "the checklist entry is the structured step title, verbatim and in plan order",
        );
        c.assertEqual(
          checklist[index].kind,
          "implementation",
          "a plan-derived entry is an implementation-phase progress item",
        );
        c.assertEqual(checklist[index].completedAt, null, "and it starts open");
      }
      // The load-bearing negative: none of the decoys made it in.
      const checklistText = checklist.map((row) => row.text);
      for (const decoy of DECOYS) {
        c.assert(
          !checklistText.includes(decoy),
          `no scraped Markdown line reached the checklist ("${decoy}")`,
        );
      }

      // A sequential plan with no named delegate produces NO delegatable work:
      // the checklist is the whole outcome.
      const children = await childTasksOf(task.id);
      c.assertEqual(
        children.length,
        0,
        "a plan whose steps name no delegate creates no delegatable subtasks",
      );

      // Approval is idempotent. Re-approving must not double the checklist —
      // a duplicated board would be indistinguishable from real extra work.
      const again = await approval.post("approve_plan");
      c.assertEqual(again.status, 200, "a repeated approval is accepted rather than erroring");
      c.assertEqual(again.body.alreadyApproved, true, "…and it reports the plan was already approved");
      c.assertEqual((await checklistOf(task.id)).length, 3, "the checklist was not duplicated");

      // ---- WFI-008, the Epic's own invariant for this case ----
      //
      // Asserted through the production adapter + the production predicate, so
      // the vocabulary is the Epic's and not a second one invented here.
      const snapshot = await loadWorkflowInvariantSnapshot({ projectId: world.projectId });
      const taskRecord = snapshot.tasks.find((row) => row.id === task.id);
      c.assert(taskRecord, "the live-DB adapter loaded the approved task");
      c.assertEqual(taskRecord!.assigneeSlug, AGENT_SLUG, "…with its assignee resolved");
      c.assert(taskRecord!.checklistCount > 0, "…and its durable checklist counted");

      const wfi008 = workflowInvariantById("WFI-008");
      c.assert(wfi008, "WFI-008 is still registered");
      // Scoped to THIS task so the count is exact regardless of what else the
      // project holds.
      const scoped = wfi008!.predicate({ ...snapshot, tasks: [taskRecord!] });

      c.assertEqual(
        taskRecord!.planStepSource,
        "structured",
        "the adapter reads checklist provenance from the approved ActionPlanStep rows",
      );
      c.assertEqual(scoped.ok, true, "WFI-008 holds for a structured approved plan");
      c.assertEqual(scoped.violations.length, 0, "the structured checklist has no plan-provenance violation");
    }

    // ==================================================================
    // C7 — an approved PARALLEL plan creates delegatable subtasks.
    //
    // "Delegatable" means something a DIFFERENT worker can pick up: it needs an
    // assignee, a status and a place on the board, none of which a checklist
    // row has. So the outcome under test is a child Task, and the Epic item 5
    // contract is that it stays SEPARATE from the progress checklist rather
    // than being folded into it.
    // ==================================================================
    {
      const c: ScenarioCase = report.case("C7", "an approved parallel plan creates delegatable subtasks, kept separate from the checklist");

      const task = await seedTask(db, world, {
        title: "C7 parallel plan",
        status: "To Do",
        approved: false,
        underEpic: true,
      });
      await db.task.update({ where: { id: task.id }, data: { actingManagerId: lead.userId } });

      const SEQ_TITLE = "Land the shared schema change first";
      const PARALLEL_DELEGATED_TITLE = "Port the mobile client in parallel";
      const PARALLEL_UNOWNED_TITLE = "Port the desktop client in parallel";
      const DECOYS = [
        "Scrape this C7 decoy line out of the Markdown",
        "And this second C7 decoy the parser accepts",
      ];

      const posted = await postPlanAsAssignee({
        taskId: task.id,
        body: decoyPlanBody(DECOYS),
        plan: {
          summary: "C7 structured plan with parallel steps",
          steps: [
            {
              id: "c7-s1",
              title: SEQ_TITLE,
              acceptanceCriteria: ["Migration is applied"],
              kind: "sequential" as const,
            },
            {
              id: "c7-s2",
              title: PARALLEL_DELEGATED_TITLE,
              acceptanceCriteria: ["Mobile build is green", "Screens render"],
              kind: "parallel" as const,
              assigneeId: helper.userId,
            },
            {
              id: "c7-s3",
              title: PARALLEL_UNOWNED_TITLE,
              acceptanceCriteria: ["Desktop build is green"],
              kind: "parallel" as const,
            },
          ],
        },
      });
      c.assertEqual(posted.result.status, 200, "the parallel plan reply was accepted");
      c.assertEqual(
        extractActionPlanSteps(posted.persistedBody).length,
        DECOYS.length,
        "the prose path is armed here too",
      );

      const plan = await getActionPlanForTask(task.id);
      c.assert(plan, "the parallel plan persisted");
      c.assertEqual(plan!.steps.length, 3, "all three steps persisted");
      c.assertEqual(plan!.steps[1].kind, "parallel", "the delegated step is durably marked parallel");
      c.assertEqual(
        plan!.steps[1].assigneeId,
        helper.userId,
        "…and names its delegate as a foreign key, not a name in prose",
      );
      c.assertEqual(plan!.steps[2].kind, "parallel", "the unowned step is durably marked parallel too");
      c.assertEqual(plan!.steps[2].assigneeId, null, "…but names no delegate");

      const approval = await dispatchWorkflowTurn({
        boot,
        world: leadWorld,
        taskId: task.id,
        reason: "action_plan_review_requested",
        body: "Review the posted Action Plan.",
      });
      const approved = await approval.post("approve_plan");
      c.assertEqual(approved.status, 200, "the acting manager may approve the parallel plan");
      c.assertEqual(approved.body.approved, true, "the route reports the plan approved");

      // ---- the delegatable subtask ----
      const children = await childTasksOf(task.id);
      c.assertEqual(children.length, 2, "approval created one delegatable Task for each parallel step");
      const child = children.find((row) => row.title === PARALLEL_DELEGATED_TITLE)!;
      c.assertEqual(child.title, PARALLEL_DELEGATED_TITLE, "it is the parallel step that named a delegate");
      c.assertEqual(child.assigneeId, helper.userId, "…assigned to that delegate, so another worker can pick it up");
      c.assertEqual(child.status, "To Do", "…queued rather than silently in flight");
      c.assertEqual(child.epicId, world.epicId, "…and it inherits the parent's Epic, so it stays on the same board");
      c.assertIncludes(
        child.description,
        "Mobile build is green",
        "the step's acceptance criteria are carried onto the delegated work",
      );

      const childTitles = children.map((row) => row.title);
      c.assert(
        childTitles.includes(PARALLEL_UNOWNED_TITLE),
        "a parallel step without a named delegate still creates unassigned delegatable work",
      );
      c.assertEqual(
        children.find((row) => row.title === PARALLEL_UNOWNED_TITLE)?.assigneeId,
        null,
        "the unowned parallel child remains available for explicit assignment",
      );
      c.assert(
        !childTitles.includes(SEQ_TITLE),
        "a sequential step with no delegate creates no delegatable subtask either",
      );

      // ---- Epic item 5: the two kinds are separate durable things ----
      const checklist = await checklistOf(task.id);
      c.assertEqual(checklist.length, 3, "every step still gets a progress checklist entry");
      c.assertEqual(checklist[0].text, SEQ_TITLE, "…in plan order");
      c.assertEqual(checklist[1].text, PARALLEL_DELEGATED_TITLE, "…including the delegated one");
      c.assertEqual(checklist[2].text, PARALLEL_UNOWNED_TITLE, "…and the unowned parallel one");
      for (const row of checklist) {
        c.assertEqual(row.kind, "implementation", "plan-derived progress entries are implementation-phase");
      }
      for (const decoy of DECOYS) {
        c.assert(
          !checklist.map((row) => row.text).includes(decoy),
          `no scraped Markdown line reached the C7 checklist ("${decoy}")`,
        );
      }

      // Separate rows in separate tables: the checklist mirror of the delegated
      // step is NOT the delegatable subtask, and the delegatable subtask
      // carries no checklist of its own.
      const mirror = checklist.find((row) => row.text === PARALLEL_DELEGATED_TITLE);
      c.assert(mirror, "the delegated step has a checklist mirror on the parent");
      c.assert(
        mirror!.id !== child.id,
        "the progress entry and the delegatable subtask are distinct durable rows",
      );
      c.assertEqual(
        await db.subTask.count({ where: { taskId: child.id } }),
        0,
        "the delegatable subtask is a Task, not a checklist row — it has a checklist of its own, currently empty",
      );
      c.assertEqual(
        await db.subTask.count({ where: { taskId: task.id, kind: "implementation" } }),
        3,
        "and the parent's checklist counts the steps, not the delegated child task twice",
      );

      // The `kind` axis on a checklist row is the PHASE (whose list it is),
      // which is why it cannot be the delegation discriminator. Driven through
      // the route so the response contract is asserted, not just the column.
      const assigneeTurn = await dispatchWorkflowTurn({ boot, world, taskId: task.id });
      const asImplementation = await assigneeTurn.post("add_subtask", {
        subtaskText: "C7 extra implementation step",
        subtaskKind: "implementation",
      });
      c.assertEqual(asImplementation.status, 200, "the assignee may add an implementation checklist item");
      c.assertEqual(
        asImplementation.body.subtaskKind,
        "implementation",
        "…and the route echoes the phase it stored",
      );

      const reviewTurn = await dispatchWorkflowTurn({
        boot,
        world: leadWorld,
        taskId: task.id,
        reason: "action_plan_review_requested",
        body: "Add your review topics.",
      });
      const asReview = await reviewTurn.post("add_subtask", {
        subtaskText: "C7 reviewer topic to address",
        subtaskKind: "review",
      });
      c.assertEqual(asReview.status, 200, "the resolved reviewer may add a review checklist item");
      c.assertEqual(
        asReview.body.subtaskKind,
        "review",
        "the other member of the phase axis is the reviewer's list",
      );

      // FINDING (same gap, seen from the other side): there is no
      // "delegatable" checklist kind to ask for. normalizeSubTaskKind
      // (lib/tasks/subtasks.ts:33) coerces anything that is not "review" to
      // "implementation", so a request for one is silently accepted as a
      // plain progress item. That is CORRECT under Epic item 5 — delegation is
      // a child Task, not a checklist kind — but it is silent, so it is pinned
      // here rather than left to be discovered.
      c.assertEqual(
        SUBTASK_KINDS.join(","),
        "implementation,review",
        "the checklist kind axis is phase-only: there is no delegatable member",
      );
      c.assertEqual(
        normalizeSubTaskKind("delegatable"),
        "implementation",
        "FINDING: an unknown subtaskKind is silently coerced to implementation rather than rejected",
      );
      const coerced = await assigneeTurn.post("add_subtask", {
        subtaskText: "C7 step requested as delegatable",
        subtaskKind: "delegatable",
      });
      c.assertEqual(coerced.status, 200, "the route accepts the unknown kind");
      c.assertEqual(
        coerced.body.subtaskKind,
        "implementation",
        "FINDING: …and reports it back as a progress item, never creating a delegatable subtask",
      );
      c.assertEqual(
        (await childTasksOf(task.id)).length,
        2,
        "no delegatable subtask appeared from a checklist add — the two paths stay separate",
      );

      const finalCounts = {
        implementation: await db.subTask.count({
          where: { taskId: task.id, kind: "implementation" },
        }),
        review: await db.subTask.count({ where: { taskId: task.id, kind: "review" } }),
      };
      c.assertEqual(finalCounts.implementation, 5, "three plan steps plus two added progress items");
      c.assertEqual(finalCounts.review, 1, "the reviewer's list is counted separately");
    }

    report.ok();
  } finally {
    await sandbox.dispose();
  }
}

main().catch((error: unknown) => {
  console.error(`[${SUITE}] unexpected failure:`, error);
  process.exit(1);
});
