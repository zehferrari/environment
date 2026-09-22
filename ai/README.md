# ThinkPad — Bookshelf 24/7 AI Agent Host

Documentation of the openSUSE Tumbleweed setup on the ThinkPad P16s Gen 2, configured to run lid-closed on a bookshelf 24/7 while still supporting an occasional Hyprland session.

Last configured: 2026-05-06.

---

## 1. Identity and Access

| Field | Value |
|---|---|
| Hostname | `thinkpad` |
| Static IP | `10.0.0.105` (router-pinned to USB-C dock NIC MAC) |
| Hardware | Lenovo ThinkPad P16s Gen 2 (`20YK0011AU`) |
| CPU | AMD Ryzen 7 PRO 7840U (8C/16T, Phoenix) |
| GPU | AMD Radeon 780M (integrated) |
| RAM / Swap | 60 GiB / 2 GB partition swap |
| Disk | NVMe Samsung SSD 990 PRO 1 TB — see partitioning below |
| OS | openSUSE Tumbleweed (snapshot 20260430 at install) |
| Kernel | `7.0.2-1-default` (rolling) |
| Battery | (P16s battery details — see `p16s/README.md` for full hardware specs) |

### SSH

- **Address**: `ssh zeh@10.0.0.105`
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
| `enp0s20f0u5u4` | USB-C dock Ethernet | `r8152` (Realtek RTL8152, 100 Mbps) | `10.0.0.105` (router-pinned) |
| `wlp0s20f3` | Internal Wi-Fi (Intel AX201) | `iwlwifi` | `10.0.0.9` (DHCP, fallback) |

NetworkManager prefers Ethernet (metric 100 < Wi-Fi metric 600). Wi-Fi stays up as a backup if the dock disconnects.

Firewalld zone: `public`. Allowed services: `ssh`, `http`, `https`, `dhcpv6-client`.

---

## 4. Power and Thermal

### Charge thresholds (TLP)

Repo source: `ai/host/tlp/30-charge-thresholds.conf`, installed at
`/etc/tlp.d/30-charge-thresholds.conf`:

```
START_CHARGE_THRESH_BAT0=75
STOP_CHARGE_THRESH_BAT0=80
CPU_BOOST_ON_AC=1
CPU_BOOST_ON_BAT=0
CPU_SCALING_GOVERNOR_ON_AC=powersave
CPU_SCALING_GOVERNOR_ON_BAT=powersave
CPU_ENERGY_PERF_POLICY_ON_AC=balance_performance
CPU_ENERGY_PERF_POLICY_ON_BAT=balance_power
PLATFORM_PROFILE_ON_AC=balanced
PLATFORM_PROFILE_ON_BAT=low-power
```

**Why 75/80**: a li-poly battery sitting permanently at 100% AC degrades fast. This range cycles in a narrow band that maximizes lifetime at the cost of capacity-as-UPS.

The Ryzen 7840U uses `amd-pstate-epp`, which exposes `performance` and
`powersave` governors—not `schedutil`. `powersave` still boosts dynamically;
the EPP setting controls how eagerly it boosts. `tlp.service` must be enabled
so the policy is reapplied on boot.

Live values are readable at
`/sys/class/power_supply/BAT0/charge_control_{start,end}_threshold`. Verify with
`sudo tlp-stat -s -p -b`.

### Thermal: DYTC (NOT thermald)

`thermald` is **disabled**. The ThinkPad firmware/EC platform profile and
`amd-pstate-epp` manage the Ryzen CPU's thermal and frequency policy.

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

Repo sources are under `ai/host/systemd/` and install into
`/etc/systemd/system/`:

