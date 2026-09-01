#!/usr/bin/env python3

import json
import os
import pwd
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "bin" / "gmail-watch-renew-all"


class GmailWatchRenewAllTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        self.home = self.root / "agent home"
        self.google = self.home / ".openclaw/workspace/google"
        self.google.mkdir(parents=True)
        (self.google / "gmail-watch.js").write_text("// fixture\n")

        self.user = pwd.getpwuid(os.getuid()).pw_name
        self.registry = self.root / "agents.json"
        self.registry.write_text(json.dumps({
            "agents": [{
                "user": self.user,
                "home": str(self.home),
                "enabled": True,
                "integrations": {"gmail": True},
            }],
        }))

        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.argv_file = self.root / "node-argv.json"
        self.node = self.bin_dir / "node"
        self.node.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, sys\n"
            "from pathlib import Path\n"
            "Path(os.environ['ARGS_FILE']).write_text(json.dumps({\n"
            "  'home': os.environ.get('HOME'), 'argv': sys.argv[1:]\n"
            "}))\n"
        )
        self.node.chmod(0o755)

        sudo = self.bin_dir / "sudo"
        sudo.write_text(
            "#!/bin/sh\n"
            "test \"$1\" = -n && shift\n"
            "test \"$1\" = -u && shift 2\n"
            "exec \"$@\"\n"
        )
        sudo.chmod(0o755)

        logger = self.bin_dir / "logger"
        logger.write_text("#!/bin/sh\nexit 0\n")
        logger.chmod(0o755)

    def run_helper(self):
        env = os.environ.copy()
        env.update({
            "OPENCLAW_AGENTS_JSON": str(self.registry),
            "GMAIL_WATCH_NODE_BIN": str(self.node),
            "ARGS_FILE": str(self.argv_file),
            "PATH": f"{self.bin_dir}:{env['PATH']}",
        })
        return subprocess.run(
            [str(SCRIPT)],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_executes_as_owner_with_literal_topic_and_label_arguments(self):
        state = {
            "topicName": "projects/example/topics/gmail-inbox-watch",
            "labelIds": ["INBOX", "Label With Space", "Label_3"],
            "expiration": "123456789",
        }
        (self.google / "watch-state.json").write_text(json.dumps(state))

        result = self.run_helper()

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        invocation = json.loads(self.argv_file.read_text())
        self.assertEqual(invocation["home"], str(self.home))
        self.assertEqual(invocation["argv"], [
            str(self.google / "gmail-watch.js"),
            "projects/example/topics/gmail-inbox-watch",
            "INBOX",
            "Label With Space",
            "Label_3",
        ])
        self.assertNotIn("bash -lc", result.stdout)

    def test_missing_watch_state_is_a_setup_failure(self):
        result = self.run_helper()

        self.assertEqual(result.returncode, 1)
        self.assertIn("missing", result.stdout)
        self.assertFalse(self.argv_file.exists())


if __name__ == "__main__":
    unittest.main()
