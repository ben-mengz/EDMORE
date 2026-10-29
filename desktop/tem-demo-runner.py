"""Own a local TEM twin stack for the desktop Demo controller."""
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import shutil
import urllib.request
from pathlib import Path


def emit(phase, **fields):
    print(json.dumps({"phase": phase, **fields}), flush=True)


def main():
    stop = threading.Event()
    child = None
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())

    def watch_input():
        sys.stdin.readline()
        stop.set()

    threading.Thread(target=watch_input, daemon=True).start()
    try:
        for port in (7521, 8767, 8768):
            with socket.socket() as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    probe.bind(("127.0.0.1", port))
                except OSError:
                    raise RuntimeError(f"Port {port} is occupied. Stop the existing service first; it was not changed.")
        env = {**os.environ, "PYTHONUNBUFFERED": "1"}
        env.setdefault("TEM_TWIN_STATE_FILE", str(Path.home() / ".dsh" / "edmore" / "tem-twin-state.json"))
        node = env.get("TEM_TWIN_NODE") or shutil.which("node")
        if not node:
            node = next((p for p in ("/opt/homebrew/bin/node", "/usr/local/bin/node") if Path(p).is_file()), None)
        if not node:
            raise RuntimeError("Node.js is required for the backend TEM simulation.")
        env["TEM_TWIN_NODE"] = node
        child = subprocess.Popen(
            [sys.executable, "-u", "-m", "tem_twin_autoscript.cloud", "--host", "127.0.0.1"],
            cwd=sys.argv[1], stdin=subprocess.DEVNULL, stdout=sys.stderr, stderr=sys.stderr,
            env=env)
        deadline = time.monotonic() + 120
        while not stop.wait(0.25):
            if child.poll() is not None:
                raise RuntimeError(f"TEM twin exited ({child.returncode})")
            try:
                with urllib.request.urlopen("http://127.0.0.1:8768/health", timeout=1) as response:
                    ready = json.load(response).get("ready")
                with socket.create_connection(("127.0.0.1", 8767), timeout=1):
                    pass
                if ready:
                    break
            except (OSError, ValueError):
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError("TEM twin startup timed out")
        if not stop.is_set():
            emit("running", detail="TEM Digital Twin", twin="http://127.0.0.1:8767/mcp", viewer="http://127.0.0.1:8768/")
        while not stop.wait(0.5):
            if child.poll() is not None:
                raise RuntimeError(f"TEM twin exited ({child.returncode})")
    except Exception as error:
        emit("error", detail=str(error))
    finally:
        if child and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=25)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == "__main__":
    main()
