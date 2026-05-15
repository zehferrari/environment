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
| `1001+` | Coding agents (`role: manager`, `role: developer`) | Full OpenClaw agent, WDT playground, Telegram/Gmail/Jira auth. One UID per registered agent in `agents.json`. |
| `1003` | Monitoring agent (Linux user `karen`) | Telegram alert persona, multi-tenant webhook dispatch account, shared web root. |

The authoritative roster — usernames, UIDs, roles, services, ports — is `/etc/openclaw/agents.json`. Add or rename agents only by editing that registry; the docs below describe behaviour by **role**, not by name.

Runtime notes:

- Source homes are still intact on `thinkpad`, but migrated user services and linger are disabled there.
- `moonlight` proxies the relevant `vixi.au` routes to `10.0.0.108` in `/etc/nginx/sites-available/vixiAu`; disabled `/etc/nginx/sites-available/webhooks` was also updated from `10.0.0.105` to `10.0.0.108`.
- Global OpenClaw lives at `/usr/local/lib/node_modules/openclaw`; `/usr/local/bin/openclaw` points to it.
- `pnpm` 10.33.0 is installed at `/usr/local/lib/node_modules/pnpm` and `/usr/local/bin/pnpm` for WDT builds.
- Tumbleweed's Node 24 binary rejects being invoked as `node-24`, so `/usr/bin/node-24` is a wrapper that execs `/usr/bin/node` with argv name `node`.
- SELinux is enforcing. nginx needs `httpd_can_network_connect`, ACL traverse rights on migrated home dirs, and `httpd_sys_content_t` labels on migrated web roots/static assets.
- Root SSH client material from `thinkpad:/root/.ssh` was migrated because the integrity checker probes `moonlight` over SSH.
- `/etc/hosts` maps `moonlight` to `10.0.0.10` for the same integrity probe.
- OpenClaw services must run as their Linux users, never as root.
- Listener processes should bind to loopback unless nginx is intentionally exposing them locally. Public ingress terminates at `moonlight`, then proxies to nginx on `x1`.

### Current Service Ownership

`karen` hosts the monitoring agent. The monitoring agent inspects services, logs, health checks, and monitor outputs, but does not code or take Jira implementation work unless zeh explicitly expands the role.

`karen` still owns the shared webhook dispatcher. It does not own Gmail polling, because Gmail polling uses each coding agent's Google OAuth state, task files, gateway token, and per-agent memory. Keeping Gmail under each coding agent preserves least privilege and prevents cross-agent mailbox confusion.

Expected enabled user services/timers, by role (concrete user → services map is in `/etc/openclaw/agents.json` `services`):

| Role | Services / timers |
|---|---|
| Monitoring agent (user `karen`) | `openclaw-gateway.service`, `openclaw-webhook-receiver.service` |
| Each coding agent (one row per agent in registry) | `openclaw-gateway.service`, `openclaw-gmail-listener.service`, `openclaw-webhook-receiver.service`, `wdt-<user>.service` |

Expected listeners on `x1` (concrete `user → port` map is in `agents.json` `listeners`):

| Port range | Role | Service |
|---:|---|---|
| `18789–1879N` (one per coding agent) | Coding agent | OpenClaw gateway |
| `18791, 18792, …` (one per coding agent) | Coding agent | OpenClaw browser sidecar |
| `18793` | Monitoring agent (`karen`) | OpenClaw gateway |
| `3010` | Monitoring agent (`karen`) | Multi-tenant OpenClaw webhook receiver |
| `3011, 3012, …` (one per coding agent) | Coding agent | Per-agent OpenClaw webhook receiver |
| `3001, 3002, …` (one per coding agent) | Coding agent | WDT Next.js standalone, loopback |
| `11434` | system (`ollama`) | Ollama API, loopback |
| `3013` | system (`root`, `agent-dashboard.service`) | Agent dashboard backend (HTTP + SSE), loopback only — public access via nginx at `https://dev.vixi.au/agents.html` with basic auth |

The exact port numbers per registered user live in `agents.json` (`listeners[].host:port`); `openclaw-registry-check --runtime` validates that the listed ports are actually bound.

### OpenClaw Architecture

