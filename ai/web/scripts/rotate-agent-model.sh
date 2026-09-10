#!/usr/bin/env bash
# Usage: sudo ./rotate-agent-model.sh [--dry-run] <provider> <new-model>
# Use the running PM database and service identity, even before this branch is deployed.
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec python3 - "$script_dir" "$@" <<'BOOTSTRAP'
import os, subprocess, sys
from pathlib import Path
script_dir, *args = sys.argv[1:]
if len(args) not in (2, 3) or (len(args) == 3 and args[0] != '--dry-run'):
    sys.exit('Usage: sudo rotate-agent-model.sh [--dry-run] <provider> <new-model>')
if os.geteuid() != 0:
    sys.exit('Run with sudo so the command can use the running PM service identity and database.')
pid = subprocess.check_output(['/usr/bin/systemctl', 'show', 'pm.service', '-p', 'MainPID', '--value'], text=True).strip()
if not pid.isdigit() or int(pid) < 2:
    sys.exit('pm.service is not running')
env = dict(x.split('=', 1) for x in Path('/proc/' + pid + '/environ').read_bytes().decode().split('\0') if '=' in x)
status = dict(x.split(':', 1) for x in Path('/proc/' + pid + '/status').read_text().splitlines() if ':' in x)
uid, gid = int(status['Uid'].split()[1]), int(status['Gid'].split()[1])
if not uid or 'DATABASE_URL' not in env:
    sys.exit('Refusing a root PM identity or missing database configuration')
# Do not pass unrelated service secrets into the updater.
child_env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'NODE_ENV': 'production', 'DATABASE_URL': env['DATABASE_URL']}
for key in ['AGENT_INDEX_PATH', 'PM_AGENT_CONFIG_ROOT']:
    if key in env: child_env[key] = env[key]
if args[0] == '--dry-run': child_env.pop('DATABASE_URL', None)
os.setgroups([int(x) for x in status.get('Groups', '').split()])
os.setgid(gid)
os.setuid(uid)
os.chdir(str(Path(script_dir).parent))
os.execve('/usr/bin/node', ['node', '--import', 'tsx', str(Path(script_dir) / 'rotate-agent-model.ts'), *args], child_env)
BOOTSTRAP
