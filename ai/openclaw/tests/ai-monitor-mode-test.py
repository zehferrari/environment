#!/usr/bin/env python3

import importlib.machinery
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "bin" / "ai-monitor"


def load_monitor():
    loader = importlib.machinery.SourceFileLoader("ai_monitor_mode_under_test", str(SCRIPT))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class AiMonitorModeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.monitor = load_monitor()

    def test_defaults_active_when_mode_file_is_absent(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(
            os.environ,
            {"AI_MONITOR_MODE_PATH": str(Path(tmp) / "missing.json")},
            clear=False,
        ):
            os.environ.pop("AI_MONITOR_MODE", None)
            self.assertEqual(self.monitor.operating_mode(), "active")

    def test_persistent_observe_only_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            mode_file = Path(tmp) / "mode.json"
            mode_file.write_text(json.dumps({"mode": "observe-only"}))
            with mock.patch.dict(
                os.environ,
                {"AI_MONITOR_MODE_PATH": str(mode_file)},
                clear=False,
            ):
                os.environ.pop("AI_MONITOR_MODE", None)
                self.assertEqual(self.monitor.operating_mode(), "observe-only")

    def test_cli_observe_only_wins(self):
        with mock.patch.dict(os.environ, {"AI_MONITOR_MODE": "active"}, clear=False):
            self.assertEqual(self.monitor.operating_mode(True), "observe-only")

    def test_observe_only_bypasses_action_dispatch_and_state_advance(self):
        source = SCRIPT.read_text()
        self.assertIn('if mode == "observe-only":', source)
        self.assertIn('"type": "observe_only"', source)
        self.assertIn('if mode == "active":\n            save_state(state)', source)


if __name__ == "__main__":
    unittest.main()