- OpenClaw runtime was migrated from ThinkPad runtime `2026.4.15`.
- Per-user OpenClaw state lives under `/home/<user>/.openclaw/`.
- Full users have `~/.config/systemd/user/openclaw-*.service.d/20-node24.conf` drop-ins pinning Node through `/usr/bin/node-24`.
- Gateway services use `10-secrets.conf` with `EnvironmentFile=~/.config/openclaw/openclaw-secrets.env`.
- Secrets stay out of `openclaw.json`; use env/token files only.
- `karen` runs the monitoring agent's OpenClaw gateway on `127.0.0.1:18793`.
- `karen` also receives webhooks, updates `/home/<user>/tasks/current.md`, and wakes the target agent via `/usr/local/sbin/openclaw-control`.
- Shared operational knowledge lives in `/srv/agents/shared`.
- Active monitored-agent registry lives at `/etc/openclaw/agents.json`; `` points to the same file.
- `/home/karen/webhooks/users.json` is webhook routing only, not the full monitoring roster.
- The shared docs (`AGENTS.md`, `ROLES.md`, `TEAM_WORKFLOW.md`) are canonical at `/srv/agents/shared/` (deployed from `environment/ai/openclaw/` in the unified `environment` repo). Each coding agent's home has two symlinks per file (one in `~/workspace/`, one in `~/.openclaw/workspace/`) pointing at the canonical file in the repo, so both the user-facing and OpenClaw internal workspaces see the same content. The monitoring agent (`karen`) has only `~/.openclaw/workspace/`, with one symlink per file.
- Per-agent files (`SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `MEMORY.md`, `HEARTBEAT.md`) are **content-per-agent** but **single-canonical in location**: each lives at `~/workspace/<file>` and `~/.openclaw/workspace/<file>` is a symlink to it.
- `AGENTS.md` defines the operating baseline (always-on rules + memory/safety/group-chats/heartbeats/tools). `ROLES.md` defines role-specific behaviour. `TEAM_WORKFLOW.md` is the action-indexed playbook for tasks. `SOUL.md` and `IDENTITY.md` define per-agent persona only.
- Jira tickets in `Backlog` are not actionable. Agents and dispatchers must completely ignore them: do not queue, wake, send Telegram, comment, transition, or start work unless zeh explicitly overrides Backlog for that specific ticket.
- Mandatory outbound signature rule: every outbound email and Jira update/comment must end with `--`, the agent name, and `Model: <provider>/<model>` using the actual current runtime model at send time.
- Agent communication policy: report only when finished or blocked. No play-by-play progress updates.
- Preserve the source communication channel. Jira tasks use Jira comments/status updates; email tasks use the email thread; Telegram tasks use Telegram. Jira/email-triggered work may send exactly one Telegram start notice to zeh, then no further Telegram messages for that task unless zeh explicitly redirects the conversation.

Current model posture by role. Each role uses a model **tuned for that kind of work**, not arranged on a cheap-vs-expensive ladder; the manager and developer running different models is what makes "escalating to the manager" useful as a *fresh perspective* rather than just a louder voice.

| Role | Tuned for | Typical primary | Typical fallbacks |
|---|---|---|---|
| `manager` | Ambiguity, architecture, risky review, difficult blockers | `openai-codex/gpt-5.5` | `openai-codex/gpt-5.4`, `openai-codex/gpt-5.3-codex`, `openrouter/google/gemini-3-flash-preview`, `openrouter/x-ai/grok-4.1-fast` |
| `developer` | Focused execution of well-scoped tasks | `ollama/kimi-k2.6:cloud` | `ollama/deepseek-v4-pro:cloud`, `ollama/glm-5.1:cloud`, `ollama/deepseek-v4-flash:cloud` |
| `monitor` (user `karen`) | Triage, host probing, terse Telegram alerts | `ollama/deepseek-v4-pro:cloud` | `ollama/kimi-k2.6:cloud`, `ollama/glm-5.1:cloud`, `ollama/deepseek-v4-flash:cloud` |

Live per-user defaults are in each agent's own `~/.openclaw/openclaw.json`, **not** in the shared registry — model preference is persona, not host topology.

Enabled model providers for coding agents:

- OpenAI/Codex
- Ollama
- OpenRouter

The Z.ai provider/plugin was intentionally removed/disabled on 2026-05-06.

### Webhook Flow

```
https://dev.vixi.au/webhooks/*
  -> moonlight nginx
  -> x1 nginx
  -> karen openclaw-webhook-receiver on 127.0.0.1:3010
  -> /usr/local/sbin/openclaw-control <coding-agent-user> ...
```

Webhook and integration facts:

- Shared webhook dispatcher: `/home/karen/webhooks/webhook-receiver.js`.
- Routing config: `/home/karen/webhooks/users.json`.
- Endpoints: `GET /health`, `POST /jira`, `POST /bitbucket`.
- `karen` may run `/usr/local/sbin/openclaw-control *` via `/etc/sudoers.d/karen-openclaw-control`.
- `openclaw-control` only permits target users that are coding agents in `/etc/openclaw/agents.json` (`role` matches a coding role); commands include `restart-services`, `wake-agent`, and `restart-and-wake`. As of 2026-05-08, `restart-services` covers all enabled `openclaw-*` **and** `wdt-*` user services for the target user (was `openclaw-*` only); `systemctl restart` is invoked uniformly so inactive units are also (re)started. This is the path the monitoring agent / `ai-monitor` uses to bring stuck user services back up automatically.
- `openclaw-control wake-agent` loads `/home/<user>/.config/openclaw/openclaw-secrets.env` before calling `openclaw system event`, so gateway token secret refs resolve for webhook wakes.
- Telegram bots: one per agent, recorded in `/etc/openclaw/agents.json` under each agent's `telegram.bot` field.
- Jira host: `zeh-ferrari.atlassian.net`.
- Bitbucket workspace/repo: `zehferrari` / `whitsunday-discovery-trail`.
- Jira issue keys are not WDT-only. Gmail/Jira automation must accept generic `PROJECT-123` keys such as `HOMELAB-3`.
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
- Secret env drop-in: `/home/<user>/.config/systemd/user/openclaw-gmail-listener.service.d/10-secrets.conf` loads `OPENCLAW_GATEWAY_TOKEN` so Gmail workers can run `openclaw system event`.
- Gmail watches still publish to the shared topic, but each agent now has its own subscription, so messages are broadcast once to each agent instead of load-balanced between them.
- The legacy shared subscription `gmail-inbox-watch-sub` should not be used by either agent service.
- The Gmail push worker was patched to ignore Pub/Sub notifications where `emailAddress` belongs to the other mailbox, so each agent only processes its own mailbox events.
- The Gmail push worker marks every in-scope email as read immediately after fetching it, even when no action is required.
- Manual Gmail body/reply helpers also mark the source message read. Agents must not fetch/read Gmail content and leave that message unread.
- The Gmail push worker is a dispatcher only: queue task, mark mail read, wake OpenClaw. It must not send Telegram task-start notices itself; the awakened agent sends exactly one concise start notice after accepting the task.
- Sibling-agent emails are actionable by default. If they are replies inside an existing task thread, the worker wakes the agent as an email-thread update and explicitly suppresses a new Telegram start notice.
- Gmail reply helpers reply-all by default, excluding the sending agent, and mark the source message read after fetching it.
- Email requests from zeh/internal agents that ask for a response should be replied to promptly by the agent before longer work continues.
- Gmail and Jira wake prompts explicitly remind the agent to sign outbound email/Jira comments with the actual current runtime model.
- Gmail and Jira wake prompts explicitly remind the agent to keep task communication in the source channel after the one allowed Telegram start notice.

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
- Bind: `127.0.0.1:11434`
- Data dir: `/usr/share/ollama`
- Cloud auth identity: `/usr/share/ollama/.ollama/id_ed25519` and `.pub` were migrated from ThinkPad. If these are regenerated, `:cloud` models can still list but fail with `401 unauthorized`.

Only cloud models were installed on `x1`; the large local ThinkPad model blobs were intentionally not copied.

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
- AI monitor: `/usr/local/bin/ai-monitor`, using the monitoring agent (Linux user `karen`, Telegram bot from `agents.json`) as a **triage + remediation layer** before alerts reach Telegram. Reads the agent watch list dynamically from the registry every tick (no script reload needed when registry changes).
- Monitor triage flow: ai-monitor writes the incident to `/var/lib/ai-monitor/incidents/<id>.json`, wakes the monitoring agent via `openclaw system event`, and polls `/var/lib/ai-monitor/decisions/<id>.json` (5 min timeout). The monitoring agent re-probes live state, attempts a bounded fix if applicable (see `~/.openclaw/workspace/INCIDENT_HANDLING.md`), and writes `{decision: 'suppress'|'escalate', reason, actions_taken, telegram_sent}`. Telegram is sent only on `escalate`. If the monitoring agent times out / errors, ai-monitor falls back to a direct Telegram with a `⚠️ monitor unavailable` tag — alerts are never lost. Self-incidents (issues affecting the `karen` user / monitoring agent or ai-monitor itself) skip the handoff and go direct.
- Active monitored-agent registry: `/etc/openclaw/agents.json`.
- Registry `capabilities` fields are the machine-readable authority model. Coding agents may code/comment/transition/send email; the monitoring agent may triage incidents, wake/restart agents, and send Telegram monitor alerts, but may not modify code, transition Jira, comment Jira, or send email until those capabilities are explicitly granted.
- Stalled-task detection (two complementary kinds, evaluated in order; secondary only fires if primary doesn't):
  - `task-stalled-no-agent` (primary, **policy-defined stall**): Jira issue assigned to a coding agent in `In Progress` *while that agent's openclaw session jsonl mtime is older than the threshold*. Definitionally a stall — the agent isn't actively running on it. Threshold: warn at 5 min idle, crit at 15 min. The monitoring agent is asked to triage and is expected to run `openclaw-control wake-agent <user>` before suppressing. **If the monitoring agent suppresses with empty `actions_taken`, ai-monitor performs the wake itself** (deterministic fallback) — `sudo openclaw-control wake-agent <user> '<reminder>'`, sleep 15 s, re-probe session idle. If recovered (idle < 30 s after wake) → log `auto_woke_after_karen_suppress` and stay silent. If still idle → Telegram with the wake attempt result. Net effect: the agent always gets nudged when this kind fires, regardless of triage judgment; you only get a Telegram when the wake genuinely failed.
  - `task-stalled-no-progress` (secondary): Jira issue `In Progress` with stale `updated` field (>30 min) but session is fresh — i.e. the agent is alive but spinning (HOMELAB-5 heartbeat-loop pattern). The monitoring agent uses `openclaw-control restart-and-wake <user> '<focused brief>'` to break the loop.
  - Both checks query Jira via each coding agent's own token (`~/.ssh/jiraToken.txt`, per-user least privilege). Thresholds live in `/etc/ai-monitor/config.json` under `stalled_tasks_check` (`session_idle_warn_minutes`, `session_idle_crit_minutes`, `update_warn_minutes`). Disable per-agent by setting `coding: false` or `integrations.jira: false` in the registry.
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
sudo -u karen XDG_RUNTIME_DIR=/run/user/1003 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1003/bus systemctl --user status openclaw-gateway.service openclaw-webhook-receiver.service
/usr/local/bin/ollama list
/usr/local/bin/openclaw-registry-check --runtime
/usr/local/bin/openclaw-integrity-check
/usr/local/bin/ai-monitor --probe-only
/usr/local/bin/openclaw-boot-readiness
/usr/local/bin/openclaw-backup --inventory
```

#### Backup scope

`openclaw-backup` backs up small but high-value state only: `/etc/openclaw`, `/etc/ai-monitor/config.json`, `/srv/agents/shared`, agent `.openclaw` and `.config/openclaw` directories, key workspace instruction files, webhook routing, and Ollama cloud identity keys. It excludes large caches, `node_modules`, browser data, git directories, and local model blobs. The archive and manifest are mode `0600` under `/var/backups/openclaw`.

This is a local safety net. Off-host copies should live on `moonlight` under `/srv/backups/openclaw/x1`; the first manual copy was written there on 2026-05-08. Future automation should sync the latest archive and matching `.manifest.json` there after each local backup.

### Agent Dashboard (`agent-dashboard`)

Added 2026-05-08. A read-only single-page dashboard at `https://dev.vixi.au/agents.html` showing what every agent on x1 is doing in real time: per-agent activity (latest assistant text / tool call / tool result, session-idle timer, primary model), current Jira task, open Jira tickets per coding agent, ai-monitor health and recent monitoring-agent decisions, and system-service status. Runs as a single Node service; the page itself is plain HTML with vanilla JS connecting to a Server-Sent Events stream — no framework, no build step.

#### URL and auth

- **Public**: `https://dev.vixi.au/agents.html` — terminates TLS at moonlight, proxies to x1's nginx, then to `127.0.0.1:3013`.
- **OpenClaw Control UIs**: `https://dev.vixi.au/asdrubal/` proxies to Asdrubal's OpenClaw gateway dashboard on `10.0.0.108:18789`; `https://dev.vixi.au/barekbaal/` proxies to Barekbaal's dashboard on `10.0.0.108:18790`. `/openclaw` and `/openclaw/` are legacy redirects to `/asdrubal/`. Both routes are nginx basic-auth protected and pass `X-Forwarded-User: $remote_user` into OpenClaw trusted-proxy auth, so there is no second OpenClaw token login after nginx auth. The gateway ports bind to LAN for trusted-proxy source detection, but firewalld does not open 18789/18790 to the network.
- **Auth**: HTTP basic auth at the x1 nginx layer, `auth_basic_user_file /etc/nginx/.htpasswd` (same `admin` user that protects per-agent `*.vixi.au` vhosts).
- **Health probe**: `https://dev.vixi.au/agents/health` is unauthenticated by design — returns `{ok, agents, clients}` as JSON for cheap external uptime checks.

#### Files

| Path | Purpose |
|---|---|
| `/usr/local/bin/agent-dashboard` | Node server (~530 lines). Stdlib `http`, `fs`, `child_process`. Listens on 127.0.0.1:3013. |
| `/srv/agents/shared/web/agents.html` | Single-file frontend (~810 lines including CSS + JS), redesigned 2026-05-10: modern dark/light themes (toggle persisted in `localStorage`), role-coded cards (`manager`/`developer`/`monitor` accent colors), capability + integration + service badges per agent, SVG-free icons. Hydrates per-agent metadata from `/agents/registry.json` (auth-gated nginx alias to `/srv/agents/index.json` — the live runtime registry, NOT in the repo); live state still flows via the SSE stream. Tracked in `environment/ai/web/agents.html`. Served by **nginx** directly via `alias`; SELinux context `httpd_sys_content_t`. The legacy path `/usr/local/share/agent-dashboard/agents.html` is now a symlink to this file so the Node fallback path still works for loopback-direct fetches. |
| `/etc/agent-dashboard/config.json` | Bind address/port, `agents_registry` path, jira host, `system_services` list, poll intervals. |
| `/etc/systemd/system/agent-dashboard.service` | `Type=simple`, `Restart=always`, runs as root, depends on `network-online.target` and `ai-monitor.timer`. |

#### Data sources (how it stays live)

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

`snapshot` (initial state on connect), `agent_activity` (jsonl line emitted), `agent_task_change` (current.md changed), `agent_jira` (Jira poll completed), `system_state` (service flipped state), `ai_monitor_tick`, `ai_monitor_state`, `karen_decision` (monitoring-agent decision; wire-format name kept verbatim for code compatibility — both backend and frontend reference the literal `karen_decision`), `session_idle_tick` (heartbeat).

#### nginx wiring

Three location blocks added to `/etc/nginx/vhosts.d/dev-migrated.conf`:

- `location = /agents.html` — `auth_basic` + `alias /srv/agents/shared/web/agents.html` (served directly by nginx as of 2026-05-10; was a `proxy_pass` to the Node service before).
- `location = /agents/registry.json` — `auth_basic` + `alias /srv/agents/index.json` (added 2026-05-10 to let the dashboard hydrate per-agent metadata: capabilities, integrations, services, listeners, telegram bot — all the fields the SSE snapshot doesn't emit). Same auth as the HTML.
- `location = /agents/events` — same auth, plus `proxy_buffering off; proxy_cache off; proxy_read_timeout 24h; chunked_transfer_encoding off;` so the persistent SSE connection isn't broken by buffering.
- `location = /agents/health` — no auth, simple proxy.

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

- **`karen_triage` config block** (`/etc/ai-monitor/config.json`). On a new alert, ai-monitor now writes `/var/lib/ai-monitor/incidents/<id>.json`, wakes the monitoring agent via `runuser -u karen openclaw system event --text "INCIDENT <id> ..."`, and polls `/var/lib/ai-monitor/decisions/<id>.json` for up to 300 s. The monitoring agent returns `{decision, reason, actions_taken, telegram_sent, timestamp}`. Self-incident guard: issues whose `unit` starts with `karen/` or `ai-monitor:` skip handoff and go to direct Telegram (the monitoring agent can't safely triage its own outage). The literal config-block name `karen_triage` is kept verbatim because ai-monitor reads it as a JSON key.

- **Policy guardrail for `task-stalled-no-agent`**. When the monitoring agent returns `decision: suppress` with `actions_taken` not containing `wake-agent` or `restart-and-wake`, ai-monitor flags it as a policy violation. Reason: a Jira ticket marked `In Progress` with no recent agent session activity is *defined* as stalled regardless of LLM rationalisation.

- **Auto-wake fallback** (action type `auto_woke_after_karen_suppress` — wire-format string kept verbatim for code/log compatibility). When the policy guardrail fires, ai-monitor itself runs `sudo /usr/local/sbin/openclaw-control wake-agent <user> "<reminder>"`, sleeps 15 s, and re-probes the agent's session jsonl mtime. If recovered (idle < 30 s after wake) → log silently, no Telegram. If still idle → Telegram with the wake attempt result. Net effect: stalled agents always get nudged on this kind, regardless of triage judgment.

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

- **Shared docs + skills moved to a git repo** (`bitbucket.org:zehferrari/zagents`, cloned at `/srv/agents/shared/`, working tree owned by a single configured "git owner" user — resolve dynamically with `stat -c %U /srv/agents/shared`). Replaces the manual-file model; edits land via `sudo -u <git-owner> git -C /srv/agents/shared {pull,commit,push}`. Per-repo `core.sshCommand` is set in `.git/config` to use the git-owner's own ed25519 key (the agents' default `bbZeh` SSH key authenticates as a personal account that may lack explicit write on this repo). Repo includes `README.md`, `AGENT_FILES.md` (per-agent file inventory with descriptions), `index.example.json` (single-record registry template — live registry is `/srv/agents/index.json`, NOT in the repo), all the existing shared docs, and `skills/`. All `*.bak*` files were nuked across the host (260 files) — git history is the backup.

- **`/etc/openclaw/agents.json` is now a symlink** → `/srv/agents/index.json` (the live runtime registry, kept *outside* the git working tree at `/srv/agents/shared/` so dashboard toggle writes don't pollute `git diff`). ai-monitor, the dashboard, registry-check and the webhook receiver all read through the symlink transparently. The single-record template `/srv/agents/shared/index.example.json` stays in git as the in-repo reference; copy it to `/srv/agents/index.json` and edit when bootstrapping a new host. nginx alias for `/agents/registry.json` and the dashboard's `setRegistryFlag()` write target both point at the live file directly.

- **Dashboard HTML moved into the repo** (`/srv/agents/shared/web/agents.html`). nginx serves it directly via `alias` from `/etc/nginx/vhosts.d/dev-migrated.conf` (was previously `proxy_pass http://127.0.0.1:3013/agents.html`). The Node service still handles `/agents/events` (SSE) and `/agents/health`. Legacy `/usr/local/share/agent-dashboard/agents.html` is a symlink for backwards compatibility.

- **Webhook @-mention routing** (`/home/karen/webhooks/webhook-receiver.js` + `users.json`). `comment_*` events are parsed for both ADF and wiki-markup mentions (`[~accountid:712020:...]`). Jira Cloud delivers webhook `comment.body` as a wiki-markup string (not ADF — the REST API does ADF, webhooks do not), so `extractWikiMentions()` is the path that fires in practice. Mentioned agents are routed by `jiraAccountId` lookup (per-user map built at startup from `users.json`); the wake message gets a "You were @-mentioned in <KEY> by <Mentioner>" prefix invoking the new TEAM_WORKFLOW.md "Responding to @-mentions" rule. Comment author is excluded (no self-wake). Falls back to assignee match, then broadcast.

- **Pending-mention queue** (`/var/lib/ai-monitor/pending-mentions/`, root:karen 0775). Receiver writes one JSON per `(issue_key, comment_id, agent)` recording mention metadata. ai-monitor's new `probe_pending_mentions` walks the queue every tick, queries Jira for an agent reply on the issue dated ≥ the mention's `created`, and either deletes the resolved entry or surfaces a `mention-awaiting-reply` warn (≥15 min) or crit (≥60 min). Configured under `/etc/ai-monitor/config.json` → `pending_mentions` block.

- **`jira-probe-failed` / `pending-mentions-probe-failed` axes** (`/usr/local/bin/ai-monitor`). Errors that previously hid in `stalled_tasks.errors` and `pending_mentions.errors` now surface as deterministic issues. Catches token expiry, rate-limit, and network breakage that would otherwise silently disable the alerts.

- **TEAM_WORKFLOW.md consolidated** (`/srv/agents/shared/TEAM_WORKFLOW.md`). Each coding agent's two paths (`/home/<user>/workspace/TEAM_WORKFLOW.md` and `/home/<user>/.openclaw/workspace/TEAM_WORKFLOW.md`) are now symlinks to the canonical shared file — single source of truth, edits land in one place, every agent picks up the change on next read.

- **New / updated TEAM_WORKFLOW.md sections**:
  - `Responding to @-mentions` — agents must reply on the ticket if @-mentioned, even if the ticket isn't theirs. Backed by the `mention-awaiting-reply` axis.
  - `Reply Formatting` — Jira/email replies must be proper markdown (blank-line-separated paragraphs, bullet/numbered lists, ATX headings, fenced code blocks, inline code, pipe tables). Walls of one-paragraph text are unacceptable. Telegram stays terse, no markdown decoration, no signature.
  - Updated `Outbound Signature Rule` — signature is now `--` / `<First Name>` / `<provider>/<model>` (no `Model:` prefix, first name only). Helpers render the provider/model line subdued (smaller, grey). Mandatory for Jira/email; forbidden in Telegram.

- **Shared skills tree** (`/srv/agents/shared/skills/`). Agent identity now flows from `/etc/openclaw/agents.json` (resolved by `os.userInfo().username`) through a small `agent-self.js` module, eliminating per-agent forks of helper code. Layout:
  ```
  /srv/agents/shared/skills/
    agent-self.js              # registry-driven identity resolver
    jira/                      # 9 files (lib.js reads email from agents.json)
      jira-comment.js, lib.js, jira-transition.js, jira-my-issues.js, ...
    google-workspace/          # 61 files (docs-comments-* read displayName from agents.json)
      gmail-send.js, mime.js, lib.js, drive-*.js, calendar-*.js, ...
  ```
  Per-agent `~/.openclaw/workspace/jira/*.js` and `~/.openclaw/skills/google-workspace/*.js` are now symlinks. Per-agent **state** files stay real per-agent (state.json, *-state.json, _comments.json, _docs.json, auto-reply-policy.json) — each agent maintains its own gmail/drive state. Pre-symlink originals saved as `*.bak-symlink-20260510T1100`.

- **`jira-comment.js` markdown → ADF** (`/srv/agents/shared/skills/jira/jira-comment.js`). Was a single-paragraph passthrough that crammed everything into one ADF text node; now parses markdown into a proper ADF doc — paragraphs, ATX headings (1–3), bullet/numbered lists, fenced code blocks, pipe tables, inline `**bold**` / `*italic*` / `` `code` `` / `[text](url)`. A trailing `--` / `<first name>` / `<provider>/<model>` signature is detected and the provider/model line gets ADF marks `subsup{type:sub}` + `textColor{#999999}` for a subdued render.

- **`mime.js textToHtml` signature styling** (`/srv/agents/shared/skills/google-workspace/mime.js`). Detects the trailing `--/Name/Provider/Model` paragraph and renders the provider/model line as `<span style="color:#888;font-size:smaller;font-style:italic;">…</span>` in the HTML email part. Plain-text part unchanged.

- **Roles renamed** in `agents.json` and every doc/per-agent file: `manager-worker` → `manager`, `cost-efficient implementer` → `developer`, `monitor` unchanged. No code did literal string-matching on these (verified by grep across `/usr/local/bin`, `/usr/local/sbin`, `/etc/ai-monitor`, `/etc/agent-dashboard`, `/home/karen/webhooks`, `skills/`), so the rename is data-only. Reframed the model-tier language: each role uses a model **tuned for that kind of work**, not arranged on a cheap-vs-expensive ladder. An "escalation" between roles is a fresh perspective from a different model — not an admission that the other model is inferior.

- **Documentation generalised**: every prose mention of `Asdrubal`, `Barekbaal`, `Karen` removed from the shared docs (replaced with role-based or `<user>` references). Wire-format identifiers (`karen_decision` SSE event, `karen_triage` JSON config key, `auto_woke_after_karen_suppress` log/action string) kept verbatim because they're live code/config constants — annotated as such in this doc. The `agents.json` registry, the per-agent `SOUL.md`/`IDENTITY.md` (persona), and webhook routing config legitimately keep agent names as data.

- **Doc consolidation: `AGENTS.md` + new `ROLES.md`**. The `AGENTS/` folder (manager.md / developer.md / monitor.md) was collapsed into a single shared `AGENTS.md` (operating baseline read by every agent regardless of role) and a new `ROLES.md` (sectioned by role: `## Manager`, `## Developer`, `## Monitor`). Each agent reads `AGENTS.md`, looks up its `role` in `agents.json`, and reads the matching section in `ROLES.md`. All five per-agent `AGENTS.md` symlinks now point at the same shared file. Also: `TEAM_SHARED.md` deleted (was a strict duplicate of `TEAM_WORKFLOW.md`).

- **Action-indexed workflow doc**. `TEAM_WORKFLOW.md` got a Quick Index table at the top mapping "When you are about to X, read § Y", with action-titled section headings ("Sending an outbound", "Receiving an @-mention", "Picking your next task", "Working a Jira ticket", "Reviewing", "Email", "Telegram", "System / service operations", "Knowledge handling", "Escalation", "Manager → developer handoff"). Lets agents jump to the relevant ~10-line section instead of re-reading 200+ lines per task. Net byte size on always-loaded baseline (`AGENTS.md` + `ROLES.md` + `TEAM_WORKFLOW.md`) dropped ~24 % alongside.

- **Per-agent file audit**. Removed restated workflow rules (Communication, Boundaries, escalation criteria) from `SOUL.md` and `IDENTITY.md` for both coding agents — those rules now live exclusively in `AGENTS.md` and `TEAM_WORKFLOW.md`. Updated stale role names (`manager-worker`, `cost-efficient implementer`) and obsolete model-tier framings (`stronger model`, `Ollama cloud models, so be disciplined`) to match the new role-tuned-for-work framing. The monitoring agent's stale `/home/zeh/AGENTS.md` reference in `IDENTITY.md` was replaced with the actual canonical doc paths.

- **Workspace divergence resolved**. For each coding agent, `~/.openclaw/workspace/{SOUL,IDENTITY,USER,TOOLS,MEMORY,HEARTBEAT}.md` was previously a separate file from `~/workspace/<file>` — typically a generic openclaw template, drifted from the user-customised `~/workspace/` version. Each `~/.openclaw/workspace/` per-agent file is now a symlink to its `~/workspace/` canonical. Pre-unification originals saved as `*.preunify-20260510T1541` for inspection. Net effect: a single canonical location per per-agent file regardless of which workspace the runtime reads.

### Recent changes (2026-05-13)

Set of fixes triggered by moving an agent onto the `claude-cli` provider and discovering the rest of the stack assumed the openclaw session jsonl was the source of truth for "is the agent doing anything". For `claude-cli` sessions openclaw doesn't write its own session jsonl — conversation content lives only in `~/.claude/projects/-home-<user>-workspace/<sid>.jsonl` — and there are no incremental tool/text events back into openclaw's typing pipeline either. Bookkeeping in `~/.openclaw/agents/main/sessions/sessions.json` is the only signal that survives across providers, so several places now read it directly.

- **Stall probe upgraded** (`/usr/local/bin/ai-monitor` → `probe_session_idle_for_user`). Previous probe: `ls -t .openclaw/agents/main/sessions/*.jsonl | head -1` then `stat`. New probe takes max of (a) newest openclaw jsonl mtime AND (b) max `updatedAt` across **all** `agent:main:*` keys in `sessions.json`. Source (b) is what catches `claude-cli` sessions and activity on non-heartbeat surfaces (Telegram DMs, subagents). Without it `task-stalled-no-agent` false-fires for any agent on `claude-cli` even while opus is mid-turn.

- **Dashboard idle indicator + tail dispatch** (`/usr/local/bin/agent-dashboard`). Mirror change: `mostRecentActivityMs(user)` does the same max(jsonl-mtime, sessions.json-updatedAt-across-all-keys) calculation. New `pickActiveSessionInfo(user)` scans every `agent:main:*` conversation key, picks the one with the most-recent `updatedAt`, and returns `{file, format}`. For a `claude-cli` key it returns the claude-cli jsonl path under `~/.claude/projects/-home-<user>-workspace/<claudeCliSessionId>.jsonl` with `format: 'claude-cli'`; otherwise the conversation entry's own `sessionFile` with `format: 'openclaw'`. `startSessionTail` then dispatches each line to either `handleSessionLine` (openclaw schema: `{type, message}`) or the new `handleClaudeCliLine` (claude-cli schema: `{type:'user'|'assistant', message:{role,content,model,stop_reason}, timestamp}`). `summarizeContentClaudeCli` maps content blocks `text`/`tool_use`/`tool_result`/`thinking` into the same shape `agentsActivity` already renders, so no frontend change was needed for the activity log. `rotateSessionTailsIfNeeded` (every 30 s) detects file OR format flips and re-spawns the tail.

- **Per-agent currently-running model** displayed on each agent tile. Backend has a new `currentModelFromSessions(user)` helper that returns `<modelProvider>/<model>` for the most-recent `agent:main:*` entry — runs as part of `pollSessionIdle` so it covers initial paint, fallback engagement, and `claude-cli` agents whose stream events never reach the openclaw jsonl. `model_primary` is broadcast as a `model_change` event when it transitions. Frontend renders it as a `model-chip` badge in the agent card meta-row; `shortModel()` strips verbose prefixes (`claude-`, `:cloud`, `openrouter/<vendor>/`) so the chip stays tile-sized; the full `provider/model` is the tooltip. Reflects what the agent is *actually* running (after fallbacks), not just the configured primary.

- **Telegram typing-keepalive sidecar** (`/usr/local/bin/openclaw-typing-keepalive`, `openclaw-typing-keepalive.service`, system-wide). The cli-backend (`runCliAgent` in `cli-runner-BI7Whd5n.js:7`) is non-streaming — it `await`s the full claude response in one call, no incremental events. openclaw's built-in typing keepalive has a ~60 s TTL refreshed by those events; without them "typing…" disappears mid-turn on long opus runs. The sidecar polls each registered agent's `sessions.json` every 1 s, finds telegram conversation keys (`agent:main:telegram:direct:<chat>` or `:group:<chat>`) currently `status=running` on `modelProvider=claude-cli`, and re-fires `sendChatAction("typing")` for the matching chat every 4 s until status flips back to `done`. Reads each agent's bot token from `~/.config/openclaw/openclaw-secrets.env` (`TELEGRAM_BOT_TOKEN`). Auto-discovers from `/etc/openclaw/agents.json` — adding a new agent to the registry and giving it `enabled + telegram.enabled` is enough; no per-user install. Agents on `ollama` / `openai-codex` / other providers are skipped silently because they emit native streaming events that drive the in-process typing pipeline correctly. Picked up by `openclaw-control restart-services` via the `openclaw-*` prefix.

- **`sessions.json` is now a first-class probe surface.** Three independent places (ai-monitor, dashboard, typing-keepalive) read it directly: `agent:main:main.updatedAt` for the heartbeat conversation's last activity; the full set of `agent:main:*` keys for cross-conversation activity max; `claudeCliSessionId` / `cliSessionBindings.claude-cli.sessionId` for resolving the claude-cli jsonl file path; `modelProvider`/`model` for the currently-running model. Schema noted here so future probes don't re-derive these fields — the file is mode `0600` owned by the agent user; root readers (ai-monitor, dashboard, typing-keepalive) read directly.

- **New `agent-idle-with-queue` axis** (`/usr/local/bin/ai-monitor` → `probe_idle_with_queue_for_agent` + `probe_agent_queue`). Closes the gap that `task-stalled-no-agent` couldn't see: agent finishes a ticket → transitions out of *In Progress* → has zero In Progress tickets → the existing stall probe finds nothing to attach an alert to. Meanwhile *Selected for Development* / *To Do* tickets sit unstarted indefinitely. New probe queries `assignee=currentUser() AND status in (In Progress + queue_statuses)` per coding agent each tick, classifies locally; fires when *queue_count ≥ 1 AND in_progress_count = 0 AND session_idle_s ≥ threshold*. Defaults: `queue_statuses = ["Selected for Development", "To Do"]`, 10 min warn / 30 min crit. Configured under `/etc/ai-monitor/config.json` → `agent_queue_check`. Severity-named issue is `jira:<user>/queue` with `kind: agent-idle-with-queue`; reason text names the first 5 queued keys for context.

- **Bypass-Karen path for deterministic kinds** (`dedupe_and_act`). New `karen_triage.auto_action_kinds_bypass_karen` config list (default `["agent-idle-with-queue"]`). When an issue of one of these kinds appears in the same tick, ai-monitor partitions it OUT of the karen-bound set, runs `auto_wake_stalled_agents` directly (which generates a kind-aware reminder naming the queued keys + TEAM_WORKFLOW.md *"Picking the Next Task"* and pushes it through `openclaw-control wake-agent`), marks the alert key `alert_sent` so it doesn't re-fire next tick, and records an `auto_action_bypass_karen` action in the verdict log. The remaining (non-auto) issues still flow through Karen as before. If ALL issues this tick were auto-handled, the Karen handoff is skipped entirely — no incident written, no Telegram. Rationale: when the situation is unambiguous and the action is bounded + idempotent, a triage round-trip just adds latency and a chance of a wrong suppress. To extend, add a kind to the config list — no code change.

### WDT Notes

Each coding agent has its own `wdt-<user>.service` (Next.js standalone WDT playground). The unit name embeds the Linux username; the `<user>` and per-agent listener port are recorded in `/etc/openclaw/agents.json`.

- WDT playgrounds were brought up on 2026-05-06 during the ThinkPad → x1 migration.
- Legacy `wdt-branch-control.service` has been removed. Do not recreate it; branch-control server code was a retired dev helper, not part of the active WDT runtime.
- The current WDT app uses `.env`; `.env.production` is legacy.
- Each agent's `.env` uses an absolute SQLite URL so it resolves correctly when systemd runs from `.next/standalone`.
- `wdt-<user>.service` uses `EnvironmentFile=/home/<user>/Code/whitsunday-discovery-trail/.env`, a per-agent `PORT` (see `agents.json` `listeners`), and `HOSTNAME=127.0.0.1`.
- The app is rebuilt with `pnpm run build`, generating `.next/standalone/server.js`.
- After rebuilding WDT, re-apply nginx access and SELinux context to static assets if nginx serves `/_next/static/` directly. Substitute `<user>` for each coding agent:

  ```
  setfacl -m u:nginx:rx /home/<user> /home/<user>/Code /home/<user>/Code/whitsunday-discovery-trail /home/<user>/Code/whitsunday-discovery-trail/.next
  setfacl -R -m u:nginx:rX /home/<user>/Code/whitsunday-discovery-trail/.next/static
  chcon -R -t httpd_sys_content_t /home/<user>/Code/whitsunday-discovery-trail/.next/static
  ```

Known follow-ups:

- If BotFather tokens are ever rotated, update each user's `telegram-token` and OpenClaw secrets env.
- The Ollama service on `x1` uses conservative default backend settings, not ThinkPad-specific GPU tuning.
- x1 is still a single point of failure for OpenClaw agents, WDT playgrounds, monitoring, and remediation. Local backup reduces accidental-loss risk; disk-loss protection depends on keeping `moonlight:/srv/backups/openclaw/x1` current.
- Gmail watch renewal remains operationally critical because Gmail watches expire. Keep `/usr/local/bin/openclaw-integrity-check` and dashboard status green.
- The monitoring agent runs on the host it monitors. Self-incidents must continue to bypass the monitoring agent and go directly to Telegram fallback.
- Secrets are split by Linux user for least privilege, which is correct, but audits should use `/usr/local/bin/openclaw-backup --inventory` plus `/usr/local/bin/openclaw-registry-check`.
- Future changes should go through `/etc/openclaw/agents.json` and `/srv/agents/shared`; hand-editing dependent configs without running the validator can reintroduce drift.
