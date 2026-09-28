#!/usr/bin/env python3
"""Exercise branch-only preview inventory and preparation in isolated Git repos."""
import os
from pathlib import Path
import runpy
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch


DEPLOY = Path(__file__).resolve().parents[1] / "deploy"


class PreviewTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="worktree-preview-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / "repo"
        self.wt = self.root / "repo.worktrees"
        self.wt.mkdir()
        self.git("init", "-b", "main", str(self.repo), cwd=self.root)
        self.git("config", "user.name", "Preview Test")
        self.git("config", "user.email", "preview@example.invalid")
        (self.repo / ".gitignore").write_text(".env\nnode_modules/\ndist/\n")
        self.git("add", ".gitignore")
        self.git("commit", "-m", "fixture")
        self.git("checkout", "--detach")
        self.git("worktree", "add", str(self.wt / "main"), "main")
        (self.wt / "main" / ".env").write_text("PREVIEW_FIXTURE=1\n")
        for branch in ("sept-2026", "feature/epic", "off", "occupied", "linked"):
            self.git("branch", branch)
        self.git("worktree", "add", str(self.wt / "linked"), "linked")
        (self.wt / "occupied").mkdir()
        env = {
            "WT_ENV_FILE": str(self.root / "missing.env"), "WT_KEY": "test",
            "REPO": str(self.repo), "WORKTREES_ROOT": str(self.wt),
            "DRIVER": "node-service", "APP_SUBDIR": "",
        }
        with patch.dict(os.environ, env):
            self.runner = runpy.run_path(str(DEPLOY / "worktree-switch-runner"))
        self.inventory = self.runner["worktrees"]

    def git(self, *args, cwd=None):
        return subprocess.run(["git", "-C", str(cwd or self.repo), *args],
                              capture_output=True, text=True, check=True).stdout.strip()

    def test_inventory_and_routing(self):
        entries = self.inventory(str(self.wt / "main"))
        virtual = {w["branch"]: w for w in entries if w.get("needsWorktree")}
        self.assertEqual(set(virtual), {"sept-2026", "feature/epic", "off"})
        self.assertEqual(virtual["feature/epic"]["name"], "feature_epic")
        self.assertEqual(virtual["off"]["name"], "preview-off")
        self.assertTrue(virtual["sept-2026"]["canPrepare"])
        self.assertFalse(virtual["sept-2026"]["ready"])
        main = next(w for w in entries if w["branch"] == "main")
        self.assertTrue(main["served"])
        self.assertTrue(main["canPrepare"])
        # Inventories are read-only: no checkout until the user selects it.
        self.assertFalse((self.wt / "sept-2026").exists())
        action = self.runner["run_action"]
        with patch.dict(action.__globals__, {"write_state": lambda _: None}), \
                patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, "", "")) as run:
            # Keep real inventory available while intercepting just dispatch.
            with patch.dict(action.__globals__, {"worktrees": lambda _: entries}):
                result = action({"id": "test", "target": "sept-2026", "branch": "untrusted"})
            self.assertEqual(result["state"], "done")
            self.assertEqual(run.call_args.args[0][-2:], [str(self.wt / "sept-2026"), "sept-2026"])
        rejected = self.runner["run_remove"]({"id": "remove", "target": "sept-2026"})
        self.assertEqual(rejected["state"], "error")

    def switch(self, target, branch="", fail_install=False):
        config = self.root / "config"
        config.mkdir(exist_ok=True)
        lock = self.root / "operation.lock"
        lock.touch()
        values = {
            "REPO": str(self.repo), "WORKTREES_ROOT": str(self.wt),
            "DRIVER": "node-service", "WORKTREE_LOCK_FILE": str(lock),
            "DB_ENGINE": "none", "BUILD_CMD": "mkdir -p dist", "BUILD_OUTPUT_DIR": "dist",
        }
        (config / "test.env").write_text("".join(f"{k}={shlex.quote(v)}\n" for k, v in values.items()))
        # Redirect only the installed config location; run the actual shell logic.
        script = self.root / "switch.sh"
        script.write_text((DEPLOY / "worktree-switch.sh").read_text().replace(
            "ENV_DIR=/etc/worktree-preview", f"ENV_DIR={shlex.quote(str(config))}"))
        bin_dir = self.root / "bin"
        bin_dir.mkdir(exist_ok=True)
        for command, body in {
            "pnpm": 'printf "%s\\n" "$*" >> "$TEST_LOG"\n' + ("exit 7\n" if fail_install else "mkdir -p node_modules\n"),
            "sudo": 'printf "apply %s\\n" "$*" >> "$TEST_LOG"\n',
            "curl": "exit 0\n",
        }.items():
            executable = bin_dir / command
            executable.write_text("#!/bin/sh\n" + body)
            executable.chmod(0o755)
        return subprocess.run(["bash", str(script), "test", str(target), branch],
                              capture_output=True, text=True, env={**os.environ,
                              "PATH": f"{bin_dir}:{os.environ['PATH']}", "TEST_LOG": str(self.root / "calls")})

    def test_prepare_and_rebuild(self):
        target = self.wt / "sept-2026"
        result = self.switch(target, "sept-2026")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.git("branch", "--show-current", cwd=target), "sept-2026")
        self.assertTrue((target / ".env").is_symlink())
        self.assertEqual((target / ".env").resolve(), self.wt / "main" / ".env")
        self.assertTrue((target / "dist").is_dir())
        self.assertEqual(self.git("status", "--porcelain", cwd=target), "")
        calls = (self.root / "calls").read_text()
        self.assertIn("install --frozen-lockfile", calls)
        self.assertIn("apply ", calls)
        entry = next(w for w in self.inventory(str(target)) if w["branch"] == "sept-2026")
        self.assertTrue(entry["ready"])
        self.assertTrue(entry["served"])
        self.assertFalse(entry.get("needsWorktree", False))
        result = self.switch(target)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "calls").read_text().count("install --frozen-lockfile"), 1)

    def test_refuses_collision_mismatch_and_foreign_checkout(self):
        collision = self.switch(self.wt / "occupied", "occupied")
        self.assertNotEqual(collision.returncode, 0)
        self.assertIn("already exists", collision.stderr)
        mismatch = self.switch(self.root / "escape", "sept-2026")
        self.assertNotEqual(mismatch.returncode, 0)
        self.assertFalse((self.root / "escape").exists())
        foreign = self.wt / "foreign"
        self.git("init", str(foreign))
        self.assertNotEqual(self.switch(foreign).returncode, 0)
        self.assertFalse((self.root / "calls").exists())

    def test_failed_install_does_not_flip_site_and_can_retry(self):
        target = self.wt / "sept-2026"
        result = self.switch(target, "sept-2026", fail_install=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("apply ", (self.root / "calls").read_text())
        self.assertFalse((target / "dist").exists())
        result = self.switch(target)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
