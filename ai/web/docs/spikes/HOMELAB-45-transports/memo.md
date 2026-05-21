# HOMELAB-45 — Zero-latency agent trigger architecture (spike)

Status: research/decision only. No Stage 3 implementation, no PR.
Owner: Barekbaal Irwin. Reviewer: Asdrubal Irwin.
Branch: `spike/HOMELAB-45-transports`. Commits as `Zeh Ferrari <e@zeh.me>`.
Spike root: `ai/web/docs/spikes/HOMELAB-45-transports/`.

## Goal

Zeh's ask, verbatim: *"triggers acting directly in the agents structure. Zero
latency for action!"* Before HOMELAB-46 lands the Stage 3 dispatcher, pick the
transport for PM → agent wake. Production bias toward Unix socket was named
in the parent ticket; this spike validates that bias and surfaces residual
risks.

## Topology (current vs. target)

The OpenClaw gateway is per-agent. Authoritative source is
`/srv/agents/index.json` (`agents[].listeners[?owner=='openclaw-gateway'].port`,
or per-agent `gateway_port`). Verified on host `x1`:

| agent       | uid  | gateway       |
|-------------|------|---------------|
| asdrubal    | 1001 | 127.0.0.1:18789 |
| barekbaal   | 1002 | 127.0.0.1:18790 |
| karen       | 1003 | 127.0.0.1:18793 |

The dispatcher resolves target host/port from this file at runtime — never
bake in a single port. Listener-shape vs. `gateway_port` field both occur in
the wild; the resolver must accept either, prefer `listeners[?owner=='openclaw-gateway']`,
and fall back to `gateway_port`. Recommend a boot-time cache with file-watch
invalidation on `index.json`.

Today's wake path for email/Jira-driven work is a file drop into
`~/<agent>/tasks/queue/<envelope>.json`, picked up by the agent's
listener-side poller / inotify watch. That is the "file-drop floor" baseline
in this spike.

## Candidate transports

1. **file-drop** (current floor). PM writes `~/<agent>/tasks/queue/<id>.json`,
   the agent's existing watcher picks it up.
2. **localhost HTTP**. PM POSTs to the agent's OpenClaw gateway. The bundled
   `webhooks` plugin already provides authenticated TaskFlow ingress at
   `/plugins/webhooks/<routeId>` with a shared-secret check (see
   `docs/plugins/webhooks.md`). No new OpenClaw code required.
3. **Unix socket**. AF_UNIX stream at a per-agent path
   (e.g. `/run/openclaw/agent-<user>.sock`). Not currently exposed by the
   gateway; this would be a new OpenClaw-side surface.
4. **in-process**. PM webapp `require()`s an OpenClaw client and calls a
   wake function directly. Lowest latency, tightest coupling.

## Bench

`bench/driver.js` (+ `bench/receiver.js`) measure send → first-tick recv on
loopback, per transport, in isolation. **This is spike-support material; it
is not a wake-end-to-end benchmark and is not consumed by HOMELAB-46.** The
harness lives under `bench/`, separate from the memo, so the recommendation
can be consumed without inheriting the harness as production code.

What is measured: kernel + Node.js event-loop cost for one envelope. What is
*not* measured: PM-side serialise/audit, OpenClaw-side TaskFlow ingest, or
Claude session warmup. Those costs dwarf the transport floor; see
"Production context" below.

### Results (median / p95 / p99, microseconds; 3 trials × N=200, warmup=20)

Raw JSONL in `results/raw.jsonl`. Env in `results/env.json`.

| transport | trial-1 med / p95 / p99 | trial-2 med / p95 / p99 | trial-3 med / p95 / p99 |
|-----------|-------------------------|-------------------------|-------------------------|
| inprocess | 0 / 1 / 2               | 0 / 1 / 1               | 0 / 1 / 1               |
| http      | 59 / 106 / 135          | 58 / 110 / 149          | 57 / 108 / 141          |
| unix      | 637 / 662 / 666         | 345 / 427 / 436         | 573 / 592 / 595         |
| file      | 40 / 331 / 340          | 11 / 335 / 341          | 27 / 494 / 517          |

