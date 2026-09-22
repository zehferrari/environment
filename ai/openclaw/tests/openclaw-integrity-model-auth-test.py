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

CODEX_USER_HOME = {"plugins": {"entries": {"codex": {"config": {"appServer": {"homeScope": "user"}}}}}}

# Real gateway lines (2026-09-07/16, barekbaal), identifiers trimmed.
CLAUDE_FALLBACK_LINE = (
    "2026-09-16T10:32:12.119+10:00 [model-fallback/decision] model fallback decision: "
    "decision=candidate_failed requested=anthropic/claude-fable-5-1 candidate=anthropic/claude-opus-5 "
    "reason=auth next=anthropic/claude-opus-4-8 detail=Failed to authenticate"
)
CLAUDE_CLI_LINE = (
    "2026-09-16T10:32:13.504+10:00 [agent/cli-backend] cli terminal failure: provider=claude-cli "
    "model=claude-opus-4-8 durationMs=1376 error=Failed to authenticate: OAuth session expired"
)
OPENAI_REFRESH_LINE = (
    "2026-09-07T16:08:13.000+10:00 [memory] sync failed (watch): Error: OAuth token refresh failed "
    "for openai: OpenAI Codex token refresh failed (401): {"
)
AUTH_UNKNOWN_NOISE = (
    "2026-09-22T11:43:44.300+10:00 [agent/cli-backend] cli session history refused across auth "
    "boundary: reason=auth-unknown"
)


def model_status(default, fallbacks=None, providers=None, missing=None, routes=None):
    return {
        "configPath": "/tmp/openclaw.json",
        "defaultModel": default,
        "fallbacks": fallbacks or [],
        "auth": {
            "storePath": "~/.openclaw/state/openclaw.sqlite",
            "missingProvidersInUse": missing or [],
            "runtimeAuthRoutes": routes or [],
            "oauth": {"providers": providers or []},
        },
    }


def write_claude(home, refresh_in_days):
    claude = home / ".local" / "bin" / "claude"
    claude.parent.mkdir(parents=True)
    claude.touch()
    credentials = home / ".claude" / ".credentials.json"
    credentials.parent.mkdir(parents=True)
    credentials.write_text(json.dumps({
        "claudeAiOauth": {
            "refreshToken": "present-but-never-logged",
            "refreshTokenExpiresAt": int((time.time() + refresh_in_days * 86400) * 1000),
        }
    }))


