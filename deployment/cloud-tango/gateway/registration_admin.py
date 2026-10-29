"""Browser administration and credential-bound, approval-based enrollment."""
import asyncio
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import secrets
import time
from aiohttp import ClientSession, ClientTimeout, web
from .registration_server import digest, write_private

def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')

def password_record(password):
    salt = secrets.token_hex(24)
    return {'salt': salt, 'iterations': 600000,
            'hash': hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 600000).hex()}

def password_matches(password, record):
    actual = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(record['salt']), record['iterations']).hex()
    return secrets.compare_digest(actual, record['hash'])

class Admin:
    def __init__(self, service):
        self.service = service
        self.auth_file = Path(service.config['admin_auth_file'])
        self.sessions = {}
        self.attempts = {}
        self.operations = {}
        self.tasks = set()
        self.action_lock = asyncio.Lock()

    def save(self):
        write_private(self.service.path, self.service.state)

    def credential(self, request):
        value = request.headers.get('Authorization', '')
        token = value[7:] if value.startswith('Bearer ') else ''
        if len(token) < 32 or len(token) > 256: raise web.HTTPUnauthorized()
        return token

    async def body(self, request):
        try:
            value = await request.json()
            if not isinstance(value, dict): raise ValueError()
            return value
        except (TypeError, ValueError): raise web.HTTPBadRequest(text='Expected a JSON object') from None

    def identity(self, body):
        device = body.get('device', '')
        if not isinstance(device, str) or len(device) > 160 or not re.fullmatch(r'[a-z0-9_\-]+/[a-z0-9_\-]+/[a-z0-9_\-]+', device):
            raise web.HTTPBadRequest(text='Use a lowercase domain/family/member device name')
        return device

    async def apply(self, request):
        body = await self.body(request); device = self.identity(body); token = self.credential(request)
        if device in self.service.config.get('protected_devices', ['edmore/tem/twin']):
            raise web.HTTPForbidden(text='System-managed Tango devices are protected')
        if body.get('node_token') != token or body.get('transport') != 'https-relay':
            raise web.HTTPBadRequest(text='Use authenticated HTTPS relay enrollment')
        async with self.service.lock:
            owner = self.service.state['owners'].get(device)
            if owner and not secrets.compare_digest(owner, digest(token)):
                raise web.HTTPConflict(text='This device name belongs to another installation; choose a unique device name')
            metadata = self.service.state['metadata'].get(device, {})
            if metadata.get('status') in ('disabled', 'revoked'):
                return web.json_response({'device': device, 'status': metadata['status']})
            existing = self.service.state['requests'].get(device)
            if existing and not secrets.compare_digest(existing['credential_hash'], digest(token)):
                raise web.HTTPConflict(text='A different installation already requested this device name')
            if device in self.service.state['nodes']:
                pairing = self.service.pairing.issue(device, token) if hasattr(self.service, 'pairing') else {}
                return web.json_response({'device': device, 'status': 'registered', 'mcp_verified': False, **pairing})
            if not existing or (owner and existing['status'] == 'registered'):
                if sum(r['status'] == 'pending' for r in self.service.state['requests'].values()) >= 100:
                    raise web.HTTPTooManyRequests(text='Enrollment queue is full')
                computer = body.get('computer_name', '')
                if not isinstance(computer, str) or len(computer) > 120: raise web.HTTPBadRequest(text='Invalid computer name')
                existing = dict(device=device, credential_hash=digest(token), status='approved' if owner else 'pending',
                    submitted_at=now(), computer_name=computer,
                    body={'device': device, 'node_token': token, 'transport': 'https-relay'})
                self.service.state['requests'][device] = existing; self.save()
            pairing = self.service.pairing.issue(device, token) if hasattr(self.service, 'pairing') and existing['status'] != 'rejected' else {}
            return web.json_response({**self.public_request(existing), **pairing})

    def public_request(self, record):
        return {key: record[key] for key in ('device', 'status', 'submitted_at', 'computer_name', 'decided_at', 'error') if key in record}

    async def status(self, request):
        body = await self.body(request); device = self.identity(body); token = self.credential(request)
        owner = self.service.state['owners'].get(device)
        record = self.service.state['requests'].get(device, {})
        expected = owner or record.get('credential_hash')
        if not expected or not secrets.compare_digest(expected, digest(token)): raise web.HTTPUnauthorized()
        state = self.service.state['metadata'].get(device, {}).get('status')
        if state in ('disabled', 'revoked'):
            return web.json_response({'device': device, 'status': state})
        if device in self.service.state['nodes'] and not self.service.state['pending']:
            return web.json_response({'device': device, 'status': 'registered', 'mcp_verified': True})
        return web.json_response(self.public_request(record) if record else {'device': device, 'status': 'unregistered'})

    async def withdraw(self, request):
        body = await self.body(request); device = self.identity(body); token = self.credential(request)
        async with self.service.lock:
            record = self.service.state['requests'].get(device)
            if not record or not secrets.compare_digest(record['credential_hash'], digest(token)): raise web.HTTPUnauthorized()
            if device in self.service.state['nodes'] or self.service.state['pending']:
                raise web.HTTPConflict(text='Registration is updating or already registered; use unregister')
            if record['status'] not in ('pending', 'rejected'): raise web.HTTPConflict(text='Approval is in progress')
            self.service.state['requests'].pop(device); self.save()
        peer = self.service.relay.peers.get(device)
        if peer: await peer.ws.close(code=1008, message=b'Enrollment withdrawn')
        return web.json_response({'device': device, 'status': 'unregistered', 'mcp_verified': True})

    def origin(self, request):
        if request.headers.get('Origin') != self.service.config['public_url'].rstrip('/'):
            raise web.HTTPForbidden(text='Invalid browser origin')

    def session(self, request, mutation=False):
        token = request.cookies.get('edmore_admin', '')
        session = self.sessions.get(digest(token))
        if not session or session['expires'] < time.monotonic(): raise web.HTTPUnauthorized()
        if mutation:
            self.origin(request)
            if not secrets.compare_digest(request.headers.get('X-CSRF-Token', ''), session['csrf']):
                raise web.HTTPForbidden(text='Invalid session token')
        return session

    async def login(self, request):
        self.origin(request)
        remote = request.remote or 'unknown'; stamp = time.monotonic()
        attempts = self.attempts.setdefault(remote, [])
        attempts[:] = [t for t in attempts if stamp - t < 60]
        if len(attempts) >= 5: raise web.HTTPTooManyRequests(text='Please wait one minute before retrying')
        if len(self.attempts) > 1000: self.attempts = {remote: attempts}
        attempts.append(stamp)
        body = await self.body(request); auth = json.loads(self.auth_file.read_text())
        password = body.get('password', '')
        if not isinstance(password, str) or len(password) > 256: raise web.HTTPUnauthorized()
        valid = await asyncio.to_thread(password_matches, password, auth['password'])
        if body.get('username') != auth['username'] or not valid: raise web.HTTPUnauthorized(text='Invalid username or password')
        self.sessions = {k:v for k,v in self.sessions.items() if v['expires'] > stamp}
        token = secrets.token_urlsafe(48); csrf = secrets.token_urlsafe(32)
        self.sessions[digest(token)] = {'csrf': csrf, 'expires': stamp + 8*3600}
        response = web.json_response({'username': auth['username'], 'csrf': csrf})
        response.set_cookie('edmore_admin', token, secure=True, httponly=True, samesite='Strict', path='/admin', max_age=8*3600)
        return response

    async def whoami(self, request):
        session = self.session(request)
        return web.json_response({'csrf': session['csrf'], 'username': json.loads(self.auth_file.read_text())['username']})

    async def logout(self, request):
        self.session(request, True)
        self.sessions.pop(digest(request.cookies.get('edmore_admin', '')), None)
        response = web.json_response({'ok': True}); response.del_cookie('edmore_admin', path='/admin')
        return response

    async def password(self, request):
        self.session(request, True); body = await self.body(request); new = body.get('password', '')
        if not isinstance(new, str) or not 12 <= len(new) <= 256:
            raise web.HTTPBadRequest(text='Use a password of 12–256 characters')
        auth = json.loads(self.auth_file.read_text())
        old = body.get('current_password', '')
        if not isinstance(old, str) or len(old) > 256 or not await asyncio.to_thread(password_matches, old, auth['password']):
            raise web.HTTPForbidden(text='Current password does not match')
        auth['password'] = await asyncio.to_thread(password_record, new); write_private(self.auth_file, auth)
        self.sessions.clear()
        response = web.json_response({'ok': True}); response.del_cookie('edmore_admin', path='/admin')
        return response

    async def inventory(self, request):
        self.session(request)
        live = {}; error = None
        try:
            async with ClientSession(timeout=ClientTimeout(total=20), trust_env=False) as client:
                async with client.get(self.service.config['gateway_admin_url']+'/registration/devices',
                        headers={'Authorization': 'Bearer '+self.service.config['management_token']}) as response:
                    if response.status != 200: raise ValueError()
                    live = {r['device']:r for r in (await response.json())['devices']}
        except Exception:
            error = 'Live Tango status is temporarily unavailable; saved device records are still shown'
        # Repair legacy status only when the registry and live MCP agree.
        # An offline device can still be successfully registered.
        async with self.service.lock:
            if not self.service.state['pending'] and not error:
                for device in self.service.state['nodes']:
                    metadata = self.service.state['metadata'].get(device, {})
                    record = self.service.state['requests'].get(device, {})
                    if (device in self.service.state['owners']
                            and live.get(device, {}).get('mcp_visible') is True
                            and metadata.get('status') not in ('disabled', 'revoked')
                            and (metadata.get('status') != 'registered'
                                 or record.get('status') in ('approved', 'unregistered'))):
                        self.service.complete_registration(device, 'register', historical=True)
        names = set(live) | set(self.service.state['nodes']) | set(self.service.state['metadata'])
        rows = []
        for device in sorted(names):
            metadata = self.service.state['metadata'].get(device, {})
            row = dict(device=device, status=metadata.get('status', 'registered'),
                protected=device not in self.service.state['owners'] or device in self.service.config.get('protected_devices', ['edmore/tem/twin']), available=None, state='UNKNOWN', mcp_visible=None)
            row.update(live.get(device, {}))
            if device not in live and not error: row.update(available=False, mcp_visible=False)
            row['connected'] = device in self.service.relay.peers
            row['registered_at'] = metadata.get('registered_at')
            row['updated_at'] = metadata.get('updated_at')
            row['transport'] = 'https-relay' if '/relay/' in self.service.state['nodes'].get(device, metadata.get('saved_node', {})).get('node_url','') else 'direct'
            if metadata.get('cleared') and device not in self.service.state['nodes'] and not row['protected']:
                continue
            rows.append(row)
        pending = [dict(self.public_request(r), fingerprint=r['credential_hash'][:12], connected=r['device'] in self.service.relay.peers)
            for r in self.service.state['requests'].values() if r['status'] not in ('registered', 'unregistered')]
        return web.json_response({'devices': rows, 'requests': pending, 'pending_update': self.service.state['pending'],
            'operations': list(self.operations.values()), 'error': error, 'updated_at': now()})

    async def clear_removed(self, request):
        self.session(request, True)
        inventory = json.loads((await self.inventory(request)).body)
        if inventory['error']:
            raise web.HTTPServiceUnavailable(text=inventory['error'])
        async with self.service.lock:
            if self.service.state['pending'] or any(not task.done() for task in self.tasks):
                raise web.HTTPConflict(text='A cloud update is already running')
            cleared = []
            for row in inventory['devices']:
                device = row['device']
                application = self.service.state['requests'].get(device, {})
                if (row['mcp_visible'] is False and not row['protected']
                        and device not in self.service.state['nodes']
                        and application.get('status') not in ('pending', 'approved')):
                    # Retain authorization tombstones so clearing history cannot
                    # make revoked credentials usable again.
                    self.service.state['metadata'].setdefault(device, {})['cleared'] = True
                    cleared.append(device)
            self.save()
        return web.json_response({'cleared': len(cleared)})

    async def action(self, request):
        self.session(request, True); body = await self.body(request); device = self.identity(body)
        action = body.get('action')
        if device in self.service.config.get('protected_devices', ['edmore/tem/twin']):
            raise web.HTTPForbidden(text='System-managed Tango devices are protected')
        if action not in ('approve', 'reject', 'disable', 'enable', 'revoke', 'retry'):
            raise web.HTTPBadRequest(text='Unsupported action')
        if any(not task.done() for task in self.tasks): raise web.HTTPConflict(text='A cloud update is already running')
        if action in ('approve', 'reject', 'retry'):
            if device not in self.service.state['requests']: raise web.HTTPNotFound(text='Enrollment request not found')
        elif device not in self.service.state['owners']:
            raise web.HTTPForbidden(text='System-managed Tango devices are protected')
        if action == 'reject':
            async with self.service.lock:
                record = self.service.state['requests'][device]
                if record['status'] != 'pending': raise web.HTTPConflict(text='Only a pending request can be rejected')
                record.update(status='rejected', decided_at=now()); self.save()
            peer = self.service.relay.peers.get(device)
            if peer: await peer.ws.close(code=1008, message=b'Enrollment rejected')
            return web.json_response({'status': 'rejected'})
        operation = dict(id=secrets.token_hex(16), device=device, action=action, status='running', started_at=now())
        self.operations[operation['id']] = operation
        if len(self.operations) > 50: self.operations.pop(next(iter(self.operations)))
        task = asyncio.create_task(self.perform(operation)); self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return web.json_response(operation, status=202)

    async def perform(self, operation):
        device = operation['device']; action = operation['action']; service = self.service
        try:
            async with self.action_lock:
                if action in ('approve', 'retry'):
                    record = service.state['requests'][device]
                    if record['status'] not in ('pending', 'approved'): raise ValueError('Request cannot be approved')
                    async with service.lock:
                        record.update(status='approved', decided_at=now()); record.pop('error', None); self.save()
                    body = record['body']; token = body['node_token']
                    await service.change('register', body, token, admin=True)
                    record['status'] = 'registered'
                    service.state['metadata'][device] = {'status': 'registered', 'registered_at': now(), 'updated_at': now()}
                elif action == 'enable':
                    metadata = service.state['metadata'].get(device, {})
                    if metadata.get('status') != 'disabled': raise ValueError('Only a disabled device can be enabled')
                    node = metadata['saved_node']; token = node['node_token']
                    body = dict(device=device, _restore=True, **node)
                    if '/relay/' in node['node_url']: body['transport'] = 'https-relay'
                    await service.change('register', body, token, admin=True)
                    metadata.update(status='registered', updated_at=now()); metadata.pop('saved_node', None)
                else:
                    metadata = service.state['metadata'].setdefault(device, {})
                    node = service.state['nodes'].get(device) or metadata.get('saved_node')
                    if not node: raise ValueError('No active or disabled registration exists')
                    # Persist the restore data before applying the removal.
                    metadata['saved_node'] = node; self.save()
                    await service.change('unregister', {'device': device}, node['node_token'], admin=True)
                    metadata.update(status='disabled' if action == 'disable' else 'revoked', updated_at=now())
                    if action == 'revoke':
                        metadata.pop('saved_node', None)
                        peer = service.relay.peers.get(device)
                        if peer: await peer.ws.close(code=1008, message=b'Device authorization revoked')
                self.save(); operation.update(status='complete', completed_at=now())
        except asyncio.CancelledError:
            operation.update(status='interrupted', error='Service restarted; review pending update before retrying')
            raise
        except Exception as error:
            message = error.text if isinstance(error, web.HTTPException) else str(error)
            operation.update(status='failed', error=message[:500])
            if device in service.state['requests'] and action in ('approve','retry'):
                service.state['requests'][device]['error'] = message[:500]; self.save()

