# Task/Epic save and navigation reliability — 2026-09-10

## Findings

The Task dirty guard captured its first FormData snapshot and never replaced it
when a save succeeded. It also discarded repeated field values and relied on a
shared `taskMain` element ID. Epics did not have the equivalent guard. A saved
Task could consequently keep warning about unsaved edits.

Task and Epic update handlers silently returned on some invalid values. The
forms had no pending, success or failure feedback. Description state also reset
when refreshed server props changed, potentially replacing a local draft.

A read-only review of the live PM journal found `Failed to find Server Action`
errors referring to older/newer deployments. This confirms a stale-client save
failure; it does not establish the cause of every reported page-opening error.
The app lacked deployment identity and its route boundary blindly reloaded the
first unknown error, masking other failures.

## Changes

- A shared Save form reports Saving, Saved or an error. Only a successful
  response updates the dirty baseline, using the submitted snapshot. Edits made
  while saving remain dirty. Failed requests preserve the draft.
- Task, Epic and task-pane forms have record-specific identities. Snapshots
  retain repeated values and exclude framework/revision bookkeeping.
- A stable same-origin POST endpoint invokes the existing save handlers with
  their authentication, project access, owner-field and workflow checks intact.
  Invalid inputs return explicit errors. Unchanged status is omitted so a
  metadata save cannot replay the editor's original workflow state. An explicit
  Epic status change with a stale revision fails before any fields are saved.
- Periodic refresh pauses while an editor is dirty. Description prop changes
  preserve local edits; an explicit new AI draft or record change still applies.
- Every build gets a deployment ID. Known stale assets/actions retain bounded
  recovery, which refuses an automatic reload while an editor is dirty. Unknown
  route errors remain visible and are logged with their digest.

Task metadata and workflow transitions still use the existing separate mutation
steps: a workflow failure after metadata commit can mean some fields were saved.
The error remains visible and the form remains dirty; this change does not make
that operation atomic. Concurrent edits from multiple people are not generally
version-locked. Error-boundary unmounts, manual reloads and browser closure are
not persistent draft storage. If page-opening errors recur after deployment,
correlate the displayed/browser digest with `journalctl -u pm.service` rather
than assuming every error is stale assets.

## Validation

Run from `ai/web` after installing the normal locked dependencies:

```sh
pnpm test:editor-save-server
PM_BROWSER_DRIVER=/absolute/path/to/puppeteer-core/lib/puppeteer/puppeteer-core.js pnpm test:editor-save-browser
pnpm exec tsc --noEmit --incremental false
```

The server fixture migrates a fresh temporary SQLite database and exercises the
actual route, authorization helpers and persistence handlers. Only session lookup
is mocked. It checks both record types, repeated/no-op saves, invalid titles,
stale Epic status, cross-origin/identity rejection and owner-only role changes.
It never uses the PM database. A failed run retains its scratch directory for
inspection.

The browser fixture bundles the actual Save form, dirty guard and Description
component. It uses a local fake HTTP save service and a stub router; unrelated
AI actions, avatar UI and Markdown rendering are isolated. It checks Task/Epic
repeated saves, navigation warnings, repeated assignee fields, error retention,
edits made during a delayed save, unchanged status and description refreshes.
Install `puppeteer-core` in a separate test directory or make it resolvable from
this script. `PM_BROWSER_BIN` defaults to `/usr/bin/chromium`.

These fixtures do not exercise a full authenticated Next deployment or browser
navigation across two deployed builds. Deployment must still follow the normal
human merge and `pm-switch` process. No live restart is part of this repair.

References: [Next self-hosting](https://nextjs.org/docs/15/app/guides/self-hosting),
[deploymentId](https://nextjs.org/docs/pages/api-reference/config/next-config-js/deploymentId),
[missing Server Actions](https://nextjs.org/docs/messages/failed-to-find-server-action).
