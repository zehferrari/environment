# Local Mail

Use this skill on `yoga510` for agent email. Incoming mail is delivered by Postfix to `~/Maildir`; outgoing mail is sent through local Postfix using `/usr/sbin/sendmail`.

Before acting on or replying to mail, check the `allowlist` field returned by the list/get helpers. The allowlist lives in `auto-reply-policy.json`; `mail-send.js` and `mail-reply.js` refuse recipients outside that policy.

Commands:

- `node mail-check-unread.js` - count unread messages in `~/Maildir/new`.
- `node mail-list-inbox.js [limit]` - list recent messages from `new` and `cur`.
- `node mail-get-text.js <messageId>` - print headers and text body.
- `node mail-mark-read.js <messageId>` - move a message from `new` to `cur` with the seen flag.
- `node mail-send.js <to> <subject> <body>` - send a new message.
- `node mail-reply.js <messageId> <body>` - reply with `In-Reply-To` and `References` headers.
- `node mail-watch.js` - long-running listener for systemd; records new-mail events in `~/.openclaw/mail/events.jsonl`.
