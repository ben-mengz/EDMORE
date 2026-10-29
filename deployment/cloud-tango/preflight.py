"""Read live worker activity and drain only the managed MCP gateway."""
import json
import os
from pathlib import Path
import subprocess
from urllib.request import Request, urlopen

def deploy_config():
    """Site values from edmore.deploy.env (see edmore.deploy.env.example)."""
    path = Path(os.environ.get('EDMORE_DEPLOY_ENV', Path.home() / '.config/edmore/deploy.env'))
    if not path.is_file():
        raise SystemExit(f'Missing deployment config: {path}')
    output = subprocess.run(['bash', '-c', 'set -a; source "$1"; env -0', '_', str(path)],
                            check=True, capture_output=True).stdout.decode()
    return dict(row.split('=', 1) for row in output.split('\0') if '=' in row)


DEPLOY = deploy_config()
users = []
for process in Path('/proc').iterdir():
    if not process.name.isdigit():
        continue
    try:
        if process.stat().st_uid != os.getuid():
            continue
        environment = dict(row.split('=', 1) for row in (process / 'environ').read_text().split('\0') if '=' in row)
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        continue
    if environment.get('EDMORE_AUTH_WORKER') == '1':
        user = Path(environment['DSH_HOME']).name
        path = Path(DEPLOY['EDMORE_DATA_DIR']) / 'auth/users' / user / 'edmore/events.jsonl'
        running = set()
        for line in path.read_text().splitlines():
            event = json.loads(line)
            response = event.get('payload', {}).get('response_id')
            if event['type'] == 'edmore.assistant.started':
                running.add(response)
            elif event['type'] in ('edmore.assistant.completed', 'edmore.assistant.failed'):
                running.discard(response)
        if running:
            raise RuntimeError('Active response exists; migration postponed')
        users.append(user)
print('Idle live workers:', sorted(set(users)))
config = json.loads((Path(DEPLOY['EDMORE_REGISTRATION_ROOT']) / 'private/config.json').read_text())
state = json.loads(Path(config['state_file']).read_text())
if state.get('pending'):
    raise RuntimeError('Registration update is pending; migration postponed')
request = Request(config['gateway_admin_url'] + '/registration/quiesce', method='POST', data=b'',
                  headers={'Authorization': 'Bearer ' + config['management_token']})
with urlopen(request, timeout=10) as response:
    if not json.load(response).get('quiesced'):
        raise RuntimeError('Gateway refused to drain')
print('Gateway drained: no active managed device calls; new calls blocked for migration.')
