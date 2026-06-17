import Link from "next/link";
import { getSystemSettings } from "@/lib/settings/system";
import { setSystemSettings } from "@/lib/settings/actions";

export const dynamic = "force-dynamic";

const SETTINGS_TABS = [
  { key: "general", label: "General" },
  { key: "models", label: "Models" },
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]["key"];

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseSettingsTab(value: string | string[] | undefined): SettingsTab {
  const tab = single(value);
  return SETTINGS_TABS.some((item) => item.key === tab) ? (tab as SettingsTab) : "general";
}

// System-wide settings. These are the global fallbacks used when a
// project leaves the matching field blank (see lib/settings/system.ts).
// Mirrors the project Settings tab.
export default async function SystemSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string | string[] }>;
}) {
  const sp = await (searchParams ?? Promise.resolve({} as { tab?: string | string[] }));
  const activeTab = parseSettingsTab(sp.tab);
  const settings = await getSystemSettings();

  return (
    <div className="space-y-6">
      <header className="rounded-hero border border-line bg-panel p-6 shadow-sm">
        <p className="text-caption uppercase tracking-[0.28em] text-text-muted">System</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-[-0.04em]">Settings.</h1>
        <p className="mt-3 max-w-2xl text-body leading-6 text-text-muted">
          Global defaults for the whole workspace. A project uses these
          whenever its own matching field is left blank.
        </p>
      </header>

      <SettingsTabNav activeTab={activeTab} />

      {activeTab === "general" ? (
        <form
          action={setSystemSettings}
          className="max-w-2xl space-y-section-gap rounded-panel border border-line bg-panel p-card-lg shadow-sm"
        >
          <input type="hidden" name="settingsScope" value="general" />
          <SettingsRow
            label="Theme"
            hint="Choose the UI theme explicitly. Light is the default."
          >
            <select
              name="theme"
              defaultValue={settings.theme}
              className="w-48 rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent"
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </SettingsRow>

          <div className="grid grid-cols-1 gap-card sm:grid-cols-2">
            <SettingsRow
              label="Default git user (name)"
              hint="Author name for agent commits when a project doesn't set its own."
            >
              <input
                type="text"
                name="defaultGitUserName"
                defaultValue={settings.defaultGitUserName ?? ""}
                placeholder="Zeh Ferrari"
                className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent"
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
                className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent"
              />
            </SettingsRow>
          </div>

          <SettingsRow
            label="Automatic Archive (days)"
            hint="Done tasks are automatically archived after this many days when a project leaves its own value blank. Built-in fallback is 5."
          >
            <input
              type="number"
              name="doneTtlDays"
              min={1}
              max={365}
              defaultValue={settings.doneTtlDays ?? ""}
              placeholder="5"
              className="w-40 rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent"
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
              className="w-40 rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent"
            />
          </SettingsRow>

          <SettingsRow
            label="Integration defaults JSON"
            hint="Provider-agnostic, non-secret integration defaults used when workspace and project settings leave values blank."
          >
            <textarea
              name="integrationDefaults"
              rows={6}
              defaultValue={settings.integrationDefaults ?? ""}
              placeholder={'{\n  "deployment": { "provider": "bitbucket" }\n}'}
              className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y font-mono text-body outline-none focus:border-accent"
            />
          </SettingsRow>

          <div className="flex justify-end pt-1">
            <button
              type="submit"
              className="rounded-lg bg-accent px-control-x py-control-y text-body font-medium text-bg hover:opacity-90"
            >
              Save settings
            </button>
          </div>
        </form>
      ) : null}

      {activeTab === "models" ? (
        <div className="max-w-3xl space-y-section-gap">
          <form
            action={setSystemSettings}
            className="space-y-section-gap rounded-panel border border-line bg-panel p-card-lg shadow-sm"
          >
            <input type="hidden" name="settingsScope" value="models" />
            <div>
              <h2 className="text-body font-semibold tracking-tight">OpenRouter</h2>
              <p className="mt-1 text-caption leading-5 text-text-muted">
                OpenRouter models are available in the agent model picker. Store the API key here before assigning OpenRouter models to an agent.
              </p>
            </div>
            <SettingsRow
              label="API key"
              hint={settings.hasOpenRouterApiKey ? "A key is stored. Leave blank to keep it." : "Used when provisioning agent model config for OpenRouter."}
            >
              <input
                type="password"
                name="openRouterApiKey"
                autoComplete="off"
                placeholder={settings.hasOpenRouterApiKey ? "Stored; leave blank to keep" : "sk-or-v1-..."}
                className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent"
              />
            </SettingsRow>
            {settings.hasOpenRouterApiKey ? (
              <label className="flex items-center gap-2 text-body">
                <input
                  type="checkbox"
                  name="clearOpenRouterApiKey"
                  className="h-4 w-4 rounded border-line accent-accent"
                />
                <span>Clear stored OpenRouter key</span>
              </label>
            ) : null}
            <div className="grid gap-card sm:grid-cols-2">
              <SettingsRow
                label="HTTP referer"
                hint="Optional OpenRouter attribution value."
              >
                <input
                  type="url"
                  name="openRouterReferer"
                  defaultValue={settings.openRouterReferer ?? ""}
                  placeholder="Current site origin"
                  className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent"
                />
              </SettingsRow>
              <SettingsRow
                label="App title"
                hint="Optional OpenRouter attribution value."
              >
                <input
                  type="text"
                  name="openRouterTitle"
                  defaultValue={settings.openRouterTitle ?? ""}
                  placeholder="Vixi Agents"
                  className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent"
                />
              </SettingsRow>
            </div>
            <div className="flex justify-end pt-1">
              <button
                type="submit"
                className="rounded-lg bg-accent px-control-x py-control-y text-body font-medium text-bg hover:opacity-90"
              >
                Save model settings
              </button>
            </div>
          </form>

          <section className="space-y-3 rounded-panel border border-line bg-panel p-card-lg shadow-sm">
            <div>
              <h2 className="text-body font-semibold tracking-tight">OAuth provider re-authentication</h2>
              <p className="mt-1 text-caption leading-5 text-text-muted">
                OAuth providers are re-authenticated through the OpenClaw CLI because the browser cannot complete the agent-local credential flow safely.
              </p>
            </div>
            <pre className="overflow-x-auto rounded-lg border border-line bg-bg p-3 text-caption leading-5 text-text"><code>{`sudo -u <agent> openclaw models auth list
sudo -u <agent> openclaw models auth login --provider <provider-id> --device-code
sudo -u <agent> openclaw models status --probe`}</code></pre>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function SettingsTabNav({ activeTab }: { activeTab: SettingsTab }) {
  return (
    <nav className="flex flex-wrap gap-2 rounded-panel border border-line bg-panel p-2 shadow-sm" aria-label="System settings tabs">
      {SETTINGS_TABS.map((tab) => {
        const active = tab.key === activeTab;
        return (
          <Link
            key={tab.key}
            href={`/system/settings?tab=${tab.key}`}
            className={`rounded-lg px-control-x py-control-y text-body font-medium transition ${
              active
                ? "bg-accent text-bg"
                : "text-text-muted hover:bg-panel-soft hover:text-text"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
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
      <span className="block text-micro font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="block text-caption text-text-muted">{hint}</span>
      ) : null}
    </label>
  );
}
