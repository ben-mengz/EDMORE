"""Registration service supervised alongside Twin in the same Slurm job.

The service remains alive while the supervisor reloads the Twin child process.
Enrollment codes are SHA256 digests mapped to explicit device names in config.
The reload command is administrator configuration, never supplied by a client.
"""
import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import ipaddress
import importlib
import json
import os
import re
import secrets
import ssl
from pathlib import Path
from urllib.parse import urlsplit
from aiohttp import ClientSession, ClientTimeout, web
from .registration_relay import RelayHub

RELAY_KEY = web.AppKey('relay', RelayHub)

def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()

def write_private(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_suffix('.pending')
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2); stream.flush(); os.fsync(stream.fileno())
    os.chmod(pending, 0o600); os.replace(pending, path)

class CloudRuntime:
    def __init__(self, config):
        self.config = config

    async def describe(self, node):
        async with ClientSession(timeout=ClientTimeout(total=10), trust_env=False) as session:
            async with session.get(node['node_url'] + '/api/v1/describe',
                    headers={'Authorization': 'Bearer ' + node['node_token']}, allow_redirects=False) as response:
                if response.status != 200: raise ValueError('Device identity probe failed')
                return await response.json()

    async def quiesce(self):
        async with ClientSession(timeout=ClientTimeout(total=10)) as session:
            async with session.post(self.config['gateway_admin_url'] + '/registration/quiesce',
                    headers={'Authorization': 'Bearer ' + self.config['management_token']}) as response:
                if response.status == 409: raise web.HTTPConflict(text='A device operation is running; retry after it finishes')
                if response.status != 200: raise web.HTTPServiceUnavailable(text='Gateway could not pause new operations')

    async def reload(self):
        process = await asyncio.create_subprocess_exec(*self.config['reload_command'],
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        try:
            code = await asyncio.wait_for(process.wait(), 60)
        except TimeoutError:
            process.kill(); await process.wait()
            raise RuntimeError('Cloud reload timed out') from None
        if code: raise RuntimeError('Cloud reload command failed')

    async def verify(self, device, present, timeout=180):
        Client = (await asyncio.to_thread(importlib.import_module, 'fastmcp')).Client
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            try:
                async with ClientSession(timeout=ClientTimeout(total=5)) as session:
                    async with session.get(self.config['gateway_admin_url'] + '/registration/status',
                            headers={'Authorization': 'Bearer ' + self.config['management_token']}) as response:
                        if response.status != 200 or (await response.json()).get('quiesced', True):
                            raise RuntimeError('Gateway has not completed its restart')
                    if self.config.get('device_access_file'):
                        async with session.get(self.config['gateway_admin_url'] + '/registration/devices',
                                headers={'Authorization': 'Bearer ' + self.config['management_token']}) as response:
                            if response.status != 200:
                                raise RuntimeError('Management discovery is unavailable')
                            rows = (await response.json())['devices']
                        if any(row['device'] == device for row in rows) == present:
                            return
                        raise RuntimeError('Management discovery has not converged')
                async with Client(self.config['mcp_url'], timeout=8) as client:
                    result = await client.call_tool('list_devices', {})
                    data = result.data
                    if not isinstance(data, dict):
                        data = json.loads(next(c.text for c in result.content if hasattr(c, 'text')))
                    rows = data['devices']
                    if any(row['device'] == device and (not present or row.get('available')) for row in rows) == present:
                        return
            except Exception:
                pass
            if asyncio.get_running_loop().time() >= deadline:
                raise RuntimeError('MCP device discovery has not converged')
            await asyncio.sleep(1)

class RegistrationService:
    def __init__(self, config, runtime=None):
        self.config = config; self.runtime = runtime or CloudRuntime(config)
        self.path = Path(config['state_file']); self.registry = Path(config['registry_file'])
        self.lock = asyncio.Lock()
        self.networks = [ipaddress.ip_network(cidr) for cidr in config['allowed_node_subnets']]
        if self.path.exists():
            self.state = json.loads(self.path.read_text(encoding='utf-8'))
        else:
            nodes = json.loads(self.registry.read_text(encoding='utf-8')) if self.registry.exists() else {}
            self.state = {'nodes': nodes, 'owners': {name: digest(n['node_token']) for name, n in nodes.items()}, 'used_codes': [], 'pending': None}
        self.state.setdefault('requests', {})
        self.state.setdefault('metadata', {})

    def complete_registration(self, device, action, historical=False):
        status = 'registered' if action == 'register' else 'unregistered'
        metadata = self.state['metadata'].setdefault(device, {})
        stamp = datetime.now(timezone.utc).isoformat(timespec='seconds')
        metadata.update(status=status, updated_at=stamp)
        metadata.pop('cleared', None)
        if action == 'register' and not historical:
            metadata.setdefault('registered_at', stamp)
        record = self.state['requests'].get(device)
        if record:
            record['status'] = status
            record.pop('error', None)
        write_private(self.path, self.state)
        return dict(device=device, status=status, mcp_verified=True)

    def validate_node(self, body):
        if body.get('transport') == 'https-relay':
            device = body['device']; token = body['node_token']
            if not self.relay.connected(device, token):
                raise ValueError('Device HTTPS connection is not ready')
            return dict(node_url=self.config['relay_base_url'].rstrip('/')+'/relay/'+device.replace('/','~'),
                        node_token=token,operation_timeout_seconds=300)
        value = urlsplit(body['node_url'])
        if value.scheme not in ('http', 'https') or value.username or value.password or value.path not in ('', '/') or value.query or value.fragment:
            raise ValueError('Invalid node URL')
        address = ipaddress.ip_address(value.hostname)
        if not any(address in net for net in self.networks) or address.is_unspecified or address.is_multicast:
            raise ValueError('Node address is outside the configured VPN subnets')
        if value.port is None: raise ValueError('An explicit node port is required')
        token = body['node_token']
        if not isinstance(token, str) or len(token) < 32: raise ValueError('Invalid node token')
        return dict(node_url=body['node_url'].rstrip('/'), node_token=token, operation_timeout_seconds=300)

    async def change(self, action, body, credential, admin=False):
        device = body.get('device', '')
        if not isinstance(device, str) or not re.fullmatch(r'[a-z0-9_\-]+/[a-z0-9_\-]+/[a-z0-9_\-]+', device):
            raise web.HTTPBadRequest(text='Use a lowercase domain/family/member device name')
        if len(credential) < 32: raise web.HTTPUnauthorized()
        if device in self.config.get('protected_devices', ['edmore/tem/twin']):
            raise web.HTTPForbidden(text='System-managed Tango devices are protected')
        async with self.lock:
            metadata = self.state['metadata'].get(device, {})
            if not admin and metadata.get('status') in ('disabled', 'revoked'):
                raise web.HTTPForbidden(text='Device access was disabled or revoked by the administrator')
            owner = self.state['owners'].get(device)
            code = digest(str(body.get('enrollment_code', '')))
            if owner:
                if not secrets.compare_digest(owner, digest(credential)): raise web.HTTPForbidden(text='Device credential mismatch')
            elif action == 'register':
                application = self.state['requests'].get(device, {})
                approved = application.get('status') == 'approved' and secrets.compare_digest(application.get('credential_hash', ''), digest(credential))
                if not approved and (self.config.get('approval_required') or self.config['enrollment_codes'].get(code) != device or code in self.state['used_codes']):
                    raise web.HTTPForbidden(text='Invalid or already used enrollment code')
            else:
                raise web.HTTPNotFound(text='No registration exists for this device')
            pending = self.state.get('pending')
            if pending and (pending['device'] != device or pending['action'] != action):
                raise web.HTTPConflict(text='A pending cloud update must be retried before another change')
            # A timed-out request may already have converged. Acknowledge it
            # without interrupting the newly healthy gateway a second time.
            if pending and self.registry.exists() and json.loads(self.registry.read_text(encoding='utf-8')) == self.state['nodes']:
                try:
                    await self.runtime.verify(device, action == 'register', timeout=8)
                except Exception:
                    pass
                else:
                    self.state['pending'] = None
                    return self.complete_registration(device, action)
            node = None
            if action == 'register':
                try:
                    if admin and body.get('_restore'):
                        node = dict(metadata['saved_node'])
                    else:
                        node = self.validate_node(body)
                    if not secrets.compare_digest(node['node_token'], credential): raise ValueError('Node token must match the device credential')
                    descriptor = await self.runtime.describe(node)
                    if descriptor.get('device') != device or descriptor.get('protocol') != 1: raise ValueError('Device identity mismatch')
                except (ValueError, KeyError, TypeError):
                    raise web.HTTPBadRequest(text='Invalid node or device identity') from None
            if not pending and owner and ((action == 'unregister' and device not in self.state['nodes']) or
                    (action == 'register' and self.state['nodes'].get(device) == node)):
                try:
                    await self.runtime.verify(device, action == 'register')
                    return self.complete_registration(device, action)
                except Exception:
                    pass
            # A retry may reach a newly started gateway with active operations.
            # Drain again even if durable intent already exists.
            await self.runtime.quiesce()
            if not pending:
                if node is not None: self.state['nodes'][device] = node
                else: self.state['nodes'].pop(device, None)
                self.state['owners'][device] = digest(credential)
                if not owner: self.state['used_codes'].append(code)
                self.state['pending'] = {'device': device, 'action': action}
                write_private(self.path, self.state)
            # Intent is durable before writing the registry. A retry finishes it.
            write_private(self.registry, self.state['nodes'])
            try:
                await self.runtime.reload()
                await self.runtime.verify(device, action == 'register')
            except Exception:
                raise web.HTTPServiceUnavailable(text='Cloud update pending; retry the same request with the same device credential') from None
            self.state['pending'] = None
            return self.complete_registration(device, action)

def create_app(config, runtime=None):
    service = RegistrationService(config, runtime)
    service.relay = RelayHub(service)
    async def change(request):
        authorization = request.headers.get('Authorization', '')
        if not authorization.startswith('Bearer '): raise web.HTTPUnauthorized()
        try:
            body = await request.json()
            if not isinstance(body, dict): raise ValueError()
        except (ValueError, TypeError): raise web.HTTPBadRequest(text='Expected a JSON object') from None
        return web.json_response(await service.change(request.match_info['action'], body, authorization[7:]))
    app = web.Application(client_max_size=16384)
    if config.get('device_access_file'):
        if not config.get('admin_auth_file'):
            raise ValueError('Device pairing requires the existing admission service')
        from .device_pairing import DevicePairing
        service.pairing = DevicePairing(service, config['device_access_file'])
        if Path(service.pairing.access.config()['registration_state_file']).resolve() != service.path.resolve():
            raise ValueError('Device access must reference this registration state file')
        if not service.path.exists(): write_private(service.path, service.state)
        app.add_routes([web.get('/api/v1/harness/devices', service.pairing.route),
                        web.post('/api/v1/harness/devices', service.pairing.route)])
    app[RELAY_KEY] = service.relay
    app.add_routes([web.get('/api/v1/bridge', service.relay.connect),
                    web.post('/api/v1/nodes/bridge-status', service.relay.status)])
    async def relay_startup(application):
        if config.get('relay_port'):
            runner = web.AppRunner(service.relay.internal_app())
            await runner.setup()
            await web.TCPSite(runner, '127.0.0.1', config['relay_port']).start()
            service.relay_runner = runner
    async def relay_cleanup(application):
        await service.relay.close()
        if hasattr(service, 'relay_runner'): await service.relay_runner.cleanup()
    app.on_startup.append(relay_startup)
    app.on_cleanup.append(relay_cleanup)
    async def health(request):
        return web.json_response({'service': 'edmore-tem-registration', 'ready': True, 'protocol': 1})
    app.add_routes([web.get('/health', health)])
    app.add_routes([web.post('/api/v1/nodes/{action:register|unregister}', change)])
    if config.get('admin_auth_file'):
        from .registration_admin import setup_admin
        service.admin = setup_admin(app, service)
    return app

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--issue-code', metavar='DEVICE', help='Add a one-time enrollment code to the config and print it')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding='utf-8'))
    if args.issue_code:
        if not re.fullmatch(r'[a-z0-9_\-]+/[a-z0-9_\-]+/[a-z0-9_\-]+', args.issue_code):
            raise ValueError('Use a lowercase domain/family/member device name')
        code = secrets.token_urlsafe(32)
        config.setdefault('enrollment_codes', {})[digest(code)] = args.issue_code
        write_private(Path(args.config), config)
        print(code)
        return
    if len(config['management_token']) < 32 or not isinstance(config['reload_command'], list) or not config['reload_command']:
        raise ValueError('Provide a management token and a trusted reload command argument list')
    context = None
    host = config.get('host', '127.0.0.1')
    if config.get('tls_cert'):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(config['tls_cert'], config['tls_key'])
    elif host not in ('127.0.0.1', '::1', 'localhost'):
        raise ValueError('Non-loopback registration listeners require TLS')
    web.run_app(create_app(config), host=host, port=config.get('port', 8780), ssl_context=context, access_log=None)

if __name__ == '__main__': main()