def setup_admin(app, service):
    admin = Admin(service)
    assets = Path(__file__).parent/'admin_assets'
    async def page(request):
        name = request.match_info.get('asset') or 'index.html'
        if name not in ('index.html', 'admin.js', 'admin.css'): raise web.HTTPNotFound()
        content_type = {'index.html':'text/html', 'admin.js':'application/javascript', 'admin.css':'text/css'}[name]
        return web.Response(body=(assets/name).read_bytes(), content_type=content_type,
            headers={'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
                'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"})
    app.add_routes([web.get('/admin', page), web.get('/admin/', page), web.get('/admin/assets/{asset}', page),
        web.post('/admin/api/login', admin.login), web.get('/admin/api/session', admin.whoami),
        web.post('/admin/api/logout', admin.logout), web.post('/admin/api/password', admin.password),
        web.get('/admin/api/devices', admin.inventory), web.post('/admin/api/action', admin.action),
        web.post('/admin/api/clear-removed', admin.clear_removed),
        web.post('/api/v1/nodes/apply', admin.apply), web.post('/api/v1/nodes/status', admin.status),
        web.post('/api/v1/nodes/withdraw', admin.withdraw)])
    async def cleanup(application):
        for task in list(admin.tasks): task.cancel()
        await asyncio.gather(*admin.tasks, return_exceptions=True)
    app.on_cleanup.append(cleanup)
    return admin
