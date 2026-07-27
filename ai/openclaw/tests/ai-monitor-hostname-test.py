#!/usr/bin/env python3

import importlib.machinery
import importlib.util
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "bin" / "ai-monitor"


def load_monitor_module():
    loader = importlib.machinery.SourceFileLoader(
        "ai_monitor_under_test", str(SCRIPT)
    )
    spec = importlib.util.spec_from_file_location(
        "ai_monitor_under_test", SCRIPT, loader=loader
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AiMonitorHostnameTest(unittest.TestCase):
    def test_gather_probes_uses_runtime_hostname(self):
        monitor = load_monitor_module()
        config = {
            "resources": {"thresholds": {}},
            "watch": {"system_units": []},
        }

        empty_probe = mock.Mock(return_value={})
        with (
            mock.patch.object(
                monitor,
                "load_registry",
                return_value=({"agents": []}, {"ok": True}),
            ),
            mock.patch.object(
                monitor, "expand_watch_from_registry", return_value=([], [])
            ),
            mock.patch.object(monitor, "probe_integrity_check", empty_probe),
            mock.patch.object(monitor, "probe_journal_integrity", empty_probe),
            mock.patch.object(monitor, "probe_ollama", empty_probe),
            mock.patch.object(monitor, "probe_resources", empty_probe),
            mock.patch.object(monitor, "probe_gateway_memory", empty_probe),
            mock.patch.object(monitor, "probe_previous_shutdown", empty_probe),
            mock.patch.object(monitor, "probe_stalled_tasks", empty_probe),
            mock.patch.object(monitor, "probe_agent_queue", empty_probe),
            mock.patch.object(monitor, "probe_pending_email_tasks", empty_probe),
            mock.patch.object(monitor, "probe_pending_mentions", empty_probe),
            mock.patch.object(monitor, "probe_pm_workflow", empty_probe),
            mock.patch.object(monitor, "probe_agent_symlinks", empty_probe),
            mock.patch.object(
                monitor.socket, "gethostname", return_value="thinkpad-test"
            ),
        ):
            probes = monitor.gather_probes(config)

        self.assertEqual(probes["host"], "thinkpad-test")

    def test_telegram_messages_use_runtime_hostname(self):
        monitor = load_monitor_module()
        issue = {
            "severity": "warn",
            "unit": "example.service",
            "kind": "failed",
            "reason": "test",
            "suggested_action": "inspect",
        }

        with mock.patch.object(
            monitor.socket,
            "gethostname",
            return_value="thinkpad-test",
        ):
            alert = monitor.format_alerts_message([issue])
            resolved = monitor.format_resolved_message([issue])

        self.assertTrue(alert.startswith("🟡 thinkpad-test — 1 issue"))
        self.assertTrue(resolved.startswith("✅ thinkpad-test — 1 resolved"))
        self.assertNotIn("x1", alert)
        self.assertNotIn("x1", resolved)


if __name__ == "__main__":
    unittest.main()
