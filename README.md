# Environment

Unified settings and documentation for the hosts in this network. One folder per host or host role:

| Folder | Subject |
|---|---|
| [`ai/`](./ai) | OpenClaw multi-agent stack on **x1** — host doc + shared agent docs/skills + dashboard frontend |
| [`ha/`](./ha) | Home Assistant configuration (hostname `homeassistant`) |
| [`p16s/`](./p16s) | Hyprland/Wayland desktop config for the **thinkpad** laptop (Lenovo P16s Gen 2) |
| [`zeus/`](./zeus) | Hyprland/Wayland desktop config for the **fedora** workstation |

Host inventory below covers the networked roles (where they live, what they do); per-host deep docs live in the folders above.

## x1

- Host/IP: `x1`, `10.0.0.108`
- OS: openSUSE Tumbleweed
- Role: OpenClaw multi-agent host, WDT playground host, local service host.
- Active users and their roles are listed in `/etc/openclaw/agents.json` (symlinked from `/srv/agents/index.json`). UIDs start at 1001 for agents.

### Samba Private Shared Folders

- Samba service: `smb` and `nmb`, enabled and active through systemd.
- Share name: `Shared`.
- Share path in Samba: `/srv/samba/shared/%U`, so each authenticated user lands in their own private folder.
- Per-user folders: one folder per Linux account at `/srv/samba/shared/<username>` (one for the operator account, one for each entry in the agent registry).
- Home symlinks: each user has `~/Shared -> /srv/samba/shared/<username>` so the same folder is reachable from inside the home dir.
- Permissions: each private folder is owned by the matching Linux user and set to mode `0700`; users cannot read or write each other's shared folder.
- Firewall: `firewalld` permanently allows the `samba` service.
- Samba config: `/etc/samba/smb.conf`, section `[Shared]`.
- SELinux: `/srv/samba/shared(/.*)?` is permanently labeled `samba_share_t` through local file contexts.

### Samba Password Sync

- PAM hook: `/usr/local/sbin/sync-samba-password`, registered from `/etc/pam.d/common-password` through `pam_exec.so`.
- Queue worker: `/usr/local/sbin/sync-samba-password-queue`, run by `sync-samba-password-queue.service`.
- Queue trigger: `sync-samba-password-queue.timer` runs every 5 seconds as a fallback. `sync-samba-password-queue.path` is also enabled, but the timer is the reliable trigger on this host.
- Queue inbox: `/tmp/samba-password-sync/<username>/password.pw`; the parent is root-owned `0711`, and each user subdirectory is owned by the matching Linux account with mode `0700`.
- Scope: the operator account plus every active user in the agent registry.
- Behavior: when one of those users changes their Linux password with `passwd`, the hook creates or updates the matching Samba credential with the same password.
- Bootstrap: users who do not yet exist in Samba should run `passwd` once on `x1`; after that, SMB login uses the same username and password as Linux.
- Verification commands:
  - `sudo /usr/sbin/pam-config --verify`
  - `sudo pdbedit -L`
  - `sudo testparm -s /etc/samba/smb.conf`
  - `systemctl is-active smb nmb sync-samba-password-queue.timer`

## moonlight

- Host/IP: `moonlight`, `10.0.0.10`
- Role: public nginx ingress for `vixi.au` routes.
- Webhook path: `https://dev.vixi.au/webhooks/*` proxies to x1.
- Ollama is also proxied externally through moonlight as documented in root operations notes.

## thinkpad

- Host/IP: `thinkpad`, `10.0.0.105`
- Role: previous OpenClaw agent host; current portable Hyprland/Wayland laptop.
- Current status: migrated user services and linger are disabled; source homes remain intact for reference only.
- Desktop config: [`p16s/`](./p16s).
