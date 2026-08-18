#!/usr/bin/env python3
import importlib.machinery
import importlib.util
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "bin" / "openclaw-integrity-check"
LOADER = importlib.machinery.SourceFileLoader("openclaw_integrity_check", str(SCRIPT))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
MODULE = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(MODULE)


def model_status(default, fallbacks=None, providers=None, missing=None):
    return {
        "configPath": "/tmp/openclaw.json",
        "defaultModel": default,
        "fallbacks": fallbacks or [],
        "auth": {
            "missingProvidersInUse": missing or [],
            "oauth": {"providers": providers or []},
        },
    }


class ModelAuthTest(unittest.TestCase):
    def capture(self, status, home, native_status=None):
        events = []

        def fake_run(argv, timeout=20, cwd=None, env=None):
            if "models" in argv and "status" in argv:
                # Reproduce the plugin notice OpenClaw may prepend to JSON.
                body = 'notice {"plugins":{"allow":[]}}\n' + json.dumps(status)
                return 0, body, ""
            if argv[-2:] == ["auth", "status"]:
                return 0, json.dumps(native_status or {"loggedIn": False}), ""
            raise AssertionError(argv)

        with patch.object(MODULE, "run", side_effect=fake_run), patch.object(
            MODULE, "emit", side_effect=lambda level, message: events.append((level, message))
        ):
            MODULE.check_model_auth("agent", str(home))
        return events

    def test_renewable_native_claude_auth_overrides_short_access_expiry(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            claude = home / ".local" / "bin" / "claude"
            claude.parent.mkdir(parents=True)
            claude.touch()
            credentials = home / ".claude" / ".credentials.json"
            credentials.parent.mkdir(parents=True)
            credentials.write_text(json.dumps({
                "claudeAiOauth": {
                    "refreshToken": "present-but-never-logged",
                    "refreshTokenExpiresAt": int((time.time() + 20 * 86400) * 1000),
                }
            }))
            status = model_status(
                "claude-cli/claude-opus-5",
                providers=[{"provider": "claude-cli", "status": "expired"}],
            )
            events = self.capture(status, home, {"loggedIn": True})
            self.assertTrue(any(level == "OK" and "renewable" in message for level, message in events))
            self.assertFalse(any(level == "FAIL" for level, _message in events))

    def test_logged_out_native_claude_is_a_failure(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            claude = home / ".local" / "bin" / "claude"
            claude.parent.mkdir(parents=True)
            claude.touch()
            status = model_status("claude-cli/claude-opus-5")
            events = self.capture(status, home, {"loggedIn": False})
            self.assertTrue(any(level == "FAIL" and "Claude CLI login" in message for level, message in events))

    def test_refresh_token_warns_before_expiry(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            claude = home / ".local" / "bin" / "claude"
            claude.parent.mkdir(parents=True)
            claude.touch()
            credentials = home / ".claude" / ".credentials.json"
            credentials.parent.mkdir(parents=True)
            credentials.write_text(json.dumps({
                "claudeAiOauth": {
                    "refreshToken": "present-but-never-logged",
                    "refreshTokenExpiresAt": int((time.time() + 6 * 86400) * 1000),
                }
            }))
            events = self.capture(
                model_status("claude-cli/claude-opus-5"),
                home,
                {"loggedIn": True},
            )
            self.assertTrue(any(level == "WARN" and "expires in" in message for level, message in events))

    def test_expired_active_oauth_fails_but_inactive_profile_is_ignored(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            active = model_status(
                "openai/gpt-5.6-sol",
                providers=[{"provider": "openai", "status": "expired", "expiresAt": 1}],
            )
            active_events = self.capture(active, home)
            self.assertTrue(any(level == "FAIL" and "openai" in message for level, message in active_events))

            inactive = model_status(
                "ollama/kimi-k2.6:cloud",
                providers=[
                    {"provider": "ollama", "status": "static"},
                    {"provider": "openai", "status": "expired", "expiresAt": 1},
                ],
            )
            inactive_events = self.capture(inactive, home)
            self.assertFalse(any(level == "FAIL" for level, _message in inactive_events))


if __name__ == "__main__":
    unittest.main()