class ModelAuthTest(unittest.TestCase):
    def capture(self, status, home, native_status=None, openclaw_cfg=None, journal="", store=None):
        events = []
        calls = []

        def fake_run(argv, timeout=20, cwd=None, env=None):
            calls.append(argv)
            if "models" in argv and "status" in argv:
                # Reproduce the plugin notice OpenClaw may prepend to JSON.
                body = 'notice {"plugins":{"allow":[]}}\n' + json.dumps(status)
                return 0, body, ""
            if argv[-2:] == ["auth", "status"]:
                return 0, json.dumps(native_status or {"loggedIn": False}), ""
            if argv[:2] == ["su", "-"] and "journalctl" in argv[-1]:
                return 0, journal, ""
            if MODULE.OPENCLAW_AUTH_STORE_PROBE in argv:
                return 0, json.dumps(store if store is not None else {"profiles": {}}), ""
            raise AssertionError(argv)

        with patch.object(MODULE, "run", side_effect=fake_run), patch.object(
            MODULE, "emit", side_effect=lambda level, message: events.append((level, message))
        ):
            MODULE.check_model_auth("agent", str(home), openclaw_cfg)
        self.calls = calls
        return events

    def fails(self, events):
        return [message for level, message in events if level == "FAIL"]

    def test_renewable_native_claude_auth_overrides_short_access_expiry(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            write_claude(home, 20)
            status = model_status(
                "claude-cli/claude-opus-5",
                providers=[{"provider": "claude-cli", "status": "expired"}],
            )
            events = self.capture(status, home, {"loggedIn": True})
            self.assertTrue(any(level == "OK" and "renewable" in message for level, message in events))
            self.assertEqual(self.fails(events), [])

    def test_anthropic_on_claude_cli_runtime_gets_the_native_renewal_check(self):
        # After the 2026.9 migration the chain names `anthropic/*` models that
        # run on claude-cli; the renewal check previously never ran for them.
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            write_claude(home, 6)
            status = model_status(
                "anthropic/claude-fable-5-1",
                routes=[{"provider": "anthropic", "runtime": "claude-cli"}],
            )
            events = self.capture(status, home, {"loggedIn": True})
            warns = [message for level, message in events if level == "WARN"]
            self.assertEqual(len(warns), 1)
            self.assertIn("agent: model-auth anthropic: Claude CLI refresh token expires in", warns[0])
            self.assertIn("`claude auth login`", warns[0])

    def test_logged_out_native_claude_is_a_failure(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            claude = home / ".local" / "bin" / "claude"
            claude.parent.mkdir(parents=True)
            claude.touch()
            status = model_status("claude-cli/claude-opus-5")
            events = self.capture(status, home, {"loggedIn": False})
            self.assertTrue(any("Claude CLI login" in message and "Fix:" in message for message in self.fails(events)))

    def test_refresh_token_warns_before_expiry(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            write_claude(home, 6)
            events = self.capture(
                model_status("claude-cli/claude-opus-5"),
                home,
                {"loggedIn": True},
            )
            self.assertTrue(any(level == "WARN" and "expires in" in message for level, message in events))

    def test_expired_openclaw_oauth_with_refresh_token_is_renewable(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            status = model_status(
                "openai/gpt-5.6-sol",
                providers=[{"provider": "openai", "status": "expired", "expiresAt": 1}],
            )
            store = {"profiles": {"openai:me": {"provider": "openai", "type": "oauth", "renewable": True}}}
            events = self.capture(status, home, store=store)
            self.assertEqual(self.fails(events), [])
            self.assertTrue(any(level == "OK" and "renews on next use" in message for level, message in events))
            probe = next(argv for argv in self.calls if MODULE.OPENCLAW_AUTH_STORE_PROBE in argv)
            self.assertEqual(probe[-1], f"{home}/.openclaw/state/openclaw.sqlite")

    def test_openclaw_oauth_without_refresh_token_fails_with_fix(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            status = model_status(
                "openai/gpt-5.6-sol",
                providers=[{"provider": "openai", "status": "expiring", "expiresAt": 1}],
            )
            store = {"profiles": {"openai:me": {"provider": "openai", "type": "oauth", "renewable": False}}}
            fails = self.fails(self.capture(status, home, store=store))
            self.assertEqual(len(fails), 1)
            self.assertIn("agent: model-auth openai: OpenClaw OAuth profile has no refresh token", fails[0])
            self.assertIn("`openclaw models auth login --provider openai`", fails[0])

    def test_inactive_expired_profile_is_ignored(self):
        with tempfile.TemporaryDirectory() as td:
            inactive = model_status(
                "ollama/kimi-k2.6:cloud",
                providers=[
                    {"provider": "ollama", "status": "static"},
                    {"provider": "openai", "status": "expired", "expiresAt": 1},
                ],
            )
            self.assertEqual(self.fails(self.capture(inactive, Path(td))), [])

    def test_codex_user_home_is_judged_by_the_codex_login_not_the_store_copy(self):
        with tempfile.TemporaryDirectory() as td:
            home = Path(td)
            (home / ".codex").mkdir()
            (home / ".codex" / "auth.json").write_text(json.dumps({
                "auth_mode": "chatgpt",
                "tokens": {"refresh_token": "present-but-never-logged"},
                "last_refresh": "2026-09-18T03:57:02Z",
            }))
            # The stored OpenClaw copy is expired, as on 2026-09-20; Codex does
            # not use it with homeScope=user, so it must not page.
            status = model_status(
                "openai/gpt-6-astra",
                providers=[{"provider": "openai", "status": "expired", "expiresAt": 1}],
                routes=[{"provider": "openai", "runtime": "codex"}],
            )
            events = self.capture(status, home, openclaw_cfg=CODEX_USER_HOME)
            self.assertEqual(self.fails(events), [])
            self.assertTrue(any("Codex CLI login is renewable" in message for _level, message in events))
            self.assertFalse(any(MODULE.OPENCLAW_AUTH_STORE_PROBE in argv for argv in self.calls))

    def test_codex_user_home_without_login_fails_with_device_login_fix(self):
        with tempfile.TemporaryDirectory() as td:
            status = model_status("openai/gpt-6-astra", missing=["openai"])
            fails = self.fails(self.capture(status, Path(td), openclaw_cfg=CODEX_USER_HOME))
            self.assertEqual(len(fails), 1)
            self.assertIn("model-auth openai: Codex CLI has no login", fails[0])
            self.assertIn("`codex login --device-auth`", fails[0])

    def test_observed_login_failures_are_reported_once_per_login(self):
        with tempfile.TemporaryDirectory() as td:
            status = model_status(
                "ollama/kimi-k2.6:cloud",
                routes=[{"provider": "anthropic", "runtime": "claude-cli"}],
            )
            journal = "\n".join([
                CLAUDE_FALLBACK_LINE, CLAUDE_CLI_LINE, OPENAI_REFRESH_LINE, AUTH_UNKNOWN_NOISE,
            ])
            fails = self.fails(self.capture(status, Path(td), journal=journal))
            self.assertEqual(len(fails), 2, fails)
            anthropic, openai = sorted(fails)
            self.assertIn("agent: model-auth anthropic: login failing: 2 authentication failure(s)", anthropic)
            self.assertIn("`claude auth login`", anthropic)
            self.assertIn("agent: model-auth openai: login failing: 1 authentication failure(s)", openai)
            self.assertIn("OAuth token refresh failed for openai", openai)
            self.assertIn("`openclaw models auth login --provider openai`", openai)

    def test_auth_boundary_noise_is_not_a_login_failure(self):
        with tempfile.TemporaryDirectory() as td:
            events = self.capture(model_status("ollama/kimi-k2.6:cloud"), Path(td), journal=AUTH_UNKNOWN_NOISE)
            self.assertEqual(self.fails(events), [])
            self.assertTrue(any("no model login failures" in message for _level, message in events))

    def test_codex_refresh_failure_line_maps_to_openai(self):
        with tempfile.TemporaryDirectory() as td:
            journal = (
                "Your access token could not be refreshed because your refresh token was already used. "
                "Please log out and sign in again."
            )
            fails = self.fails(self.capture(
                model_status("ollama/kimi-k2.6:cloud"), Path(td), openclaw_cfg=CODEX_USER_HOME, journal=journal,
            ))
            self.assertEqual(len(fails), 1)
            self.assertIn("model-auth openai: login failing", fails[0])
            self.assertIn("`codex login --device-auth`", fails[0])


if __name__ == "__main__":
    unittest.main()
