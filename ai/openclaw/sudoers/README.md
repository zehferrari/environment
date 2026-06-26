# sudoers fragments

Templates for the privileged accounts OpenClaw relies on. **Never** install
these as-is — they contain placeholders. Copy, substitute, validate with
`visudo -c -f`, install to `/etc/sudoers.d/` with mode `0440`.

| File | Used by | Substitutions required |
|---|---|---|
| `monitor-agent.example` | The monitor agent (role: monitor in agents.json) — e.g. `karen` on thinkpad, `emery` on yoga510 | `<MONITOR_USER>`, `<CODING_USERS>`, plus uncomment per-host system services |
| `openclaw-mail-self-wake.example` | yoga510 mail-stack integration | (see comments inside) |

The concrete `/etc/sudoers.d/<user>-openclaw-control` files are
host-specific and live ONLY on the host, never in the shared repo
(different system services, different agent names, different per-host
secrets path). The example/template is the source of truth for the
*shape* of the file.
