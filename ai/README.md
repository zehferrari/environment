# X1 — Bookshelf 24/7 AI Agent Host

Documentation of the openSUSE Tumbleweed setup on the secondary ThinkPad, configured to run lid-closed on a bookshelf 24/7 while still supporting an occasional Hyprland session.

Last configured: 2026-05-06.

---

## 1. Identity and Access

| Field | Value |
|---|---|
| Hostname | `x1` |
| Static IP | `10.0.0.108` (router-pinned to USB-C dock NIC MAC) |
| Hardware | Lenovo ThinkPad X1 Yoga Gen 6 (`20XY0011AU`) |
| CPU | Intel i7-1165G7 (4C/8T, Tiger Lake) |
| GPU | Intel Iris Xe (integrated) |
| RAM / Swap | 15 GiB / 2 GB partition swap |
| Disk | NVMe Kioxia 476 GB — see partitioning below |
| OS | openSUSE Tumbleweed (snapshot 20260430 at install) |
| Kernel | `7.0.2-1-default` (rolling) |
| Battery | Sunwoda `5B10W13975`, 51.3 Wh / 57 Wh design (~90% health, 120 cycles at install) |

### SSH

- **Address**: `ssh zeh@10.0.0.108`
- **Auth**: ed25519 public key only (`e@zeh.me` from this desktop's `~/.ssh/id_ed25519.pub`).
- **Password auth disabled**, root SSH disabled — see `/etc/ssh/sshd_config.d/90-harden.conf`.
- Console login still uses local password (the user account password set during install).

### Sudo

`zeh` has NOPASSWD sudo via `/etc/sudoers.d/zeh-install`. Convenient for remote admin but a deliberate security relaxation; remove the file to require password.

---

## 2. Disk Layout

```
/dev/nvme0n1     476.9G
├─/dev/nvme0n1p1   4.1G  vfat   /boot/efi
├─/dev/nvme0n1p2 470.8G  btrfs  /, /home, /var, /usr/local, /opt, /srv, /root, /.snapshots
└─/dev/nvme0n1p3     2G  swap
```

- btrfs with default Tumbleweed subvolume layout. **Snapper** is configured by default and takes pre/post snapshots on every `zypper` transaction.
- **Rollback**: at the GRUB menu, choose a `.snapshots/N/snapshot` entry. One-shot recovery from a bad rolling update.

---

## 3. Network

| Interface | Type | Driver | IP |
|---|---|---|---|
| `enp0s20f0u5u4` | USB-C dock Ethernet | `r8152` (Realtek RTL8152, 100 Mbps) | `10.0.0.108` (router-pinned) |
| `wlp0s20f3` | Internal Wi-Fi (Intel AX201) | `iwlwifi` | `10.0.0.9` (DHCP, fallback) |

NetworkManager prefers Ethernet (metric 100 < Wi-Fi metric 600). Wi-Fi stays up as a backup if the dock disconnects.

Firewalld zone: `public`. Allowed services: `ssh`, `http`, `https`, `dhcpv6-client`.

---

## 4. Power and Thermal

### Charge thresholds (TLP)

`/etc/tlp.d/30-charge-thresholds.conf`:

```
START_CHARGE_THRESH_BAT0=75
STOP_CHARGE_THRESH_BAT0=80
CPU_BOOST_ON_AC=1
CPU_SCALING_GOVERNOR_ON_AC=schedutil
CPU_SCALING_GOVERNOR_ON_BAT=schedutil
PLATFORM_PROFILE_ON_AC=balanced
PLATFORM_PROFILE_ON_BAT=low-power
```

**Why 75/80**: a li-poly battery sitting permanently at 100% AC degrades fast. This range cycles in a narrow band that maximizes lifetime at the cost of capacity-as-UPS.

Live values readable at `/sys/class/power_supply/BAT0/charge_control_{start,end}_threshold`. Verify with `sudo tlp-stat -b`.

### Thermal: DYTC (NOT thermald)

`thermald` was installed but **disabled** — the ThinkPad's firmware DYTC (Dynamic Thermal Control) runs proactively from the EC and intel_pstate, and thermald correctly refuses to fight it (logs `Thermald can't run on this platform` because `/sys/devices/platform/thinkpad_acpi/dytc_lapmode` is present).

TLP's `PLATFORM_PROFILE_*` settings drive DYTC via the kernel's `platform_profile` interface.

Do not re-enable thermald or pass it `--ignore-cpuid-check`.

### AC reminder

24/7 operation requires AC power (laptop's USB-C charger directly, or the dock's PSU passing PD through). Verify with `cat /sys/class/power_supply/AC*/online` — must be `1`.

---

## 5. Suspend / Lid Behavior — Disabled

Drop-in `/etc/systemd/logind.conf.d/90-no-suspend.conf`:

```ini
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
IdleAction=ignore
```

Plus the four sleep targets are **masked**:

```
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

Effect: lid-close does nothing, idle does nothing, no scheduled or DPMS-triggered suspend ever fires. Safe for headless 24/7.

To verify: `busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager HandleLidSwitch IdleAction` → all `"ignore"`.

---

## 6. Default Target

`systemctl get-default` = `multi-user.target` (text login, no display manager). Hyprland is started manually from a tty — see section 9.

---

## 7. Auto-Updates

Custom systemd unit + timer in `/etc/systemd/system/`:

- `zypper-dup.service` — runs `zypper ref` then `zypper --non-interactive --auto-agree-with-licenses dup --replacefiles --download-in-advance`.
- `zypper-dup.timer` — `OnCalendar=Sun 03:30`, `RandomizedDelaySec=30min`, `Persistent=true`.
- `ConditionACPower=true` on the service — won't run if on battery.

```
systemctl list-timers zypper-dup.timer
journalctl -u zypper-dup.service
```

Tumbleweed has no separate "security patches" stream — everything rolls together. The safety net is snapper (Section 2): bad updates roll back from GRUB.

If a kernel update lands, reboot is needed at your discretion (no auto-reboot).

---

## 8. Web / DB / Runtime Stack

| Component | Version | Service | Notes |
|---|---|---|---|
| nginx | 1.29.8 | `nginx.service` | binary at `/usr/sbin/nginx`. http/https open in firewalld. |
| MariaDB | 11.8.5 | `mariadb.service` | bound to `127.0.0.1:3306` only |
| PHP | 8.5.5 | `php-fpm.service` | NOTE: requested 8.4 but Tumbleweed ships 8.5 — accepted. To get 8.4 instead, OBS repo `devel:languages:php`. |
| Node.js | 24.14.1 | n/a | from `nodejs24` package |
| npm | 11.11.0 | n/a | from `npm24` |

### MariaDB root credentials

- Plugin: `mysql_native_password`
- Password: `chec6Hai` (matches the console login password)
- `/root/.my.cnf` (mode 600, root-only) holds the credential so `sudo mariadb` works without prompt.
- To revoke the file-stored credential: `sudo rm /root/.my.cnf`.

### PHP extensions installed

`fpm`, `mysql`, `curl`, `gd`, `mbstring`, `dom`, `zip`, `intl`, `bcmath`, `cli`, `pdo`, `fileinfo`, `tokenizer`, `iconv`, plus what `php8` pulls in by default (ctype, openssl, sqlite, xmlreader, xmlwriter).

**Note on PHP package names on Tumbleweed**: there is no `php8-xml` (use `php8-dom`) and no separate `php8-opcache` (built into base `php8`).

### MariaDB package note

There is no `mariadb-server` package on Tumbleweed — the daemon (`mariadbd`) ships in the `mariadb` package. `mariadb-galera` exists if you ever want a cluster.

---

## 9. Hyprland (Wayland Desktop)

Started manually from a tty. **Use the wrapper, not bare `Hyprland`:**

```
start-hyprland
```

The wrapper at `/usr/bin/start-hyprland` (shipped by the `hyprland` package) sets up systemd user-session integration (cgroups, dbus activation, env propagation). Bare `Hyprland` works but logs `WARNING: Hyprland is being launched without start-hyprland`.

### Config files

| File | Purpose | Source |
|---|---|---|
| `~/.config/hypr/hyprland.conf` | Compositor config | adapted from desktop's `~/.config/hypr/hyprland.conf` |
| `~/.config/hypr/hyprlock.conf` | Lock-screen layout | copied verbatim (monitor-agnostic) |
| `~/.config/hypr/hyprpaper-solid-workspaces.sh` | Per-workspace solid wallpaper generator | copied verbatim from desktop |
| `~/.config/waybar/config` | Waybar layout (JSONC) | adapted; on-clicks swapped |
| `~/.config/waybar/style.css` | Waybar styling | copied; font stack updated |
| `~/.config/waybar/launch-waybar.sh` | Waybar launcher | simplified (no monitor targeting) |
| `~/.config/waybar/power-menu.sh` | wofi-based power menu | copied verbatim |

### What was *removed* vs the desktop config

- All NVIDIA env vars (Iris Xe iGPU only)
- Monitor configuration block and `apply-displays.sh` (single internal display, auto-detect)
- HDMI-audio disable script
- `wob` volume OSD (not installed on x1)
- Bindings and exec-once entries that referenced scripts living in the desktop's `~/.local/bin` or `~/Scripts/` (loadSession, closeWindows, shutdown, show-keybindings, gnome-control-center, gnome-calendar, hyprlock-dpms, grimblast)
- `custom/displays` waybar module (no `wdisplays` use case on a 14" panel)

### What was *substituted*

| Desktop | x1 |
|---|---|
| `ghostty` (terminal) | `kitty` |
| `dunst` (notifications) | `mako` |
| `lxpolkit` (polkit agent) | `/usr/libexec/polkit-gnome-authentication-agent-1` |
| `hyprlock-dpms` wrapper | bare `hyprlock` |
| `grimblast` screenshots | inline `grim + slurp + wl-copy` (region/full/active-window) |
| FA6 in CSS | FA7 (with FA6 fallback) — Tumbleweed only ships FA7 |
| `wofi` | `fuzzel` (final state — same launcher as desktop) |

### What was *kept* (visual + behavior parity)

- All decoration: rounding 12, blur 8/3, shadow, dim_inactive 0.1
- All animations (myBezier, overshot, smoothOut/In, slide/fade/loop entries)
- Layouts (dwindle/master), gaps 5/10, border colors (`33ccffee` → `00ff99ee` 45° gradient)
- All workspace mods (1–10 + Shift variants), special:magic scratchpad
- Window rules: JetBrains focus fix, float pavucontrol/nm-connection-editor/PiP/file dialogs, terminal+editor opacity, fullscreen noblur, workspace pinning per app (Code→6, PhpStorm→1, Firefox→5, Brave→7, Chromium→8, Chrome→9, Discord/Slack/Teams→4, Spotify/Gimp/VLC→2)
- Workspace persistence (1–10 persistent, 5 = default)
- `swallow_regex` (kitty, alacritty, foot)

### Hyprland 0.49+ syntax notes

This is the version on x1; relevant for editing the config:

- `windowrulev2` is **deprecated**; use `windowrule`.
- Most window rule actions only work in **block syntax** now, not inline. The pattern is:

  ```
  windowrule {
      name = unique-name
      match:class = ^(regex)$
      match:float = true       # NB: matcher key is "float", not "floating"
      ...
      float = yes               # action property
      no_focus = true           # action property — note underscore
      no_blur = true            # action property — note underscore (was inline "noblur")
  }
  ```

- A few inline rules still work — e.g. `windowrule = nofocus, class:...`, `windowrule = suppressevent maximize, class:.*`. Most others must be in blocks.

---

## 10. Per-Workspace Solid-Color Wallpapers

The script `~/.config/hypr/hyprpaper-solid-workspaces.sh` runs as `exec-once` from `hyprland.conf`. It:

1. Polls `hyprctl monitors` to track the active workspace.
2. Maps each workspace ID to one of 12 deterministic palette colors.
3. Generates a 5120×3200 PNG via ImageMagick, caches in `~/.cache/hyprpaper-solid/`.
4. Writes `~/.config/hypr/hyprpaper.conf` and (re)starts hyprpaper.
5. Re-applies on every workspace switch (poll loop, ~0.5 s).

### Palette (workspace → color)

| WS | Hex | Color | | WS | Hex | Color |
|---|---|---|---|---|---|---|
| 1 | `#e6194b` | red | | 7 | `#46f0f0` | cyan |
| 2 | `#3cb44b` | green | | 8 | `#f032e6` | magenta |
| 3 | `#4363d8` | blue | | 9 | `#bcf60c` | lime |
| 4 | `#ffe119` | yellow | | 10 | `#008080` | teal |
| 5 | `#f58231` | orange | | 11 | `#800000` | maroon |
| 6 | `#911eb4` | purple | | 12+ | `#000075` | navy (then wraps) |

Same palette as the desktop, so workspace 5 looks identical orange on both machines.

### Dependencies

`hyprctl`, `jq`, `hyprpaper`, `magick` (ImageMagick) — all installed.

---

## 11. Waybar (Top Bar)

### Layout

- **Left**: empty
- **Center**: `clock` (HH:MM:SS • Weekday DD/MM, with month-grid tooltip)
- **Right**: group `network`, `bluetooth`, `pulseaudio`, `custom/power`

The `custom/displays` module from the desktop config was dropped (no `wdisplays` use case on single monitor).

### On-click handlers (all swapped from desktop)

| Module | Handler | Replaces |
|---|---|---|
| pulseaudio | `pavucontrol` | `gnome-control-center sound` |
| network | `nm-connection-editor` | `gnome-control-center wifi` |
| bluetooth | `blueman-manager` | `gnome-control-center bluetooth` |
| clock | (none — tooltip only) | `gnome-calendar` |
| custom/power | `~/.config/waybar/power-menu.sh` | same |

Daemons backing the modules: `bluetooth.service` (active), `NetworkManager.service` (active), `pipewire-pulse.socket` (PulseAudio compatibility for the `pulseaudio` waybar module).

### Font stack

`style.css` font-family:

```css
"JetBrains Mono",
"Font Awesome 7 Free Solid",
"Font Awesome 7 Free",
"Font Awesome 7 Brands",
"Font Awesome 6 Free",
"Noto Sans",
sans-serif;
```

The `Font Awesome 7 Free Solid` family is **explicitly listed** because most icon glyphs (volume, wifi, ethernet, power) live in the Solid variant — fontconfig matches the Regular variant by default if you only ask for `Font Awesome 7 Free`.

### Important deployment gotcha (lessons learned)

The icon strings in `waybar/config` (`""`, `""`, `""`, etc.) are multi-byte UTF-8 characters in the Private Use Area. **Heredoc-over-SSH stripped them silently**. The reliable way to copy them is `scp` or `cat | ssh 'cat >'` (binary-safe). If icons go missing again, hex-dump the `format-*` strings:

```
grep "format-wifi" ~/.config/waybar/config | od -c | head -2
```

You should see bytes like `357 207 253` between the quotes (UTF-8 of U+F1EB).

---

## 12. Application Launcher

`Super+R` → `fuzzel` (default config, no `~/.config/fuzzel/fuzzel.ini` needed — same as desktop).

Why fuzzel and not wofi: visual parity with the desktop. `wofi` is still installed because `power-menu.sh` uses `wofi --dmenu` for the Logout/Restart/Shutdown picker.

---

## 13. Quick Reference

### Service health one-shot

```
ssh zeh@10.0.0.108 'for s in sshd nginx php-fpm mariadb tlp firewalld zypper-dup.timer bluetooth NetworkManager; do
  printf "%-22s %s/%s\n" "$s" "$(systemctl is-active $s)" "$(systemctl is-enabled $s)"
done'
```

### Charge / battery health

```
ssh zeh@10.0.0.108 'sudo tlp-stat -b | grep -E "energy_full|cycle_count|charge_control"'
```

### Force a Tumbleweed update now

```
ssh zeh@10.0.0.108 'sudo zypper ref && sudo zypper -n dup --auto-agree-with-licenses'
```

### See config errors after editing Hyprland config

```
ssh zeh@10.0.0.108 'HIS=$(ls /run/user/1000/hypr/ | tail -1); HYPRLAND_INSTANCE_SIGNATURE=$HIS hyprctl configerrors'
```

### Hyprland log tail

```
ssh zeh@10.0.0.108 'tail -50 $(ls -t /run/user/1000/hypr/*/hyprland.log | head -1)'
```

### Restart waybar

```
ssh zeh@10.0.0.108 'killall waybar; HIS=$(ls /run/user/1000/hypr/ | tail -1); HYPRLAND_INSTANCE_SIGNATURE=$HIS hyprctl dispatch exec /home/zeh/.config/waybar/launch-waybar.sh'
```

---

## 14. Open Items

- **AC power**: at last verification the laptop was on battery (`AC0 online: 0`). For 24/7 use, plug in the laptop's USB-C charger or the dock's PSU.
- **NOPASSWD sudo** in `/etc/sudoers.d/zeh-install`: kept for remote admin convenience. Remove the file if you'd prefer to type the password.
- **PHP 8.4 vs 8.5**: shipped 8.5; your desktop uses 8.4. If a project requires 8.4 specifically, swap to OBS `devel:languages:php`.
- **Auto-launch Hyprland on tty1**: not wired up. To enable, add to `~/.bash_profile` (or fish equivalent):

  ```bash
  [ -z "$WAYLAND_DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ] && exec start-hyprland
  ```

---

## 15. Lessons Learned (Install Path)

For future remote installs of similar hardware:

1. **kexec from CachyOS into the Tumbleweed installer kernel failed twice** on this exact hardware combination (Tiger Lake iGPU + USB-C dock state across kernel switches): once the dock NIC didn't enumerate, once the kernel hung pre-display. The kexec approach is brittle on USB-C-docked laptops because hardware state (graphics, USB-C PD) gets confused mid-handoff.
2. **USB rescue boot worked first try** — cold-boot through firmware re-initializes everything cleanly. **Skip kexec** for any future re-install of this machine.
3. The Tumbleweed netinstall ISO is ~390 MB; HTTPS download from `download.opensuse.org` is integrity-checked by TLS, plus there's a `.sha256` file on the same path.

---

## 16. Migrated ThinkPad AI Agent Services

Migrated from `thinkpad` (`10.0.0.105`) to `x1` (`10.0.0.108`) on 2026-05-06.

| UID/GID range | Role | Notes |
|---:|---|---|
| `1001+` | Coding agents (`role: coding`) | Full OpenClaw agent, Telegram/Gmail/Jira auth. One UID per registered agent in `agents.json`. |
| `1003` | Monitoring agent (Linux user `karen`) | Telegram alert persona, multi-tenant webhook dispatch account, shared web root. |

The authoritative roster — usernames, UIDs, operational role/class, services,
and ports — is `/etc/openclaw/agents.json`. Add or rename agents only by
editing that registry; coding task roles still come from Jira/Epic context.

Runtime notes:

- Source homes are still intact on `thinkpad`, but migrated user services and linger are disabled there.
- `moonlight` proxies the relevant `vixi.au` routes to `10.0.0.108` in `/etc/nginx/sites-available/vixiAu`; disabled `/etc/nginx/sites-available/webhooks` was also updated from `10.0.0.105` to `10.0.0.108`.
- Global OpenClaw lives at `/usr/local/lib/node_modules/openclaw`; `/usr/local/bin/openclaw` points to it.
- `pnpm` 10.33.0 is installed at `/usr/local/lib/node_modules/pnpm` and `/usr/local/bin/pnpm` for Node project builds.
- Tumbleweed's Node 24 binary rejects being invoked as `node-24`, so `/usr/bin/node-24` is a wrapper that execs `/usr/bin/node` with argv name `node`.
- SELinux is enforcing. nginx needs `httpd_can_network_connect`, ACL traverse rights on migrated home dirs, and `httpd_sys_content_t` labels on migrated web roots/static assets.
- Root SSH client material from `thinkpad:/root/.ssh` was migrated because the integrity checker probes `moonlight` over SSH.
- `/etc/hosts` maps `moonlight` to `10.0.0.10` for the same integrity probe.
- OpenClaw services must run as their Linux users, never as root.
- Listener processes should bind to loopback unless nginx is intentionally exposing them locally. Public ingress terminates at `moonlight`, then proxies to nginx on `x1`.

### Current Service Ownership

`karen` hosts the monitoring agent. The monitoring agent inspects services, logs, health checks, and monitor outputs, but does not code or take Jira implementation work unless zeh explicitly expands the role.

`karen` still owns the shared webhook dispatcher. It does not own Gmail polling, because Gmail polling uses each coding agent's Google OAuth state, task files, gateway token, and per-agent memory. Keeping Gmail under each coding agent preserves least privilege and prevents cross-agent mailbox confusion.

`karen` also owns the PM runtime. `pm.service` and
`pm-consumer.service` are host-wide **system** services in
`/etc/systemd/system` with runtime `User=karen`; they must not be
installed or enabled as per-agent user services under a coding agent's
`~/.config/systemd/user`. The PM consumer keeps `ProtectHome=true` and
uses service-private `pnpm` home/config/cache directories under
`/var/lib/pm` so it never probes hidden `/home/karen` config paths.

Expected enabled user services/timers, by role (concrete user → services map is in `/etc/openclaw/agents.json` `services`):

| Role | Services / timers |
|---|---|
| Monitoring agent (user `karen`) | `openclaw-gateway.service`, `openclaw-jira-receiver.service`, `openclaw-bitbucket-receiver.service` |
| Each coding agent (one row per agent in registry) | Core: `openclaw-gateway.service`, `openclaw-gmail-listener.service` (derived from `role` + `integrations` via `agent-defaults.json`). Plus any project resources the agent has enabled in `~/.local/openclaw/monitor.json` (e.g. `wdt-<user>.service`). |

Expected listeners on `x1` (concrete `user → port` map is in `agents.json` `listeners`):

| Port range | Role | Service |
|---:|---|---|
| `18789–1879N` (one per coding agent) | Coding agent | OpenClaw gateway |
| `18791, 18792, …` (one per coding agent) | Coding agent | OpenClaw browser sidecar |
| `18793` | Monitoring agent (`karen`) | OpenClaw gateway |
| `3000` | Project Manager (`karen`) | PM (Zero Latency) web server, Next.js loopback |
| `3014` | Monitoring agent (`karen`) | OpenClaw Jira webhook receiver |
| `3015` | Monitoring agent (`karen`) | OpenClaw Bitbucket webhook receiver |
| Per-agent project resources (e.g. `3001, 3002, …`) | Coding agent | Declared in that agent's `~/.local/openclaw/monitor.json` (e.g. WDT Next.js standalone, loopback). Each resource's `enabled` flag controls both whether it runs and whether it's monitored. |
| `11434` | system (`ollama`) | Ollama API, loopback |
| `3013` | system (`root`, `agent-dashboard.service`) | Agent dashboard backend (HTTP + SSE), loopback only — public access via nginx at `https://dev.vixi.au/agents.html` with basic auth |

The exact port numbers per registered user live in `agents.json` (`listeners[].host:port`); `openclaw-registry-check --runtime` validates that the listed ports are actually bound.

### Project Manager (Zero Latency) Services

The Project Manager (Zero Latency) web interface and queue processor run as host-wide system-level services on `x1` under user `karen`.

- **`pm.service`**: A system-wide `systemd` service running the Next.js production standalone server on `127.0.0.1:3000`.
  - Env configuration loads from `/etc/default/pm`.
  - Serves the Zero Latency web interface at `https://agents.vixi.au` (via Nginx reverse proxy).
  - Background intervals (periodic agent sync, hourly soft-delete bin purges, and orphaned attachment cleanup) are scheduled in-process via Next.js `instrumentation.node.ts` scheduler.
- **`pm-consumer.service`**: A system-wide `systemd` service that watches for events dropped by the web application into `/var/lib/pm/drop/`.
  - Runs in a loop using `pnpm tsx` to execute `scripts/pm-consumer-loop.ts`.
  - Reads dropped event files and triggers loopback wake requests (`POST /hooks/wake`) to target agent gateways (e.g. `http://127.0.0.1:18789/hooks/wake` with Bearer tokens).
  - Configured with `ProtectHome=true` and service-private cache/config directories under `/var/lib/pm/` (`pnpm-home`, `pnpm-config`, `pnpm-cache`, `.npmrc`) to avoid home directory configuration leaks.
- **Native PM workflow notifications**: Mission Control sends workflow turns through the same native `pm` channel used for task comments. Backlog assignment wakes the assigned agent only to post a concise implementation plan/opinion as a task comment; `To Do` is the approval-to-execute signal; assignees then move to `In Progress`, and move to `Review` when work is complete or when they need reviewer/manager/reporter feedback. The resolved reviewer moves satisfied work to `Done` without approval-only comments or leaves feedback. If an agent has no new information, action result, plan, feedback, blocker, or necessary question, PM supports a silent no-contribution completion instead of visible chatter.
- **Monitor-agent workflow enforcement**: `ai-monitor` reads the PM SQLite database read-only and raises/wakes on missing Backlog plans, stale `To Do`, stale `In Progress`, Review waiting on a reviewer, Review feedback waiting on the assignee, tasks blocked by a non-Open Epic, and stale active workflow live-bubble turns that no longer match the task's current owner/status. PM workflow drift is deterministic: it bypasses monitor-agent judgment and runs the wake/restart ladder directly so the agent is nudged on the next monitor cycle.
- **`pm-switch-runner.service`**: A system-wide `systemd` service (runs as `karen`, decoupled from `pm.service`) implementing the "switchable single site" live preview — it builds a chosen git worktree and flips which one `pm.service` serves. The web app stays unprivileged (drops a request into a spool, polls a state file); the runner builds and a path-validated root helper (`pm-apply-worktree`) does the only privileged step, granted by one NOPASSWD sudoers line. Triggered from a git/worktree-exposed project's Settings → **Worktree live preview** panel (admin) or the `pm-switch` CLI. Backed by `/srv/Code` being group-collaborative (`code-tree-perms`: setgid + default ACLs) so any code-agent can build. See [web/deploy/MULTI_AGENT_WORKTREES.md](web/deploy/MULTI_AGENT_WORKTREES.md).

#### Database and Data Storage
- **Database**: A Prisma SQLite database located at `ai/web/prisma/prisma/dev.db` (under the `/srv/Code/environment.worktrees/...` checkout). The DB directory is owned by `karen` (`0700`) so the coding agents cannot read it, even though the surrounding source tree is group-collaborative.
- **Attachments**: Task and Epic file attachments are saved to `/srv/Data/projects/<projectId>/attachments/<sha256>`.
- **Private Credentials**: Stored securely in `/etc/openclaw/pm-agent-credentials/` (owned by `karen:karen`, mode `0700`).

#### Integration and Security Tokens
To securely interface with local agent gateways without exposing credentials, PM uses configuration files mapping agent users to token strings:
- `/etc/openclaw/pm-consumer-tokens.json` (owned by `root:karen`, mode `0640`): Map of `/hooks/wake` gateway Bearer tokens.
- `/etc/openclaw/pm-channel-tokens.json` (owned by `root:karen`, mode `0640`): Map of native `pm` channel Bearer tokens.

#### Webhook and Ingress Routing
Incoming webhooks from Atlassian (Jira/Bitbucket) flow from public URLs through `moonlight` and `x1` nginx, routing to `openclaw-jira-receiver.service` (port `3014`) and `openclaw-bitbucket-receiver.service` (port `3015`) running under `karen`.

### OpenClaw Architecture

- OpenClaw runtime was migrated from ThinkPad runtime `2026.4.15`.
- Per-user OpenClaw state lives under `/home/<user>/.openclaw/`.
- Full users have `~/.config/systemd/user/openclaw-*.service.d/20-node24.conf` drop-ins pinning Node through `/usr/bin/node-24`.
- Gateway services use `10-secrets.conf` with `EnvironmentFile=~/.config/openclaw/openclaw-secrets.env`.
- Secrets stay out of `openclaw.json`; use env/token files only.
- `karen` runs the monitoring agent's OpenClaw gateway on `127.0.0.1:18793`.
- `karen` also receives webhooks, updates `/home/<user>/tasks/current.md`, and wakes the target agent via `/usr/local/sbin/openclaw-control`.
- Shared operational knowledge lives in `/srv/Code/environment/ai/openclaw`.
- Active monitored-agent registry lives at `/srv/agents/index.json`; `/etc/openclaw/agents.json` is a symlink to it.
- Webhook routing is derived from `/srv/agents/index.json`: enabled coding agents with `integrations.jira` receive Jira events, and enabled coding agents with `integrations.bitbucket` receive Bitbucket events.
- The shared docs (`AGENTS.md`, `ROLES.md`, `TEAM_WORKFLOW.md`, `CODE_REPOS.md`) are canonical at `/srv/Code/environment/ai/openclaw/` (deployed from `environment/ai/openclaw/` in the unified `environment` repo). Each coding agent's home has two symlinks per file (one in `~/workspace/`, one in `~/.openclaw/workspace/`) pointing at the canonical file in the repo, so both the user-facing and OpenClaw internal workspaces see the same content. The monitoring agent (`karen`) has only `~/.openclaw/workspace/`, with one symlink per file.
- Per-agent files (`SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `MEMORY.md`, `HEARTBEAT.md`) are **content-per-agent** but **single-canonical in location**: each lives at `~/workspace/<file>` and `~/.openclaw/workspace/<file>` is a symlink to it.
- `AGENTS.md` defines the operating baseline (always-on rules + memory/safety/group-chats/heartbeats/tools). `ROLES.md` defines task-role behaviour for coding agents plus the standing monitor role. `TEAM_WORKFLOW.md` is the action-indexed playbook for tasks. `SOUL.md` and `IDENTITY.md` define per-agent persona only.
- Jira tickets in `Backlog` are not actionable. Agents and dispatchers must completely ignore them: do not queue, wake, send Telegram, comment, transition, or start work unless zeh explicitly overrides Backlog for that specific ticket.
- Mandatory outbound signature rule: every outbound email and Jira update/comment must end with `--`, the agent name, and `Model: <provider>/<model>` using the actual current runtime model at send time.
- Agent communication policy: report only when finished or blocked. No play-by-play progress updates.
- Preserve the source communication channel. Jira tasks use Jira comments/status updates; email tasks use the email thread; Telegram tasks use Telegram. Jira/email-triggered work may send exactly one Telegram start notice to zeh, then no further Telegram messages for that task unless zeh explicitly redirects the conversation.

Model posture is dynamically resolved per-agent based on task-fit, not arranged on a cheap-vs-expensive ladder. Coding agents do not have fixed manager/developer personas; they take task roles from Jira/Epic assignment or explicit handoff.

As of May 2026, we rely dynamically on **OpenAI OAuth**, **Claude CLI**, and **Ollama Cloud** to provision the models in use.

Coding agents can implement, coordinate, review, research, or operate when the live ticket/Epic assignment gives them that role. They must never self-assign Jira work. No agent creates or merges pull requests; agents push branches and report readiness, and zeh creates/lands PRs.

Live per-user defaults are in each agent's own `~/.openclaw/openclaw.json`, **not** in the shared registry — model preference is persona, not host topology.

### Webhook Flow

```
https://dev.vixi.au/webhooks/*
  -> moonlight nginx
  -> x1 nginx
  -> karen openclaw-jira-receiver on 127.0.0.1:3014
  -> karen openclaw-bitbucket-receiver on 127.0.0.1:3015
  -> /usr/local/sbin/openclaw-control <coding-agent-user> ...
```

Webhook and integration facts:

- Shared webhook receivers: `/home/karen/webhooks/jira-receiver.js` and `/home/karen/webhooks/bitbucket-receiver.js`.
- Routing config: `/srv/agents/index.json` via `/etc/openclaw/agents.json`; `users.json` is deprecated.
- Endpoints: `GET /health`, `POST /jira`, `POST /bitbucket`.
- `karen` may run `/usr/local/sbin/openclaw-control *` via `/etc/sudoers.d/karen-openclaw-control`.
- `openclaw-control` permits target users that are coding agents in `/etc/openclaw/agents.json`; commands include `restart-services`, `wake-agent`, and `restart-and-wake`. `restart-services` covers all enabled `openclaw-*` user services for the target user; `systemctl restart` is invoked uniformly so inactive units are also (re)started. This is the path the monitoring agent / `ai-monitor` uses to bring stuck user services back up automatically. Project-specific services should NOT be named `openclaw-*`; declare them in `~/<user>/.config/openclaw/projects/<name>.json` instead (convention; loader hook not yet wired).
- `openclaw-control wake-agent` loads `/home/<user>/.config/openclaw/openclaw-secrets.env` before calling `openclaw system event`, so gateway token secret refs resolve for webhook wakes.
- Telegram bots: one per agent, recorded in `/etc/openclaw/agents.json` under each agent's `telegram.bot` field.
- Jira host and Bitbucket workspace/repo are declared in `/srv/agents/index.json`.
- Agents may push ticket branches but must not create or merge Bitbucket pull
  requests. PR creation and landing are human-only.
- Jira issue keys are project-agnostic. Gmail/Jira automation must accept any generic `PROJECT-123` key, not a hard-coded prefix.
- If an agent gets a Jira "not found/no access" result but a webhook or email clearly names the ticket, the agent must re-check with workspace Jira helpers before telling zeh no action is needed.
- Jira webhook receivers and Gmail Jira fallback ignore issues whose live/current status is `Backlog`.

### Gmail Automation

Current approach since 2026-05-07:

- `openclaw-gmail-listener.service` is enabled for both full agents.
- `openclaw-gmail-poller.timer` was temporary and has been disabled/removed.
- Each coding agent's listener uses a dedicated pull subscription named `gmail-inbox-watch-<user>-sub`.
- All per-agent subscriptions attach to the shared topic `projects/<gcp-project>/topics/gmail-inbox-watch` (the GCP project name is captured in the listener's secret env, not in this doc).
- Gmail watch labels are INBOX, Jira, Atlassian, Bitbucket, and Confluence, using each mailbox's actual Gmail label IDs. INBOX keeps direct email from zeh/sibling agents in scope; the product labels keep archived Jira/Atlassian/Bitbucket/Confluence mail in scope.
- Listener script: `/home/<user>/.openclaw/workspace/google/gmail-push-worker.js`.
- Manual unread labeled-mail catch-up helper: `/home/<user>/.openclaw/workspace/google/gmail-catchup-labelled.js`.
- Listener unit: `/home/<user>/.config/systemd/user/openclaw-gmail-listener.service`.
- Node 24 drop-in: `/home/<user>/.config/systemd/user/openclaw-gmail-listener.service.d/20-node24.conf`.
- Secret env drop-in: `/home/<user>/.config/systemd/user/openclaw-gmail-listener.service.d/10-secrets.conf` is still loaded by the service for Google/OpenClaw secrets, but Gmail intake now wakes the agent through `sudo -n /usr/local/sbin/openclaw-control wake-agent <self>` instead of calling `openclaw system event` directly.
- Mail intake users have a narrow sudoers grant in `/etc/sudoers.d/openclaw-mail-self-wake` for their own `wake-agent` command only. Do not give coding agents the broader monitor sudoers rule.
- Gmail watches still publish to the shared topic, but each agent now has its own subscription, so messages are broadcast once to each agent instead of load-balanced between them.
- The legacy shared subscription `gmail-inbox-watch-sub` does **not** exist and must not be referenced by any agent service or monitoring tool.
- The Gmail push worker was patched to ignore Pub/Sub notifications where `emailAddress` belongs to the other mailbox, so each agent only processes its own mailbox events.
- The Gmail push worker marks every in-scope email as read immediately after fetching it, even when no action is required.
- Manual Gmail body/reply helpers also mark the source message read. Agents must not fetch/read Gmail content and leave that message unread.
- The Gmail push worker is a dispatcher only: queue task, mark mail read, wake OpenClaw through `openclaw-control`. It must not send Telegram task-start notices itself; the awakened agent sends exactly one concise start notice after accepting the task.
- Sibling-agent emails are actionable by default. If they are replies inside an existing task thread, the worker wakes the agent as an email-thread update and explicitly suppresses a new Telegram start notice.
- Gmail reply helpers reply-all by default, excluding the sending agent, and mark the source message read after fetching it.
- Email requests from whitelisted senders and local agents with email access that ask for a response or action are actionable immediately. The listener must wake the owner agent at intake time; `ai-monitor` is only the fallback when a queued email remains unprocessed.
- Gmail and Jira wake prompts explicitly remind the agent to sign outbound email/Jira comments with the actual current runtime model.
- Gmail and Jira wake prompts explicitly remind the agent to keep task communication in the source channel after the one allowed Telegram start notice.

#### Gmail Watch Renewal

Gmail watches expire after ~7 days and must be renewed regularly. As of 2026-06-07:

- **Automated renewal**: A daily cron job (`gmail-watch-renewal`) runs at midnight Brisbane time under the monitoring agent's OpenClaw cron system. It checks each agent's `watch-state.json` expiration and renews if expired or expiring within 24 hours.
  - Asdrubal renewal: `cd /home/asdrubal/workspace/google && node gmail-watch.js projects/asdrubal-projects/topics/gmail-inbox-watch INBOX`
  - Barekbaal renewal: `cd /home/barekbaal/workspace/google && node gmail-watch.js projects/asdrubal-projects/topics/gmail-inbox-watch INBOX Label_2 Label_1 Label_3 Label_1164642172958135904`
  - Results are announced to zeh on Telegram after each run.
- **Watch state files**: `/home/<user>/.openclaw/workspace/google/watch-state.json` tracks `topicName`, `labelIds`, `historyId`, `expiration` (ms epoch), and `createdAt`.
- **Push state files**: `/home/<user>/.openclaw/workspace/google/push-state.json` tracks `lastHistoryId` for the push worker's Gmail History cursor. If this falls too far behind (e.g. after a long watch expiry), the push worker resets to the current profile `historyId` automatically on restart.
- **OAuth tokens**: `/home/<user>/.openclaw/workspace/google/secrets/token.json` stores the OAuth access/refresh tokens. Access tokens expire after ~1 hour but are auto-refreshed by the googleapis library using the refresh token. The saved file may appear stale but refresh works transparently.

#### GCP Service Account and IAM

The service account `gmail-watch@asdrubal-projects.iam.gserviceaccount.com` (key at `/home/<user>/.openclaw/workspace/google/secrets/gcp-sa.json`) authenticates Pub/Sub operations.

- **Project**: `asdrubal-projects`
- **Pub/Sub topic**: `gmail-inbox-watch`
- **Subscriptions**: `gmail-inbox-watch-asdrubal-sub`, `gmail-inbox-watch-barekbaal-sub`
- **Required IAM roles** (as of 2026-06-07):
  - `roles/pubsub.subscriber` — read/consume subscriptions (ack, pull, get)
  - `roles/pubsub.editor` — create and delete subscriptions (recovery if subs are accidentally removed). Granted 2026-06-07.
  - `roles/pubsub.publisher` — needed by Gmail API to publish to the topic (configured at topic level, not SA level)

**Important**: The base `openclaw-gmail-listener.service` unit must reference the agent-specific subscription name (`gmail-inbox-watch-<user>-sub`), **not** the legacy `gmail-inbox-watch-sub`. The `openclaw-integrity-check` probe reads the subscription name from the base service file via regex and will false-fail if it finds the wrong name. This was the root cause of repeated false `gmail-watch-expired` alerts on 2026-06-07 — the base file still had the old `gmail-inbox-watch-sub` while the drop-in override corrected it, but the integrity check read the base file first.

Why this matters:

- A Pub/Sub topic broadcasts to subscriptions.
- A single subscription load-balances messages between consumers.
- The old setup had both agents consuming `gmail-inbox-watch-sub`, so one agent could consume and ack a notification for the other agent.
- Dedicated subscriptions fix this while preserving the preferred push/listener model.

### Ollama

Ollama is installed as a system service:

- Service: `/etc/systemd/system/ollama.service`
- Binary: `/usr/local/bin/ollama`
- User/group: `ollama:ollama` (`971:971`), also in `video` and `render`
- Bind: `0.0.0.0:11434` on x1, with firewalld allowing TCP `11434` only from moonlight (`10.0.0.10`). Agents should use `http://ollama.local`, not the raw backend port.
- Data dir: `/usr/share/ollama`
- Cloud auth identity: `/usr/share/ollama/.ollama/id_ed25519` and `.pub` were migrated from ThinkPad. If these are regenerated, `:cloud` models can still list but fail with `401 unauthorized`.

Cloud models are installed on `x1`; `qwen2.5:3b-instruct` is also available locally as the small offline fallback. `x1` is registered as a backup backend behind the moonlight `ollama.local` nginx proxy.

Expected cloud models:

| Model | Notes |
|---|---|
| `kimi-k2.6:cloud` | cloud entry only |
| `glm-5.1:cloud` | cloud entry only |
| `deepseek-v4-flash:cloud` | cloud entry only |
| `deepseek-v4-pro:cloud` | cloud entry only |

Local fallback model (added 2026-05-08):

| Model | Size | Role |
|---|---|---|
| `qwen2.5:3b-instruct` | ~2 GB (q4_K_M) | Last-resort fallback when internet/cloud is unavailable. Listed at the tail of the monitoring agent's openclaw `agents.defaults.model.fallbacks` chain *and* ai-monitor's `ai.fallback_models` chain. Slow (~30–60 s on Tiger Lake CPU) but keeps the host functional offline. |

### Monitoring and Recovery

- Integrity checker: `/usr/local/bin/openclaw-integrity-check`.
- Registry drift checker: `/usr/local/bin/openclaw-registry-check`; use `--runtime` to also verify declared user services and listener ports.
- Boot readiness checker: `/usr/local/bin/openclaw-boot-readiness`; intended after reboot or larger service changes.
- OpenClaw state backup: `/usr/local/bin/openclaw-backup`, scheduled by `openclaw-backup.timer`.
- AI monitor: `/usr/local/bin/ai-monitor`, using the monitoring agent (Telegram bot from `agents.json`) as a **triage + remediation layer** before alerts reach Telegram. Reads the agent watch list dynamically from the registry every tick (no script reload needed when registry changes).
- Monitor triage flow: ai-monitor writes the incident to `/var/lib/ai-monitor/incidents/<id>.json`, wakes the monitoring agent via `openclaw system event`, and polls `/var/lib/ai-monitor/decisions/<id>.json` (5 min timeout). The monitoring agent re-probes live state, attempts a bounded fix if applicable (see `~/.openclaw/workspace/INCIDENT_HANDLING.md`), and writes `{decision: 'suppress'|'escalate', reason, actions_taken, telegram_sent}`. Telegram is sent only on `escalate`. If the monitoring agent times out / errors, ai-monitor falls back to a direct Telegram with a `monitor unavailable` tag; alerts are never lost. Self-incidents (issues affecting the monitor user or ai-monitor itself) skip the handoff and go direct.
- Active monitored-agent registry: `/etc/openclaw/agents.json`.
- Registry `capabilities` fields are the machine-readable authority model. Coding agents may code/comment/transition/send email; the monitoring agent may triage incidents, wake/restart agents, and send Telegram monitor alerts, but may not modify code, transition Jira, comment Jira, or send email until those capabilities are explicitly granted.
- Stalled-task detection (two complementary kinds, evaluated in order; secondary only fires if primary doesn't):
  - `task-stalled-no-agent` (primary, **policy-defined stall**): Jira issue assigned to a coding agent in `In Progress` *while that agent's openclaw session jsonl mtime is older than the threshold*. Definitionally a stall — the agent isn't actively running on it. Threshold: warn at 5 min idle, crit at 15 min. The monitoring agent is asked to triage and is expected to run `openclaw-control wake-agent <user>` before suppressing. **If the monitoring agent suppresses with empty `actions_taken`, ai-monitor performs the wake itself** (deterministic fallback) — `sudo openclaw-control wake-agent <user> '<reminder>'`, sleep 15 s, re-probe session idle. If recovered (idle < 30 s after wake) → log `auto_woke_after_karen_suppress` and stay silent. If still idle → Telegram with the wake attempt result. Net effect: the agent always gets nudged when this kind fires, regardless of triage judgment; you only get a Telegram when the wake genuinely failed.
  - `task-stalled-no-progress` (secondary): Jira issue `In Progress` with stale `updated` field (>30 min) but session is fresh — i.e. the agent is alive but spinning (HOMELAB-5 heartbeat-loop pattern). The monitoring agent uses `openclaw-control restart-and-wake <user> '<focused brief>'` to break the loop.
  - Both checks query Jira via each coding agent's own token (`~/.ssh/jiraToken.txt`, per-user least privilege). Thresholds live in `/etc/ai-monitor/config.json` under `stalled_tasks_check` (`session_idle_warn_minutes`, `session_idle_crit_minutes`, `update_warn_minutes`). Disable per-agent by setting `coding: false` or `integrations.jira: false` in the registry.
- Pending email action detection: Gmail/local-mail listeners must wake the owning agent immediately for requests from the configured whitelist plus every local agent with email access. ai-monitor is the fallback path, not the first responder: it scans each monitored coding agent's `~/tasks/current.md` for Gmail-backed sections (`Gmail messageId:`) still marked `Status: QUEUED`. It fires `email-awaiting-action` at 15 min warn / 60 min crit, ignores stale historical entries older than 24 h, and wakes the owning agent directly with a reminder to process the queued email, reply in-thread when required, include the configured signature/runtime model, and move the task out of `QUEUED`. Recovery is task-status based: the wake/restart is not considered successful while the same Gmail messageId remains `QUEUED`, and tier-3 Telegram escalation no longer suppresses future recovery attempts for unresolved email work.
- PM workflow drift detection: Mission Control already wakes the target agent when the PM event happens; `ai-monitor` is the fast fallback. Defaults are Backlog plan missing after 2 min, `To Do` not started after 2 min, `In Progress` stale after 5 min, and Review waiting after 10 min. `In Progress` is only for active implementation; if the assignee needs reviewer/manager/reporter feedback, the task should move to `Review` with one concise note. For `In Progress`, the stale timer is based on the assignee's latest task comment after the task entered `In Progress`. PM kinds are mandatory bypass-monitor auto-actions: T1 sends a native PM-channel workflow nudge with the full task context packet, T2 restarts agent services and sends the PM-channel nudge again, T3 performs a final restart/nudge recovery attempt, and Telegram is sent only if the issue is still present after T3's confirmation window.
- Monitor config replication: keep host secrets and literal runtime users out of git, but version the policy/defaults in `ai/openclaw/config/ai-monitor.config.json.example`. New AI servers should copy that template to `/etc/ai-monitor/config.json`, fill host-specific values, and keep `monitor_triage.auto_action_kinds_bypass_monitor` plus `pm_workflow.retry_after_tier3_seconds` aligned with this repo.
- ai-monitor live ticks are single-instance locked; `--dry-run` and `--probe-only` are read-only and do not write state. This prevents debugging or overlapping timer/manual runs from accidentally suppressing future recovery attempts or double-sending nudges.
- Agent dashboard: `https://dev.vixi.au/agents.html` (basic auth — same `admin` user as the per-agent vhosts, htpasswd at `/etc/nginx/.htpasswd`). Real-time per-agent activity, AI monitor status, monitoring agent decisions, system service health. SSE-driven, no refresh needed. See **§16 Agent Dashboard** subsection below for the architecture.
- ThinkPad cron job `/etc/cron.d/openclaw-integrity` was preserved for reference only. x1's active automation uses systemd timers, not cron.
- On openSUSE, the active scheduler is `openclaw-integrity.timer` plus `openclaw-integrity.service`, running every 2 minutes.
- `ai-monitor.timer` runs the AI judgment layer every 2 minutes, offset from the integrity check.
- `openclaw-backup.timer` runs a daily root-only backup of small critical OpenClaw state to `/var/backups/openclaw`, scheduled at 04:20 with up to 20 minutes randomized delay, and keeps the latest 14 archives.
- Remediation state path: `/var/lib/openclaw/remediation-state.json`.
- Remediation log path: `/var/log/openclaw-remediation.log`.
- Manual restart helper: `/root/restartOpenClaws.sh`.

Useful checks:

```
systemctl is-active ollama openclaw-integrity.timer
# For each coding agent (substitute <user>/<uid> from /etc/openclaw/agents.json):
sudo -u <user> XDG_RUNTIME_DIR=/run/user/<uid> DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus systemctl --user status openclaw-gateway.service openclaw-gmail-listener.service
# For the monitoring agent:
sudo -u karen XDG_RUNTIME_DIR=/run/user/1003 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1003/bus systemctl --user status openclaw-gateway.service openclaw-jira-receiver.service openclaw-bitbucket-receiver.service
/usr/local/bin/ollama list
/usr/local/bin/openclaw-registry-check --runtime
/usr/local/bin/openclaw-integrity-check
/usr/local/bin/ai-monitor --probe-only
/usr/local/bin/openclaw-boot-readiness
/usr/local/bin/openclaw-backup --inventory
```

#### Backup scope

openclaw-backup backs up small but high-value state only: /etc/openclaw, /etc/ai-monitor/config.json, /srv/Code/environment/ai/openclaw, /srv/Code/environment/ai/web, agent .openclaw and .config/openclaw directories, key workspace instruction files, webhook routing, and Ollama cloud identity keys. It excludes large caches, node_modules, browser data, git directories, and local model blobs. The archive and manifest are mode 0600 under /var/backups/openclaw.

This is a local safety net. Off-host copies should live on `moonlight` under `/srv/backups/openclaw/x1`; the first manual copy was written there on 2026-05-08. Future automation should sync the latest archive and matching `.manifest.json` there after each local backup.

### Agent Dashboard (`agent-dashboard`)

Added 2026-05-08. A read-only single-page dashboard at `https://dev.vixi.au/agents.html` showing what every agent on x1 is doing in real time: per-agent activity (latest assistant text / tool call / tool result, session-idle timer, primary model), current Jira task, open Jira tickets per coding agent, ai-monitor health and recent monitoring-agent decisions, and system-service status. Runs as a single Node service; the page itself is plain HTML with vanilla JS connecting to a Server-Sent Events stream — no framework, no build step.

#### URL and auth

- **Public**: `https://dev.vixi.au/agents.html` — terminates TLS at moonlight, proxies to x1's nginx, then to `127.0.0.1:3013`.
- **OpenClaw Control UIs**: x1 exposes the coding-agent gateway dashboards through nginx role-based routes backed by ports `18789` and `18790`. The routes are nginx basic-auth protected and pass `X-Forwarded-User: $remote_user` into OpenClaw trusted-proxy auth, so there is no second OpenClaw token login after nginx auth. The gateway ports bind to LAN for trusted-proxy source detection, but firewalld does not open 18789/18790 to the network.
- **Auth**: HTTP basic auth at the x1 nginx layer, `auth_basic_user_file /etc/nginx/.htpasswd` (same `admin` user that protects per-agent `*.vixi.au` vhosts).
- **Health probe**: `https://dev.vixi.au/agents/health` is unauthenticated by design — returns `{ok, agents, clients}` as JSON for cheap external uptime checks.

#### Files

| Path | Purpose |
|---|---|
| `/usr/local/bin/agent-dashboard` | Node server (~530 lines). Stdlib `http`, `fs`, `child_process`. Listens on 127.0.0.1:3013. |
| `/srv/Code/environment/ai/web/agents.html` | Single-file frontend (~810 lines including CSS + JS), redesigned 2026-05-10: modern dark/light themes (toggle persisted in `localStorage`), class-coded cards (`coding`/`monitor` accent colors), capability + integration + service badges per agent, SVG-free icons. Hydrates per-agent metadata from `/agents/registry.json` (auth-gated nginx alias to `/srv/agents/index.json` — the live runtime registry, NOT in the repo); live state still flows via the SSE stream. Tracked in `environment/ai/web/agents.html`. Served by **nginx** directly via `alias`; SELinux context `httpd_sys_content_t`. The legacy path `/usr/local/share/agent-dashboard/agents.html` is now a symlink to this file so the Node fallback path still works for loopback-direct fetches. |
| `/etc/agent-dashboard/config.json` | Bind address/port, `agents_registry` path, jira host, `system_services` list, poll intervals. |
| `/etc/systemd/system/agent-dashboard.service` | `Type=simple`, `Restart=always`, runs as root, depends on `network-online.target` and `ai-monitor.timer`. |

| /srv/Code/environment/ai/web/agents.html | Main dashboard frontend, served at /agents.html. |
| Dashboard experiment copy A | Independent copy of agents.html for frontend experiments. |
| Dashboard experiment copy B | Independent copy of agents.html for frontend experiments. |

| Source | Mechanism | Used for |
|---|---|---|
| `/home/<user>/.openclaw/agents/main/sessions/*.jsonl` (latest per agent) | `tail -F` (sub-second) | per-agent live activity stream — every assistant message, tool call, tool result is parsed and broadcast |
| `/home/<user>/tasks/current.md` | `fs.watch` | "current task" line per agent (ticket + heading) |
| `/var/log/ai-monitor/log.jsonl` | `tail -F` | last ai-monitor tick verdict + summary |
| `/var/lib/ai-monitor/decisions/*.json` | `fs.watch` | new monitoring-agent decisions appear as soon as written |
| `/var/lib/ai-monitor/state.json` | poll, 5 s | open events count |
| `systemctl is-active <unit>` | poll, 10 s | system + per-user service health (units come from `/etc/openclaw/agents.json` registry plus `system_services` from config) |
| Jira `/rest/api/3/search/jql` per coding agent | poll, 60 s, via `sudo -u <agent> curl` | open tickets list for each coding agent's card |
| latest session jsonl mtime | poll, 3 s | `idle Ns` counter on each agent card |

The dashboard reads `/etc/openclaw/agents.json` on startup to know which agents to watch — same registry the rest of the stack uses. New agents added there appear after a service restart.

#### SSE event types (broadcast to all connected browsers)

Dashboard location blocks live in /etc/nginx/vhosts.d/dev.conf:
- /agents.html: auth_basic + alias /srv/Code/environment/ai/web/agents.html.
- Dashboard experiment pages: auth_basic + alias to the matching tracked HTML copy.
- /agents/registry.json: auth_basic + alias /srv/agents/index.json.
- /agents/events: authenticated SSE proxy to agent-dashboard on 127.0.0.1:3013.
- /agents/health: unauthenticated health proxy.

#### Operational

```
sudo systemctl status agent-dashboard.service
sudo journalctl -u agent-dashboard.service -f                # service logs (file tails, polls, broadcasts)
curl -sS http://127.0.0.1:3013/agents/health                  # service health
curl -sS https://dev.vixi.au/agents/health -H 'User-Agent: x' # public health (UA required because moonlight bot-blocks empty UA)
```

#### Out of scope (v1)

- No interactive controls (wake-agent / restart buttons in the UI). Read-only.
- No long-term metrics / graphs. Use `/var/log/ai-monitor/log.jsonl` for that.
- No multi-user role separation — single `admin` basic-auth account.

### Recent changes (2026-05-08)

A consolidated note of decisions and changes since the last full rewrite of this section. Each bullet names the file path and current state.

- **Workflow rule — `Picking the Next Task` / always-feedback-first** (TEAM_WORKFLOW.md). After every `In Review` handoff or task completion, agents must exhaust unanswered feedback on review-stage tickets before starting `Selected for Development` or `To Do` work. `Backlog` always skipped. Pressure-relief escape hatch: ≥3 feedback rounds + zero `Selected for Development` progress > 24 h → one Telegram notice (max 1/24 h/agent), then continue feedback-first. Triggered for both coding agents on 2026-05-08 via `restart-and-wake` so the rule is in their loaded session context, not just on disk.

- **`monitor_triage` config block** (`/etc/ai-monitor/config.json`). On a new alert, ai-monitor now writes `/var/lib/ai-monitor/incidents/<id>.json`, wakes the monitoring agent via `openclaw system event --text "INCIDENT <id> ..."`, and polls `/var/lib/ai-monitor/decisions/<id>.json` for up to 300 s. The monitoring agent returns `{decision, reason, actions_taken, telegram_sent, timestamp}`. Self-incident guard: issues affecting the monitor user or `ai-monitor:` skip handoff and go to direct Telegram because the monitoring agent cannot safely triage its own outage.

- **Policy guardrail for `task-stalled-no-agent`**. When the monitoring agent returns `decision: suppress` with `actions_taken` not containing `wake-agent` or `restart-and-wake`, ai-monitor flags it as a policy violation. Reason: a Jira ticket marked `In Progress` with no recent agent session activity is *defined* as stalled regardless of LLM rationalisation.

- **Auto-wake fallback**. When the policy guardrail fires, ai-monitor itself runs `sudo /usr/local/sbin/openclaw-control wake-agent <user> "<reminder>"`, sleeps 15 s, and re-probes the agent's session jsonl mtime. If recovered (idle < 30 s after wake) → log silently, no Telegram. If still idle → Telegram with the wake attempt result. Net effect: stalled agents always get nudged on this kind, regardless of triage judgment.

- **Two-kind stall detection** (`/etc/ai-monitor/config.json` → `stalled_tasks_check`):
  - `task-stalled-no-agent` (primary) — Jira `In Progress` AND agent's `~/.openclaw/agents/main/sessions/*.jsonl` mtime > threshold. Defaults: warn at 5 min idle, crit at 15 min.
  - `task-stalled-no-progress` (secondary, only if primary doesn't fire) — Jira `updated` > 30 min on an `In Progress` ticket with a fresh session (i.e. agent alive but spinning, HOMELAB-5 pattern). No crit on this kind.
  Old single-threshold (`warn_minutes`/`crit_minutes`) is gone.

- **`openclaw-control restart-services` extension** (`/usr/local/sbin/openclaw-control`). Now matches both `openclaw-*.service` AND `wdt-*.service` user services for the target user, using `list-unit-files --state=enabled,enabled-runtime` so inactive enabled units are also (re)started via `systemctl restart`. Was previously openclaw-* only and only listed running units, which silently no-op'd on a stopped wdt-*. Pre-edit copy at `…openclaw-control.bak-<ts>`.

- **Monitoring agent's openclaw catalog — strictly ollama** (`/home/karen/.openclaw/openclaw.json`). The `models.providers.openai-codex` and `models.providers.openrouter` blocks were removed; only `models.providers.ollama` (4 cloud models) remains. The monitoring agent's primary stays `ollama/deepseek-v4-pro:cloud`.

- **Agent dashboard** (`agent-dashboard.service`, port 3013 loopback). Read-only real-time page at `https://dev.vixi.au/agents.html` (basic auth `admin`) showing per-agent activity, AI monitor health, monitoring-agent decisions, and system services. SSE-driven; tails session jsonl for sub-second updates. See `### Agent Dashboard` subsection above.
- **Local fallback model `qwen2.5:3b-instruct`** (~2 GB, q4_K_M, on x1's ollama). Appended as the tail entry of:
  - `/etc/ai-monitor/config.json` → `ai.fallback_models`: `["kimi-k2.6:cloud","qwen2.5:3b-instruct"]`
  - `/home/karen/.openclaw/openclaw.json` → `agents.defaults.model.fallbacks`: `[…, "ollama/qwen2.5:3b-instruct"]`
  Slow on Tiger Lake CPU (~30–60 s per inference) but keeps both ai-monitor and the monitoring agent functional offline.

- **Registry validation + boot readiness tooling** (`/usr/local/bin/openclaw-registry-check`, `/usr/local/bin/openclaw-boot-readiness`). The registry checker catches drift between `/etc/openclaw/agents.json`, the Linux users, shared docs symlink, ai-monitor config, webhook routing, declared services, and listener ports. The boot-readiness command runs the runtime registry validation, checks linger for monitored agents, then runs the integrity checker and ai-monitor probe.

- **Root-only OpenClaw backup path** (`/usr/local/bin/openclaw-backup`, `openclaw-backup.timer`). Daily local archives live under `/var/backups/openclaw` with mode `0600`; latest 14 are retained. Scope is small critical state only, not large caches or model blobs.
- **Off-host backup copy** (`moonlight:/srv/backups/openclaw/x1`). The first manual copy was made on 2026-05-08 using the latest local archive and manifest. Directory and files are root-owned/root-only.

- **Machine-readable remediation authority** (`/etc/openclaw/agents.json` → `capabilities`). The monitoring agent may triage incidents, wake/restart agents, and send Telegram monitor alerts; it may not modify code, transition/comment Jira, or send email until those capabilities are explicitly granted. Coding agents keep normal coding and communication capabilities but do not have monitor-remediation authority.

### Recent changes (2026-05-10)

Second consolidated note covering changes since the 2026-05-08 entry. Each bullet names current paths.
- **Shared docs + skills now live in the unified environment repo** (bitbucket.org:zehferrari/environment.git, working tree /srv/Code/environment). OpenClaw shared files are under /srv/Code/environment/ai/openclaw/; dashboard HTML is under /srv/Code/environment/ai/web/. Agent workspace files and shared skills symlink directly to those paths, and edits land through the environment repo root.

- **`/etc/openclaw/agents.json` is now a symlink** → `/srv/agents/index.json` (the live runtime registry, kept *outside* the git working tree at `/srv/Code/environment/ai/openclaw/` so dashboard toggle writes don't pollute `git diff`). ai-monitor, the dashboard, registry-check and the webhook receiver all read through the symlink transparently. The single-record template `/srv/Code/environment/ai/openclaw/index.example.json` stays in git as the in-repo reference; copy it to `/srv/agents/index.json` and edit when bootstrapping a new host. nginx alias for `/agents/registry.json` and the dashboard's `setRegistryFlag()` write target both point at the live file directly.

- **Dashboard HTML lives in the environment repo** (/srv/Code/environment/ai/web/). nginx serves the main dashboard and experiment HTML copies directly via alias from /etc/nginx/vhosts.d/dev.conf. The Node service still handles /agents/events, /agents/snapshot, registry toggles, service restarts, and /agents/health.

- **Webhook @-mention routing** (`/home/karen/webhooks/jira-receiver.js` + `/srv/agents/index.json`). `comment_*` events are parsed for both ADF and wiki-markup mentions (`[~accountid:712020:...]`). Jira Cloud delivers webhook `comment.body` as a wiki-markup string (not ADF — the REST API does ADF, webhooks do not), so `extractWikiMentions()` is the path that fires in practice. Mentioned agents are routed by `jira_account_id` lookup from enabled coding agents with `integrations.jira: true`; the wake message gets a "You were @-mentioned in <KEY> by <Mentioner>" prefix invoking the TEAM_WORKFLOW.md "Receiving an @-mention" rule. Comment author is excluded (no self-wake). Otherwise routing is assignee-only; unassigned Jira updates are not broadcast to all agents and are not executable work.

- **Pending-mention queue** (`/var/lib/ai-monitor/pending-mentions/`, root:karen 0775). Receiver writes one JSON per `(issue_key, comment_id, agent)` recording mention metadata. ai-monitor's new `probe_pending_mentions` walks the queue every tick, queries Jira for an agent reply on the issue dated ≥ the mention's `created`, and either deletes the resolved entry or surfaces a `mention-awaiting-reply` warn (≥15 min) or crit (≥60 min). Configured under `/etc/ai-monitor/config.json` → `pending_mentions` block.

- **Pending Epic-owner comment-review queue** (`/var/lib/ai-monitor/pending-epic-comments/`, monitor-agent owned 0775). When a known agent creates a Jira comment on an issue under an Epic, the webhook receiver records a marker. ai-monitor resolves the parent Epic owner through Jira, drops irrelevant markers (done issue/Epic, unowned Epic, owner authored the comment, owner already replied), and otherwise emits `epic-comment-awaiting-reply` warn (≥15 min) / crit (≥60 min). This kind bypasses monitor triage and wakes the Epic owner directly to read the comment and reply in Jira if required.

- **`jira-probe-failed` / `pending-mentions-probe-failed` axes** (`/usr/local/bin/ai-monitor`). Errors that previously hid in `stalled_tasks.errors` and `pending_mentions.errors` now surface as deterministic issues. Catches token expiry, rate-limit, and network breakage that would otherwise silently disable the alerts.

- **TEAM_WORKFLOW.md consolidated** (`/srv/Code/environment/ai/openclaw/TEAM_WORKFLOW.md`). Each coding agent's two paths (`/home/<user>/workspace/TEAM_WORKFLOW.md` and `/home/<user>/.openclaw/workspace/TEAM_WORKFLOW.md`) are now symlinks to the canonical shared file — single source of truth, edits land in one place, every agent picks up the change on next read.

- **New / updated TEAM_WORKFLOW.md sections**:
  - `Responding to @-mentions` — agents must reply on the ticket if @-mentioned, even if the ticket isn't theirs. Backed by the `mention-awaiting-reply` axis.
  - `Reply Formatting` — Jira/email replies must be proper markdown (blank-line-separated paragraphs, bullet/numbered lists, ATX headings, fenced code blocks, inline code, pipe tables). Walls of one-paragraph text are unacceptable. Telegram stays terse, no markdown decoration, no signature.
  - Updated `Outbound Signature Rule` — signature is now `--` / `<First Name>` / `<provider>/<model>` (no `Model:` prefix, first name only). Helpers render the provider/model line subdued (smaller, grey). Mandatory for Jira/email; forbidden in Telegram.

- **Shared skills tree** (`/srv/Code/environment/ai/openclaw/skills/`). Agent identity now flows from `/etc/openclaw/agents.json` (resolved by `os.userInfo().username`) through a small `agent-self.js` module, eliminating per-agent forks of helper code. Layout:
  ```
  /srv/Code/environment/ai/openclaw/skills/
    agent-self.js              # registry-driven identity resolver
    jira/                      # 9 files (lib.js reads email from agents.json)
      jira-comment.js, lib.js, jira-transition.js, jira-my-issues.js, ...
    google-workspace/          # 61 files (docs-comments-* read displayName from agents.json)
      gmail-send.js, mime.js, lib.js, drive-*.js, calendar-*.js, ...
  ```
  Per-agent `~/.openclaw/workspace/jira/*.js` and `~/.openclaw/skills/google-workspace/*.js` are now symlinks. Per-agent **state** files stay real per-agent (state.json, *-state.json, _comments.json, _docs.json, auto-reply-policy.json) — each agent maintains its own gmail/drive state. Pre-symlink originals saved as `*.bak-symlink-20260510T1100`.

- **`jira-comment.js` markdown → ADF** (`/srv/Code/environment/ai/openclaw/skills/jira/jira-comment.js`). Was a single-paragraph passthrough that crammed everything into one ADF text node; now parses markdown into a proper ADF doc — paragraphs, ATX headings (1–3), bullet/numbered lists, fenced code blocks, pipe tables, inline `**bold**` / `*italic*` / `` `code` `` / `[text](url)`. A trailing `--` / `<first name>` / `<provider>/<model>` signature is detected and the provider/model line gets ADF marks `subsup{type:sub}` + `textColor{#999999}` for a subdued render.

- **`mime.js textToHtml` signature styling** (`/srv/Code/environment/ai/openclaw/skills/google-workspace/mime.js`). Detects the trailing `--/Name/Provider/Model` paragraph and renders the provider/model line as `<span style="color:#888;font-size:smaller;font-style:italic;">…</span>` in the HTML email part. Plain-text part unchanged.

- **Coding role normalized** in `agents.json`: Asdrubal and Barekbaal use `role: coding`; `manager` and `developer` are task roles determined from Jira/Epic assignment or explicit handoff, not standing personas. `monitor` remains unchanged for Karen because it maps to a service responsibility.

- **Documentation generalised**: every prose mention of `Asdrubal`, `Barekbaal`, `Karen` removed from the shared docs (replaced with role-based or `<user>` references). Wire-format identifiers (`karen_decision` SSE event, `karen_triage` JSON config key, `auto_woke_after_karen_suppress` log/action string) kept verbatim because they're live code/config constants — annotated as such in this doc. The `agents.json` registry, the per-agent `SOUL.md`/`IDENTITY.md` (persona), and webhook routing config legitimately keep agent names as data.

- **Doc consolidation: `AGENTS.md` + `ROLES.md`**. The `AGENTS/` folder (manager.md / developer.md / monitor.md) was collapsed into a single shared `AGENTS.md` (operating baseline read by every agent regardless of role) and `ROLES.md` (task-role guidance plus the standing monitor role). Coding agents have registry `role: coding`; manager/developer are task roles proven by Jira/Epic assignment, not personas. All five per-agent `AGENTS.md` symlinks now point at the same shared file. Also: `TEAM_SHARED.md` deleted (was a strict duplicate of `TEAM_WORKFLOW.md`).

- **Action-indexed workflow doc**. `TEAM_WORKFLOW.md` got a Quick Index table at the top mapping "When you are about to X, read § Y", with action-titled section headings ("Sending an outbound", "Receiving an @-mention", "Picking your next task", "Working a Jira ticket", "Reviewing", "Email", "Telegram", "System / service operations", "Knowledge handling", "Escalation", "Task handoff"). Lets agents jump to the relevant ~10-line section instead of re-reading 200+ lines per task. Net byte size on always-loaded baseline (`AGENTS.md` + `ROLES.md` + `TEAM_WORKFLOW.md`) dropped ~24 % alongside.

- **Per-agent file audit**. Removed restated workflow rules (Communication, Boundaries, escalation criteria) from `SOUL.md` and `IDENTITY.md` for both coding agents — those rules now live exclusively in `AGENTS.md` and `TEAM_WORKFLOW.md`. Updated stale role names and obsolete model-tier framings; current policy is `role: coding` for coding agents, with manager/developer used only as task roles. The monitoring agent's stale `/home/zeh/AGENTS.md` reference in `IDENTITY.md` was replaced with the actual canonical doc paths.

- **Workspace divergence resolved**. For each coding agent, `~/.openclaw/workspace/{SOUL,IDENTITY,USER,TOOLS,MEMORY,HEARTBEAT}.md` was previously a separate file from `~/workspace/<file>` — typically a generic openclaw template, drifted from the user-customised `~/workspace/` version. Each `~/.openclaw/workspace/` per-agent file is now a symlink to its `~/workspace/` canonical. Pre-unification originals saved as `*.preunify-20260510T1541` for inspection. Net effect: a single canonical location per per-agent file regardless of which workspace the runtime reads.

### Recent changes (2026-05-13)

Set of fixes triggered by moving an agent onto the `claude-cli` provider and discovering the rest of the stack assumed the openclaw session jsonl was the source of truth for "is the agent doing anything". For `claude-cli` sessions openclaw doesn't write its own session jsonl — conversation content lives only in `~/.claude/projects/-home-<user>-workspace/<sid>.jsonl` — and there are no incremental tool/text events back into openclaw's typing pipeline either. Bookkeeping in `~/.openclaw/agents/main/sessions/sessions.json` is the only signal that survives across providers, so several places now read it directly.

- **Stall probe upgraded** (`/usr/local/bin/ai-monitor` → `probe_session_idle_for_user`). Previous probe: `ls -t .openclaw/agents/main/sessions/*.jsonl | head -1` then `stat`. New probe takes max of (a) newest openclaw jsonl mtime AND (b) max `updatedAt` across **all** `agent:main:*` keys in `sessions.json`. Source (b) is what catches `claude-cli` sessions and activity on non-heartbeat surfaces (Telegram DMs, subagents). Without it `task-stalled-no-agent` false-fires for any agent on `claude-cli` even while opus is mid-turn.

- **Dashboard idle indicator + tail dispatch** (`/usr/local/bin/agent-dashboard`). Mirror change: `mostRecentActivityMs(user)` does the same max(jsonl-mtime, sessions.json-updatedAt-across-all-keys) calculation. New `pickActiveSessionInfo(user)` scans every `agent:main:*` conversation key, picks the one with the most-recent `updatedAt`, and returns `{file, format}`. For a `claude-cli` key it returns the claude-cli jsonl path under `~/.claude/projects/-home-<user>-workspace/<claudeCliSessionId>.jsonl` with `format: 'claude-cli'`; otherwise the conversation entry's own `sessionFile` with `format: 'openclaw'`. `startSessionTail` then dispatches each line to either `handleSessionLine` (openclaw schema: `{type, message}`) or the new `handleClaudeCliLine` (claude-cli schema: `{type:'user'|'assistant', message:{role,content,model,stop_reason}, timestamp}`). `summarizeContentClaudeCli` maps content blocks `text`/`tool_use`/`tool_result`/`thinking` into the same shape `agentsActivity` already renders, so no frontend change was needed for the activity log. `rotateSessionTailsIfNeeded` (every 30 s) detects file OR format flips and re-spawns the tail.

- **Per-agent currently-running model** displayed on each agent tile. Backend has a new `currentModelFromSessions(user)` helper that returns `<modelProvider>/<model>` for the most-recent `agent:main:*` entry — runs as part of `pollSessionIdle` so it covers initial paint, fallback engagement, and `claude-cli` agents whose stream events never reach the openclaw jsonl. `model_primary` is broadcast as a `model_change` event when it transitions. Frontend renders it as a `model-chip` badge in the agent card meta-row; `shortModel()` strips verbose prefixes (`claude-`, `:cloud`, `openrouter/<vendor>/`) so the chip stays tile-sized; the full `provider/model` is the tooltip. Reflects what the agent is *actually* running (after fallbacks), not just the configured primary.

- **Telegram typing-keepalive sidecar** (`/usr/local/bin/openclaw-typing-keepalive`, `openclaw-typing-keepalive.service`, system-wide). The cli-backend (`runCliAgent` in `cli-runner-BI7Whd5n.js:7`) is non-streaming — it `await`s the full claude response in one call, no incremental events. openclaw's built-in typing keepalive has a ~60 s TTL refreshed by those events; without them "typing…" disappears mid-turn on long opus runs. The sidecar polls each registered agent's `sessions.json` every 1 s, finds telegram conversation keys (`agent:main:telegram:direct:<chat>` or `:group:<chat>`) currently `status=running` on `modelProvider=claude-cli`, and re-fires `sendChatAction("typing")` for the matching chat every 4 s until status flips back to `done`. Reads each agent's bot token from `~/.config/openclaw/openclaw-secrets.env` (`TELEGRAM_BOT_TOKEN`). Auto-discovers from `/etc/openclaw/agents.json` — adding a new agent to the registry and giving it `enabled + telegram.enabled` is enough; no per-user install. Agents on `ollama` / `openai-codex` / other providers are skipped silently because they emit native streaming events that drive the in-process typing pipeline correctly. Picked up by `openclaw-control restart-services` via the `openclaw-*` prefix.

- **`sessions.json` is now a first-class probe surface.** Three independent places (ai-monitor, dashboard, typing-keepalive) read it directly: `agent:main:main.updatedAt` for the heartbeat conversation's last activity; the full set of `agent:main:*` keys for cross-conversation activity max; `claudeCliSessionId` / `cliSessionBindings.claude-cli.sessionId` for resolving the claude-cli jsonl file path; `modelProvider`/`model` for the currently-running model. Schema noted here so future probes don't re-derive these fields — the file is mode `0600` owned by the agent user; root readers (ai-monitor, dashboard, typing-keepalive) read directly.

- **New `agent-idle-with-queue` axis** (`/usr/local/bin/ai-monitor` → `probe_idle_with_queue_for_agent` + `probe_agent_queue`). Closes the gap that `task-stalled-no-agent` couldn't see: agent finishes a ticket → transitions out of *In Progress* → has zero In Progress tickets → the existing stall probe finds nothing to attach an alert to. Meanwhile *Selected for Development* / *To Do* tickets sit unstarted indefinitely. New probe queries `assignee=currentUser() AND status in (In Progress + queue_statuses)` per coding agent each tick, classifies locally; fires when *queue_count ≥ 1 AND in_progress_count = 0 AND session_idle_s ≥ threshold*. Defaults: `queue_statuses = ["Selected for Development", "To Do"]`, 10 min warn / 30 min crit. Configured under `/etc/ai-monitor/config.json` → `agent_queue_check`. Severity-named issue is `jira:<user>/queue` with `kind: agent-idle-with-queue`; reason text names the first 5 queued keys for context.

- **Bypass-monitor path for deterministic kinds** (`dedupe_and_act`). The `monitor_triage.auto_action_kinds_bypass_monitor` config list controls deterministic issues such as `agent-idle-with-queue`, `email-awaiting-action`, and PM workflow drift. When one appears, ai-monitor partitions it out of the monitor-agent-bound set, runs the bounded recovery action directly, and records a bypass-monitor action in the verdict log. If all issues in the tick were auto-handled, the monitor-agent handoff is skipped entirely: no incident written, no Telegram. Rationale: when the situation is unambiguous and the action is bounded plus idempotent, a triage round-trip adds latency and can suppress the required wake. To extend, add a kind to the config list; no code change is required.

### Recent changes (2026-05-20)

Big registry refactor: separate identity (central) from derived data (defaults) from per-agent project resources (per-agent files). Goal: `agents.json` carries only flags; everything else is computed.

- **New schema `agent-defaults.json`** (`/srv/Code/environment/ai/openclaw/agent-defaults.json`, symlinked to `/etc/openclaw/agent-defaults.json`). Defines `core` (services every agent gets), `byRole` (services + capabilities per role: `coding` modifies code and works tickets; `monitor` triages incidents and wakes/restarts other agents — never both), and `byIntegration` (each enabled integration contributes its services + capabilities). Per-agent overrides under `agent.capabilities` (key-by-key override) and `agent.services` (append) still win. `can_send_telegram_alerts` replaced by `send_alerts_to: "telegram"` (default for monitor role).

- **`agents.json` slimmed.** Dropped the `services` and `capabilities` arrays (now derived). Dropped the `monitor` and `coding` boolean flags — `role` is now the single exclusive switch (`coding | monitor`, never both). Dropped `integrations.wdt` — WDT moved to per-agent `monitor.json` (see next bullet). Listeners stay (host-specific, not derivable).

- **Per-agent `~/.local/openclaw/monitor.json`**. Each agent declares their own project resources (WDT dev playground, custom containers, etc.) in this file. Schema: `{ resources: [{ name, enabled, services, listeners }] }`. The single `enabled` flag controls both whether the service runs AND whether ai-monitor / agent-dashboard probe it. Side projects come and go without touching the central registry.

- **`openclaw-monitor-sync`** (`/usr/local/sbin/openclaw-monitor-sync`, `openclaw-monitor-sync.{service,path,timer}`). Reconciles actual systemd state against each agent's `monitor.json`. Path-watch unit fires within ~1 s of any `monitor.json` write; timer runs every 5 min for drift correction. Idempotent. Manual invocation: `sudo /usr/local/sbin/openclaw-monitor-sync [<user>]`. Verified end-to-end with the WDT round-trip: flip `enabled` to `false` → service stops within 4 s + ai-monitor drops it from the sweep → flip back to `true` → service restarts + reappears in the sweep.

- **`derive_effective_agent(agent, defaults)` shared helper** (mirrored in Python for `ai-monitor` and `openclaw-integrity-check`, in JS for `agent-dashboard`). Merge order: `core` → `byRole[role]` → `byIntegration[k]` for every truthy integration → per-agent overrides → per-agent `monitor.json` enabled resources. All consumers see a single uniform view; callers no longer touch `agent.monitor` / `agent.coding` (gone), just `agent.role`.

Known follow-ups:

- If BotFather tokens are ever rotated, update each user's `telegram-token` and OpenClaw secrets env.
- The Ollama service on `x1` uses conservative default backend settings, not ThinkPad-specific GPU tuning.
- x1 is still a single point of failure for its OpenClaw agents, monitoring, and remediation. Local backup reduces accidental-loss risk; disk-loss protection depends on keeping `moonlight:/srv/backups/openclaw/x1` current.
- Gmail watch renewal is automated (daily cron via OpenClaw cron system, see § Gmail Automation). IAM: the SA `gmail-watch@asdrubal-projects.iam.gserviceaccount.com` now has `roles/pubsub.editor` (granted 2026-06-07) so subscriptions can be recreated if lost. Keep `/usr/local/bin/openclaw-integrity-check` and dashboard status green; verify that base `openclaw-gmail-listener.service` units reference agent-specific subscription names (not the legacy `gmail-inbox-watch-sub`).
- The monitoring agent runs on the host it monitors. Self-incidents must continue to bypass the monitoring agent and go directly to Telegram fallback.
- Secrets are split by Linux user for least privilege, which is correct, but audits should use `/usr/local/bin/openclaw-backup --inventory` plus `/usr/local/bin/openclaw-registry-check`.
- Future changes should go through `/etc/openclaw/agents.json` and `/srv/Code/environment/ai/openclaw`; hand-editing dependent configs without running the validator can reintroduce drift.

---

## 21. Duplicating the OpenClaw Agent Instance on a New Computer

This chapter captures the yoga510 migration pattern for bringing up a new local agent host that shares selected operating behaviour with x1 without treating the new agents as continuations, replacements, or clones of previous agents.

### 21.1 Decide the user mapping first

Create the target Linux users before installing OpenClaw. Keep a written class
map for the target users, including which operating profile each user should
follow:

| Source class | Target example from yoga510 |
|---|---|
| Owner/admin | `rachael` |
| Coding-agent behaviour | `ada` |
| Coding-agent behaviour | `claudia` |
| Monitoring-agent behaviour | `emery` |

Use the target names everywhere in runtime paths: `/home/<target>`, `/home/<target>/workspace`, `/home/<target>/.openclaw`, systemd user services, Maildir ownership, and `/etc/openclaw/agents.json`.

### 21.2 Install the shared runtime

On a fresh Debian-like target, install the base packages, Node 24, and the same OpenClaw release used by x1:

```bash
apt-get update
apt-get install -y git curl ca-certificates gnupg sudo rsync unzip tar gcc g++ make python3 python3-pip inotify-tools jq
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup_24.sh
bash /tmp/nodesource_setup_24.sh
apt-get install -y nodejs
npm install -g openclaw@2026.5.7
printf "%s\n" "#!/bin/sh" "exec /usr/bin/node \"\$@\"" > /usr/bin/node-24
chmod 0755 /usr/bin/node-24
```

Create a shared group for agent-readable repo files, then clone the environment repo as the owner/admin user. On yoga510 the checkout lives under the owner home, not under `/srv`, so it stays outside the samba-backed tree while remaining readable by agents:

```bash
groupadd -f code-agents
usermod -aG code-agents <owner> <code-agent-1> <code-agent-2> <monitor-agent>
install -d -m 2775 -o <owner> -g code-agents /home/<owner>/Code
sudo -u <owner> git clone git@bitbucket.org:zehferrari/environment.git /home/<owner>/Code/environment
chgrp -R code-agents /home/<owner>/Code/environment
find /home/<owner>/Code/environment -type d -exec chmod g+rws {} +
find /home/<owner>/Code/environment -type f -exec chmod g+rw {} +
```

If root/admin validation commands use Git in that checkout, add `/home/<owner>/Code/environment` as a safe directory for that account. x1 is the legacy exception that still uses `/srv/Code/environment`.

### 21.3 Build each agent home

For every target agent:

- Create `~/.openclaw`, `~/.openclaw/workspace`, `~/.openclaw/agents/main`, `~/.config/openclaw`, `~/.config/systemd/user`, `~/workspace`, and `~/Maildir/{new,cur,tmp}`.
- Symlink shared documents from the host checkout (`/home/<owner>/Code/environment/ai/openclaw` on yoga510, `/srv/Code/environment/ai/openclaw` on x1) into both `~/workspace` and `~/.openclaw/workspace`: `AGENTS.md`, `ROLES.md`, `TEAM_WORKFLOW.md`, `CODE_REPOS.md`; add `INCIDENT_HANDLING.md`, `MONITORING.md`, and `SERVICES.md` for the monitor agent.
- Keep persona/runtime files per-user: `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `MEMORY.md`, `HEARTBEAT.md`.
- Set `~/Code -> /home/<owner>/Code` for users that should work with the shared repository tree on yoga510.
- Generate new local secrets; do not copy Telegram, model provider, OAuth, or webhook secrets from x1 unless that is explicitly intended.
- For Telegram, keep the x1-compatible single-account shape under `channels.telegram` with `enabled`, `dmPolicy: pairing`, `groupPolicy: allowlist`, `streaming.mode: partial`, and `tokenFile: /home/<agent>/.config/openclaw/telegram-token`. Do not use `channels.telegram.accounts.*` unless intentionally changing the host convention. Token files must be owned by the agent and mode `0600`.

Create `/etc/openclaw/agents.json` as the host-level runtime registry. It should contain one record per enabled agent with `user`, `role`, `home`, `workspace`, `gatewayPort`, `services`, and integration flags. The dashboard and integrity tooling read this file as the live source of truth.

### 21.4 Prefer Maildir for local mail hosts

When the new host already delivers mail locally through Postfix/Dovecot, OpenClaw does not need Gmail or IMAP credentials. The yoga510 pattern is:

- Postfix delivers incoming mail to `~/Maildir`.
- Dovecot remains available for human IMAP clients.
- Agents read `~/Maildir/new` and `~/Maildir/cur` directly.
- Replies and new outgoing mail go through `/usr/sbin/sendmail -oi -t`.
- Read state is Maildir-native: move messages from `new/` to `cur/` with `:2,S`.
- A listener service watches `~/Maildir/new` and writes events to `~/.openclaw/mail/events.jsonl`.

The reusable skill lives at `/home/<owner>/Code/environment/ai/openclaw/skills/local-mail` on yoga510 (`/srv/Code/environment/ai/openclaw/skills/local-mail` on x1). Link it into each agent as `~/workspace/mail`, `~/.openclaw/workspace/mail`, and `~/.openclaw/skills/local-mail`.

### 21.5 Services to enable

Enable linger for each agent so user services survive logout:

```bash
loginctl enable-linger <agent>
systemctl start user@$(id -u <agent>).service
```

Each agent should normally have these user services:

- `openclaw-gateway.service`
- `openclaw-mail-listener.service` when using local Maildir
- `openclaw-gmail-listener.service` for Gmail integrations
- `openclaw-jira-receiver.service` and `openclaw-bitbucket-receiver.service` (monitor agent only, when enabled)

Host-level services/timers to install:

- `agent-dashboard.service` on `127.0.0.1:3013`
- `openclaw-typing-keepalive.service` if Telegram/long-turn typing support is required; on Telegram-disabled hosts it can be a harmless registry watcher
- `openclaw-backup.timer`
- `openclaw-integrity.timer`

For the monitor user, create a narrow sudoers file modelled after `karen-openclaw-control`, but scoped to the target users and target host services only.

### 21.6 Web dashboard and protection

The dashboard source pages stay in the checkout at `/home/<owner>/Code/environment/ai/web/` on yoga510 (x1 legacy path: `/srv/Code/environment/ai/web/`). On yoga510 nginx serves `agents.html` directly from that checkout as the web root, proxies dashboard API routes to the local dashboard service, and maps `/agents/avatars/<Name>` to `/srv/agents/Pictures/<Name>/avatar.png`:

~~~nginx
server {
    listen 80;
    listen [::]:80;
    server_name agents.example.com;

    root /home/<owner>/Code/environment/ai/web;
    index agents.html;

    auth_basic "Agents";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location = / { try_files /agents.html =404; }
    location = /agents.html { try_files /agents.html =404; }
    location ~ ^/agents/avatars/([^/]+)$ {
        alias /srv/agents/Pictures/$1/avatar.png;
        default_type image/png;
        add_header Cache-Control "public, max-age=300";
    }

    location = /agents/registry.json {
        alias /etc/openclaw/agents.json;
        default_type application/json;
    }

    location /agents/ {
        proxy_pass http://127.0.0.1:3013;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
~~~

For private dashboards, copy the existing nginx password file from x1:

```bash
scp x1:/etc/nginx/.htpasswd /etc/nginx/.htpasswd
chown root:root /etc/nginx/.htpasswd
chmod 0644 /etc/nginx/.htpasswd
nginx -t && systemctl reload nginx
```

Unauthenticated checks for `/`, `/agents.html`, `/agents/registry.json`, `/agents/snapshot`, and `/agents/events` should all return `401`.

### 21.7 Validation checklist

Run these before considering the clone complete:

```bash
node --version
node-24 --version
npm --version
openclaw --version
git -C /home/<owner>/Code/environment status --short
/usr/local/bin/openclaw-integrity-check
```

Also verify:

- `openclaw config validate` passes as every agent user.
- `systemctl --user is-active` reports active for each agent service.
- Local mail delivery works for every agent: send a message, list it, read it, mark it read, and reply through Postfix.
- `agent-dashboard.service`, `nginx`, `postfix`, and `dovecot` are active where applicable.
- Gateway ports are listening as intended: code agents may bind LAN, monitor agents should usually bind loopback.
- A backup archive exists under `/var/backups/openclaw/`.
