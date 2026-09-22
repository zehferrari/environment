#!/usr/bin/env python3
import importlib.machinery
import importlib.util
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "bin" / "ai-monitor"

FIX = "as barekbaal: `claude auth login`, then `openclaw models auth login --provider anthropic --method cli --force`"
FAILING_LINE = (
    "[FAIL] barekbaal: model-auth anthropic: login failing: 24 authentication failure(s) in the last 15min "
    f"(cli terminal failure: provider=claude-cli). Fix: {FIX}"
)
RENEWAL_LINE = (
    "[WARN] barekbaal: model-auth anthropic: Claude CLI refresh token expires in 6.0d "
    f"(2026-10-15T20:38:59+00:00) and cannot renew itself. Fix before then: {FIX}"
)


def load_monitor():
    loader = importlib.machinery.SourceFileLoader("ai_monitor_model_auth_under_test", str(SCRIPT))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def cfg():
    return {
        "notify": {"dedupe": {"resolved_after_runs": 2}},
        "monitor_triage": {"enabled": True, "model_auth_renotify_s": 3600},
    }


class ModelAuthRoutingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.monitor = load_monitor()

    def test_model_auth_lines_bypass_the_llm_judge(self):
        journal = "\n".join([
            "[INFO] openclaw integrity check started at 2026-09-22T01:00:00+00:00",
            "[OK] barekbaal: model-auth ollama: usable runtime auth",
            FAILING_LINE,
            RENEWAL_LINE,
            "[FAIL] carmen: service openclaw-gateway.service is not active (failed)",
            "[SUMMARY] ok=1 warn=1 fail=2",
        ])
        probe_cfg = {"integrity": {"journal_tag": "openclaw-integrity", "journal_window": "-5min"}}
        with mock.patch.object(self.monitor, "run_cmd", return_value=(0, journal, "")):
            probe = self.monitor.probe_integrity_check(probe_cfg)
        self.assertEqual(probe["model_auth_lines"], [FAILING_LINE, RENEWAL_LINE])
        self.assertEqual(probe["fail_lines"], ["[FAIL] carmen: service openclaw-gateway.service is not active (failed)"])
        self.assertEqual(probe["warn_lines"], [])
        compact = self.monitor.build_compact_input({"integrity_check": probe})
        self.assertNotIn("model-auth", str(compact))

    def test_one_issue_per_login_with_failure_winning(self):
        issues = self.monitor.model_auth_issues([RENEWAL_LINE, FAILING_LINE])
        self.assertEqual(len(issues), 1)
        issue = issues[0]
        self.assertEqual(issue["unit"], "barekbaal/model-auth:anthropic")
        self.assertEqual(issue["kind"], "model-auth-failing")
        self.assertEqual(issue["severity"], "crit")
        self.assertIn("`claude auth login`", issue["reason"])

        renewal = self.monitor.model_auth_issues([RENEWAL_LINE])[0]
        self.assertEqual((renewal["kind"], renewal["severity"]), ("model-auth-renewal-due", "warn"))

    def test_deterministic_issues_include_model_auth(self):
        issues = self.monitor.deterministic_issues({
            "integrity_check": {"exit_code": 0, "model_auth_lines": [FAILING_LINE]},
            "registry": {"ok": True, "agents_seen": 1},
            "ollama_probe": {"ok": True},
        })
        self.assertIn("barekbaal/model-auth:anthropic", [i["unit"] for i in issues])

    def run_ticks(self, verdicts, clock_values, telegram=None):
        state = {"events": {}}
        clock = [0]
        sends = []

        def send(_cfg, text, registry=None):
            sends.append(text)
            return telegram or {"ok": True}

        with mock.patch.object(self.monitor, "send_telegram", side_effect=send), mock.patch.object(
            self.monitor.time, "time", side_effect=lambda: clock[0]
        ), mock.patch.object(self.monitor, "hand_off_to_monitor") as handoff:
            for verdict, now in zip(verdicts, clock_values):
                clock[0] = now
                self.monitor.dedupe_and_act(cfg(), verdict, state, registry={"agents": []})
        handoff.assert_not_called()
        return state, sends

    def test_human_is_paged_once_with_the_fix_and_eviction_is_silent(self):
        issue = self.monitor.model_auth_issues([FAILING_LINE])[0]
        present = {"issues": [issue]}
        cleared = {"issues": []}
        state, sends = self.run_ticks(
            [present, present, cleared, cleared, present],
            [1000, 1120, 1240, 1360, 1480],
        )
        # One page for the episode; no "resolved" message when the failure
        # lines age out; the recurrence inside the renotify window is quiet.
        self.assertEqual(len(sends), 1, sends)
        self.assertIn("model login needs you", sends[0])
        self.assertIn("barekbaal/model-auth:anthropic", sends[0])
        self.assertIn("`claude auth login`", sends[0])
        self.assertEqual(state["model_auth_notified"], {"barekbaal/model-auth:anthropic": 1000})

    def test_recurrence_after_the_renotify_window_pages_again(self):
        issue = self.monitor.model_auth_issues([FAILING_LINE])[0]
        present = {"issues": [issue]}
        cleared = {"issues": []}
        _state, sends = self.run_ticks(
            [present, cleared, cleared, present],
            [1000, 1120, 1240, 1000 + 3600 + 1],
        )
        self.assertEqual(len(sends), 2, sends)

    def test_monitor_login_issue_does_not_make_the_tick_a_self_incident(self):
        karen_login = self.monitor.model_auth_issues([
            "[FAIL] karen: model-auth ollama: login failing: 1 authentication failure(s). "
            "Fix: as karen: `openclaw models auth login --provider ollama`"
        ])[0]
        other = {
            "unit": "asdrubal/openclaw-gateway.service",
            "kind": "user-unit-not-active",
            "severity": "crit",
            "reason": "inactive",
            "suggested_action": "investigate",
        }
        registry = {"agents": [{"user": "karen", "role": "monitor", "enabled": True}]}
        sends = []
        with mock.patch.object(
            self.monitor, "send_telegram", side_effect=lambda _c, text, registry=None: sends.append(text) or {"ok": True}
        ), mock.patch.object(self.monitor.time, "time", return_value=1000), mock.patch.object(
            self.monitor, "hand_off_to_monitor", return_value={"ok": True}
        ) as handoff:
            self.monitor.dedupe_and_act(cfg(), {"issues": [karen_login, other]}, {"events": {}}, registry=registry)
        # (The monitor path may also send its own post-handoff alert; only the
        # login page is under test here.)
        login_pages = [text for text in sends if "model login needs you" in text]
        self.assertEqual(len(login_pages), 1)
        self.assertIn("karen/model-auth:ollama", login_pages[0])
        self.assertFalse(any("model-auth" in text for text in sends if text not in login_pages))
        handoff.assert_called_once()
        self.assertIn("asdrubal/openclaw-gateway.service", str(handoff.call_args))
        self.assertNotIn("model-auth", str(handoff.call_args))

    def test_failed_telegram_is_retried_next_tick(self):
        issue = self.monitor.model_auth_issues([FAILING_LINE])[0]
        present = {"issues": [issue]}
        state, sends = self.run_ticks([present, present], [1000, 1120], telegram={"ok": False})
        self.assertEqual(len(sends), 2)
        self.assertEqual(state.get("model_auth_notified"), {})


if __name__ == "__main__":
    unittest.main()
