"""Single-writer registration-side pairing and owner-consented sharing."""
import hashlib
import secrets
import time
from pathlib import Path
from aiohttp import web
from .device_access import DeviceAccess
from .registration_server import write_private


class DevicePairing:
    def __init__(self, service, configuration):
        self.service = service
        self.access = DeviceAccess(configuration)

    def save(self, state, principal, action, device):
        audit = state.setdefault('audit', [])
        audit.append({'at': int(time.time()), 'actor': principal, 'action': action, 'device': device})
        # Keep complete audit separately through deployment log archival before pruning.
        write_private(Path(self.access.config()['policy_file']), state)

    def issue(self, device, credential):
        state = self.access.state()
        if device in state['devices']:
            return {}
        now = int(time.time())
        state['pairings'] = {key: row for key, row in state['pairings'].items()
                             if row['expires'] > now and row['device'] != device}
        code = secrets.token_urlsafe(18)
        state['pairings'][hashlib.sha256(code.encode()).hexdigest()] = {
            'device': device, 'credential_hash': hashlib.sha256(credential.encode()).hexdigest(), 'expires': now + 600}
        self.save(state, 'node', 'pairing-issued', device)
        return {'pairing_code': code, 'pairing_expires': now + 600}

    def apply(self, principal, action, body):
        state = self.access.state()
        device = body.get('device', '')
        if action == 'claim':
            code = body.get('code', '')
            if not isinstance(code, str) or len(code) > 128:
                raise web.HTTPForbidden(text='Invalid or expired pairing')
            digest = hashlib.sha256(code.encode()).hexdigest()
            pair = state['pairings'].get(digest)
            if not pair or pair['expires'] <= time.time():
                raise web.HTTPForbidden(text='Invalid or expired pairing')
            device = pair['device']
            record = self.service.state.get('requests', {}).get(device, {})
            owner = self.service.state.get('owners', {}).get(device) or record.get('credential_hash')
            status = self.service.state.get('metadata', {}).get(device, {}).get('status')
            if owner != pair['credential_hash'] or record.get('status') == 'rejected' or status in ('disabled', 'revoked'):
                raise web.HTTPForbidden(text='Pairing is no longer valid')
            if device in state['devices']:
                raise web.HTTPConflict(text='Device already has an owner')
            state['devices'][device] = {'owner': principal['id'], 'owner_label': principal['label'], 'grants': {}, 'blocked': False}
            del state['pairings'][digest]
        elif action == 'assign':
            if not principal['admin']:
                raise web.HTTPForbidden()
            if device not in self.registered() or device in state['devices']:
                raise web.HTTPConflict(text='Only unclaimed registered devices can be assigned')
            target = self.target(body)
            state['devices'][device] = {'owner': target, 'owner_label': str(body.get('target_label', ''))[:64], 'grants': {}, 'blocked': False}
        else:
            row = state['devices'].get(device)
            if not row:
                raise web.HTTPForbidden(text='Device or operation is not authorized')
            is_owner = row['owner'] == principal['id']
            if action == 'share':
                if not is_owner:
                    raise web.HTTPForbidden()
                target = self.target(body)
                permission = body.get('permission')
                if permission not in ('read', 'operate') or target == row['owner']:
                    raise web.HTTPBadRequest(text='Invalid sharing permission')
                identifier = secrets.token_hex(16)
                state['shares'][identifier] = {'device': device, 'owner': row['owner'], 'target': target,
                    'target_label': str(body.get('target_label', ''))[:64], 'permission': permission, 'status': 'pending'}
            elif action == 'approve-share':
                if not principal['admin']:
                    raise web.HTTPForbidden()
                share = state['shares'].get(body.get('request'))
                if not share or share['device'] != device or share['owner'] != row['owner'] or share['status'] != 'pending':
                    raise web.HTTPConflict(text='No current owner-approved request')
                if row.get('blocked'):
                    raise web.HTTPConflict(text='Device access is blocked')
                row['grants'][share['target']] = share['permission']
                share['status'] = 'approved'
            elif action == 'revoke-share':
                if not is_owner and not principal['admin']:
                    raise web.HTTPForbidden()
                target = self.target(body)
                row['grants'].pop(target, None)
                for share in state['shares'].values():
                    if share['device'] == device and share['target'] == target:
                        share['status'] = 'revoked'
            elif action == 'activate':
                if not is_owner:
                    raise web.HTTPForbidden()
                if row.get('blocked') or self.service.state.get('metadata', {}).get(device, {}).get('status') in ('disabled', 'revoked'):
                    raise web.HTTPForbidden(text='Device admission is disabled')
                if self.service.state.get('requests', {}).get(device, {}).get('status') not in ('pending', 'approved'):
                    raise web.HTTPConflict(text='No pending admission to retry')
            elif action in ('block', 'unblock'):
                if not is_owner and not principal['admin']:
                    raise web.HTTPForbidden()
                if action == 'unblock' and row.get('blocked_by_admin') and not principal['admin']:
                    raise web.HTTPForbidden(text='Administrator must remove this block')
                row['blocked'] = action == 'block'
                row['blocked_by_admin'] = action == 'block' and (principal['admin'] or row.get('blocked_by_admin', False))
            else:
                raise web.HTTPBadRequest(text='Unsupported device action')
        self.save(state, principal['id'], action, device)
        return {'ok': True, 'device': device}

    def target(self, body):
        target = body.get('target')
        if not isinstance(target, str) or len(target) > 256 or ':' not in target:
            raise web.HTTPBadRequest(text='Invalid target identity')
        if target.split(':', 1)[0] not in self.access.config()['issuers']:
            raise web.HTTPBadRequest(text='Unknown Harness identity issuer')
        return target

    def registered(self):
        return set(self.service.state['nodes']) | set(self.access.config().get('static_devices', []))

    async def route(self, request):
        try:
            principal = self.access.identity(request.headers.get('Authorization', ''), 'tango-registration')
        except PermissionError:
            raise web.HTTPUnauthorized() from None
        if request.method == 'GET':
            state = self.access.state()
            devices = []
            for device, row in state['devices'].items():
                permission = self.access.permission(principal, device)
                if principal['admin'] or row['owner'] == principal['id'] or permission:
                    devices.append({'device': device, 'owner': row['owner'], 'owner_label': row.get('owner_label', ''), 'permission': permission,
                                    'mine': row['owner'] == principal['id'], 'blocked': row.get('blocked', False),
                                    'registered': device in self.registered(),
                                    **({'grants': row.get('grants', {})} if principal['admin'] or row['owner'] == principal['id'] else {})})
            if principal['admin']:
                devices.extend({'device': d, 'unclaimed': True, 'registered': True} for d in sorted(self.registered()) if d not in state['devices'])
            shares = [{'id': key, **row} for key, row in state['shares'].items() if principal['admin'] or row['owner'] == principal['id']]
            return web.json_response({'identity': principal['id'], 'admin': principal['admin'], 'devices': devices, 'shares': shares})
        try:
            body = await request.json()
            if not isinstance(body, dict): raise ValueError()
        except (ValueError, TypeError):
            raise web.HTTPBadRequest() from None
        async with self.service.lock:
            result = self.apply(principal, body.get('action'), body)
        # Pairing approves ownership, not arbitrary hardware actions. Reuse the
        # existing admission/quiesce/reload pipeline and expose uncertain outcomes.
        device = result['device']
        if body.get('action') in ('claim', 'activate') and device not in self.service.state['nodes']:
            result['registration'] = 'pending'
            admin = getattr(self.service, 'admin', None)
            if admin:
                operation = {'device': device, 'action': 'approve', 'status': 'running'}
                await admin.perform(operation)
                result['registration'] = operation['status']
                if operation.get('error'): result['error'] = operation['error']
        return web.json_response(result)
