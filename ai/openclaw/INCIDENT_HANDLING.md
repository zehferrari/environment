# INCIDENT_HANDLING.md — Karen's monitoring incident protocol

## When this fires

You receive a system event whose text starts with `INCIDENT <id>` (where `<id>` is a short hex like `7f5a628e8a838474`). That means `ai-monitor` has detected something and handed it to you for triage. Your job is to decide whether zeh actually needs to be told.

**Default to silence.** Most flaps self-heal before you even read them. If you can confirm the host is fine *right now*, suppress and log — don't bother zeh.

## The tier framework — try twice, telegram on the third

Every alert key gets up to **three attempts** before zeh is paged:

| Tier | What happens | Telegram? |
|---|---|---|
| **1** | You take a bounded fix. ai-monitor checks if it worked after a 300 s confirmation window. | **No.** |
| **2** | If the issue is still present after the window, you get a second handoff with `escalation_context` listing what tier 1 tried and why it didn't take. Try a different fix (usually heavier — restart over wake, restart-and-wake over wake-agent). | **No.** |
| **3** | Still failing after a second window — ai-monitor sends Telegram itself with the full attempt history. You don't have to send it. | **Yes (by ai-monitor).** |

How you know which tier you're on:

- The incident JSON has an `escalation_context` block: `{attempt: 1|2|3, max_attempts: 3, prior_attempts: [{ts, actions_taken, outcome}, ...]}`.
- If `escalation_context.attempt < max_attempts`: **act and `decision: suppress`** with a real `actions_taken`. Set `telegram_sent: false`. ai-monitor will re-handoff in 300 s if the fix didn't take.
- If `escalation_context.attempt == max_attempts`: this is your last shot. Try the heaviest sensible fix; if it doesn't recover within ~30 s, `decision: escalate`, `telegram_sent: true`, send the Telegram. (ai-monitor will also send one if you don't — but it'll have less context than yours.)
- If `escalation_context` is **absent**, treat the incident as `attempt: 1`.

You can still escalate early if a tier-1 fix is unsafe or out-of-scope (system-services with no playbook entry, code/data corruption hints, anything in the **Escalate immediately** list below).

## Step-by-step

1. **Read the incident**. The full payload lives at `/var/lib/ai-monitor/incidents/<id>.json`. Fields you'll see:
   - `issues[]` — the issues ai-monitor flagged, each with `{unit, kind, severity, reason, suggested_action}`
   - `summary` — ai-monitor's one-line summary
   - `ts` — when it was emitted
   - `_model` — `deterministic`, `glm-5.1:cloud`, etc.
   - `escalation_context` — present if this is a retry. See above.

2. **Re-probe live state.** ai-monitor saw a moment in time; you're seeing now. Run quick checks for the units in the issue:
   - `systemctl is-active <unit>` for system units (no sudo needed for read).
   - `sudo -u <user> XDG_RUNTIME_DIR=/run/user/<uid> DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus systemctl --user is-active <unit>` for user units.
   - For listener-down: try `nc -zv 127.0.0.1 <port>` or `curl -sI http://127.0.0.1:<port>`.
   - For `task-stalled` Jira issues: query Jira (your token is at `~/.ssh/jiraToken.txt`) — confirm the stall is still real *now*.
   - **Busy-vs-stalled check (mandatory before any wake/restart action).** A long tool call (big grep, slow API call, codex turn) looks identical to a wedged process if you only check session-jsonl mtime. ai-monitor already gates `task-stalled-no-agent` and `agent-idle-with-queue` on its 3-signal busy probe (sessions.json status=running with recent updatedAt, claude-cli jsonl < 60 s old, process CPU > 5 %), so an incident reaching you means at least one signal said "not busy" at probe time — but turns can start in the gap. Re-confirm before acting. The cheap version Karen runs:
     - `sudo cat /home/<user>/.openclaw/agents/main/sessions/sessions.json | jq '[to_entries[] | select(.key|startswith("agent:main:")) | select(.value.status=="running") | select((now*1000 - (.value.updatedAt//0)) < 1800000)] | length'` — non-zero means a turn is in progress within the last 30 min. Suppress with `actions_taken: []` and `reason: "agent mid-turn — sessions.json running key, age <Xm"`.
     - `sudo find /home/<user>/.claude/projects -name '*.jsonl' -newermt '60 seconds ago' | head -1` — if any line returns, claude-cli wrote within the last minute (active turn). Suppress with `reason: "claude-cli jsonl write within last 60 s"`.
     - `sudo ps -u <user> -o pid,pcpu,comm --no-headers | awk '/openclaw|claude/ {sum+=$2} END {print sum+0}'` — gives lifetime-average CPU per process; if > 10 % on long-lived processes the agent is doing real work. (For a more precise "right now" sample, read `/proc/<pid>/stat` field 14+15 twice 1 s apart and diff.)
     - When in doubt, **suppress with the busy reason** rather than wake. The next ai-monitor tick (~2 min) will re-fire if the agent is genuinely stalled. False wakes interrupt real work; missed wakes recover within one tier window (300 s).

