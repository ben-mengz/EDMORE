"""Per-request identity and per-call authorization; never trust MCP session identity."""
import copy
from contextvars import ContextVar
from fastmcp.server.dependencies import get_http_headers
from fastmcp.server.middleware import Middleware

principal = ContextVar('tango_principal', default=None)


class DeviceMiddleware(Middleware):
    def __init__(self, access, registry):
        self.access, self.registry = access, registry

    async def on_message(self, context, call_next):
        identity = self.access.identity(get_http_headers().get('authorization', ''))
        token = principal.set(identity)
        try:
            return await call_next(context)
        finally:
            principal.reset(token)

    async def on_call_tool(self, context, call_next):
        if context.message.name != 'list_devices':
            self.access.require(principal.get(), (context.message.arguments or {}).get('device'), context.message.name)
        return await call_next(context)

    async def on_list_tools(self, context, call_next):
        result = []
        for tool in await call_next(context):
            if tool.name == 'list_devices':
                result.append(tool)
                continue
            devices = [device for device in self.registry.devices
                       if (tool.name == 'select_device' or tool.name in self.registry.schemas.get(device, {}))
                       and self.access.allowed(principal.get(), device, tool.name)]
            if not devices:
                continue
            filtered = tool.model_copy()
            filtered.parameters = copy.deepcopy(tool.parameters)
            filtered.parameters['properties']['device']['enum'] = devices
            result.append(filtered)
        return result
