"""Inspect the active client roles and MCP tools without creating another runtime."""

import json
import os
import httpx


def main():
    base = os.environ.get("EDMORE_CLIENT_URL", "http://127.0.0.1:7380").rstrip("/")
    with httpx.Client(base_url=base, timeout=10) as client:
        for path in ("/api/edmore/agent-roles", "/api/edmore/harness/tools"):
            response = client.get(path)
            response.raise_for_status()
            print(path)
            print(json.dumps(response.json(), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
