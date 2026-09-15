"""Submit a request to the running EDMORE client; view its progress in /edmore/."""

import argparse
import os
import uuid
import httpx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("prompt")
    parser.add_argument("--session", default=str(uuid.uuid4()))
    args = parser.parse_args()
    base = os.environ.get("EDMORE_CLIENT_URL", "http://127.0.0.1:7380").rstrip("/")
    response = httpx.post(base + "/api/edmore/actions/trigger", json={
        "prompt": args.prompt, "session_id": args.session,
        "source": "demo-client", "action_id": str(uuid.uuid4()),
    }, timeout=60)
    response.raise_for_status()
    print(response.json())
    print(f"Session: {args.session}; UI: {base}/edmore/")


if __name__ == "__main__":
    main()