- `zypper-dup.service` — runs `zypper ref` then `zypper --non-interactive dup --auto-agree-with-licenses --replacefiles --download in-advance`. The license option is a `dup` option and must follow the command.
- `zypper-dup.timer` — `OnCalendar=Sun 03:30`, `RandomizedDelaySec=30min`, `Persistent=true`.
- `ConditionACPower=true` on the service — won't run if on battery.
- The service does not impose a systemd start timeout, because hard-killing an
  RPM transaction can leave a partial rolling upgrade. It treats zypper's
  informational reboot/service-restart codes as successful.

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
| Chromium | 151.0.7922.71 | per-agent, gateway-managed | System package at `/usr/bin/chromium`; one isolated managed profile per OpenClaw Linux user. |

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
- `wob` volume OSD (not installed on thinkpad)
- Bindings and exec-once entries that referenced scripts living in the desktop's `~/.local/bin` or `~/Scripts/` (loadSession, closeWindows, shutdown, show-keybindings, gnome-control-center, gnome-calendar, hyprlock-dpms, grimblast)
- `custom/displays` waybar module (no `wdisplays` use case on a 14" panel)

### What was *substituted*

| Desktop | thinkpad |
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

This is the version on thinkpad; relevant for editing the config:

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
ssh zeh@10.0.0.105 'for s in sshd nginx php-fpm mariadb tlp firewalld zypper-dup.timer bluetooth NetworkManager; do
  printf "%-22s %s/%s\n" "$s" "$(systemctl is-active $s)" "$(systemctl is-enabled $s)"
done'
```

### Charge / battery health

```
ssh zeh@10.0.0.105 'sudo tlp-stat -b | grep -E "energy_full|cycle_count|charge_control"'
```

### Force a Tumbleweed update now

```
ssh zeh@10.0.0.105 'sudo zypper ref && sudo zypper -n dup --auto-agree-with-licenses'
```

### See config errors after editing Hyprland config

```
ssh zeh@10.0.0.105 'HIS=$(ls /run/user/1000/hypr/ | tail -1); HYPRLAND_INSTANCE_SIGNATURE=$HIS hyprctl configerrors'
```

### Hyprland log tail

```
ssh zeh@10.0.0.105 'tail -50 $(ls -t /run/user/1000/hypr/*/hyprland.log | head -1)'
```

### Restart waybar

```
ssh zeh@10.0.0.105 'killall waybar; HIS=$(ls /run/user/1000/hypr/ | tail -1); HYPRLAND_INSTANCE_SIGNATURE=$HIS hyprctl dispatch exec /home/zeh/.config/waybar/launch-waybar.sh'
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

> **Update:** As of the host-swap rename, these services have **moved back to `thinkpad`** (`10.0.0.105`). The prose and paths below describe the 2026-05-06 migration as a historical marker of how the AI agent host landed on `x1` at the time, and were retained as the lineage note for the migration back. The AI agent host is now `thinkpad`; `x1` (`10.0.0.108`) is the personal laptop.

| UID/GID range | Role | Notes |
|---:|---|---|
| `1001+` | Coding agents (`role: coding`) | Full OpenClaw agent, Telegram/Gmail/Jira auth. One UID per registered agent in `agents.json`. |
| `1003` | Monitoring agent (Linux user `karen`) | Telegram alert persona, multi-tenant webhook dispatch account, shared web root. |

The authoritative roster — usernames, UIDs, operational role/class, services,
and ports — is `/etc/openclaw/agents.json`. Add or rename agents only by
editing that registry; coding task roles still come from Jira/Epic context.

Runtime notes:

- Source homes are still intact on `thinkpad`, but migrated user services and linger are disabled there.
- `moonlight` proxies the relevant `vixi.au` routes to `10.0.0.105` in `/etc/nginx/sites-available/vixiAu`; disabled `/etc/nginx/sites-available/webhooks` was also updated from `10.0.0.108` to `10.0.0.105`.
- Global OpenClaw lives at `/usr/local/lib/node_modules/openclaw`; `/usr/local/bin/openclaw` points to it.
- `pnpm` 10.33.0 is installed at `/usr/local/lib/node_modules/pnpm` and `/usr/local/bin/pnpm` for Node project builds.
- Tumbleweed's Node 24 binary rejects being invoked as `node-24`, so `/usr/bin/node-24` is a wrapper that execs `/usr/bin/node` with argv name `node`.
- SELinux is enforcing. nginx needs `httpd_can_network_connect`, ACL traverse rights on migrated home dirs, and `httpd_sys_content_t` labels on migrated web roots/static assets.
- Root SSH client material from `thinkpad:/root/.ssh` was migrated because the integrity checker probes `moonlight` over SSH.
- `/etc/hosts` maps `moonlight` to `10.0.0.10` for the same integrity probe.
- OpenClaw services must run as their Linux users, never as root.
- Listener processes should bind to loopback unless nginx is intentionally exposing them locally. Public ingress terminates at `moonlight`, then proxies to nginx on `thinkpad`.

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

The compact PM task runtime was enabled on **2026-09-08**. Both PM services
have `PM_TASK_RUNTIME_V2=1`; the persistent setting is in `/etc/default/pm`
and the effective copy is in `/etc/default/pm-active-worktree`. PM channel
plugin 0.1.2 is installed on Asdrubal, Karen, Barekbaal and Carmen. Updated
shared agent instructions were synchronized and all gateways passed their
authenticated native-tool capability checks. Scope and operational procedures:
[compact PM task runtime](web/docs/pm-task-runtime.md).

Expected enabled user services/timers, by role (concrete user → services map is in `/etc/openclaw/agents.json` `services`):

| Role | Services / timers |
|---|---|
| Monitoring agent (user `karen`) | `openclaw-gateway.service`, `openclaw-jira-receiver.service`, `openclaw-bitbucket-receiver.service` |
| Each coding agent (one row per agent in registry) | Core: `openclaw-gateway.service`, `openclaw-gmail-listener.service` (derived from `role` + `integrations` via `agent-defaults.json`). Plus any project resources the agent has enabled in `~/.local/openclaw/monitor.json` (e.g. `wdt-<user>.service`). |

Expected listeners on `thinkpad` (concrete `user → port` map is in `agents.json` `listeners`):

| Port range | Role | Service |
|---:|---|---|
| `18789–1879N` (one per coding agent) | Coding agent | OpenClaw gateway |
| `18791, 18792, …` (one per coding agent) | Coding agent | OpenClaw browser sidecar |
| `18793` | Monitoring agent (`karen`) | OpenClaw gateway |
| `3000` | Project Manager (`karen`) | PM (Mission Control) web server, Next.js loopback |
| `3014` | Monitoring agent (`karen`) | OpenClaw Jira webhook receiver |
| `3015` | Monitoring agent (`karen`) | OpenClaw Bitbucket webhook receiver |
| Per-agent project resources (e.g. `3001, 3002, …`) | Coding agent | Declared in that agent's `~/.local/openclaw/monitor.json` (e.g. WDT Next.js standalone, loopback). Each resource's `enabled` flag controls both whether it runs and whether it's monitored. |
| `11434` | system (`ollama`) | Ollama API, loopback |
| `3013` | system (`root`, `agent-dashboard.service`) | Agent dashboard backend (HTTP + SSE), loopback only — public access via nginx at `https://dev.vixi.au/agents.html` with basic auth |

OpenClaw 2026.7+ makes the standalone browser-control listener opt-in. Coding
agent gateways keep the existing monitored topology through the managed
`25-browser-control.conf` drop-in
(`OPENCLAW_EAGER_BROWSER_CONTROL_SERVER=1`), with the loopback sidecar at
`gateway port + 2`. Monitor gateways do not advertise this optional listener.

The browser sidecar is only the control plane; it does not supply a browser
binary. The host installs the Tumbleweed `chromium` package and pins every
enabled agent's `browser.executablePath` to `/usr/bin/chromium`, with
`browser.enabled=true`, `headless=true`, `noSandbox=false`, and the managed
`openclaw` profile. OpenClaw stores that profile under the running user's own
`~/.openclaw/browser/openclaw/user-data`; agents share the maintained binary,
never cookies, locks, cache, or login state. Coding agents use the eager
sidecar; the monitor agent uses the same local managed browser through its
gateway's lazy in-process control runtime.

Validate one agent without borrowing another user's cache or starting a
separate CDP daemon:

```bash
sudo -u <agent> env HOME=/home/<agent> openclaw browser doctor --deep
sudo -u <agent> env HOME=/home/<agent> openclaw browser status --json
```

The exact port numbers per registered user live in `agents.json` (`listeners[].host:port`); `openclaw-registry-check --runtime` validates that the listed ports are actually bound.

### Project Manager (Mission Control) Services

The Project Manager (Mission Control) web interface and queue processor run as host-wide system-level services on `thinkpad` under user `karen`.

- **`pm.service`**: A system-wide `systemd` service running the Next.js production standalone server on `127.0.0.1:3000`.
  - Env configuration loads from `/etc/default/pm`.
  - Serves the Mission Control web interface at `https://agents.vixi.au` (via Nginx reverse proxy).
  - Background intervals (periodic agent sync, hourly soft-delete bin purges, and orphaned attachment cleanup) are scheduled in-process via Next.js `instrumentation.node.ts` scheduler.
- **`pm-consumer.service`**: A system-wide `systemd` service that watches for events dropped by the web application into `/var/lib/pm/drop/`.
  - Runs in a loop using `pnpm tsx` to execute `scripts/pm-consumer-loop.ts`.
  - Reads dropped event files and triggers loopback wake requests (`POST /hooks/wake`) to target agent gateways (e.g. `http://127.0.0.1:18789/hooks/wake` with Bearer tokens).
  - Configured with `ProtectHome=true` and service-private cache/config directories under `/var/lib/pm/` (`pnpm-home`, `pnpm-config`, `pnpm-cache`, `.npmrc`) to avoid home directory configuration leaks.
- **Native PM workflow notifications**: Mission Control sends workflow turns through the same native `pm` channel used for task comments. Backlog assignment wakes the assigned agent only to post a concise implementation plan/opinion as a task comment; `To Do` is the approval-to-execute signal; assignees then move to `In Progress`, and move to `Review` when work is complete or when they need reviewer/manager/reporter feedback. The resolved reviewer moves satisfied work to `Done` without approval-only comments or leaves feedback. If an agent has no new information, action result, plan, feedback, blocker, or necessary question, PM supports a silent no-contribution completion instead of visible chatter.
- **Monitor-agent workflow enforcement**: `ai-monitor` reads the PM SQLite database read-only and raises/wakes on missing Backlog plans, stale `To Do`, stale `In Progress`, Review waiting on a reviewer, Review feedback waiting on the assignee, tasks blocked by a non-Open Epic, and stale active workflow live-bubble turns that no longer match the task's current owner/status. PM workflow drift is deterministic: it bypasses monitor-agent judgment and runs the native PM nudge ladder directly. Semantic drift does not restart a healthy agent/browser; service restart is reserved for concrete PM-channel delivery/runtime failure.
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
Incoming webhooks from Atlassian (Jira/Bitbucket) flow from public URLs through `moonlight` and `thinkpad` nginx, routing to `openclaw-jira-receiver.service` (port `3014`) and `openclaw-bitbucket-receiver.service` (port `3015`) running under `karen`.

### OpenClaw Architecture

- OpenClaw runtime was migrated from ThinkPad runtime `2026.4.15`.
- Per-user OpenClaw state lives under `/home/<user>/.openclaw/`.
- Full users have `~/.config/systemd/user/openclaw-*.service.d/20-node24.conf` drop-ins pinning Node through `/usr/bin/node-24`.
- Gateway services use `10-secrets.conf` with `EnvironmentFile=~/.config/openclaw/openclaw-secrets.env`.
- Secrets stay out of `openclaw.json`; use env/token files only.
- `karen` runs the monitoring agent's OpenClaw gateway on `127.0.0.1:18793`.
- `karen` also receives webhooks, updates `/home/<user>/tasks/current.md`, and wakes the target agent via `/usr/local/sbin/openclaw-control`.
- Shared operational knowledge lives in the active OpenClaw worktree at
  `/srv/Code/environment.worktrees/<branch>/ai/openclaw` on both thinkpad and
  yoga510. Yoga510's `/home/rachael/Code/environment` checkout is compatibility
  only; it is never the deployment or document-reconciliation authority.
- Active monitored-agent registry lives at `/srv/agents/index.json`; `/etc/openclaw/agents.json` is a symlink to it.
- Webhook routing is derived from `/srv/agents/index.json`: enabled coding agents with `integrations.jira` receive Jira events, and enabled coding agents with `integrations.bitbucket` receive Bitbucket events.
- The shared docs (`AGENTS.md`, `guides/ROLES.md`, `WORKFLOW.md`, `guides/CODE_REPOS.md`, `USER.md`) are canonical in the active OpenClaw checkout. `openclaw-manage-user` copies them from `$REPO_ROOT/ai/openclaw/` (the worktree that ran the helper) into each agent's `~/workspace/` and `~/.openclaw/workspace/`, overwriting only when content differs, so both the user-facing and OpenClaw internal workspaces see the same content. The monitoring agent (`karen`) has only `~/.openclaw/workspace/`. A doc change reaches agents once it lands in git and the active PM/OpenClaw worktree is reconciled.
- Per-agent files (`SOUL.md`, `IDENTITY.md`, `TOOLS.md`, `MEMORY.md`, `HEARTBEAT.md`) are **content-per-agent** but **single-canonical in location**: each lives at `~/workspace/<file>` and `~/.openclaw/workspace/<file>` is a symlink to it.
- `AGENTS.md` defines the operating baseline (always-on rules + memory/safety/group-chats/heartbeats/tools). `guides/ROLES.md` defines task-role behaviour for coding agents plus the standing monitor role. `WORKFLOW.md` is the action-indexed playbook for tasks. `SOUL.md` and `IDENTITY.md` define per-agent persona only.
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
  -> thinkpad nginx
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

Gmail watches expire after ~7 days and must be renewed regularly:

- **Automated renewal**: the host-wide `gmail-watch-renew.timer` runs daily at 04:00 (with up to 10 minutes of jitter). Its root oneshot service discovers enabled Gmail agents from `/etc/openclaw/agents.json`, reads each private `watch-state.json`, and executes that agent's `gmail-watch.js` as the owning Linux user. Topic and labels come from the state file, so the schedule contains no hard-coded users or mailbox labels.
- **No monitor-agent cron**: do not create an OpenClaw cron job for renewal. The monitor user intentionally cannot read or execute inside coding-agent homes, and successful routine renewal belongs in the system journal rather than Telegram. `openclaw-integrity-check` and `ai-monitor` provide the failure path.
- **Verification**: `systemctl status gmail-watch-renew.timer gmail-watch-renew.service` and `journalctl -u gmail-watch-renew.service` show the next trigger and per-agent result.
- **Watch state files**: `/home/<user>/.openclaw/workspace/google/watch-state.json` tracks `topicName`, `labelIds`, `historyId`, `expiration` (ms epoch), and `createdAt`.
- **Push state files**: `/home/<user>/.openclaw/workspace/google/push-state.json` tracks `lastHistoryId` for the push worker's Gmail History cursor. If this falls too far behind (e.g. after a long watch expiry), the push worker resets to the current profile `historyId` automatically on restart.
- **OAuth tokens**: `/home/<user>/.openclaw/workspace/google/secrets/token.json` stores the OAuth access/refresh tokens. Access tokens expire after ~1 hour but are auto-refreshed by the googleapis library using the refresh token. The saved file may appear stale but refresh works transparently.

#### GCP Service Account and IAM

The service account `gmail-watch@asdrubal-projects.iam.gserviceaccount.com` (key at `/home/<user>/.openclaw/workspace/google/secrets/gcp-sa.json`) authenticates Pub/Sub operations.

- **Project**: `asdrubal-projects`
- **Pub/Sub topic**: `gmail-inbox-watch`
- **Subscriptions**: `gmail-inbox-watch-asdrubal-sub`, `gmail-inbox-watch-barekbaal-sub`
- **Subscription recovery helper**: from `ai/openclaw/skills/google-workspace/`, run `GOOGLE_APPLICATION_CREDENTIALS=secrets/gcp-sa.json node create-gmail-subs.js projects/asdrubal-projects/topics/gmail-inbox-watch gmail-inbox-watch-asdrubal-sub gmail-inbox-watch-barekbaal-sub` to recreate missing subscriptions.
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
- Bind: `0.0.0.0:11434` on thinkpad, with firewalld allowing TCP `11434` only from moonlight (`10.0.0.10`). Agent `models.providers.ollama.baseUrl` points at `http://127.0.0.1:11434` (the local instance directly). The previous `http://ollama.local` indirection through moonlight is **deprecated** — its nginx upstream pointed at `10.0.0.17` (a different LAN host) which did not serve the agents' `:cloud` models; see [`THINKPAD.md`](./THINKPAD.md) § Models and Providers.
- Data dir: `/usr/share/ollama`
- Cloud auth identity: `/usr/share/ollama/.ollama/id_ed25519` and `.pub` were migrated from ThinkPad. If these are regenerated, `:cloud` models can still list but fail with `401 unauthorized`.

Cloud models are installed on `thinkpad`; `qwen2.5:7b-instruct` and `qwen2.5:3b-instruct` also run locally (on the Radeon 780M iGPU) for ai-monitor's judge and as offline fallbacks. The moonlight `ollama.local` nginx proxy still exists but agents no longer route through it.

Expected cloud models:

| Model | Notes |
|---|---|
| `kimi-k2.6:cloud` | cloud entry only |
| `glm-5.1:cloud` | cloud entry only |
| `deepseek-v4-flash:cloud` | cloud entry only |
| `deepseek-v4-pro:cloud` | cloud entry only |

Local models (3B added 2026-05-08; 7B judge since 2026-09-22). Both run 100% on the Radeon 780M iGPU using shared memory:

| Model | Size | Role |
|---|---|---|
| `qwen2.5:7b-instruct` | ~4.7 GB on disk, ~6.6 GB loaded | ai-monitor's judge (`ai.model`). Kept off the shared Ollama cloud quota so monitoring still works when coding agents exhaust it. Measured on a real judge request: 16 s warm, 23 s cold, found 3/3 issues. |
| `qwen2.5:3b-instruct` | ~2 GB (q4_K_M), ~3.4 GB loaded | Last-resort fallback when internet/cloud is unavailable. Tail of the monitoring agent's openclaw `agents.defaults.model.fallbacks` chain and ai-monitor's `ai.fallback_models`. Fast (3 s warm) but missed 2 of 3 issues in the same test, so it is only a fallback. |

### Monitoring and Recovery

- Integrity checker: `/usr/local/bin/openclaw-integrity-check`.
- Registry drift checker: `/usr/local/bin/openclaw-registry-check`; use `--runtime` to also verify declared user services and listener ports.
- Boot readiness checker: `/usr/local/bin/openclaw-boot-readiness`; intended after reboot or larger service changes.
- OpenClaw state backup: `/usr/local/bin/openclaw-backup`, scheduled by `openclaw-backup.timer`.
- AI monitor: `/usr/local/bin/ai-monitor`, using the monitoring agent (Telegram bot from `agents.json`) as a **triage + remediation layer** before alerts reach Telegram. Reads the agent watch list dynamically from the registry every tick (no script reload needed when registry changes).
- Monitor triage flow: ai-monitor writes the incident to `/var/lib/ai-monitor/incidents/<id>.json`, wakes the monitoring agent via `openclaw system event`, and polls `/var/lib/ai-monitor/decisions/<id>.json` (3 min timeout). The monitoring agent re-probes live state, attempts a bounded fix if applicable (see `~/.openclaw/workspace/INCIDENT_HANDLING.md`), and writes `{decision: 'suppress'|'escalate', reason, actions_taken, telegram_sent}`. Telegram is sent only on `escalate`. If the monitoring agent times out / errors, ai-monitor falls back to a direct Telegram with a `monitor unavailable` tag; alerts are never lost. Self-incidents (issues affecting the monitor user or ai-monitor itself) skip the handoff and go direct.
- Active monitored-agent registry: `/etc/openclaw/agents.json`.
- Registry `capabilities` fields are the machine-readable authority model. Coding agents may code/comment/transition/send email; the monitoring agent may triage incidents, wake/restart agents, and send Telegram monitor alerts, but may not modify code, transition Jira, comment Jira, or send email until those capabilities are explicitly granted.
- Stalled-task detection (two complementary kinds, evaluated in order; secondary only fires if primary doesn't):
  - `task-stalled-no-agent` (primary, **policy-defined stall**): Jira issue assigned to a coding agent in `In Progress` *while that agent's openclaw session jsonl mtime is older than the threshold*. Definitionally a stall — the agent isn't actively running on it. Threshold: warn at 5 min idle, crit at 15 min. The monitoring agent is asked to triage and is expected to run `openclaw-control wake-agent <user>` before suppressing. **If the monitoring agent suppresses with empty `actions_taken`, ai-monitor performs the wake itself** (deterministic fallback) — `sudo openclaw-control wake-agent <user> '<reminder>'`, sleep 15 s, re-probe session idle. If recovered (idle < 30 s after wake) → log `auto_woke_after_karen_suppress` and stay silent. If still idle → Telegram with the wake attempt result. Net effect: the agent always gets nudged when this kind fires, regardless of triage judgment; you only get a Telegram when the wake genuinely failed.
  - `task-stalled-no-progress` (secondary): Jira issue `In Progress` with stale `updated` field (>30 min) but session is fresh — i.e. the agent is alive but spinning (HOMELAB-5 heartbeat-loop pattern). The monitoring agent uses `openclaw-control restart-and-wake <user> '<focused brief>'` to break the loop.
  - Both checks query Jira via each coding agent's own token (`~/.ssh/jiraToken.txt`, per-user least privilege). Thresholds live in `/etc/ai-monitor/config.json` under `stalled_tasks_check` (`session_idle_warn_minutes`, `session_idle_crit_minutes`, `update_warn_minutes`). Disable per-agent by setting `coding: false` or `integrations.jira: false` in the registry.
- Pending email action detection: Gmail/local-mail listeners must wake the owning agent immediately for requests from the configured whitelist plus every local agent with email access. ai-monitor is the fallback path, not the first responder: it scans each monitored coding agent's `~/tasks/current.md` for Gmail-backed sections (`Gmail messageId:`) still marked `Status: QUEUED`. It fires `email-awaiting-action` at 15 min warn / 60 min crit, ignores stale historical entries older than 24 h, and wakes the owning agent directly with a reminder to process the queued email, reply in-thread when required, include the configured signature/runtime model, and move the task out of `QUEUED`. Recovery is task-status based: the wake/restart is not considered successful while the same Gmail messageId remains `QUEUED`, and tier-3 Telegram escalation no longer suppresses future recovery attempts for unresolved email work.
- PM workflow drift detection: Mission Control already wakes the target agent when the PM event happens; `ai-monitor` is the fast fallback. Defaults are Backlog plan missing after 2 min, `To Do` not started after 2 min, `In Progress` stale after 5 min, and Review waiting after 10 min. `In Progress` remains the state for incomplete implementation, including a formal infrastructure, credential, external-service, or human-decision blocker; `Review` is only for completed work awaiting review. A formal blocker is recorded once with `flag_blocker` and suppresses ordinary stale-assignee recovery only while external input is missing. A structured permission grant makes the round agent-actionable immediately; checkpoint success or failure closes the exact consumed round. A generic `alertReporter` flag is not by itself blocker evidence because repository and administrative alerts use it too. Task execution always stays with the visible assignee; independent cross-agent work requires a separate explicitly assigned PM task. For `In Progress`, the stale timer is based on the assignee's latest task comment after the task entered `In Progress`. Before issuing recovery, the monitor also suppresses duplicate turns while any queued, accepted, streaming, or retryable PM-channel run already exists for that task and agent. `In Progress` recovery uses disposable task-session episodes: PM rotates them after the configured completed-turn budget or unrecoverable context failure and rebuilds from canonical PM/repository state. Each turn receives a bounded inline working set plus scoped loopback grants for deeper task history; the defaults are 48000 aggregate inline characters and 2000 per duplicated recent body, tunable downward for smaller local Ollama windows. PM kinds are mandatory bypass-monitor auto-actions: T1 sends a native PM-channel workflow nudge with the current bounded task context packet, T2 repeats the semantic nudge, T3 performs a final recovery attempt, and Telegram is sent only if the issue is still present after T3's confirmation window. Only concrete `pm-channel-no-start`, `pm-channel-stalled`, or `pm-channel-failed` evidence permits a service restart.
- PM recovery revalidation (2026-09-22): both monitor recovery tiers reread the current task/run and agent-wide execution leases immediately before intervention. Live admitted/streaming execution, capacity waits, newer turns and changed workflow owners suppress stale restart/nudge requests; DB lookup failure also defers. Deferred checks do not spend the recovery attempt budget. The root-owned `/usr/local/bin/ai-monitor` must be explicitly replaced after a source update; editing the worktree alone does not update the timer's executable.
- Broken user-manager recovery: if user-scoped systemd probes return `Transport endpoint is not connected`, `Bad message`, or `Failed to connect to bus`, `ai-monitor` emits `user-manager-bus-broken` and bypasses the monitor agent. The deterministic action restarts `user@UID.service`, then restarts the agent's managed `openclaw-*` services through `openclaw-control`. `openclaw-control restart-services` also performs the same user-bus repair before retrying service restarts, so PM-channel no-start recovery can self-heal a broken user manager before nudging again.
- Monitor config replication: keep host secrets and literal runtime users out of git, but version the policy/defaults in `ai/openclaw/config/ai-monitor.config.json.example`. New AI servers should copy that template to `/etc/ai-monitor/config.json`, fill host-specific values, and keep `monitor_triage.auto_action_kinds_bypass_monitor` plus `pm_workflow.retry_after_tier3_seconds` aligned with this repo.
- ai-monitor live ticks are single-instance locked; `--dry-run` and `--probe-only` are read-only and do not write state. This prevents debugging or overlapping timer/manual runs from accidentally suppressing future recovery attempts or double-sending nudges.
- Agent dashboard: `https://dev.vixi.au/agents.html` (basic auth — same `admin` user as the per-agent vhosts, htpasswd at `/etc/nginx/.htpasswd`). Real-time per-agent activity, AI monitor status, monitoring agent decisions, system service health. SSE-driven, no refresh needed. See **§16 Agent Dashboard** subsection below for the architecture.
- ThinkPad cron job `/etc/cron.d/openclaw-integrity` was preserved for reference only. thinkpad's active automation uses systemd timers, not cron.
- On openSUSE, the active scheduler is `openclaw-integrity.timer` plus `openclaw-integrity.service`, running every 2 minutes.
- `ai-monitor.timer` starts the next AI judgment tick two minutes after the
  previous tick finishes. This keeps slow, bounded monitor-agent handoffs from
  turning into an immediate continuous loop.
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

Gateway resource policy is installed from `ai/host/`: OpenClaw configs enable
payload-free critical memory-pressure snapshots; each gateway has
`MemoryHigh=8G`, `MemoryMax=10G`, `MemorySwapMax=0`, `TasksMax=1024`, and a
Node heap cap (`NODE_OPTIONS=--max-old-space-size=2560`) that keeps the
gateway process well below the cgroup budget so the remainder stays
available to claude-cli child processes. Swap is disallowed on purpose:
under the old 6G/8G/2G-swap budget, `memory.high` reclaim throttling froze
busy gateway event loops for minutes mid-turn; with no swap a true overrun
OOM-kills at `MemoryMax` and `Restart=always` recovers in seconds.
Because openSUSE disables user-manager resource delegation by default, the
host installer adds `Delegate=pids memory` only to registered agent
`user@<uid>.service` instances. Existing user managers must be restarted
individually while idle before the limits become effective. The same installer
enables kernel PSI telemetry with `psi=1` on the next reboot and reduces the
RAM-backed `/tmp` retention from ten days to three.

#### Backup scope

openclaw-backup backs up small but high-value state only: /etc/openclaw, /etc/ai-monitor/config.json, /srv/Code/environment/ai/openclaw, /srv/Code/environment/ai/web, agent .openclaw and .config/openclaw directories, key workspace instruction files, webhook routing, and Ollama cloud identity keys. It excludes large caches, node_modules, browser data, git directories, local model blobs, and transient runtime lock files. Archives are published atomically only after tar succeeds; the archive and manifest are mode 0600 under /var/backups/openclaw.

This is a local safety net. Off-host copies should live on `moonlight` under `/srv/backups/openclaw/thinkpad`; the first manual copy was written there on 2026-05-08. Future automation should sync the latest archive and matching `.manifest.json` there after each local backup.

### Agent Dashboard (`agent-dashboard`)

Added 2026-05-08. A read-only single-page dashboard at `https://dev.vixi.au/agents.html` showing what every agent on thinkpad is doing in real time: per-agent activity (latest assistant text / tool call / tool result, session-idle timer, primary model), current Jira task, open Jira tickets per coding agent, ai-monitor health and recent monitoring-agent decisions, and system-service status. Runs as a single Node service; the page itself is plain HTML with vanilla JS connecting to a Server-Sent Events stream — no framework, no build step.

#### URL and auth

- **Public**: `https://dev.vixi.au/agents.html` — terminates TLS at moonlight, proxies to thinkpad's nginx, then to `127.0.0.1:3013`.
- **OpenClaw Control UIs**: thinkpad exposes the coding-agent gateway dashboards through nginx role-based routes backed by ports `18789` and `18790`. The routes are nginx basic-auth protected and pass `X-Forwarded-User: $remote_user` into OpenClaw trusted-proxy auth, so there is no second OpenClaw token login after nginx auth. The gateway ports bind to LAN for trusted-proxy source detection, but firewalld does not open 18789/18790 to the network.
- **Auth**: HTTP basic auth at the thinkpad nginx layer, `auth_basic_user_file /etc/nginx/.htpasswd` (same `admin` user that protects per-agent `*.vixi.au` vhosts).
- **Health probe**: `https://dev.vixi.au/agents/health` is unauthenticated by design — returns `{ok, agents, clients}` as JSON for cheap external uptime checks.

#### Files

| Path | Purpose |
|---|---|
| `/usr/local/bin/agent-dashboard` | Node server (~530 lines). Stdlib `http`, `fs`, `child_process`. Listens on 127.0.0.1:3013. |
| `<active-worktree>/ai/web/agents.html` | Single-file frontend (~810 lines including CSS + JS), redesigned 2026-05-10: modern dark/light themes (toggle persisted in `localStorage`), class-coded cards (`coding`/`monitor` accent colors), capability + integration + service badges per agent, SVG-free icons. Hydrates per-agent metadata from `/agents/registry.json` (auth-gated nginx alias to `/srv/agents/index.json` — the live runtime registry, NOT in the repo); live state still flows via the SSE stream. `install.sh` symlinks `/usr/local/share/agent-dashboard/agents.html` at the worktree copy that ran it, so the Node fallback path still works for loopback-direct fetches. nginx serves the active-worktree copy directly via `alias`; SELinux context `httpd_sys_content_t`. Dashboard experiment copies (`agents-asdrubal.html`, `agents-barekbaal.html`) sit next to it for frontend experiments. |
| `/etc/agent-dashboard/config.json` | Bind address/port, `agents_registry` path, jira host, `system_services` list, poll intervals. |
| `/etc/systemd/system/agent-dashboard.service` | `Type=simple`, `Restart=always`, runs as root, depends on `network-online.target` and `ai-monitor.timer`. |

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
- /agents.html: auth_basic + alias to the active-worktree `ai/web/agents.html`.
- Dashboard experiment pages: auth_basic + alias to the matching tracked HTML copy (`agents-asdrubal.html`, `agents-barekbaal.html`).
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

### Recent changes

Historical change notes (2026-05-08, 05-10, 05-13, 05-20) moved to
[`CHANGELOG.md`](./CHANGELOG.md) so this host doc stays focused on current
state. Entries there are frozen as-of their date; paths and facts reflect
what was true **then**, not necessarily now.

### Known follow-ups

- If BotFather tokens are ever rotated, update each user's `telegram-token` and OpenClaw secrets env.
- The Ollama service on `thinkpad` uses conservative default backend settings, not ThinkPad-specific GPU tuning.
- thinkpad is still a single point of failure for its OpenClaw agents, monitoring, and remediation. Local backup reduces accidental-loss risk; disk-loss protection depends on keeping `moonlight:/srv/backups/openclaw/thinkpad` current.
- Gmail watch renewal is automated by the host-wide `gmail-watch-renew.timer` (see § Gmail Automation). Do not duplicate it with an OpenClaw/monitor-agent cron job. IAM: the SA `gmail-watch@asdrubal-projects.iam.gserviceaccount.com` now has `roles/pubsub.editor` (granted 2026-06-07) so subscriptions can be recreated if lost. Keep `/usr/local/bin/openclaw-integrity-check` and dashboard status green; verify that base `openclaw-gmail-listener.service` units reference agent-specific subscription names (not the legacy `gmail-inbox-watch-sub`).
- The monitoring agent runs on the host it monitors. Self-incidents must continue to bypass the monitoring agent and go directly to Telegram fallback.
- Secrets are split by Linux user for least privilege, which is correct, but audits should use `/usr/local/bin/openclaw-backup --inventory` plus `/usr/local/bin/openclaw-registry-check`.
- Future changes should go through `/etc/openclaw/agents.json` and the active OpenClaw checkout (`/srv/Code/environment.worktrees/<branch>/ai/openclaw` on thinkpad); hand-editing dependent configs without running the validator can reintroduce drift.

---

## 21. Duplicating the OpenClaw Agent Instance on a New Computer

This chapter captures the yoga510 migration pattern for bringing up a new local agent host that shares selected operating behaviour with thinkpad without treating the new agents as continuations, replacements, or clones of previous agents.

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

On a fresh Debian-like target, install the base packages, Node 24, and the same OpenClaw release used by thinkpad:

```bash
apt-get update
apt-get install -y git curl ca-certificates gnupg sudo rsync unzip tar gcc g++ make python3 python3-pip inotify-tools jq
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup_24.sh
bash /tmp/nodesource_setup_24.sh
apt-get install -y nodejs
npm install -g openclaw@2026.5.7 pnpm@10.33.0
printf "%s\n" "#!/bin/sh" "exec /usr/bin/node \"\$@\"" > /usr/bin/node-24
chmod 0755 /usr/bin/node-24
ln -sfn /usr/bin/node-24 /usr/bin/node24
PNPM_REAL="$(command -v pnpm)"
[ "$PNPM_REAL" = /usr/local/bin/pnpm ] || ln -sfn "$PNPM_REAL" /usr/local/bin/pnpm
/usr/bin/node24 --version
/usr/local/bin/pnpm --version
```

Create a shared group for agent-readable repository files, then use the
standard `/srv/Code` layout on every host. The canonical checkout is a stable
base; deployment and shared-document reconciliation come from a managed
worktree under `/srv/Code/environment.worktrees`. Yoga510 also retains
`/home/rachael/Code/environment` for compatibility, but that checkout is not
an authority for either operation.

```bash
groupadd -f code-agents
usermod -aG code-agents <owner> <code-agent-1> <code-agent-2> <monitor-agent>
install -d -m 2775 -o <owner> -g code-agents \
  /srv/Code /srv/Code/environment.worktrees
sudo -u <owner> git clone <repository-url> /srv/Code/environment
sudo -u <owner> git -C /srv/Code/environment switch --detach origin/main
sudo -u <owner> git -C /srv/Code/environment worktree add \
  /srv/Code/environment.worktrees/main main
chgrp -R code-agents /srv/Code/environment \
  /srv/Code/environment.worktrees/main
find /srv/Code/environment /srv/Code/environment.worktrees/main \
  -type d -exec chmod g+rws {} +
find /srv/Code/environment /srv/Code/environment.worktrees/main \
  -type f -exec chmod g+rw {} +
```

If root/admin validation commands use Git in these checkouts, add both
`/srv/Code/environment` and `/srv/Code/environment.worktrees/main` as safe
directories for that account.

### 21.3 Build each agent home

For every target agent:

- Create `~/.openclaw`, `~/.openclaw/workspace`, `~/.openclaw/agents/main`, `~/.config/openclaw`, `~/.config/systemd/user`, `~/workspace`, and `~/Maildir/{new,cur,tmp}`.
- Reconcile shared documents from the active worktree's
  `/srv/Code/environment.worktrees/<branch>/ai/openclaw` directory by running
  that worktree's `ai/openclaw/install.sh`: `AGENTS.md`, `guides/ROLES.md`,
  `WORKFLOW.md`, `guides/CODE_REPOS.md`, and `USER.md` for every agent, plus
  `guides/INCIDENT_HANDLING.md`, `guides/MONITORING.md`, and
  `guides/SERVICES.md` for the monitor agent. Never sync these from an owner
  compatibility checkout.
- Keep persona/runtime files per-user: `SOUL.md`, `IDENTITY.md`, `TOOLS.md`, `MEMORY.md`, `HEARTBEAT.md`.
- Set `~/Code -> /srv/Code` for users that should work with the shared
  repository tree.
- Generate new local secrets; do not copy Telegram, model provider, OAuth, or webhook secrets from thinkpad unless that is explicitly intended.
- For Telegram, keep the thinkpad-compatible single-account shape under `channels.telegram` with `enabled`, `dmPolicy: pairing`, `groupPolicy: allowlist`, `streaming.mode: partial`, and `tokenFile: /home/<agent>/.config/openclaw/telegram-token`. Do not use `channels.telegram.accounts.*` unless intentionally changing the host convention. Token files must be owned by the agent and mode `0600`.

Create `/etc/openclaw/agents.json` as the host-level runtime registry. It should contain one record per enabled agent with `user`, `role`, `home`, `workspace`, `gatewayPort`, `services`, and integration flags. The dashboard and integrity tooling read this file as the live source of truth.

### 21.4 Prefer Maildir for local mail hosts

When the new host already delivers mail locally through Postfix/Dovecot, OpenClaw does not need Gmail or IMAP credentials. The yoga510 pattern is:

- Postfix delivers incoming mail to `~/Maildir`.
- Dovecot remains available for human IMAP clients.
- Agents read `~/Maildir/new` and `~/Maildir/cur` directly.
- Replies and new outgoing mail go through `/usr/sbin/sendmail -oi -t`.
- Read state is Maildir-native: move messages from `new/` to `cur/` with `:2,S`.
- A listener service watches `~/Maildir/new` and writes events to `~/.openclaw/mail/events.jsonl`.

The reusable skill source is the active worktree's
`/srv/Code/environment.worktrees/<branch>/ai/openclaw/skills/local-mail`.
Link that source into each agent as `~/workspace/mail`,
`~/.openclaw/workspace/mail`, and `~/.openclaw/skills/local-mail`.

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

- `pm.service` on `127.0.0.1:3000` and `pm-consumer.service` when the host
  runs Mission Control; both are host-wide system services owned by the
  selected monitor/PM runtime user
- `agent-dashboard.service` on `127.0.0.1:3013` when the legacy read-only
  activity dashboard is still required
- `openclaw-typing-keepalive.service` if Telegram/long-turn typing support is required; on Telegram-disabled hosts it can be a harmless registry watcher
- `openclaw-backup.timer`
- `openclaw-integrity.timer`

For the monitor user, create a narrow sudoers file modelled after `karen-openclaw-control`, but scoped to the target users and target host services only.

### 21.6 Mission Control and the legacy dashboard

Mission Control and `agent-dashboard` are separate applications. A replicated
host may run both, but they need different hostnames and upstreams:

| Interface | Upstream | Purpose |
|---|---|---|
| Mission Control | `pm.service` on `127.0.0.1:3000` | Current Next.js project-management UI and agent workflow |
| Legacy agent dashboard | `agent-dashboard.service` on `127.0.0.1:3013` | Optional read-only activity/SSE page |

On yoga510, Mission Control is `https://agents.eurekafiles.com` and runs as
`emery` from `/srv/Code/environment.worktrees/main/ai/web`, with
`pm-consumer.service` using the same managed worktree and
`file:/srv/Data/pm/wt-main.db`. The canonical checkout is
`/srv/Code/environment`; `/home/rachael/Code/environment` is also present but
is compatibility-only and is never the deployment or shared-document sync
source. The legacy dashboard remains at
`https://dev.eurekafiles.com` through port `3013`.

Everything portable for a Mission Control install is tracked in the
repository:

- the application, `pnpm-lock.yaml`, and committed Prisma migrations under
  `ai/web/`;
- systemd templates, the host-private env example, nginx template, rebuilding
  page, worktree switch helpers, and idempotent installers under
  [`web/deploy/`](web/deploy/);
- host reconciliation and native OpenClaw PM-channel setup under
  [`openclaw/install.sh`](openclaw/install.sh) and
  `web/deploy/install-openclaw-pm-channel.mjs`.

Secrets, generated agent tokens, certificates, and live databases stay on the
host. Create `/etc/default/pm` from `deploy/pm.env.example`; do not commit its
values. Follow [`web/deploy/README.md`](web/deploy/README.md#first-time-install)
for the first install, including the required SQLite package, PM env, systemd
units, gateway hooks/channel plugin, nginx vhost, and initial migration. Use
the standard `/srv/Code/environment` plus
`/srv/Code/environment.worktrees/<branch>` layout so the committed switch
helpers work consistently across hosts. Render
`deploy/nginx-mission-control.conf` with the target hostname and certificate
paths; never point the Mission Control hostname at the legacy static page.
Every OpenClaw gateway used by PM must bind to loopback. Nginx may expose an
authenticated gateway control UI when required, but it must not proxy
`/hooks`, `/pm-channel`, or any subpath of either internal endpoint.

After initial installation, use the guarded managed-host updater. Replace the
repository/monitor users and worktree when deploying another host:

```bash
sudo /srv/Code/environment.worktrees/main/ai/web/deploy/update-managed-host.sh \
  --worktree /srv/Code/environment.worktrees/main \
  --repo-user rachael --monitor-user emery --branch main
```

The updater refuses dirty, local-ahead, detached, or diverged worktrees and
never resets, rebases, commits, or deletes local work. It refreshes the
installed `/usr/local/sbin` helper copies and root-owned non-secret deployment
contract before `pm-switch` applies all pending committed migrations to the
branch database, builds the standalone bundle, atomically repoints/restarts
both PM services, and verifies the login page plus a hashed asset. Do not use
`prisma db push` on a real host and do not run `next build` without the
immediate switch/restart.
If a release changes the PM/OpenClaw units, gateway hooks, or native channel
plugin, also rerun the active worktree's idempotent OpenClaw installer as
documented in the first-install guide.

Verify a replicated host with:

```bash
/usr/local/sbin/pm-switch status
systemctl is-active pm.service pm-consumer.service
curl -fsS -o /dev/null http://127.0.0.1:3000/login
curl -fsS -o /dev/null https://agents.example.com/login
```

If the legacy dashboard is retained, keep it on its own protected vhost,
proxy only its `/agents/` API/SSE routes to `127.0.0.1:3013`, and continue to
serve avatars from `/srv/agents/Pictures`. Unauthenticated legacy dashboard
pages and data routes should return `401`; its explicit health endpoint may
remain unauthenticated for uptime checks.

### 21.7 Validation checklist

Run these before considering the clone complete:

```bash
node --version
node-24 --version
npm --version
openclaw --version
git -C /srv/Code/environment status --short
git -C /srv/Code/environment.worktrees/main status --short
/usr/local/bin/openclaw-integrity-check
```

Also verify:

- `openclaw config validate` passes as every agent user.
- `systemctl --user is-active` reports active for each agent service.
- Local mail delivery works for every agent: send a message, list it, read it, mark it read, and reply through Postfix.
- `pm.service`, `pm-consumer.service`, `agent-dashboard.service`, `nginx`,
  `postfix`, and `dovecot` are active where applicable; Mission Control's
  `/login` responds locally on port `3000` and through its public hostname.
- Every gateway used by Mission Control listens only on loopback. Confirm
  nginx does not expose `/hooks`, `/pm-channel`, or any subpath of either
  endpoint; a non-PM gateway may bind elsewhere only when its threat model and
  firewall policy explicitly require it.
- A backup archive exists under `/var/backups/openclaw/`.
