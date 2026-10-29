"""Owned Tango database and device subprocesses for the simulated TEM stack."""

import asyncio
import json
import os
import socket
import sys
from pathlib import Path


def register_device(host, port, device, autoscript_port):
    from tango import Database, DbDevInfo, EnsureOmniThread
    with EnsureOmniThread():
        db = Database(host, port)
        info = DbDevInfo()
        info.name, info._class, info.server = device, "TEMTwinDevice", "TEMTwinDevice/twin"
        db.add_device(info)
        db.put_device_property(device, {"autoscript_host": "127.0.0.1", "autoscript_port": str(autoscript_port)})


def load_http_nodes(path):
    if not path or not Path(path).exists():
        return {}
    nodes = json.loads(Path(path).read_text())
    if not isinstance(nodes, dict):
        raise ValueError("Tango HTTP node configuration must be a JSON object")
    normalized = {}
    for device, value in nodes.items():
        if not isinstance(device, str) or device.count("/") != 2 or not isinstance(value, dict):
            raise ValueError("Each HTTP node requires a domain/family/member device name and object config")
        allowed = {"node_url", "node_token", "operation_timeout_seconds"}
        if set(value) - allowed or not isinstance(value.get("node_url"), str):
            raise ValueError(f"Invalid HTTP node configuration for {device}")
        token = value.get("node_token")
        if not isinstance(token, str) or len(token) < 32:
            raise ValueError(f"HTTP node token for {device} must contain at least 32 characters")
        if not value["node_url"].startswith(("http://", "https://")):
            raise ValueError(f"HTTP node URL for {device} must use HTTP or HTTPS")
        normalized[device] = {
            "node_url": value["node_url"].rstrip("/"),
            "node_token": token,
            "operation_timeout_seconds": str(float(value.get("operation_timeout_seconds", 300))),
        }
    return normalized


def register_http_nodes(host, port, nodes):
    from tango import Database, DbDevInfo, EnsureOmniThread
    with EnsureOmniThread():
        db = Database(host, port)
        # This server owns only HTTP proxy devices; remove retired registrations
        # before starting its replacement process, including when nodes is empty.
        previous = db.get_device_name("TEMHTTPProxyDevice/nodes", "TEMHTTPProxyDevice").value_string
        for device in previous:
            if device not in nodes:
                db.delete_device(device)
        for device, properties in nodes.items():
            info = DbDevInfo()
            info.name = device
            info._class = "TEMHTTPProxyDevice"
            info.server = "TEMHTTPProxyDevice/nodes"
            db.add_device(info)
            db.put_device_property(device, properties)


async def wait_ready(check, children, timeout=45):
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        if any(child.returncode is not None for child in children):
            raise RuntimeError("Tango process exited during startup")
        try:
            return await asyncio.to_thread(check)
        except Exception:
            if asyncio.get_running_loop().time() >= deadline:
                raise
            await asyncio.sleep(0.25)


async def start_tango(args, children):
    root = Path(args.tango_data_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    # Fail rather than accidentally adopt an unrelated local Tango service.
    for port in (args.tango_db_port, args.tango_device_port):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))
    env = {**os.environ, "TANGO_HOST": f"127.0.0.1:{args.tango_db_port}",
           "PYTHONPATH": os.pathsep.join([str(Path(__file__).resolve().parent.parent), os.environ.get("PYTHONPATH", "")])}
    children.append(await asyncio.create_subprocess_exec(
        sys.executable, "-m", "tango.databaseds.database", "2",
        "-ORBendPoint", f"giop:tcp:127.0.0.1:{args.tango_db_port}", cwd=root, env=env))
    await wait_ready(lambda: register_device("127.0.0.1", args.tango_db_port, args.tango_device, args.autoscript_port), children)
    children.append(await asyncio.create_subprocess_exec(
        sys.executable, "-m", "tem_twin_autoscript.tango_device", "twin",
        "-ORBendPoint", f"giop:tcp:127.0.0.1:{args.tango_device_port}", env=env))
    from .tango_mcp import TangoRegistry
    url = f"tango://127.0.0.1:{args.tango_db_port}/{args.tango_device}"
    await wait_ready(lambda: TangoRegistry({args.tango_device: url}).describe(args.tango_device), children)
    devices = {args.tango_device: url}
    http_nodes = load_http_nodes(args.tango_http_nodes)
    register_http_nodes("127.0.0.1", args.tango_db_port, http_nodes)
    if http_nodes:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", args.tango_http_device_port))
        children.append(await asyncio.create_subprocess_exec(
            sys.executable, "-m", "tem_twin_autoscript.http_tango_device", "nodes",
            "-ORBendPoint", f"giop:tcp:127.0.0.1:{args.tango_http_device_port}", env=env))
        remote_urls = {
            device: f"tango://127.0.0.1:{args.tango_db_port}/{device}"
            for device in http_nodes
        }
        for device, remote_url in remote_urls.items():
            await wait_ready(lambda d=device, u=remote_url: TangoRegistry({d: u}).describe(d), children)
        devices.update(remote_urls)
    if args.tango_extra_devices:
        extras = json.loads(Path(args.tango_extra_devices).read_text())
        if args.tango_device in extras:
            raise ValueError("Extra device configuration must not replace this Twin")
        devices.update(extras)
    config = root / "mcp-devices.json"
    config.write_text(json.dumps(devices, indent=2) + "\n")
    children.append(await asyncio.create_subprocess_exec(
        sys.executable, "-m", "tem_twin_autoscript.tango_mcp", "--devices", str(config),
        "--http-host", "127.0.0.1", "--http-port", str(args.mcp_port), env=env))
    print(f"Tango device: {args.tango_device}; MCP uses Tango -> AutoScript", flush=True)