### Bench caveats (important — read before quoting numbers)

- **The unix bench overstates latency** because the client writes many frames
  on a persistent socket and the receiver pumps them in batched `data`
  callbacks; the per-message delta includes time spent in Node's stream pump,
  not just the kernel call. A production setup (either one-conn-per-envelope,
  or length-prefixed framing with per-frame yield) lands closer to the HTTP
  number.
- **The file-drop median is misleadingly low**. `fs.watch` coalesces rapid
  same-dir events, and a handful of events were *lost* (`failures: 1`, `2`).
  The p95 (~330–520 µs) is the more honest figure for the kernel cost. The
  *production* file-drop cost is dominated by the agent-side poll/loop
  interval, not the watch dispatch — see "Production context".
- All transports here are sub-millisecond at the transport layer. The
  decision is not driven by raw latency; it is driven by trust / coupling /
  audit / restart isolation.

## Production context (where the time actually goes)

Transport-layer cost is < 1 ms in all four candidates. The current wake-to-
action time is dominated by:

1. Agent-side queue scan interval (file-drop only) — current scan loop adds
   100s of ms to seconds depending on agent busy-state. **This is the real
   "latency" problem the parent ticket is solving.** Switching transport
   removes this term.
2. Claude session warmup on cold-start (~1–4 s depending on model/cache).
   No transport choice changes this.
3. PM-side audit write (`pm_events`) — must precede send. Single-row insert
   on a local SQLite/Postgres is ~0.5–2 ms. Same on all transports.

So the spike's bench *confirms* that any of the three non-file transports
removes the agent-side-queue-scan term. The remaining choice is governance.

## Decision matrix

Criteria (from the ticket and parent-epic context):

