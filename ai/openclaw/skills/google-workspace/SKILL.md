# Google Workspace

Use this skill for Gmail, Google Calendar, Drive, and Photos on `thinkpad` and
yoga510. Email is read from Gmail via the API; outgoing mail is sent
through the same API. OAuth tokens live in `~/.local/share/openclaw/...`
and are auto-refreshed by the `googleapis` library using the refresh
token.

Incoming Gmail push events arrive over a per-agent Pub/Sub subscription
(`gmail-inbox-watch-<user>-sub`) on the shared topic
`projects/<gcp-project>/topics/gmail-inbox-watch`. The push worker
(`gmail-push-worker.js`) is a dispatcher only: it marks mail read, queues
a task, and wakes the main agent through `openclaw-control wake-agent`.
See `../WORKFLOW.md` § *Email* and § *Receiving a mention* for the reply
rules; every outbound email must be signed per the signature rule. The
listener records dispatch state in `~/.openclaw/mail/events.jsonl`.

Before acting on or replying to mail, mark it read immediately after
fetching (helpers do this automatically where noted). Reading does not
imply action; decide queue / reply / no-op separately.

Commands (most-used; the directory also carries monitoring, docs-comment,
and one-off polish helpers not listed here):

- `node gmail-check-unread.js` — check for unread emails in the inbox.
- `node gmail-list-inbox.js [limit]` — list recent inbox messages.
- `node gmail-get-text.js <messageId>` — print headers and text body; marks the message read.
- `node gmail-mark-read.js <messageId>` — mark a message read.
- `node gmail-send.js <to> <subject> <body>` — send a new message. Pass the body as a string, via `--body-file=<path>`, or via stdin (`-`). Never pass a path as the body.
- `node gmail-reply.js <messageId> <body>` — reply-all (excludes the sender) with `In-Reply-To` and `References` headers; marks the source read.
- `node gmail-watch.js <topic> [labels...]` — (re)start a Gmail push watch; called by the daily `gmail-watch-renew.timer`, rarely by hand.
- `node gmail-last-from.js` / `node gmail-thread-last-from-me.js` — find the most recent inbound / your-most-recent message in a thread.
- `node calendar-my-agenda.js` / `node calendar-next.js` — upcoming events.
- `node calendar-create-event.js <summary> <start> <end>` — create a Calendar event.
- `node drive-create-doc.js <title> <content>` — create a Google Doc.
- `node drive-list-docs.js` / `node drive-list.js` — list Drive files.
- `node drive-comment-create.js` / `drive-comment-reply.js` / `drive-comments-list.js` — Drive file comments.
- `node photos-list.js` / `node photos-upload.js <path>` / `node photos-create-album.js` — Google Photos.

Identity resolves at runtime via `../agent-self.js` (reads
`/etc/openclaw/agents.json` by `os.userInfo().username`); never hardcode
email/displayName/accountId in a helper.

See `skills/google-workspace/skill.json` for the OpenClaw tool-manifest
subset exposed to the agent runtime.