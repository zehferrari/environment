# Agent model upgrades

Use **Agents → agent → Models → Upgrade provider model** to promote a model.
The upgrade sets both the configured active/main model and default, moves the
previous default to fallback position one, and removes only the last fallback
in the selected provider namespace. Other providers retain their order.

Choose **Check available models**, select or enter an exact model ID, then
**Preview update** and **Confirm update and restart**. The preview includes both
old/new lists and the removed model. A stale preview is rejected if the config
changes before confirmation. Repeating the same target is a no-op, with no
fallback churn or restart. If active and default providers differ, reconcile
that deliberate override in the existing editor before a provider upgrade.

The model check uses the agent's OpenAI API key when directly configured and
local Ollama's `/api/tags` for Ollama. OAuth CLI accounts have no API key here;
those show configured models plus explicitly dated published suggestions,
**not an account-verified live catalogue**. Failed live checks are labeled.
Use the exact-ID input for future releases absent from the suggestions. A
listed/entered model is not a successful inference or runtime compatibility
check; CLI versions and account access must support it.

## Shell command

From the selected managed worktree, run:

```sh
sudo ./ai/web/scripts/rotate-agent-model.sh --dry-run openai gpt-6-astra
sudo ./ai/web/scripts/rotate-agent-model.sh openai gpt-6-astra
sudo ./ai/web/scripts/rotate-agent-model.sh claude-cli claude-fable-5-1
```

There are two positional arguments: **provider namespace**, **new model ID**.
`--dry-run` is optional. This updates every enabled registry agent whose
**default** belongs to that exact namespace; an occurrence only in another
agent's fallback list does not select that agent. `anthropic`, `claude-cli`,
`openai`, and `openai-codex` are distinct namespaces. Use the one displayed in
the existing model configuration, not a provider marketing name.

The script uses the running `pm.service` database and drops from root to its
service UID/groups before loading the shared PM update operation. It does not
source an arbitrary shell environment file or print credentials. Dry runs do
not connect to the database. Run from a worktree with installed web dependencies;
this script does not require the new UI to be deployed first.

Each selected agent is preflighted before writes. Updates are refused when PM
has a queued/accepted/streaming run for that agent. This is a PM activity check,
not a fleet scheduler lock: run upgrades during an idle period, including work
outside PM. A per-config exclusive lock prevents concurrent editor/updater
writes; revision checks reject intervening changes. If a process is killed,
remove its `.model-update.lock` only after confirming no updater is running.

Configuration writes preserve file permissions/ACLs, use an atomic rename,
and retain unrelated configuration and auxiliary agents. New model definitions
retain only the previous model's explicit runtime transport override; they do
not inherit invented prices, context limits, or capability metadata. Verified Astra and Fable 5.1 capability metadata is supplied explicitly because
the installed catalogue predates those releases. OpenClaw resolves other models'
metadata from its catalogue/defaults. Exact IDs can therefore
be configured before an installed runtime knows how to use them: verify the
provider/runtime before confirming an upgrade.

The operation records old/new model state in PM Activity, synchronizes the
canonical config through the existing dashboard restart handler, and awaits an
**OpenClaw gateway-only** restart. A restart failure is reported separately from
configuration success. Previously completed fleet updates are not rolled back
if a later agent fails; the command reports the stopping agent and exits nonzero.
It never resets PM tasks or resumes their work. Session-specific model overrides
may still override a new configured default; inspect the effective model on a
fresh turn when validating.

If the target already occurs in fallbacks, it is removed from that list as well
as the original last fallback for the provider. The previous default is retained
only once. With no fallback for that provider, the old default is added and no
other provider is removed. A resulting list longer than 12 is rejected.

## Validation

`pnpm test:model-rotation` covers mixed provider ordering, exact namespaces,
duplicate targets, no-ops, stale revisions, active-run refusal, concurrent update
locks, real filesystem replacement/permissions, preservation of unrelated
config, restart counts, and secret-free activity records. Fixtures use a temporary
config root with stubbed database/network boundaries, never the live agents.

Published IDs verified 10 September 2026:

- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra): `gpt-6-astra`.
- [Claude Fable 5.1](https://www.anthropic.com/claude/fable): `claude-fable-5-1`.
- [Claude Opus](https://www.anthropic.com/claude/opus): current published Opus is `claude-opus-5`; no Opus 5.1 release confirmed.

Barekbaal's original Claude Code 2.1.220 was rejected by the provider for Fable
5.1 with a requirement for 2.1.251 or newer; upgrading the CLI is a prerequisite.

## Effort by PM role

All fleet agents use `thinkingDefault: high`; newly provisioned agents default
to High as well. At actual dispatch (including queued work), PM resolves the
recipient's current task role from database state:

- Creating/revising an unapproved Action Plan: manager effort.
- Reviewing a plan or someone else's submitted work: manager effort.
- Acting task/Epic manager, including an inherited active Epic manager: manager effort.
- Implementation, unrelated participants, and direct conversation: High.

The PM channel plugin reads `sessions.list` metadata (no transcript previews),
uses the exact session's model levels where available, and chooses **xHigh →
Max → High** for manager work. Normal turns explicitly choose High. The
`thinkingLevelOverride` is a one-shot OpenClaw reply option; no `/think` command
or persistent manager/session change is used. Model fallback normalization
remains owned by OpenClaw. Binary-thinking or non-reasoning models cannot gain
extra levels through PM configuration. If neither requested level is supported,
PM uses a supported High, or the runtime-normalized High default when even High
is unavailable. Missing metadata is logged, with the latter fallback.

The old installed model catalogue omitted reasoning metadata for the fleet's
new models. OpenAI/Claude capabilities must match their official model docs;
Ollama `/api/show` confirms `thinking` for GLM 5.3 and Kimi K3. Merely writing
`thinkingDefault` does not make a catalogue entry advertise the right levels.

Validation: `pnpm test:pm-turn-effort`. Runtime logs include the role, supported
levels and selected effort. The policy requires PM web/consumer deployment and
PM channel plugin **0.1.5** reconciliation/restarts after merge; changing the
live High defaults alone does not activate the manager override.

[Claude effort support](https://platform.claude.com/docs/en/build-with-claude/effort)
confirms that xHigh and Max are distinct capabilities and Fable 5.1 supports both.

### Ollama effort is not a portable equivalent

The installed OpenClaw native Ollama adapter maps `high` to `think: "high"`,
and also maps `xhigh` and `max` to that same value. Its provider catalogue
nevertheless advertises Max for reasoning models. As requested, PM applies the
same advertised-capability policy to Ollama: **xHigh → Max → High** for manager
work, and High for ordinary work. There is no Ollama-specific exclusion. A
selected xHigh or Max is passed to OpenClaw; the current adapter may normalize
it to High on the wire. The selected runtime level therefore does not prove
that a stronger setting reached the model.

[Ollama thinking](https://docs.ollama.com/capabilities/thinking) may be boolean
or graded depending on the model. GLM 5.3 documents a separate
[`reasoning_effort` low/high/max control](https://ollama.com/library/glm-5.3),
but the installed native adapter does not forward it as a separate effort
parameter. Kimi K3 advertises thinking without documented equivalent effort
levels on its Ollama page. Enabling thinking, choosing effort, and showing a
reasoning trace in the PM are separate concepts. A future adapter improvement
must prove the actual request mapping before claiming a distinct Max setting
reaches an Ollama model.

### Claude CLI Fable compatibility

The installed OpenClaw Anthropic adapter deliberately advertises `off` only for
Fable on the CLI route, predating Claude Code's support. Writing capability
metadata alone does not override this provider policy. Claude Code 2.1.267
supports the documented `CLAUDE_CODE_EFFORT_LEVEL` setting. Barekbaal's backend
uses that variable for its High default. For this explicitly provisioned Fable
5.1 route, PM clones the backend environment per turn and sets High or xHigh;
it does not change the process-global environment or persist a manager setting.
The old gateway Thinking label can therefore read Off while Claude's actual
**effort** is High/xHigh. These are separate controls in this compatibility path.
An unprovisioned/older CLI does not opt into the special route. Other Claude
models use their advertised levels, with the same environment synchronized when
configured so it cannot override a per-turn effort choice with a stale default.

[Claude Code effort configuration](https://code.claude.com/docs/en/model-config)
documents this environment variable and its precedence. Keep the CLI at
2.1.251 or newer for Fable 5.1.


For another verified Fable CLI account, preserve its existing backend options
and add the following to `agents.defaults.cliBackends` (use that account's
installed executable path), then synchronize and restart its idle gateway:

```json
{
  "claude-cli": {
    "command": "/home/barekbaal/.local/bin/claude",
    "env": { "CLAUDE_CODE_EFFORT_LEVEL": "high" }
  }
}
```

The generic model updater preserves this configuration; it does not upgrade a
CLI binary or automatically enable this compatibility path on an unverified
account.

## Activation record — 10 September 2026

Applied before the feature merge, as requested:

- Asdrubal active/default: `openai/gpt-6-astra`; fallbacks in order:
  `openai/gpt-5.6-sol`, `openai/gpt-5.6-terra`, `openai/gpt-5.5`,
  `ollama/deepseek-v4-flash:cloud`, `ollama/kimi-k2.6:cloud`.
- Barekbaal active/default: `claude-cli/claude-fable-5-1`; fallbacks:
  `claude-cli/claude-opus-5`, `claude-cli/claude-opus-4-8`,
  `claude-cli/claude-opus-4-7`, `ollama/kimi-k2.6:cloud`,
  `ollama/deepseek-v4-flash:cloud`.
- Claude Code upgraded from 2.1.220 to 2.1.267 for Barekbaal.
- Asdrubal, Barekbaal, Carmen and Karen: High configured in the canonical and
  runtime files, registry and PM agent metadata. Gateway model metadata verified
  High for Astra, GLM 5.3 and Kimi K3. Fable CLI uses the explicit environment
  control above; the old gateway Thinking label remains Off.
- Small isolated account requests succeeded for Astra and Fable 5.1. Claude's
  Stop-hook `effort.level` reported `high` and `xhigh` respectively in two
  tool-free Fable 5.1 requests. No task was reset or resumed for these checks.

The PM UI and role-based manager override are **pending feature merge and
deployment**. After merge, deploy the managed main worktree with `pm-switch`
and reconcile PM channel plugin 0.1.5 using the documented installer/restart
procedure. Do not build the currently served worktree without its immediate
restart. Regression validation covers model rotation, effort selection,
TypeScript/lint, PM runtime/lifecycle/transport, plugin compatibility and native
task tools. The UI has not been deployed or browser-tested in production.
