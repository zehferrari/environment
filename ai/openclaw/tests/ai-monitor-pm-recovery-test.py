#!/usr/bin/env python3

import importlib.machinery
import importlib.util
import json
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parent.parent / "bin" / "ai-monitor"


def load_monitor_module():
    loader = importlib.machinery.SourceFileLoader(
        "ai_monitor_pm_recovery_under_test", str(SCRIPT)
    )
    spec = importlib.util.spec_from_file_location(
        "ai_monitor_pm_recovery_under_test", SCRIPT, loader=loader
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def registry():
    return {
        "agents": [
            {
                "user": "asdrubal",
                "enabled": True,
                "listeners": [
                    {
                        "host": "127.0.0.1",
                        "port": 18789,
                        "owner": "openclaw-gateway",
                        "expected": True,
                    }
                ],
            }
        ]
    }


class Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps({"ready": True, "failing": []}).encode()


class PmRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.monitor = load_monitor_module()

    def test_permission_recovery_excludes_consumed_and_stale_grants(self):
        with sqlite3.connect(":memory:") as conn:
            conn.row_factory = sqlite3.Row
            conn.executescript("""
                CREATE TABLE Task(id TEXT, approved_on INTEGER);
                CREATE TABLE Comment(id TEXT, taskId TEXT, createdAt INTEGER, deletedAt INTEGER);
                CREATE TABLE ActivityLog(taskId TEXT, kind TEXT, payload TEXT);
                INSERT INTO Task VALUES ('t', 1000000);
                INSERT INTO Comment VALUES ('grant','t',2000000,NULL);
            """)
            grant = {"authorizationCommentId": "grant"}
            self.assertIsNone(self.monitor._pm_permission_grant_wait(conn, 't', grant))
            conn.execute("INSERT INTO ActivityLog VALUES ('t','task.repository.checkpoint.requested',?)", (json.dumps(grant),))
            self.assertEqual(self.monitor._pm_permission_grant_wait(conn, 't', grant), "checkpoint_attempt_pending_settlement")
            conn.execute("DELETE FROM ActivityLog")
            conn.execute("UPDATE Task SET approved_on=3000000")
            self.assertEqual(self.monitor._pm_permission_grant_wait(conn, 't', grant), "permission_no_longer_valid")
            self.assertEqual(self.monitor._pm_permission_grant_wait(conn, 't', None), "external_dependency")

    def test_recorded_review_ownership_prevents_reviewer_recovery(self):
        with sqlite3.connect(":memory:") as conn:
            conn.row_factory = sqlite3.Row
            conn.executescript("""
                CREATE TABLE Task(id TEXT, active_workflow_cycle_id TEXT);
                CREATE TABLE review_runs(task_id TEXT, workflow_cycle_id TEXT, status TEXT, created_at INTEGER);
                INSERT INTO Task VALUES ('t','cycle');
                INSERT INTO review_runs VALUES ('t','cycle','accepted_pending_owner',1000);
            """)
            self.assertTrue(self.monitor._pm_review_has_recorded_acceptance(conn, 't'))
            conn.execute("UPDATE review_runs SET status='accepted'")
            self.assertTrue(self.monitor._pm_review_has_recorded_acceptance(conn, 't'))
            conn.execute("UPDATE Task SET active_workflow_cycle_id='new-cycle'")
            self.assertFalse(self.monitor._pm_review_has_recorded_acceptance(conn, 't'))

    def test_exhausted_pm_recovery_does_not_rearm_on_elapsed_time(self):
        issue = {"unit": "pm:asdrubal/task-1", "kind": "pm-in-progress-stale", "severity": "warn", "reason": "No new durable progress"}
        key = self.monitor.event_key(issue)
        state = {"events": {key: {"issue": issue, "alert_sent": False, "attempts": 3,
            "attempt_history": [], "next_attempt_after": 0, "missed_runs": 0}}}
        cfg = {"notify": {"dedupe": {"resolved_after_runs": 3}}, "monitor_triage": {
            "enabled": True, "escalation_ladder": {"max_attempts": 3, "confirmation_window_s": 1}}}
        with mock.patch.object(self.monitor, "send_telegram", return_value={"ok": True}) as send:
            self.monitor.dedupe_and_act(cfg, {"issues": [issue]}, state, registry=registry())
            self.assertTrue(state["events"][key]["alert_sent"])
            self.assertEqual(state["events"][key]["attempts"], 4)
            with mock.patch.object(self.monitor.time, "time", return_value=time.time() + 86400):
                self.monitor.dedupe_and_act(cfg, {"issues": [issue]}, state, registry=registry())
            self.assertEqual(send.call_count, 1)
            self.assertEqual(state["events"][key]["attempts"], 4)

    def test_accepted_plan_recovery_matches_approval_authority(self):
        with sqlite3.connect(":memory:") as conn:
            conn.row_factory = sqlite3.Row
            conn.executescript("""
                CREATE TABLE Project(id TEXT, only_reporters_can_approve_action_plans INTEGER);
                CREATE TABLE Epic(id TEXT, status TEXT, approved_on INTEGER, actingManagerId TEXT);
                CREATE TABLE Task(id TEXT, projectId TEXT, epicId TEXT, assigneeId TEXT, reporterId TEXT);
                CREATE TABLE ActionPlan(taskId TEXT, status TEXT, reviewedAt INTEGER, reviewedById TEXT,
                    delegatedApproverId TEXT, delegatedById TEXT);
                INSERT INTO Project VALUES ('p', 1);
                INSERT INTO Epic VALUES ('e', 'In Progress', 123, 'manager');
                INSERT INTO Task VALUES ('t', 'p', 'e', 'worker', 'owner');
                INSERT INTO ActionPlan VALUES ('t', 'draft', 456, 'manager', NULL, NULL);
            """)
            state = lambda: self.monitor._pm_plan_review_approval_state(conn, 't', 'manager')
            self.assertIs(state(), True)
            conn.execute("UPDATE Epic SET approved_on=NULL")
            self.assertIs(state(), False)
            conn.execute("UPDATE Epic SET approved_on=123, status='Done'")
            self.assertIs(state(), False)
            conn.execute("UPDATE Epic SET status='In Progress'")
            conn.execute("UPDATE Task SET assigneeId='manager'")
            self.assertIs(state(), False)
            conn.execute("UPDATE Task SET assigneeId='worker', epicId=NULL")
            self.assertIs(state(), False)
            conn.execute("UPDATE ActionPlan SET delegatedById='owner', delegatedApproverId='manager'")
            self.assertIs(state(), True)
            conn.execute("UPDATE ActionPlan SET reviewedAt=NULL")
            self.assertIsNone(state())
        with sqlite3.connect(":memory:") as older_schema:
            self.assertIsNone(self.monitor._pm_plan_review_approval_state(older_schema, 't', 'manager'))

    def test_only_formal_blockers_skip_stale_assignee_recovery(self):
        source = SCRIPT.read_text()
        blocker_guard = 'blocker["kind"] != "task.blocker.cleared"'
        stale_add = '"pm-in-progress-stale"'
        self.assertIn(blocker_guard, source)
        self.assertIn("pm-blocker-response-awaiting-assignee", source)
        self.assertIn("_pm_latest_blocker_activity", source)
        self.assertNotIn('if row["alertReporter"]:', source)
        self.assertLess(
            source.index(blocker_guard),
            source.index(stale_add, source.index(blocker_guard)),
        )

    def test_monitor_never_creates_shadow_agent_ownership(self):
        source = SCRIPT.read_text()
        self.assertNotIn("_pm_latest_agent_dependency_activity", source)
        self.assertNotIn("pm-agent-dependency-stale", source)
        self.assertNotIn("delegate_dependency", source)
        self.assertNotIn(
            "move the task to Review with one concise note if it is complete or waiting",
            source,
        )

    def test_accepted_pm_turn_gets_execution_grace_before_recovery(self):
        source = SCRIPT.read_text()
        self.assertIn('channel_accepted_warn_minutes", 30', source)
        accepted_guard = 'run_status in ("accepted", "admitted")'
        stalled_kind = '"pm-channel-stalled"'
        self.assertIn(accepted_guard, source)
        self.assertLess(
            source.index(accepted_guard),
            source.index(stalled_kind, source.index(accepted_guard)),
        )

    def test_monitor_recovery_never_stacks_behind_a_live_turn(self):
        source = SCRIPT.read_text()
        self.assertIn("_pm_has_live_channel_run", source)
        self.assertIn("status IN ('queued', 'accepted', 'admitted', 'streaming', 'retryable', 'waiting_capacity')", source)
        self.assertIn('not kind.startswith("pm-channel-")', source)

    def test_completed_status_suppresses_historical_orphan_recovery(self):
        source = SCRIPT.read_text()
        self.assertIn(
            "rr.status IN ('streaming', 'complete', 'completed')",
            source,
        )
        self.assertTrue(self.monitor._pm_channel_run_confirmed({
            "ok": True,
            "status": "completed",
        }))
        self.assertIn("AND m.deletedAt IS NULL", source)
        self.assertIn("AND (r.id IS NOT NULL OR m.createdAt >= ?)", source)

    def test_unknown_human_message_is_current_only_for_current_workflow_owner(self):
        row = {
            "body": "An old human-authored comment with no workflow status marker",
            "status": "Review",
            "messageAgentSlug": "asdrubal",
            "reviewerAgentSlug": "karen",
            "reviewerUsername": "karen",
            "epicManagerAgentSlug": None,
            "epicManagerUsername": None,
            "epicStatus": "Review",
            "reporterUsername": "zeh",
        }
        self.assertFalse(self.monitor._pm_workflow_notification_is_current(row))
        row["messageAgentSlug"] = "karen"
        self.assertTrue(self.monitor._pm_workflow_notification_is_current(row))

    def test_channel_nudge_carries_the_incident_message_identity(self):
        bucket = {
            "pm_tasks": [{
                "task_id": "task-1",
                "kind": "pm-channel-no-start",
                "message_id": "message-1",
                "reason": "Required action: retry the exact turn",
            }]
        }
        with mock.patch.object(
            self.monitor,
            "run_cmd",
            return_value=(0, '{"ok":true,"skipped":true}', ""),
        ) as run_cmd:
            self.monitor._run_pm_workflow_nudges("asdrubal", bucket)
        argv = run_cmd.call_args.args[0]
        self.assertIn("--message-id", argv)
        self.assertEqual(argv[argv.index("--message-id") + 1], "message-1")

    def test_deterministic_channel_issue_preserves_message_identity(self):
        issues = self.monitor.deterministic_issues({
            "pm_workflow": {
                "items": [{
                    "kind": "pm-channel-no-start",
                    "agent": "asdrubal",
                    "task_id": "task-1",
                    "task_title": "Historical task",
                    "project": "environment",
                    "status": "Review",
                    "epic_status": "Review",
                    "age_s": 999,
                    "required_action": "retry exact turn",
                    "message_id": "message-1",
                    "run_status": "failed",
                }],
                "errors": [],
            },
            "integrity_check": {"exit_code": 0},
            "registry": {"ok": True, "agents_seen": 1},
            "ollama_probe": {"ok": True},
        })
        issue = next(i for i in issues if i["kind"] == "pm-channel-no-start")
        self.assertEqual(issue["message_id"], "message-1")
        self.assertEqual(issue["run_status"], "failed")

    def test_ai_history_cannot_resurrect_cleared_pm_incidents(self):
        verdict = self.monitor.make_verdict([], {
            "_model": "test-model",
            "summary": "old PM failures are still critical",
            "issues": [{
                "unit": "asdrubal/old-task",
                "kind": "pm-channel-no-start",
                "severity": "crit",
                "reason": "copied from previously_open",
            }],
        })
        self.assertTrue(verdict["healthy"])
        self.assertEqual(verdict["issues"], [])
        self.assertEqual(verdict["summary"], "all signals nominal")

    def test_deterministic_pm_incident_remains_authoritative(self):
        current = {
            "unit": "pm:asdrubal/current-task",
            "kind": "pm-in-progress-stale",
            "severity": "warn",
            "reason": "current structured probe evidence",
        }
        verdict = self.monitor.make_verdict([current], {
            "_model": "test-model",
            "summary": "invented old PM summary",
            "issues": [{
                "unit": "asdrubal/old-task",
                "kind": "pm-channel-no-start",
                "severity": "crit",
                "reason": "copied from previously_open",
            }],
        })
        self.assertFalse(verdict["healthy"])
        self.assertEqual(verdict["issues"], [current])
        self.assertNotIn("invented", verdict["summary"])

    def comment_conn(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.executescript(
            """
            CREATE TABLE Agent (
                id TEXT PRIMARY KEY,
                slug TEXT,
                role TEXT
            );
            CREATE TABLE User (
                id TEXT PRIMARY KEY,
                username TEXT,
                kind TEXT,
                agentId TEXT
            );
            CREATE TABLE Comment (
                id TEXT PRIMARY KEY,
                taskId TEXT,
                userId TEXT,
                body TEXT,
                createdAt INTEGER,
                deletedAt INTEGER
            );
            INSERT INTO Agent VALUES
                ('agent-carmen', 'carmen', 'coding'),
                ('agent-karen', 'karen', 'monitor');
            INSERT INTO User VALUES
                ('user-carmen', 'carmen', 'agent', 'agent-carmen'),
                ('user-karen', 'karen', 'agent', 'agent-karen'),
                ('user-zeh', 'zeh', 'human', NULL);
            """
        )
        return conn

    def action_plan_conn(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.executescript(
            """
            CREATE TABLE ActionPlanRevision (
                id TEXT PRIMARY KEY,
                taskId TEXT,
                authorId TEXT,
                createdAt INTEGER
            );
            CREATE TABLE AgentChatMessage (
                id TEXT PRIMARY KEY,
                taskId TEXT,
                senderUserId TEXT,
                originChannel TEXT,
                createdAt INTEGER,
                deletedAt INTEGER
            );
            """
        )
        return conn

    def test_action_plan_probe_requires_a_structured_revision(self):
        conn = self.action_plan_conn()
        self.addCleanup(conn.close)
        conn.execute(
            "INSERT INTO AgentChatMessage VALUES (?, ?, ?, 'chat', ?, NULL)",
            ("chat-plan", "task-1", "worker-1", 2000),
        )
        self.assertFalse(
            self.monitor._pm_has_action_plan_since(
                conn, "task-1", "worker-1", 1000
            )
        )
        conn.execute(
            "INSERT INTO ActionPlanRevision VALUES (?, ?, ?, ?)",
            ("plan-v1", "task-1", "worker-1", 2100),
        )
        self.assertTrue(
            self.monitor._pm_has_action_plan_since(
                conn, "task-1", "worker-1", 1000
            )
        )
        self.assertEqual(
            self.monitor._pm_latest_action_plan_revision_s(
                conn, "task-1", "worker-1", 1000
            ),
            2100,
        )

    def test_reviewer_feedback_suppresses_re_review_of_unchanged_plan(self):
        conn = self.action_plan_conn()
        self.addCleanup(conn.close)
        conn.execute(
            "INSERT INTO ActionPlanRevision VALUES (?, ?, ?, ?)",
            ("plan-v1", "task-1", "worker-1", 2000000),
        )
        plan_s = self.monitor._pm_latest_action_plan_revision_s(
            conn, "task-1", "worker-1", 0
        )
        self.assertFalse(
            self.monitor._pm_has_action_plan_feedback_since(
                conn, "task-1", "manager-1", plan_s
            )
        )
        conn.execute(
            "INSERT INTO AgentChatMessage VALUES (?, ?, ?, 'chat', ?, NULL)",
            ("feedback-v1", "task-1", "manager-1", 2100000),
        )
        self.assertTrue(
            self.monitor._pm_has_action_plan_feedback_since(
                conn, "task-1", "manager-1", plan_s
            )
        )

    def recovery_db(self):
        directory = tempfile.TemporaryDirectory(prefix="ai-monitor-recovery-")
        self.addCleanup(directory.cleanup)
        db_path = Path(directory.name) / "pm.db"
        conn = sqlite3.connect(db_path)
        self.addCleanup(conn.close)
        conn.executescript("""
            CREATE TABLE PmChannelRun (id TEXT PRIMARY KEY, agentSlug TEXT, taskId TEXT,
                messageId TEXT, status TEXT, lastEventAt INTEGER, createdAt INTEGER);
            CREATE TABLE AgentExecutionLease (agentSlug TEXT, runId TEXT, status TEXT, expiresAt INTEGER);
            CREATE TABLE Project (id TEXT, deletedAt INTEGER);
            CREATE TABLE Agent (id TEXT, slug TEXT);
            CREATE TABLE User (id TEXT, username TEXT, agentId TEXT);
            CREATE TABLE Epic (id TEXT, status TEXT, actingManagerId TEXT);
            CREATE TABLE Task (id TEXT, projectId TEXT, assigneeId TEXT, actingManagerId TEXT,
                reporterId TEXT, epicId TEXT, status TEXT, deletedAt INTEGER, archived_at INTEGER);
            CREATE TABLE AgentChatMessage (id TEXT, taskId TEXT, body TEXT, deletedAt INTEGER);
            INSERT INTO Project VALUES ('project',NULL);
            INSERT INTO Agent VALUES ('agent','asdrubal');
            INSERT INTO User VALUES ('worker','asdrubal','agent');
            INSERT INTO User VALUES ('owner','zeh',NULL);
            INSERT INTO Task VALUES ('task-1','project','worker',NULL,'owner',NULL,'In Progress',NULL,NULL);
            INSERT INTO AgentChatMessage VALUES ('message-1','task-1','Resume authorized task',NULL);
        """)
        self.old_ms = int((time.time() - 4000) * 1000)
        conn.execute("INSERT INTO PmChannelRun VALUES (?,?,?,?,?,?,?)",
                     ('run-1','asdrubal','task-1','message-1','queued',self.old_ms,self.old_ms))
        conn.commit()
        cfg = {"pm_workflow": {"database_path": str(db_path)}}
        bucket = {"pm_tasks": [{"task_id": "task-1", "message_id": "message-1", "kind": "pm-channel-no-start"}]}
        return conn, cfg, bucket

    def test_recovery_rechecks_state_changed_after_probe_for_both_tiers(self):
        conn, cfg, bucket = self.recovery_db()
        issue = {"unit": "pm:asdrubal/task-1", **bucket["pm_tasks"][0]}
        for status in ('streaming', 'admitted', 'accepted', 'waiting_capacity', 'completed', 'superseded'):
            conn.execute("UPDATE PmChannelRun SET status=?,lastEventAt=?", (status, int(time.time()*1000)))
            conn.commit()
            for recovery in (self.monitor.auto_wake_stalled_agents, self.monitor.restart_and_wake_stalled_agents):
                with self.subTest(status=status, recovery=recovery.__name__), \
                     mock.patch.object(self.monitor, 'run_cmd') as command, \
                     mock.patch.object(self.monitor, '_run_pm_workflow_nudges') as nudge:
                    result = recovery([issue], cfg, registry())
                    self.assertEqual(result['asdrubal']['action'], 'pm-recovery-deferred')
                    command.assert_not_called()
                    nudge.assert_not_called()

    def test_other_task_execution_and_dispatch_lease_protect_gateway(self):
        conn, cfg, bucket = self.recovery_db()
        conn.execute("INSERT INTO PmChannelRun VALUES (?,?,?,?,?,?,?)",
                     ('other','asdrubal','task-2','other-message','streaming',self.old_ms,self.old_ms))
        conn.commit()
        self.assertFalse(self.monitor._pm_recovery_preflight(cfg,'asdrubal',bucket)['allowed'])
        conn.execute("UPDATE PmChannelRun SET status='accepted' WHERE id='other'")
        conn.commit()
        self.assertFalse(self.monitor._pm_recovery_preflight(cfg,'asdrubal',bucket)['allowed'])
        conn.execute("DELETE FROM PmChannelRun WHERE id='other'")
        conn.execute("INSERT INTO AgentExecutionLease VALUES (?,?,?,?)",
                     ('asdrubal','other','reserved',int((time.time()+120)*1000)))
        conn.commit()
        self.assertFalse(self.monitor._pm_recovery_preflight(cfg,'asdrubal',bucket)['allowed'])
        conn.execute("UPDATE AgentExecutionLease SET expiresAt=?", (self.old_ms,))
        conn.commit()
        self.assertTrue(self.monitor._pm_recovery_preflight(cfg,'asdrubal',bucket)['allowed'])

    def test_current_quiescent_failure_can_recover_but_newer_turn_or_owner_change_cannot(self):
        conn, cfg, bucket = self.recovery_db()
        conn.execute("UPDATE PmChannelRun SET status='failed'")
        conn.commit()
        self.assertTrue(self.monitor._pm_recovery_preflight(cfg,'asdrubal',bucket)['allowed'])
        conn.execute("INSERT INTO PmChannelRun VALUES (?,?,?,?,?,?,?)",
                     ('new','asdrubal','task-1','new-message','queued',self.old_ms+1,self.old_ms+1))
        conn.commit()
        self.assertFalse(self.monitor._pm_recovery_preflight(cfg,'asdrubal',bucket)['allowed'])
        conn.execute("DELETE FROM PmChannelRun WHERE id='new'")
        conn.execute("UPDATE Task SET status='Review'")
        conn.commit()
        result = self.monitor._pm_recovery_preflight(cfg,'asdrubal',bucket)
        self.assertFalse(result['allowed'])
        self.assertTrue(result['resolved'])

    def test_missing_database_and_missing_message_do_not_authorize_restart(self):
        conn, cfg, bucket = self.recovery_db()
        bucket['pm_tasks'][0].pop('message_id')
        self.assertFalse(self.monitor._pm_recovery_preflight(cfg,'asdrubal',bucket)['allowed'])
        cfg['pm_workflow']['database_path'] += '.missing'
        self.assertFalse(self.monitor._pm_recovery_preflight(cfg,'asdrubal',bucket)['allowed'])

    def test_deferral_does_not_advance_recovery_ladder(self):
        event = {'attempts': 1}
        issue = {'unit': 'pm:asdrubal/task-1', 'kind': 'pm-channel-no-start'}
        results = {'asdrubal': {'action': 'pm-recovery-deferred', 'preflight': {'reason': 'live execution'}}}
        self.assertTrue(self.monitor._record_pm_recovery_deferral(issue, results, event, 100, 60))
        self.assertEqual(event['attempts'], 1)
        self.assertEqual(event['next_attempt_after'], 160)
        self.assertEqual(event['attempt_history'][0]['action'], 'pm-recovery-deferred')

    def test_mixed_queue_incidents_cannot_bypass_live_execution_guard(self):
        conn, cfg, bucket = self.recovery_db()
        conn.execute("UPDATE PmChannelRun SET status='streaming'")
        conn.commit()
        issues = [
            {'unit': 'pm:asdrubal/task-1', **bucket['pm_tasks'][0]},
            {'unit': 'jira:asdrubal/TEST-1', 'kind': 'task-stalled-no-agent'},
        ]
        for recovery in (self.monitor.auto_wake_stalled_agents, self.monitor.restart_and_wake_stalled_agents):
            with mock.patch.object(self.monitor, 'run_cmd') as command:
                result = recovery(issues, cfg, registry())
                self.assertEqual(result['asdrubal']['action'], 'pm-recovery-deferred')
                command.assert_not_called()

    def test_admission_and_capacity_suppress_duplicate_workflow_nudges(self):
        conn, cfg, bucket = self.recovery_db()
        for status in ('admitted','waiting_capacity'):
            conn.execute("UPDATE PmChannelRun SET status=?", (status,))
            conn.commit()
            self.assertTrue(self.monitor._pm_has_live_channel_run(conn,'task-1','asdrubal'))
        self.assertTrue(self.monitor._pm_channel_run_confirmed({
            'ok': True, 'status': 'admitted', 'lastEventAt': int(time.time()*1000),
        }))
        self.assertFalse(self.monitor._pm_channel_run_confirmed({'ok':True,'status':'waiting_capacity'}))

    def test_gateway_readiness_uses_registered_readyz(self):
        with mock.patch.object(
            self.monitor.urllib.request,
            "urlopen",
            return_value=Response(),
        ) as urlopen:
            result = self.monitor._wait_for_gateway_ready(
                "asdrubal", registry(), {}
            )
        self.assertTrue(result["ready"])
        self.assertEqual(
            urlopen.call_args.args[0],
            "http://127.0.0.1:18789/readyz",
        )

    def test_restart_waits_for_ready_before_nudge(self):
        issue = {
            "unit": "pm:asdrubal/task-1",
            "kind": "pm-channel-no-start",
            "reason": "Required action: review it",
            "message_id": "failed-message-1",
        }
        calls = []

        def ready(*_args):
            calls.append("ready")
            return {"ready": True}

        def nudge(_user, bucket, _cfg=None):
            calls.append("nudge")
            self.assertEqual(
                bucket["pm_tasks"][0]["message_id"],
                "failed-message-1",
            )
            return [{
                "task_id": "task-1",
                "kind": "pm-channel-no-start",
                "parsed": {"messageId": "message-1"},
                "err": "",
            }]

        with (
            mock.patch.object(self.monitor, "_pm_recovery_preflight", return_value={"allowed": True}),
            mock.patch.object(
                self.monitor, "run_cmd", return_value=(0, "", "")
            ),
            mock.patch.object(
                self.monitor, "_wait_for_gateway_ready", side_effect=ready
            ),
            mock.patch.object(
                self.monitor, "_run_pm_workflow_nudges", side_effect=nudge
            ),
            mock.patch.object(
                self.monitor, "_confirm_pm_nudge_results", return_value=True
            ),
            mock.patch.object(
                self.monitor, "probe_session_idle_for_user",
                return_value=(0, {}),
            ),
            mock.patch.object(self.monitor.time, "sleep"),
        ):
            result = self.monitor.restart_and_wake_stalled_agents(
                [issue], {}, registry()
            )
        self.assertEqual(calls, ["ready", "nudge"])
        self.assertTrue(result["asdrubal"]["recovered"])

    def test_semantic_pm_recovery_never_restarts_agent_services(self):
        issue = {
            "unit": "pm:asdrubal/task-1",
            "kind": "pm-in-progress-stale",
            "reason": "Required action: continue implementation now",
        }
        calls = []

        def run_cmd(*_args, **_kwargs):
            calls.append("run_cmd")
            return 0, "", ""

        def nudge(*_args):
            calls.append("nudge")
            return [{
                "task_id": "task-1",
                "kind": "pm-in-progress-stale",
                "parsed": {"messageId": "message-1"},
                "err": "",
            }]

        with (
            mock.patch.object(self.monitor, "_pm_recovery_preflight", return_value={"allowed": True}),
            mock.patch.object(self.monitor, "run_cmd", side_effect=run_cmd),
            mock.patch.object(
                self.monitor, "_run_pm_workflow_nudges", side_effect=nudge
            ),
            mock.patch.object(
                self.monitor, "_confirm_pm_nudge_results", return_value=True
            ),
            mock.patch.object(
                self.monitor, "probe_session_idle_for_user",
                return_value=(0, {}),
            ),
            mock.patch.object(self.monitor.time, "sleep"),
        ):
            result = self.monitor.restart_and_wake_stalled_agents(
                [issue], {}, registry()
            )
        self.assertEqual(calls, ["nudge"])
        self.assertEqual(result["asdrubal"]["action"], "pm-channel-nudge")
        self.assertIsNone(result["asdrubal"]["restart_rc"])
        self.assertTrue(result["asdrubal"]["recovered"])

    def test_failed_pm_event_key_is_stable_and_retryable(self):
        issues = self.monitor.deterministic_issues({
            "pm_workflow": {
                "items": [{
                    "kind": "pm-channel-failed",
                    "agent": "asdrubal",
                    "task_id": "task-1",
                    "task_title": "Review me",
                    "project": "project",
                    "status": "Review",
                    "epic_status": "In Progress",
                    "age_s": 180,
                    "required_action": "retry",
                    "run_failed_at": 123456,
                }],
                "errors": [],
            },
            "integrity_check": {"exit_code": 0},
            "registry": {"ok": True, "agents_seen": 1},
            "ollama_probe": {"ok": True},
        })
        issue = next(i for i in issues if i["kind"] == "pm-channel-failed")
        self.assertEqual(issue["unit"], "pm:asdrubal/task-1")
        self.assertIn(
            "pm-channel-failed",
            self.monitor.PM_WORKFLOW_RETRY_KINDS,
        )

    def test_execution_recovery_key_survives_workflow_status_changes(self):
        common = {
            "unit": "pm:carmen/task-1",
            "severity": "warn",
        }
        todo_key = self.monitor.event_key({
            **common,
            "kind": "pm-todo-not-started",
        })
        in_progress_key = self.monitor.event_key({
            **common,
            "kind": "pm-in-progress-stale",
        })
        channel_key = self.monitor.event_key({
            **common,
            "kind": "pm-channel-failed",
        })
        self.assertEqual(todo_key, in_progress_key)
        self.assertEqual(todo_key, channel_key)
        self.assertNotEqual(
            todo_key,
            self.monitor.event_key({
                **common,
                "kind": "pm-review-awaiting-reviewer",
            }),
        )

    def test_review_response_ignores_monitor_comment(self):
        conn = self.comment_conn()
        self.addCleanup(conn.close)
        conn.execute(
            "INSERT INTO Comment VALUES (?, ?, ?, ?, ?, NULL)",
            ("comment-1", "task-1", "user-karen", "Verification passed", 2000),
        )
        response = self.monitor._pm_latest_comment_not_by(
            conn,
            "task-1",
            "user-carmen",
            1000,
            "carmen",
            "asdrubal",
        )
        self.assertIsNone(response)

    def test_review_response_ignores_reviewer_directed_comment(self):
        conn = self.comment_conn()
        self.addCleanup(conn.close)
        conn.executemany(
            "INSERT INTO Comment VALUES (?, ?, ?, ?, ?, NULL)",
            [
                (
                    "comment-general",
                    "task-1",
                    "user-zeh",
                    "Please clarify the regression result",
                    1900,
                ),
                (
                    "comment-reviewer",
                    "task-1",
                    "user-zeh",
                    "@Asdrubal please review this",
                    2000,
                ),
            ],
        )
        response = self.monitor._pm_latest_comment_not_by(
            conn,
            "task-1",
            "user-carmen",
            1000,
            "carmen",
            "asdrubal",
        )
        self.assertEqual(response["id"], "comment-general")

    def test_review_response_keeps_assignee_directed_comment(self):
        conn = self.comment_conn()
        self.addCleanup(conn.close)
        conn.execute(
            "INSERT INTO Comment VALUES (?, ?, ?, ?, ?, NULL)",
            (
                "comment-assignee",
                "task-1",
                "user-zeh",
                "@carmen please clarify; @asdrubal can then re-review",
                2000,
            ),
        )
        response = self.monitor._pm_latest_comment_not_by(
            conn,
            "task-1",
            "user-carmen",
            1000,
            "carmen",
            "asdrubal",
        )
        self.assertEqual(response["id"], "comment-assignee")

    def test_accepted_operational_finalization_is_not_review_feedback(self):
        self.assertTrue(
            self.monitor._pm_repository_finalization_owns_task({
                "repositoryPhase": "operational_error",
                "repositoryRepoTouched": 1,
                "repositoryBaseSha": "base",
                "repositoryCandidateSha": "candidate",
                "repositoryReviewedSha": "candidate",
            })
        )
        self.assertFalse(
            self.monitor._pm_repository_finalization_owns_task({
                "repositoryPhase": "operational_error",
                "repositoryRepoTouched": 1,
                "repositoryBaseSha": "base",
                "repositoryCandidateSha": "candidate",
                "repositoryReviewedSha": None,
            })
        )
        self.assertFalse(
            self.monitor._pm_repository_finalization_owns_task({
                "repositoryPhase": "review_ready",
                "repositoryRepoTouched": 1,
                "repositoryBaseSha": "base",
                "repositoryCandidateSha": "candidate",
                "repositoryReviewedSha": None,
            })
        )

    def test_closed_epic_review_targets_human_reporter(self):
        target = self.monitor._pm_closed_epic_human_target({
            "epicStatus": "Done",
            "status": "Review",
            "reporterKind": "human",
            "reporterUsername": "zeh",
            "ownerUsername": "owner",
        })
        self.assertEqual(target, "zeh")

    def test_closed_epic_never_targets_agent_reporter(self):
        target = self.monitor._pm_closed_epic_human_target({
            "epicStatus": "Done",
            "status": "In Progress",
            "reporterKind": "agent",
            "reporterUsername": "asdrubal",
            "ownerUsername": "zeh",
        })
        self.assertEqual(target, "zeh")

    def test_actionable_epic_needs_no_human_target(self):
        target = self.monitor._pm_closed_epic_human_target({
            "epicStatus": "In Progress",
            "status": "Review",
            "reporterKind": "human",
            "reporterUsername": "zeh",
            "ownerUsername": "zeh",
        })
        self.assertIsNone(target)

    def test_legacy_epic_review_needs_no_child_task_alert(self):
        target = self.monitor._pm_closed_epic_human_target({
            "epicStatus": "Review",
            "status": "Review",
            "reporterKind": "human",
            "reporterUsername": "zeh",
            "ownerUsername": "zeh",
        })
        self.assertIsNone(target)

    def test_closed_epic_children_collapse_to_one_issue(self):
        base = {
            "epicId": "epic-1",
            "epicTitle": "One Epic",
            "epicStatus": "Done",
            "epicStatusChangedAt": 1000,
            "reporterKind": "human",
            "reporterUsername": "zeh",
            "ownerUsername": "zeh",
            "projectSlug": "environment",
        }
        items = self.monitor._pm_closed_epic_items([
            {**base, "id": "task-1", "status": "Review"},
            {**base, "id": "task-2", "status": "In Progress"},
        ])
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["task_id"], "epic:epic-1")
        self.assertEqual(items[0]["child_count"], 2)
        self.assertEqual(items[0]["child_statuses"], ["In Progress", "Review"])

    def test_todo_epic_manager_is_current_review_owner(self):
        slugs = self.monitor._pm_current_workflow_slugs({
            "status": "Review",
            "reviewerAgentSlug": None,
            "reviewerUsername": None,
            "epicManagerAgentSlug": "barekbaal",
            "epicManagerUsername": "barekbaal",
            "epicStatus": "To Do",
            "reporterUsername": "zeh",
        })
        self.assertEqual(slugs, {"barekbaal"})

    def test_human_pm_alert_is_sent_only_once_until_state_changes(self):
        issue = {
            "unit": "pm:zeh/epic:epic-1",
            "kind": "pm-epic-not-open",
            "severity": "warn",
            "reason": "human action required",
            "suggested_action": "investigate",
        }
        verdict = {"issues": [issue]}
        state = {"events": {}}
        cfg = {
            "notify": {"dedupe": {"resolved_after_runs": 3}},
            "monitor_triage": {
                "enabled": True,
                "escalation_ladder": {
                    "confirmation_window_s": 1,
                    "max_attempts": 3,
                },
            },
            "pm_workflow": {"retry_after_tier3_seconds": 1},
        }
        with (
            mock.patch.object(self.monitor, "send_telegram", return_value={"ok": True}) as send,
            mock.patch.object(self.monitor.time, "time", side_effect=[1000, 1000, 2000, 2000]),
        ):
            self.monitor.dedupe_and_act(cfg, verdict, state, registry=registry())
            self.monitor.dedupe_and_act(cfg, verdict, state, registry=registry())
        self.assertEqual(send.call_count, 1)
        event = state["events"][self.monitor.event_key(issue)]
        self.assertTrue(event["alert_sent"])
        self.assertTrue(event["human_notification_final"])

    def test_backlog_probe_item_cannot_become_an_alert(self):
        issues = self.monitor.deterministic_issues({
            "pm_workflow": {
                "items": [{
                    "kind": "pm-action-plan-awaiting-approval",
                    "agent": "zeh",
                    "task_id": "task-backlog",
                    "task_title": "Deferred task",
                    "project": "project",
                    "status": "Backlog",
                    "epic_status": None,
                    "age_s": 600,
                    "required_action": "review",
                }],
                "errors": [],
            },
            "integrity_check": {"exit_code": 0},
            "registry": {"ok": True, "agents_seen": 1},
            "ollama_probe": {"ok": True},
        })
        self.assertFalse(any(i.get("unit") == "pm:zeh/task-backlog" for i in issues))

    def test_legacy_backlog_event_is_silently_evicted(self):
        issue = {
            "unit": "pm:zeh/task-backlog",
            "kind": "pm-action-plan-awaiting-approval",
            "severity": "warn",
            "reason": "project task task-backlog (Deferred task) is Backlog for 10 min; Epic=none.",
            "suggested_action": "investigate",
        }
        key = self.monitor.event_key(issue)
        state = {
            "events": {
                key: {
                    "alert_sent": True,
                    "issue": issue,
                    "missed_runs": 0,
                }
            }
        }
        cfg = {
            "notify": {"dedupe": {"resolved_after_runs": 3}},
            "monitor_triage": {"enabled": True},
        }
        with mock.patch.object(self.monitor, "send_telegram") as send:
            actions = self.monitor.dedupe_and_act(
                cfg,
                {"issues": []},
                state,
                registry=registry(),
            )
        self.assertEqual(actions, [])
        self.assertNotIn(key, state["events"])
        send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
