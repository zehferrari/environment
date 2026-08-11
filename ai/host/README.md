# thinkpad host configuration

Versioned, host-specific configuration for the `thinkpad` OpenClaw/PM host.
These files are separate from `ai/openclaw/` because they configure the
operating system itself, not the portable OpenClaw runtime.

## Managed paths

| Repository source | Live path | Purpose |
|---|---|---|
| `tlp/30-charge-thresholds.conf` | `/etc/tlp.d/30-charge-thresholds.conf` | Battery thresholds and AMD `amd-pstate-epp` policy |
| `logrotate/nginx` | `/etc/logrotate.d/nginx` | Rotate nginx logs as the owner of the host's nginx log directory |
| `systemd/nginx.service.d/10-runtime-paths.conf` | `/etc/systemd/system/nginx.service.d/10-runtime-paths.conf` | Keeps nginx request/proxy spool paths writable by the configured worker identity after package upgrades |
| `systemd/zypper-dup.service` | `/etc/systemd/system/zypper-dup.service` | Weekly Tumbleweed distribution upgrade |
| `systemd/zypper-dup.timer` | `/etc/systemd/system/zypper-dup.timer` | Schedule for the distribution upgrade |
| `kernel/required-cmdline` | merged into `/etc/kernel/cmdline` | Enables PSI telemetry on the next boot |
| `tmpfiles/fs-tmp.conf` | `/etc/tmpfiles.d/fs-tmp.conf` | Keeps RAM-backed `/tmp` retention to three days |
| `systemd/user/openclaw-gateway.service.d/30-memory-policy.conf` | `/etc/systemd/user/openclaw-gateway.service.d/30-memory-policy.conf` | Per-gateway memory containment + Node heap cap |
| `systemd/user-manager/80-openclaw-resource-controllers.conf` | `/etc/systemd/system/user@<agent-uid>.service.d/80-openclaw-resource-controllers.conf` | Delegates the memory controller only to agent user managers |

Deploy from the active worktree:

```bash
cd /srv/Code/environment.worktrees/<branch>
sudo ai/host/install.sh
```

Preview without writes:

```bash
ai/host/install.sh --dry-run
```

The installer enables `tlp.service`, applies its policy immediately, enables
the zypper timer without starting an upgrade, reconciles nginx runtime paths,
validates the nginx logrotate stanza in debug mode, enables redacted OpenClaw
pre-OOM snapshots in every active agent config, reconciles each identical home
config back to its canonical symlink, and clears the old failed state for the
repaired units.
It fails rather than overwrite a divergent home config.
It deliberately does not start `zypper-dup.service`, force a log rotation,
delete old `/tmp` entries immediately, restart nginx or agent user
managers/gateways, or reboot the host. The nginx runtime-path repair takes
effect immediately without a restart; its service drop-in prevents package
ownership resets from breaking buffered requests on later starts.

The gateway policy starts cgroup reclaim at 8 GiB, caps one gateway at
10 GiB, and allows no swap. The earlier 6 GiB high / 8 GiB max / 2 GiB swap
budget let `memory.high` reclaim throttling freeze a busy gateway's event
loop for minutes once heavy claude-cli turns filled it — turns stalled until
the watchdog or monitor killed them. With `MemorySwapMax=0` a genuine
overrun instead fails fast: OOM-kill at `MemoryMax` plus `Restart=always`
recovers in seconds. The same drop-in caps the node gateway heap
(`NODE_OPTIONS=--max-old-space-size=2560`, repeating
`--dns-result-order=ipv4first` because a drop-in assignment replaces the
unit's own value) so the remaining cgroup budget stays available to
claude-cli child processes. The host installer creates a `Delegate=pids memory`
override only for enabled agent UIDs because openSUSE otherwise withholds the
memory controller from user services. Existing `user@<uid>.service` instances
must be restarted one at a time while their agent is idle; then restart that
gateway. New agents receive the delegation before their user manager starts.
The OpenClaw diagnostics configuration itself is hot-reloadable.

The installer merges `psi=1` into `/etc/kernel/cmdline` and idempotently
refreshes every systemd-boot entry with `sdbootutil` on each reconcile. PSI
becomes available under
`/proc/pressure/` after the next reboot; the installer does not reboot.

After deployment, verify:

```bash
tlp-stat -s -p
systemctl status tlp.service zypper-dup.timer
sudo /usr/sbin/logrotate --debug /etc/logrotate.d/nginx
systemctl --failed
cat /proc/pressure/memory                 # after reboot
sudo -u karen env XDG_RUNTIME_DIR=/run/user/1003 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1003/bus \
  systemctl --user show openclaw-gateway.service \
  -p MemoryCurrent -p MemoryHigh -p MemoryMax -p MemorySwapMax
```

On this AMD host, `amd-pstate-epp` exposes only the `performance` and
`powersave` governors. `schedutil` is therefore invalid. The tracked policy
uses the `powersave` governor with `balance_performance` EPP on AC; this still
boosts under load while allowing idle and lightly loaded cores to reduce
frequency and power. Battery mode uses `balance_power`.

`tlp-pd.service` is optional. Enable it only if desktop power-profile switching
through a GUI is desired; it is not required for the boot-time and AC/battery
policy managed by `tlp.service`.