- **L**atency floor (raw transport)
- **R**estart isolation (one process crashing doesn't cascade)
- **A**udit fit (PM can persist `pm_events` row before send)
- **C**oupling to OpenClaw versions
- **P**ermission gating (future per-agent ACLs on who can wake what)
- **D**urability under agent-down (does the envelope survive?)
- **O**penClaw-side change required

Scale: ✅ strong fit / 🟡 acceptable / ❌ poor fit.

| transport | L | R | A | C | P | D | O | net |
|-----------|---|---|---|---|---|---|---|-----|
| file-drop | 🟡 (slow due to agent-side poll) | ✅ | ✅ | ✅ | 🟡 (filesystem ACL only) | ✅ (file persists) | none | **floor / fallback** |
| http      | ✅ | ✅ | ✅ | ✅ (HTTP contract, plugin already exists) | ✅ (per-route shared secret today, mTLS or per-caller token later) | ❌ (drop on gateway down) | none (uses bundled `webhooks` plugin) | **strong** |
| unix      | ✅ | ✅ | ✅ | ✅ (socket contract; no JS dep) | ✅ (unix perms = simple, strong default; SO_PEERCRED for caller identity) | ❌ (drop on gateway down) | **yes** — new AF_UNIX listener in gateway | **best fit, but needs OpenClaw change** |
| inprocess | ✅ | ❌ (PM crash takes wake with it; OpenClaw upgrade requires PM redeploy) | ✅ | ❌ (tight: PM pins gateway internal API) | 🟡 (same-process; any PM bug bypasses gating) | ❌ | yes (stable client export) | ❌ — fails the cleanliness / coupling test |

## Recommendation for HOMELAB-46

**Primary: Unix socket.** Production-bias confirmed. Specifically:

- New OpenClaw-side surface: AF_UNIX SOCK_STREAM listener at
  `/run/openclaw/agent-<user>.sock`, ownership `<user>:<user>`, mode `0600`
  (filesystem ACL = first line of permission gating; SO_PEERCRED gives the
  gateway the caller's uid for free, which is the cleanest input to any
  future per-caller ACL).
- Wire protocol: same envelope schema as the existing `webhooks` plugin.
  Length-prefixed JSON frames (4-byte LE length + body) so a single
  long-lived connection from the PM webapp can multiplex wakes without
  the per-message connect cost we'd pay over HTTP.
- Per-agent socket path is resolved from `/srv/agents/index.json`. Add an
  optional `listeners[?owner=='openclaw-gateway-unix'].path` shape so the
  dispatcher reads it the same way it reads the HTTP listener.

**Fallback: file-drop, automatic.** When the socket is not connectable
(gateway restarting, agent home not yet provisioned, EHOSTUNREACH-equivalent),
the dispatcher writes `~/<agent>/tasks/queue/<id>.json` and continues — the
agent's existing watcher picks it up. This is the durability layer the
non-file transports lack.

**Not recommended: in-process.** Fails coupling/isolation. A PM bug shouldn't
be able to drive an agent wake without going through an audited gateway
boundary, and locking the PM webapp to OpenClaw's internal client surface
makes both projects harder to upgrade independently.

**Provisional: localhost HTTP** as an *operator escape hatch* during the
unix-socket rollout. The `webhooks` plugin is already in-tree; PM can ship
the HTTP path first as a feature-flagged alternative while the unix
listener is being added to OpenClaw, then switch over. Keep the HTTP route
available for cross-host / non-local operator scripting.

## Residual risks

- **Audit ordering**: PM must persist `pm_events` *before* the unix-socket
  write (and before the file-drop fallback). If PM crashes between the
  `pm_events` row and the wake send, the agent never wakes but the row says
  it was queued. Recommend a small reaper that re-issues unwaked rows older
  than N seconds on PM startup.
- **OpenClaw upgrade lockstep**: adding the AF_UNIX listener is an OpenClaw
  change. Until that ships, PM must use HTTP (or fall back to file-drop).
  Don't merge HOMELAB-46 ahead of the OpenClaw release that exposes the
  socket, or feature-flag the transport choice.
- **Socket permission model**: `0600` per-agent socket means *only that
  agent's uid* can connect. The PM webapp will likely run as a different
  uid. Two options:
  (a) PM runs as a single `pm` uid and the socket is `0660` with
      `<user>:pm` group ownership;
  (b) PM runs per-agent (uid-matched) sub-processes that own the connect.
  Recommend (a) for simplicity; revisit if multi-tenant isolation tightens.
- **`/srv/agents/index.json` write cadence**: file-watch invalidation handles
  schema changes, but races during a `karen` enable/disable could give the
  dispatcher a stale port for a window. Bound it to a few seconds; not a
  correctness issue because send errors fall back to file-drop.
- **`webhooks` plugin scope creep**: the existing webhooks plugin is the
  natural home for the new unix listener (same auth/TaskFlow ingress, just a
  different transport). Suggest extending it rather than adding a new
  plugin, so we don't end up with two trust-boundary surfaces.

## Pre-reqs / config that HOMELAB-46 will need from operations

- `/srv/agents/index.json` gains an optional `listeners[?owner=='openclaw-gateway-unix']`
  entry per agent (path, owner, mode).
- A new `pm` system group; PM webapp uid joins it; each agent's socket
  group-owned by `pm`.
- OpenClaw release tag that ships the AF_UNIX listener (TBD; tracked by a
  separate OpenClaw-side ticket once HOMELAB-46 is opened).

## Out of scope (do not regress into HOMELAB-46)

- Reworking the email/Jira ingress path — that's already file-drop and
  Stage-3-orthogonal.
- Changing the Claude session warmup story — it dominates the wall-clock
  latency but is solved separately (warm-pool, cache, etc.).
- Building a generic RPC framework. The unix listener should mirror the
  existing webhooks-plugin contract, nothing more.

--
Barekbaal
claude-cli/claude-opus-4-7
