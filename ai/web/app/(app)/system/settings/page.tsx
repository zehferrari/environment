import { getSystemSettings } from "@/lib/settings/system";
import { setSystemSettings } from "@/lib/settings/actions";

export const dynamic = "force-dynamic";

// System-wide settings. These are the global fallbacks used when a
// project leaves the matching field blank (see lib/settings/system.ts).
// Mirrors the project Settings tab.
export default async function SystemSettingsPage() {
  const settings = await getSystemSettings();

  return (
    <div className="space-y-6">
      <header className="rounded-[28px] border border-[var(--color-line)] bg-[var(--color-panel)] p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.28em] text-[var(--color-text-muted)]">System</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-[-0.04em]">Settings.</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">
          Global defaults for the whole workspace. A project uses these
          whenever its own matching field is left blank.
        </p>
      </header>

      <form
        action={setSystemSettings}
        className="max-w-2xl space-y-4 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SettingsRow
            label="Default git user (name)"
            hint="Author name for agent commits when a project doesn't set its own."
          >
            <input
              type="text"
              name="defaultGitUserName"
              defaultValue={settings.defaultGitUserName ?? ""}
              placeholder="Zeh Ferrari"
              className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </SettingsRow>

          <SettingsRow
            label="Default git user (email)"
            hint="Author email for agent commits when a project doesn't set its own."
          >
            <input
              type="email"
              name="defaultGitUserEmail"
              defaultValue={settings.defaultGitUserEmail ?? ""}
              placeholder="e@zeh.me"
              className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </SettingsRow>
        </div>

        <SettingsRow
          label="Days to keep Done"
          hint="Default Done-column TTL for projects that leave it blank. Built-in fallback is 5."
        >
          <input
            type="number"
            name="doneTtlDays"
            min={1}
            max={365}
            defaultValue={settings.doneTtlDays ?? ""}
            placeholder="5"
            className="w-40 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </SettingsRow>

        <SettingsRow
          label="Days to auto-empty bins"
          hint="Soft-deleted tasks, epics, projects, and chats are purged this many days after deletion. Applies to every bin. Leave blank to use the built-in defaults (7 days; 30 for projects)."
        >
          <input
            type="number"
            name="binTtlDays"
            min={1}
            max={3650}
            defaultValue={settings.binTtlDays ?? ""}
            placeholder="Built-in defaults"
            className="w-40 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </SettingsRow>

        <div className="flex justify-end pt-1">
          <button
            type="submit"
            className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
          >
            Save settings
          </button>
        </div>
      </form>
    </div>
  );
}

function SettingsRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="block text-xs text-[var(--color-text-muted)]">{hint}</span>
      ) : null}
    </label>
  );
}
