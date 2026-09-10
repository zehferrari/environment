# OpenClaw / OpenAI upgrade — 2026-09-10

## Cause

Asdrubal's system Codex CLI was current (0.154.0), but OpenClaw used a separate
managed `@openclaw/codex` plugin. The old plugin (2026.7.1-1) pinned Codex
0.144.3. Astra rejected that executable as too old. Falling back to other
OpenAI models repeated the same transport failure.

The host-wide OpenClaw installation was 2026.7.1-2. Upgrading only that package
was insufficient: the user's npm cache preferred old metadata and initially
reported the old Codex plugin as current. Verify installed package contents,
not just a successful install command or the system `codex --version`.

## Runtime repair

- Shared OpenClaw: 2026.9.3, used by Asdrubal, Barekbaal, Carmen and Karen.
- Asdrubal's managed Codex plugin: 2026.9.3, with bundled Codex 0.153.4.
  System Codex remains 0.154.0; these are separate executables.
- Preserved the existing OpenAI OAuth login. Corrected its explicit provider
  route to `api: openai-chatgpt-responses`,
  `baseUrl: https://chatgpt.com/backend-api/codex`, `auth: oauth`.
  An `agentRuntime` setting alone does not select the authentication route.
- Ran the native Doctor migrations for all four agents, then copied the
  validated runtime configurations into PM's canonical agent files using
  atomic replacements preserving ownership, modes and ACLs.
- PM channel 0.1.7 supports keyed `agents.entries`, detects the canonical
  Anthropic model's `claude-cli` runtime, and retains High defaults.
  Codex supports OpenClaw dynamic tools; it continues advertising native PM
  tools. Claude CLI does not, so it receives the full CLI workflow.
- The PM plugin installer explicitly consents to its known local source and
  declared capabilities, as required by the new OpenClaw installer.

## Repository compatibility changes

The model editor and promotion code read and update `agents.entries` as well
as the previous `agents.list` format. Promotion preserves the model-scoped
runtime policy, preventing a CLI-backed model from silently changing transport.
Provisioning removes retired diagnostic/compaction fields and uses the working
OpenAI OAuth endpoint and auth mode. These web application changes require the
normal human merge and website deployment; staging the PM channel plugin does
not rebuild the website.

## Verification

Focused PM tool, effort, model rotation, and configuration policy tests pass;
TypeScript checking passes. Live capabilities expose 15 PM tools for Asdrubal,
Carmen and Karen, and zero for Barekbaal's CLI runtime. Provider probes passed
for Astra, GLM 5.3 cloud and Kimi K3 cloud. Claude CLI reports an authenticated
Max subscription; its provider does not produce a model probe result through
`models status --probe`.
A fresh gateway turn also completed through the Codex harness using Astra in
6.9 seconds: requested and effective model matched, `rerouted: false`, and
no tools were executed. All four gateways remained active with zero restarts
after the final restart; PM dispatch and previously active monitoring/sync
triggers were restored. Barekbaal also completed a fresh gateway turn on
`claude-fable-5-1` through `claude-cli`, returning the expected diagnostic reply.
The public website returned HTTP 200 after following its login redirect.

## Upgrade procedure and rollback

1. Record active services and pause PM dispatch plus monitoring/sync triggers.
   Leave the website online. Back up canonical configs and the installed core.
2. Create and verify native OpenClaw state backups for every agent before
   Doctor runs: this release migrates credentials, sessions and plugin metadata
   into SQLite. A config-only backup is insufficient.
3. Upgrade the shared core and separately upgrade installed managed plugins.
   Use a fresh agent-owned npm cache with `npm_config_prefer_offline=false`
   and `npm_config_prefer_online=true` if metadata is stale. Verify the plugin
   version and its bundled Codex dependency after installation.
4. Run Doctor, validate each config, preserve the migrated canonical copies,
   and install the matching PM plugin. Never resume doc-sync against old
   canonical configurations.
5. Check gateway startup and PM capabilities. The new CLI requires a stopped
   gateway for `models status --probe`; probe one agent at a time and restart
   it in a finally block. A CLI probe alone does not prove the gateway harness
   is functioning.
6. Restore the previously active consumer, timers and path triggers, then
   verify that gateways remain active without restart loops.

Root-private backups are under
`/var/backups/openclaw/pre-2026.9.3-20260910/`, including verified per-agent
state archives, `runtime/`, `canonical-agent-files/`, and `paused-units.json`.
Rollback requires stopping the affected services and restoring both the old
runtime and matching pre-migration state/config; do not run the old core
against the migrated databases. Backups contain credentials and stay private.

References: [OpenClaw updating](https://docs.openclaw.ai/install/updating),
[OpenAI provider](https://docs.openclaw.ai/providers/openai),
[Codex harness](https://docs.openclaw.ai/plugins/codex-harness).
