#!/usr/bin/env python3

import configparser
import json
import re
import unittest
from pathlib import Path


OPENCLAW_ROOT = Path(__file__).resolve().parents[1]
SERVICE = OPENCLAW_ROOT / "systemd" / "ai-monitor.service"
TIMER = OPENCLAW_ROOT / "systemd" / "ai-monitor.timer"
CONFIG = OPENCLAW_ROOT / "config" / "ai-monitor.config.json.example"


def read_unit(path):
    parser = configparser.ConfigParser(interpolation=None)
    parser.optionxform = str
    parser.read(path)
    return parser


def seconds(value):
    match = re.fullmatch(r"(\d+)(s|min|h)", value)
    if not match:
        raise ValueError(f"unsupported systemd duration in test: {value}")
    count = int(match.group(1))
    return count * {"s": 1, "min": 60, "h": 3600}[match.group(2)]


class AiMonitorSystemdBudgetTest(unittest.TestCase):
    def test_outer_timeout_exceeds_monitor_decision_budget(self):
        config = json.loads(CONFIG.read_text(encoding="utf-8"))
        decision_timeout = int(config["monitor_triage"]["timeout_s"])
        ai_timeout = int(config["ai"]["timeout_s"])
        model_count = 1 + len(config["ai"].get("fallback_models", []))
        service = read_unit(SERVICE)
        outer_timeout = seconds(service["Service"]["TimeoutStartSec"])

        # Every model in the fallback chain can consume its configured timeout.
        # Leave another minute for bounded probes, the monitor wake, and result
        # handling on either side of those waits.
        self.assertGreaterEqual(
            outer_timeout,
            decision_timeout + (ai_timeout * model_count) + 60,
        )

    def test_timer_waits_from_completion_not_start(self):
        timer = read_unit(TIMER)["Timer"]
        self.assertEqual(timer["OnUnitInactiveSec"], "2min")
        self.assertNotIn("OnUnitActiveSec", timer)


if __name__ == "__main__":
    unittest.main()
