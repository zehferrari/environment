#!/usr/bin/env python3

import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import tarfile
import tempfile
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "bin" / "openclaw-backup"


def load_backup_module():
    spec = importlib.util.spec_from_file_location(
        "openclaw_backup_under_test",
        SCRIPT,
        loader=importlib.machinery.SourceFileLoader(
            "openclaw_backup_under_test", str(SCRIPT)
        ),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OpenClawBackupTest(unittest.TestCase):
    def setUp(self):
        self.module = load_backup_module()
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.source = self.root / "state"
        self.dest = self.root / "backups"
        self.source.mkdir()
        (self.source / "session.jsonl").write_text("durable\n", encoding="utf-8")
        (self.source / "session.jsonl.lock").write_text(
            "ephemeral\n", encoding="utf-8"
        )

        registry = self.root / "agents.json"
        registry.write_text(json.dumps({"agents": []}), encoding="utf-8")
        self.module.REGISTRY = registry
        self.module.STATIC_PATHS = [str(self.source)]
        # TemporaryDirectory lives below /tmp, which the production exclude
        # set intentionally omits. Keep this focused fixture on lock handling.
        self.module.EXCLUDES = ["*.lock"]

    def tearDown(self):
        self.tempdir.cleanup()

    def run_main(self):
        argv = [str(SCRIPT), "--dest", str(self.dest)]
        with mock.patch.object(sys, "argv", argv), redirect_stdout(io.StringIO()):
            return self.module.main()

    def test_excludes_runtime_locks_and_publishes_complete_archive(self):
        self.assertEqual(self.run_main(), 0)

        archives = list(self.dest.glob("openclaw-state-*.tar.gz"))
        self.assertEqual(len(archives), 1)
        self.assertEqual(len(list(self.dest.glob("*.part-*"))), 0)

        with tarfile.open(archives[0], "r:gz") as archive:
            names = archive.getnames()
        self.assertTrue(any(name.endswith("/state/session.jsonl") for name in names))
        self.assertFalse(any(name.endswith(".lock") for name in names))
        self.assertEqual(len(list(self.dest.glob("*.manifest.json"))), 1)

    def test_removes_partial_archive_when_tar_fails(self):
        def fail_after_creating_partial(command, **_kwargs):
            output = Path(command[command.index("--file") + 1])
            output.write_bytes(b"partial")
            return types.SimpleNamespace(
                returncode=1, stdout="", stderr="simulated tar failure"
            )

        with mock.patch.object(
            self.module.subprocess, "run", side_effect=fail_after_creating_partial
        ), redirect_stderr(io.StringIO()):
            self.assertEqual(self.run_main(), 1)

        self.assertEqual(list(self.dest.glob("openclaw-state-*.tar.gz")), [])
        self.assertEqual(list(self.dest.glob("*.part-*")), [])
        self.assertEqual(list(self.dest.glob("*.manifest.json")), [])

    def test_inventory_failure_publishes_neither_archive_nor_manifest(self):
        with mock.patch.object(
            self.module,
            "inventory",
            side_effect=OSError("simulated inventory race"),
        ):
            with self.assertRaisesRegex(OSError, "simulated inventory race"):
                self.run_main()

        self.assertEqual(list(self.dest.glob("openclaw-state-*.tar.gz")), [])
        self.assertEqual(list(self.dest.glob("*.manifest.json")), [])
        self.assertEqual(list(self.dest.glob("*.part-*")), [])

    def test_archive_publish_failure_removes_published_manifest(self):
        real_replace = os.replace

        def fail_archive_publish(source, destination):
            if str(destination).endswith(".tar.gz"):
                raise OSError("simulated archive rename failure")
            return real_replace(source, destination)

        with mock.patch.object(
            self.module.os,
            "replace",
            side_effect=fail_archive_publish,
        ):
            with self.assertRaisesRegex(
                OSError,
                "simulated archive rename failure",
            ):
                self.run_main()

        self.assertEqual(list(self.dest.glob("openclaw-state-*.tar.gz")), [])
        self.assertEqual(list(self.dest.glob("*.manifest.json")), [])
        self.assertEqual(list(self.dest.glob("*.part-*")), [])

    def test_prune_removes_matching_manifest(self):
        self.dest.mkdir()
        old_archive = self.dest / "openclaw-state-20260101-000000.tar.gz"
        old_manifest = self.dest / "openclaw-state-20260101-000000.manifest.json"
        new_archive = self.dest / "openclaw-state-20260102-000000.tar.gz"
        new_manifest = self.dest / "openclaw-state-20260102-000000.manifest.json"
        for path in (old_archive, old_manifest, new_archive, new_manifest):
            path.touch()
        os.utime(old_archive, (1, 1))
        os.utime(new_archive, (2, 2))

        self.module.KEEP = 1
        self.module.prune_old(self.dest)

        self.assertFalse(old_archive.exists())
        self.assertFalse(old_manifest.exists())
        self.assertTrue(new_archive.exists())
        self.assertTrue(new_manifest.exists())


if __name__ == "__main__":
    unittest.main()
