#!/usr/bin/env python3

import importlib.machinery
import importlib.util
import json
import sqlite3
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
        }
        calls = []

        def ready(*_args):
            calls.append("ready")
            return {"ready": True}

        def nudge(*_args):
            calls.append("nudge")
            return [{
                "task_id": "task-1",
                "kind": "pm-channel-no-start",
                "parsed": {"messageId": "message-1"},
                "err": "",
            }]

        with (
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


if __name__ == "__main__":
    unittest.main()
