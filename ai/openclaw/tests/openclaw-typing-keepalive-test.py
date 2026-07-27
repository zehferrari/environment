#!/usr/bin/env python3

import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "bin/openclaw-typing-keepalive"
LOADER = importlib.machinery.SourceFileLoader(
    "openclaw_typing_keepalive", str(SCRIPT)
)
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
assert SPEC is not None
KEEPALIVE = importlib.util.module_from_spec(SPEC)
sys.modules[LOADER.name] = KEEPALIVE
LOADER.exec_module(KEEPALIVE)


def telegram_session(status: str = "running", provider: str = "claude-cli") -> dict:
    return {
        "agent:main:telegram:direct:12345": {
            "status": status,
            "modelProvider": provider,
        },
        "agent:main:main": {
            "status": "done",
            "modelProvider": "openai-codex",
        },
    }


class SessionFileCacheTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.path = Path(self.tempdir.name) / "sessions.json"

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def replace_json(self, value: object) -> None:
        replacement = self.path.with_suffix(".new")
        replacement.write_text(json.dumps(value))
        os.replace(replacement, self.path)

    def test_unchanged_file_is_parsed_only_once(self) -> None:
        self.replace_json(telegram_session())
        cache = KEEPALIVE.SessionFileCache()
        original_loads = json.loads

        with mock.patch.object(KEEPALIVE.json, "loads", wraps=original_loads) as loads:
            self.assertTrue(
                KEEPALIVE.refresh_session_cache(self.path, cache, now=1.0)
            )
            self.assertFalse(
                KEEPALIVE.refresh_session_cache(self.path, cache, now=2.0)
            )
            self.assertFalse(
                KEEPALIVE.refresh_session_cache(self.path, cache, now=3.0)
            )

        self.assertEqual(loads.call_count, 1)
        self.assertEqual(
            cache.active_chats,
            (("12345", "agent:main:telegram:direct:12345"),),
        )

    def test_changed_file_is_reparsed_and_stops_typing(self) -> None:
        self.replace_json(telegram_session())
        cache = KEEPALIVE.SessionFileCache()
        KEEPALIVE.refresh_session_cache(self.path, cache, now=1.0)

        self.replace_json(telegram_session(status="done"))
        self.assertTrue(
            KEEPALIVE.refresh_session_cache(self.path, cache, now=2.0)
        )

        self.assertEqual(cache.active_chats, ())
        self.assertEqual(
            cache.telegram_statuses["agent:main:telegram:direct:12345"],
            ("done", "claude-cli"),
        )

    def test_missing_file_clears_cached_active_chat(self) -> None:
        self.replace_json(telegram_session())
        cache = KEEPALIVE.SessionFileCache()
        KEEPALIVE.refresh_session_cache(self.path, cache, now=1.0)

        self.path.unlink()
        self.assertTrue(
            KEEPALIVE.refresh_session_cache(self.path, cache, now=2.0)
        )
        self.assertEqual(cache.active_chats, ())
        self.assertEqual(cache.telegram_statuses, {})

    def test_stable_invalid_file_is_rate_limited(self) -> None:
        self.path.write_text("{")
        cache = KEEPALIVE.SessionFileCache()
        original_loads = json.loads

        with mock.patch.object(KEEPALIVE.json, "loads", wraps=original_loads) as loads:
            self.assertTrue(
                KEEPALIVE.refresh_session_cache(self.path, cache, now=1.0)
            )
            self.assertFalse(
                KEEPALIVE.refresh_session_cache(self.path, cache, now=2.0)
            )
            self.assertFalse(
                KEEPALIVE.refresh_session_cache(self.path, cache, now=30.9)
            )
            self.assertTrue(
                KEEPALIVE.refresh_session_cache(self.path, cache, now=31.0)
            )

        self.assertEqual(loads.call_count, 2)
        self.assertTrue(cache.parse_failed)
        self.assertEqual(cache.active_chats, ())

    def test_file_changed_during_read_is_not_cached(self) -> None:
        self.replace_json(telegram_session())
        cache = KEEPALIVE.SessionFileCache()
        fingerprint = KEEPALIVE.file_fingerprint(self.path)

        with mock.patch.object(
            KEEPALIVE,
            "file_fingerprint",
            side_effect=[fingerprint, (1, 2, 3, 4, 5)],
        ):
            self.assertFalse(
                KEEPALIVE.refresh_session_cache(self.path, cache, now=1.0)
            )

        self.assertIs(cache.fingerprint, KEEPALIVE.UNSEEN)
        self.assertEqual(cache.active_chats, ())


class TypingCadenceTest(unittest.TestCase):
    def test_new_active_chat_is_due_immediately(self) -> None:
        active = (("12345", "agent:main:telegram:direct:12345"),)

        due, active_chats = KEEPALIVE.typing_chats_due(active, {}, 1.0)

        self.assertEqual(due, ["12345"])
        self.assertEqual(active_chats, {"12345"})

    def test_cached_active_chat_remains_due_every_four_seconds(self) -> None:
        active = (("12345", "agent:main:telegram:direct:12345"),)
        last_sent = {"12345": 10.0}

        due, active_chats = KEEPALIVE.typing_chats_due(active, last_sent, 13.999)
        self.assertEqual(due, [])
        self.assertEqual(active_chats, {"12345"})

        due, active_chats = KEEPALIVE.typing_chats_due(active, last_sent, 14.0)
        self.assertEqual(due, ["12345"])
        self.assertEqual(active_chats, {"12345"})


if __name__ == "__main__":
    unittest.main()
