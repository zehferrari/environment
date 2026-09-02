#!/usr/bin/env python3

import json
import os
import pwd
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "bin" / "openclaw-doc-sync"


class OpenClawConfigSyncTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        self.user = pwd.getpwuid(os.getuid()).pw_name
        self.home = self.root / "home"
        self.runtime_dir = self.home / ".openclaw"
        self.runtime_dir.mkdir(parents=True)
        self.agent_root = self.root / "agents"
        self.canonical_dir = self.agent_root / self.user
        self.canonical_dir.mkdir(parents=True)
        self.canonical = self.canonical_dir / "openclaw.json"
        self.runtime = self.runtime_dir / "openclaw.json"
        self.registry = self.root / "agents.json"
        self.registry.write_text(json.dumps({
            "agents": [{
                "user": self.user,
                "role": "coding",
                "home": str(self.home),
                "enabled": True,
            }],
        }))

    def run_sync(self):
        env = os.environ.copy()
        env.update({
            "OPENCLAW_AGENTS_JSON": str(self.registry),
            "OPENCLAW_AGENT_FILES_ROOT": str(self.agent_root),
        })
        return subprocess.run(
            ["bash", str(SCRIPT), "--config-only", self.user],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_replaces_legacy_symlink_with_regular_managed_copy(self):
        payload = '{"gateway":{"port":18789}}\n'
        self.canonical.write_text(payload)
        self.runtime.symlink_to(self.canonical)

        result = self.run_sync()

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.runtime.is_symlink())
        self.assertTrue(self.runtime.is_file())
        self.assertEqual(self.runtime.read_text(), payload)
        self.assertEqual(stat.S_IMODE(self.runtime.stat().st_mode), 0o600)

    def test_repairs_runtime_content_drift(self):
        self.canonical.write_text('{"models":{"source":"pm"}}\n')
        self.runtime.write_text('{"models":{"source":"local"}}\n')

        result = self.run_sync()

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.runtime.read_bytes(), self.canonical.read_bytes())

    def test_invalid_canonical_json_never_overwrites_runtime(self):
        self.canonical.write_text("{invalid\n")
        self.runtime.write_text('{"known":"good"}\n')

        result = self.run_sync()

        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.runtime.read_text(), '{"known":"good"}\n')


if __name__ == "__main__":
    unittest.main()
