"""Verify MCP protocol readiness without invoking any device operation."""
import asyncio
import sys
from fastmcp import Client


async def verify(url):
    async with Client(url, timeout=10) as client:
        tools = await client.list_tools()
        if "list_devices" not in {tool.name for tool in tools}:
            raise RuntimeError("Unexpected Tango MCP service")
        if "--empty" in sys.argv:
            result = await client.call_tool("list_devices", {})
            if result.data != {"devices": []}:
                raise RuntimeError("Expected an empty administrator device registry")


if __name__ == "__main__":
    asyncio.run(verify(sys.argv[1]))
