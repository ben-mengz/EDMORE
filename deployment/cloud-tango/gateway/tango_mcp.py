"""One MCP endpoint for explicitly configured Tango device instances.

No AutoScript client is constructed here. Device targets cannot be URLs supplied
by the LLM; administrators configure the allowlist. No retry or target fallback.
"""

import argparse
import asyncio
import copy
import json
import os
import secrets
import threading
from pathlib import Path

import jsonschema
from fastmcp import FastMCP
from fastmcp.tools import Tool
from fastmcp.tools.tool import ToolResult
from mcp.types import TextContent, ToolAnnotations
from pydantic import PrivateAttr
from tango import DeviceProxy, EnsureOmniThread


class TangoRegistry:
    def __init__(self, devices, timeout_ms=300000):
        if not devices:
            raise ValueError("At least one Tango device is required")
        self.devices = dict(devices)
        self.timeout_ms = timeout_ms
        self.schemas = {}
        self.registration_guard = threading.Lock()
        self.quiesced = False
        self.locks = {name: threading.Lock() for name in devices}

    def quiesce(self):
        with self.registration_guard:
            if any(lock.locked() for lock in self.locks.values()):
                return False
            self.quiesced = True
            return True

    def describe(self, device):
        if device not in self.devices:
            raise ValueError("Unknown device; use list_devices and choose an explicit registered target")
        with EnsureOmniThread():
            proxy = DeviceProxy(self.devices[device])
            proxy.set_timeout_millis(5000)
            descriptor = json.loads(proxy.command_inout("DescribeTools"))
        if descriptor.get("protocol") != 1 or descriptor.get("device", "").lower() != device.lower():
            raise ValueError(f"Unexpected Tango device identity/protocol for {device}")
        return descriptor

    def discover(self):
        tools = {}
        for device in self.devices:
            descriptor = self.describe(device)
            self.schemas[device] = {tool["name"]: tool for tool in descriptor["tools"]}
            for name, spec in self.schemas[device].items():
                if name in tools and any(tools[name].get(key) != spec.get(key)
                                         for key in ("inputSchema", "outputSchema")):
                    raise ValueError(f"Incompatible command schema {name} on {device}")
                tools[name] = spec
        return tools

    def invoke(self, device, name, arguments):
        if getattr(self, 'access', None):
            from tem_twin_autoscript.device_middleware import principal
            self.access.require(principal.get(), device, name)
        if device not in self.devices or name not in self.schemas.get(device, {}):
            raise ValueError(f"Unknown device or unsupported operation: {device}.{name}")
        schema = copy.deepcopy(self.schemas[device][name]["inputSchema"])
        schema["additionalProperties"] = False
        jsonschema.validate(arguments, schema)
        with self.registration_guard:
            if self.quiesced:
                raise RuntimeError("Device registration is updating; retry after the update completes")
            if not self.locks[device].acquire(blocking=False):
                raise RuntimeError("Device busy; another MCP operation is in progress")
        try:
            with EnsureOmniThread():
                proxy = DeviceProxy(self.devices[device])
                proxy.set_timeout_millis(self.timeout_ms)
                result = json.loads(proxy.command_inout(name, json.dumps(arguments, allow_nan=False)))
            if result.get("meta", {}).get("device", "").lower() != device.lower():
                raise RuntimeError("Tango result device identity mismatch; execution outcome requires review")
            return result
        except Exception as exc:
            raise RuntimeError(
                f"Tango call {device}.{name} failed: {exc}. "
                "No retry or target fallback was performed. A transport timeout does not prove the operation stopped."
            ) from exc
        finally:
            self.locks[device].release()


class TangoTool(Tool):
    _registry: TangoRegistry = PrivateAttr()

    async def run(self, arguments):
        args = dict(arguments)
        device = args.pop("device", None)
        result = await asyncio.to_thread(self._registry.invoke, device, self.name, args)
        return ToolResult(content=[TextContent.model_validate(item) for item in result["content"]],
                          structured_content=result.get("structuredContent"), meta=result["meta"])


