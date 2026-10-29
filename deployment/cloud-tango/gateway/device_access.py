"""Harness identity assertions and fail-closed device authorization."""
import base64
import hashlib
import hmac
import json
import time
from pathlib import Path


def verify_assertion(token, config, audience, now=None):
    now = int(time.time()) if now is None else now
    try:
        if not isinstance(token, str) or len(token) > 4096:
            raise ValueError()
        payload, signature = token.split('.')
        raw = base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4))
        claims = json.loads(raw)
        issuer = config['issuers'][claims['iss']]
        key = issuer['secret']
        if len(key) < 32:
            raise ValueError()
        expected = hmac.new(key.encode(), payload.encode(), hashlib.sha256).digest()
        supplied = base64.urlsafe_b64decode(signature + '=' * (-len(signature) % 4))
        if not hmac.compare_digest(expected, supplied):
            raise ValueError()
        if claims.get('v') != 1 or claims.get('aud') != audience:
            raise ValueError()
        if type(claims['exp']) is not int or type(claims['iat']) is not int:
            raise ValueError()
        if not now < claims['exp'] <= claims['iat'] + 60 or not now - 60 <= claims['iat'] <= now + 5:
            raise ValueError()
        if not isinstance(claims['sub'], str) or not claims['sub'] or len(claims['sub']) > 128:
            raise ValueError()
        return {'id': claims['iss'] + ':' + claims['sub'],
                'admin': claims.get('admin') is True and issuer.get('allow_admin') is True,
                'label': str(claims.get('label', ''))[:64]}
    except (KeyError, ValueError, TypeError, UnicodeError, AttributeError):
        raise PermissionError('Valid Harness identity required') from None


class DeviceAccess:
    def __init__(self, configuration):
        self.configuration = Path(configuration)
        self.config()  # Configuration errors are fatal, never a legacy fallback.

    def config(self):
        value = json.loads(self.configuration.read_text())
        if value.get('version') != 1 or not value.get('issuers') or not value.get('policy_file') or not value.get('registration_state_file'):
            raise ValueError('Invalid Tango access configuration')
        if any(len(row.get('secret', '')) < 32 for row in value['issuers'].values()):
            raise ValueError('A separate strong Harness issuer secret is required')
        return value

    def identity(self, authorization, audience='tango-mcp'):
        if not authorization.startswith('Bearer '):
            raise PermissionError('Valid Harness identity required')
        return verify_assertion(authorization[7:], self.config(), audience)

    def state(self):
        path = Path(self.config()['policy_file'])
        if not path.exists():
            return {'version': 1, 'devices': {}, 'shares': {}, 'pairings': {}}
        value = json.loads(path.read_text())
        if value.get('version') != 1:
            raise ValueError('Invalid device policy')
        return value

    def permission(self, principal, device):
        if not principal or not isinstance(device, str):
            return None
        # Registry changes and revocation are checked even before a gateway reload.
        registration = json.loads(Path(self.config()['registration_state_file']).read_text())
        if device not in registration.get('nodes', {}) and device not in self.config().get('static_devices', []):
            return None
        if registration.get('metadata', {}).get(device, {}).get('status') in ('disabled', 'revoked', 'unregistered'):
            return None
        row = self.state()['devices'].get(device)
        if not row or row.get('blocked'):
            return None
        if row['owner'] == principal['id']:
            return 'operate'
        return row.get('grants', {}).get(principal['id'])

    def allowed(self, principal, device, operation):
        permission = self.permission(principal, device)
        return permission == 'operate' or (permission == 'read' and operation in
            {'list_devices', 'select_device', 'microscope_status', *self.config().get('read_tools', [])})

    def require(self, principal, device, operation):
        if not self.allowed(principal, device, operation):
            raise PermissionError('Device or operation is not authorized')
