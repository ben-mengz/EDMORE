"""One-time cloud migration. Run only after backup and stopping both services."""
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess

def deploy_config():
    """Site values from edmore.deploy.env (see edmore.deploy.env.example)."""
    path = Path(os.environ.get('EDMORE_DEPLOY_ENV', Path.home() / '.config/edmore/deploy.env'))
    if not path.is_file():
        raise SystemExit(f'Missing deployment config: {path}')
    output = subprocess.run(['bash', '-c', 'set -a; source "$1"; env -0', '_', str(path)],
                            check=True, capture_output=True).stdout.decode()
    return dict(row.split('=', 1) for row in output.split('\0') if '=' in row)


DEPLOY = deploy_config()
root = Path(DEPLOY['EDMORE_REGISTRATION_ROOT'])
access = root / 'harness-access'
access.mkdir(mode=0o700, exist_ok=False)

def write(path, value):
    temporary = path.with_suffix(path.suffix + '.new')
    with temporary.open('x') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, indent=2)
        stream.write('\n')
    temporary.replace(path)

secret = secrets.token_urlsafe(48)
write(access / 'harness-access.json', {
    'version': 1, 'issuer': 'edmore-cloud', 'signingSecret': secret,
    'registrationUrl': DEPLOY['EDMORE_REGISTRATION_URL'],
    'mcpUrl': 'http://127.0.0.1:8767/mcp', 'caFile': '/tango-access/server.crt',
})
write(access / 'gateway-access.json', {
    'version': 1, 'issuers': {'edmore-cloud': {'secret': secret, 'allow_admin': True}},
    'registration_state_file': str(root / 'private/state.json'),
    'policy_file': str(access / 'device-policy.json'),
    'static_devices': ['edmore/tem/twin'], 'read_tools': [],
})
write(access / 'device-policy.json', {'version': 1, 'devices': {}, 'shares': {}, 'pairings': {}})
shutil.copyfile(root / 'private/server.crt', access / 'server.crt')
os.chmod(access / 'server.crt', 0o600)
path = root / 'private/config.json'
config = json.loads(path.read_text())
config['device_access_file'] = str(access / 'gateway-access.json')
write(path, config)
path = Path(DEPLOY['EDMORE_DATA_DIR']) / 'auth/admin/settings.json'
config = json.loads(path.read_text())
legacy = [row for row in config['mcp'] if row['id'] == 'tem_twin']
if len(legacy) != 1 or legacy[0]['url'] != 'http://127.0.0.1:8767/mcp':
    raise RuntimeError('Unexpected legacy MCP configuration; inspect before migrating')
config['mcp'] = [row for row in config['mcp'] if row['id'] != 'tem_twin']
config['revision'] += 1
config['action'] = 'migrate-tango-user-authorization'
write(path, config)
print('Access configured. Devices remain unassigned; no user permissions were granted.')
