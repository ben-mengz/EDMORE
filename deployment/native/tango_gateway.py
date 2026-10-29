"""The cloud MCP gateway with an explicit, safe empty-registry boot mode."""
import argparse
import json
from pathlib import Path
from fastmcp import FastMCP
from tem_twin_autoscript.tango_mcp import TangoRegistry, create_tango_mcp


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--devices", required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    devices = json.loads(Path(args.devices).read_text())
    if not isinstance(devices, dict):
        raise ValueError("Expected an administrator-owned device map")
    if devices:
        mcp = create_tango_mcp(TangoRegistry(devices))
    else:
        mcp = FastMCP("EDMORE Tango Devices")

        @mcp.tool(annotations={"readOnlyHint": True})
        def list_devices() -> dict:
            """No device is connected until explicitly registered by the owner."""
            return {"devices": []}

    mcp.run(transport="streamable-http", host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
