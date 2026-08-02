#!/usr/bin/env python3

import importlib.machinery
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "bin" / "ai-monitor"
GIB = 1024 ** 3


def load_monitor_module():
    loader = importlib.machinery.SourceFileLoader(
        "ai_monitor_safeguards_under_test", str(SCRIPT)
    )
    spec = importlib.util.spec_from_file_location(
        "ai_monitor_safeguards_under_test", SCRIPT, loader=loader
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def registry():
    return {
        "agents": [
            {
                "user": "karen",
                "uid": 1003,
                "enabled": True,
                "services": ["openclaw-gateway.service"],
            },
            {
                "user": "disabled",
                "uid": 1004,
                "enabled": False,
                "services": ["openclaw-gateway.service"],
            },
            {
                "user": "no-gateway",
                "uid": 1005,
                "enabled": True,
                "services": ["other.service"],
            },
        ]
    }


class GatewayMemoryProbeTest(unittest.TestCase):
    def setUp(self):
        self.monitor = load_monitor_module()

    def probe(
        self,
        current_bytes,
        memory_high=8 * GIB,
        memory_max=10 * GIB,
        config=None,
    ):
        output = (
            "ActiveState=active\n"
            f"MemoryCurrent={current_bytes}\n"
            f"MemoryPeak={current_bytes + 1024}\n"
            f"MemoryHigh={memory_high}\n"
            f"MemoryMax={memory_max}\n"
            "ControlGroup=/user.slice/test\n"
            "MainPID=42\n"
        )
        with mock.patch.object(
            self.monitor, "run_cmd", return_value=(0, output, "")
        ) as run:
            result = self.monitor.probe_gateway_memory(config or {}, registry())
        self.assertEqual(run.call_count, 1)
        return result

    def test_thresholds_follow_gateway_memory_policy(self):
        result = self.probe(8 * GIB)
        state = result["agents"]["karen"]
        self.assertEqual(state["state"], "warn")
        self.assertEqual(state["source"], "systemd")
        self.assertEqual(state["warn_bytes"], 8 * GIB)
        self.assertEqual(state["critical_bytes"], 10 * GIB)

        issues = self.monitor.deterministic_issues({
            "gateway_memory": result,
            "integrity_check": {"exit_code": 0},
            "registry": {"ok": True, "agents_seen": 1},
            "ollama_probe": {"ok": True},
        })
        issue = next(i for i in issues if i["kind"] == "gateway-memory-high")
        self.assertEqual(issue["severity"], "warn")
        self.assertIn("8.00 GiB", issue["reason"])

    def test_ten_gib_is_critical_for_current_host_policy(self):
        result = self.probe(10 * GIB)
        self.assertEqual(result["agents"]["karen"]["state"], "critical")

        issues = self.monitor.deterministic_issues({
            "gateway_memory": result,
            "integrity_check": {"exit_code": 0},
            "registry": {"ok": True, "agents_seen": 1},
            "ollama_probe": {"ok": True},
        })
        issue = next(i for i in issues if i["kind"] == "gateway-memory-high")
        self.assertEqual(issue["severity"], "crit")
        self.assertIn("10.00 GiB", issue["reason"])

    def test_memory_below_high_water_mark_is_ok(self):
        result = self.probe(7 * GIB)
        self.assertEqual(result["agents"]["karen"]["state"], "ok")

    def test_thresholds_adapt_to_a_different_gateway_policy(self):
        result = self.probe(
            6 * GIB,
            memory_high=5 * GIB,
            memory_max=6 * GIB,
        )
        state = result["agents"]["karen"]
        self.assertEqual(state["state"], "critical")
        self.assertEqual(state["warn_bytes"], 5 * GIB)
        self.assertEqual(state["critical_bytes"], 6 * GIB)

    def test_explicit_config_overrides_gateway_policy(self):
        result = self.probe(
            4 * GIB,
            config={
                "gateway_memory_check": {
                    "warn_mib": 3072,
                    "critical_mib": 4096,
                }
            },
        )
        state = result["agents"]["karen"]
        self.assertEqual(state["state"], "critical")
        self.assertEqual(state["warn_bytes"], 3 * GIB)
        self.assertEqual(state["critical_bytes"], 4 * GIB)

    def test_active_gateway_without_accounting_is_reported(self):
        output = (
            "ActiveState=active\n"
            "MemoryCurrent=[not set]\n"
            "MemoryPeak=[not set]\n"
            "MemoryHigh=8589934592\n"
            "MemoryMax=10737418240\n"
            "ControlGroup=\n"
            "MainPID=0\n"
        )
        with (
            mock.patch.object(
                self.monitor, "run_cmd", return_value=(0, output, "")
            ),
            mock.patch.object(
                self.monitor, "_read_cgroup_memory", return_value=None
            ),
            mock.patch.object(
                self.monitor, "_read_process_rss", return_value=None
            ),
        ):
            result = self.monitor.probe_gateway_memory({}, registry())

        issues = self.monitor.deterministic_issues({
            "gateway_memory": result,
            "integrity_check": {"exit_code": 0},
            "registry": {"ok": True, "agents_seen": 1},
            "ollama_probe": {"ok": True},
        })
        self.assertTrue(any(
            i["kind"] == "gateway-memory-unavailable" for i in issues
        ))


class PreviousShutdownProbeTest(unittest.TestCase):
    def setUp(self):
        self.monitor = load_monitor_module()
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.config = {
            "previous_shutdown_check": {
                "enabled": True,
                "pstore_path": self.tempdir.name,
            }
        }

    def test_explicit_journal_recovery_evidence_reports_unclean_shutdown(self):
        line = (
            "Journal file /var/log/journal/system.journal was not closed "
            "properly, rotating."
        )
        with (
            mock.patch.object(
                self.monitor, "_current_boot_epoch", return_value=100
            ),
            mock.patch.object(
                self.monitor,
                "run_cmd",
                side_effect=[(0, line, ""), (1, "", "")],
            ) as run,
        ):
            result = self.monitor.probe_previous_shutdown(self.config)

        self.assertEqual(result["status"], "unsafe-evidence")
        self.assertEqual(
            result["evidence"][0]["source"], "boot-journal:systemd-journald"
        )
        self.assertEqual(run.call_count, 2)
        for call in run.call_args_list:
            argv = call.args[0]
            self.assertIn("--until", argv)
            self.assertEqual(argv[argv.index("--until") + 1], "@1000")
        issues = self.monitor.deterministic_issues({
            "previous_shutdown": result,
            "integrity_check": {"exit_code": 0},
            "registry": {"ok": True, "agents_seen": 1},
            "ollama_probe": {"ok": True},
        })
        issue = next(
            i for i in issues if i["kind"] == "previous-shutdown-unclean"
        )
        self.assertEqual(issue["severity"], "warn")
        self.assertIn("not closed properly", issue["reason"])

    def test_missing_clean_marker_alone_does_not_alert(self):
        with (
            mock.patch.object(
                self.monitor, "_current_boot_epoch", return_value=100
            ),
            mock.patch.object(
                self.monitor, "run_cmd", return_value=(1, "", "")
            ),
        ):
            result = self.monitor.probe_previous_shutdown(self.config)

        self.assertEqual(result["status"], "no-unsafe-evidence")
        issues = self.monitor.deterministic_issues({
            "previous_shutdown": result,
            "integrity_check": {"exit_code": 0},
            "registry": {"ok": True, "agents_seen": 1},
            "ollama_probe": {"ok": True},
        })
        self.assertFalse(any(
            i["kind"] == "previous-shutdown-unclean" for i in issues
        ))

    def test_pstore_crash_record_is_affirmative_evidence(self):
        Path(self.tempdir.name, "dmesg-ramoops-0").write_text("panic")
        with (
            mock.patch.object(
                self.monitor, "_current_boot_epoch", return_value=100
            ),
            mock.patch.object(
                self.monitor, "run_cmd", return_value=(1, "", "")
            ),
        ):
            result = self.monitor.probe_previous_shutdown(self.config)

        self.assertEqual(result["status"], "unsafe-evidence")
        self.assertEqual(result["evidence"][0]["source"], "pstore")


if __name__ == "__main__":
    unittest.main()