def create_tango_mcp(registry, access=None, *, legacy_local=False):
    if access is None and not legacy_local:
        raise ValueError('Device access configuration is required')
    mcp = FastMCP("EDMORE Tango Devices")
    registry.access = access
    if access:
        from tem_twin_autoscript.device_middleware import DeviceMiddleware, principal
        mcp.add_middleware(DeviceMiddleware(access, registry))

    def allowed(device, operation):
        return not access or access.allowed(principal.get(), device, operation)

    def visible_tools(device):
        return [name for name in registry.schemas[device] if allowed(device, name)]
    management_token = os.environ.get("TEM_REGISTRATION_MANAGEMENT_TOKEN", "")
    if not management_token and os.environ.get("TEM_REGISTRATION_MANAGEMENT_TOKEN_FILE"):
        management_token = Path(os.environ['TEM_REGISTRATION_MANAGEMENT_TOKEN_FILE']).read_text().strip()
    if management_token:
        from starlette.responses import JSONResponse
        @mcp.custom_route("/registration/devices", methods=["GET"])
        async def device_status(request):
            if len(management_token) < 32 or not secrets.compare_digest(request.headers.get("Authorization", ""), "Bearer " + management_token):
                return JSONResponse({"error": "Unauthorized"}, status_code=401)
            def read_states():
                rows = []
                for name, url in registry.devices.items():
                    row = {"device": name, "mcp_visible": True, "available": False, "state": "UNKNOWN"}
                    try:
                        with EnsureOmniThread():
                            proxy = DeviceProxy(url)
                            proxy.set_timeout_millis(3000)
                            row['state'] = str(proxy.state())
                        descriptor = registry.describe(name)
                        row.update(available=row['state'] not in ('FAULT', 'UNKNOWN', 'OFF'), kind=descriptor.get('kind'), tool_count=len(descriptor.get('tools', [])))
                    except Exception:
                        row['error'] = 'Tango device is unavailable or its backend did not respond'
                    rows.append(row)
                return rows
            return JSONResponse({'devices': await asyncio.to_thread(read_states), 'quiesced': registry.quiesced})
        @mcp.custom_route("/registration/status", methods=["GET"])
        async def registration_status(request):
            if len(management_token) < 32 or not secrets.compare_digest(request.headers.get("Authorization", ""), "Bearer " + management_token):
                return JSONResponse({"error": "Unauthorized"}, status_code=401)
            return JSONResponse({"quiesced": registry.quiesced})
        @mcp.custom_route("/registration/quiesce", methods=["POST"])
        async def quiesce(request):
            if len(management_token) < 32 or not secrets.compare_digest(request.headers.get("Authorization", ""), "Bearer " + management_token):
                return JSONResponse({"error": "Unauthorized"}, status_code=401)
            ok = registry.quiesce()
            return JSONResponse({"quiesced": ok}, status_code=200 if ok else 409)

    for name, spec in registry.discover().items():
        parameters = copy.deepcopy(spec["inputSchema"])
        if "device" in parameters.get("properties", {}):
            raise ValueError(f"Reserved gateway parameter in operation: {name}.device")
        parameters.setdefault("properties", {})["device"] = {
            "type": "string", "enum": [device for device, tools in registry.schemas.items() if name in tools],
            "description": "Explicit Tango device identity. Keep the approved target unchanged throughout a workflow.",
        }
        parameters["required"] = [*parameters.get("required", []), "device"]
        parameters["additionalProperties"] = False
        tool = TangoTool(name=name, description=spec.get("description"), parameters=parameters,
                         output_schema=spec.get("outputSchema"),
                         annotations=ToolAnnotations.model_validate(spec["annotations"]) if spec.get("annotations") else None)
        tool._registry = registry
        mcp.add_tool(tool)

    @mcp.tool(annotations={"readOnlyHint": True, "destructiveHint": False})
    def list_devices() -> dict:
        """List administrator-registered Tango targets, live availability and supported tools. Does not select a global target."""
        devices = []
        for name in registry.devices:
            if not allowed(name, 'list_devices'):
                continue
            try:
                descriptor = registry.describe(name)
                devices.append({"device": name, "available": True, "kind": descriptor["kind"],
                                "tools": visible_tools(name)})
            except Exception:
                devices.append({"device": name, "available": False, "tools": visible_tools(name)})
        return {"devices": devices}

    def select_device(device: str) -> dict:
        """Validate the user's chosen Tango device and return its identity for workflow result binding.

        Ask the user which device to use before calling. No default target and
        no global selection: subsequent tools must pass this result's device.
        """
        if access:
            access.require(principal.get(), device, 'select_device')
        descriptor = registry.describe(device)
        registry.invoke(device, "microscope_status", {})
        return {"device": device, "available": True, "kind": descriptor["kind"],
                "tools": visible_tools(device)}

    selection = Tool.from_function(select_device, annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False))
    selection.parameters["properties"]["device"]["enum"] = list(registry.devices)
    mcp.add_tool(selection)
    return mcp


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--devices", required=True, help="JSON file mapping device names to Tango URLs")
    parser.add_argument("--http-host", default="127.0.0.1")
    parser.add_argument("--http-port", type=int, default=8767)
    parser.add_argument("--access-config", default=os.environ.get('TEM_DEVICE_ACCESS_FILE'))
    parser.add_argument("--legacy-local", action='store_true', help='Explicit unauthenticated loopback development mode')
    args = parser.parse_args(argv)
    if not args.access_config and not (args.legacy_local and args.http_host in ('127.0.0.1', '::1', 'localhost')):
        parser.error('Provide --access-config; legacy access is only allowed explicitly on loopback')
    from tem_twin_autoscript.device_access import DeviceAccess
    access = DeviceAccess(args.access_config) if args.access_config else None
    registry = TangoRegistry(json.loads(Path(args.devices).read_text()))
    create_tango_mcp(registry, access, legacy_local=args.legacy_local).run(transport="streamable-http", host=args.http_host, port=args.http_port, stateless_http=True)


if __name__ == "__main__":
    main()