3. **Decide using the tier framework + the playbook below.** Pick the action that matches the kind and tier. Always prefer the tier-appropriate fix over escalating; escalating early defeats the whole point of giving you tiers.

## Action playbook by kind

The action you take depends on **kind** and **tier**. Look up your kind in this table.

### Agent / openclaw kinds

| Kind | Tier 1 | Tier 2 | Tier 3 (final) |
|---|---|---|---|
| `task-stalled-no-agent` (idle session, ticket In Progress) | `wake-agent <user> "<key + reminder>"` | `restart-and-wake <user> "<key + reminder>"` | Telegram. Suspect agent runtime is wedged — needs human eyes. |
| `task-stalled-no-progress` (session active, Jira not updating — heartbeat loop) | `restart-and-wake <user> "<key + focused brief>"` | `restart-and-wake <user>` again with sharper brief naming the file/test that's failing | Telegram. Probably a real bug the agent can't break out of. |
| `agent-idle-with-queue` (idle, has Selected for Development / To Do tickets) | **Bypassed by ai-monitor** — ai-monitor runs `wake-agent` directly. You won't see this incident unless wake fails. If you do see it: tier-1 = `restart-and-wake`. | `restart-and-wake` again | Telegram. |
| Stuck `openclaw-*` or `wdt-*` user service (`inactive`/`failed`/crash-loop) | `sudo /usr/local/sbin/openclaw-control restart-services <user> "ai-monitor incident <id>"` (idempotent — restarts every enabled openclaw-*/wdt-* unit for that user) | Same `restart-services <user>` again — sometimes a slow service needed a second pass | Telegram. |

### System service kinds (you now have permission to restart these)

| Kind | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|
| `crash-loop` / `inactive` on `ollama.service` | `sudo systemctl restart ollama.service`, sleep 15, re-probe `curl -sf http://127.0.0.1:11434/api/version` | Restart again + check `journalctl -u ollama -n 50` for clue | Telegram, include the journalctl tail in the message |
| `crash-loop` / `inactive` on `nginx.service` | `sudo systemctl restart nginx.service`, sleep 5, re-probe `curl -sI http://127.0.0.1:80` | Same restart again | Telegram |
| `crash-loop` / `inactive` on `mariadb.service` | `sudo systemctl restart mariadb.service`, sleep 10, re-probe `nc -zv 127.0.0.1 3306` | Same restart again | Telegram |
| `crash-loop` / `inactive` on `php-fpm.service` | `sudo systemctl restart php-fpm.service`, sleep 5, re-probe `nc -zv 127.0.0.1 9000` | Same restart again | Telegram |
| `crash-loop` on `agent-dashboard.service` | `sudo systemctl restart agent-dashboard.service`, sleep 5, re-probe `curl -sf http://127.0.0.1:3013/agents.html >/dev/null` | Same restart again | Telegram |
| `crash-loop` on `openclaw-typing-keepalive.service` | `sudo systemctl restart openclaw-typing-keepalive.service` | Same restart again | Telegram |
| `listener-down` on a known port | Restart the **owning** service (table above maps port → service via the owner field on the issue) | Restart again | Telegram |

### Scheduled / token-renewal kinds

These are predictable, time-driven, and **should be auto-renewed by cron** — not by you reacting to an alert. If you see one:

| Kind | What it really is | Action |
|---|---|---|
| `gmail-watch-expiring` | Gmail watch tokens expire every 7 days. Renewal is `node /srv/Code/environment/ai/openclaw/skills/google-workspace/gmail-watch.js <topic> [labels]` run as the affected agent. | Tier 1: `sudo -u <agent> node /srv/Code/environment/ai/openclaw/skills/google-workspace/gmail-watch.js <topic> <labels>`. Suppress on success. **Also**: leave a one-line note in the decision `reason` saying "no auto-renew cron in place — recommend zeh add a daily timer". This is infrastructure debt, not a real incident. |

### Resource / observe-only kinds

These usually self-heal — **observe, don't act**, and prefer suppress unless the value is dangerous. The escalation tier still applies (3 strikes → telegram), but tier-1/tier-2 here means "wait one window and re-probe", not "take action".

| Kind | Tier 1 / Tier 2 | Tier 3 |
|---|---|---|
| `mem-high` (used > 90 %) | Re-probe; if value dropped → suppress | Telegram if still > 90 % after two windows |
| `load-high` (1-min load / cores > 3) | Re-probe; transient compile bursts are normal | Telegram if sustained |
| `temp-high` (CPU > 92 °C) | Re-probe — cooling usually catches up within a window | Telegram if still > 92 °C after two windows |
| `rootfs-used-pct` > 90 | Don't auto-prune — surface to zeh on tier 1 | n/a |

### Escalate immediately (skip tiers)

- **Self-incidents** — anything affecting `karen` or `ai-monitor` itself. ai-monitor's self-incident guard already routes these direct to Telegram; you should not see them in your queue.
- **Unknown kinds** without a playbook entry above — don't improvise; escalate with `actions_taken: []` and a `reason` naming the kind so zeh can add it to the playbook.
- **Repeated escalations of the same kind** within an hour for the same unit even after a tier-3 telegram already went out — page zeh again only if a new symptom is visible. Otherwise add a comment to the prior decision instead of re-paging.

## Cooldown protection

`openclaw-integrity-check` already restarts user services every 120 s on failure. The tier framework's 300 s confirmation window respects that — your tier-1 fix runs once, then ai-monitor waits 300 s before considering tier 2. **Do not loop on your own**; if your tier-1 didn't take in the first 30 s, write the decision and let ai-monitor re-handoff at tier 2 in 300 s.

## Writing the decision

Always write `/var/lib/ai-monitor/decisions/<id>.json` (it's the audit trail and how ai-monitor knows you finished):

```json
{
  "incident_id": "<id>",
  "decision": "suppress" | "escalate",
  "reason": "<terse, why>",
  "actions_taken": ["<list of commands actually run>"],
  "telegram_sent": true | false,
  "timestamp": "<ISO-8601 UTC>"
}
```

Notes:
- `actions_taken` should list the actual shell commands you ran (e.g. `"sudo systemctl restart ollama.service"`, `"sudo /usr/local/sbin/openclaw-control wake-agent <agent> 'HOMELAB-40 reminder'"`). This is the audit trail for the next tier.
- If the tier framework says you should suppress (tier 1 or 2) but the issue belongs to a kind you can't fix safely, escalate early with `telegram_sent: true` and a clear `reason`.

## Telegram message style

- One short paragraph, no preamble. Lead with the unit and what's wrong.
- Include the **attempt history** from `escalation_context` in your tier-3 message: "tier 1 ran wake-agent (no recovery), tier 2 ran restart-and-wake (no recovery), now telegram-ing".
- End with the action you'd recommend zeh take (or what you already tried). No emojis except severity icon at the start.
- If your message duplicates a tier-3 alert ai-monitor already sent for the same incident, set `telegram_sent: false` and skip — ai-monitor's dedup will not re-fire.

## Don't

- Don't loop on the same fix; one tier-1 attempt, write the decision, let ai-monitor re-handoff at tier 2.
- Don't restart your **own** services (`openclaw-gateway` for `karen`) — you'd kill your own session mid-decision. (You also don't have sudoers permission to do so.)
- Don't restart `ai-monitor.service` unless zeh told you to in the incident text. The self-incident guard already routes ai-monitor failures to zeh directly; restarting it from inside a triage you're trying to write a decision for can create a race.
- Don't run remediation outside the playbook above. If the kind isn't in the table, escalate with `actions_taken: []` and let zeh extend the playbook.
- Don't ping zeh just to say "looks fine now". Suppress quietly.
- Don't write the decision file before the remediation actually completes — `ai-monitor` polls for it.
