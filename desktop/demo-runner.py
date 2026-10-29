"""Desktop-owned demo services; reuse external listeners without adopting them."""
import asyncio
import json
import os
from pathlib import Path
import signal
import shutil
import socket
import subprocess
import sys
import threading
from urllib.request import urlopen


def report(**state):
    print(json.dumps(state), flush=True)


def occupied(port):
    with socket.socket() as sock:
        return sock.connect_ex(("127.0.0.1", port)) == 0


def viewer_ready():
    with urlopen("http://127.0.0.1:8890/api/frames", timeout=3) as response:
        data = json.load(response)
        if not isinstance(data.get("frames"), list) or "pending" not in data:
            raise RuntimeError("Port 8890 is not the HAADF output viewer")


async def run(root):
    sys.path.insert(0, str(root))
    from asyncroscopy.utils.notebook_stack import NotebookStack
    from fastmcp import Client
    import yaml

    # Finder-launched applications do not inherit the interactive shell PATH.
    os.environ["PATH"] = os.pathsep.join([
        str(Path(sys.executable).parent), os.environ.get("PATH", ""),
        str(Path.home() / ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin",
    ])

    stack = NotebookStack(root)
    viewer = None
    try:
        report(phase="starting", detail="Checking Digital Twin MCP :8010")
        external_twin = occupied(8010)
        if external_twin:
            async with Client(stack.url, timeout=10) as client:
                tools = await client.list_tools()
                if not any(t.name == "UnifiedDigitalTwin_acquire_scanned_image" for t in tools):
                    raise RuntimeError("Port 8010 does not expose the expected Digital Twin tools")
        else:
            if not shutil.which("uv"):
                raise RuntimeError("uv is required by the Asyncroscopy launchers but was not found")
            config = yaml.safe_load((root / "configs/notebook_twin.yaml").read_text())
            if config.get("instrument", {}).get("class_name") != "UnifiedDigitalTwin":
                raise RuntimeError("Demo requires UnifiedDigitalTwin, not a hardware instrument")
            await stack.start()
        report(phase="starting", detail="Checking HAADF Viewer :8890")
        external_viewer = occupied(8890)
        if external_viewer:
            await asyncio.to_thread(viewer_ready)
        else:
            viewer = subprocess.Popen(
                [sys.executable, "startup_scripts/run_output_view.py"], cwd=root,
                stdout=sys.stderr, stderr=sys.stderr,
            )
            for _ in range(40):
                if viewer.poll() is not None:
                    raise RuntimeError("HAADF viewer exited during startup")
                try:
                    await asyncio.to_thread(viewer_ready)
                    break
                except OSError:
                    await asyncio.sleep(0.25)
            else:
                raise RuntimeError("HAADF viewer startup timed out")
        report(phase="running", detail="Digital Twin :8010 + HAADF Viewer :8890",
               twin="external" if external_twin else "owned",
               viewer="external" if external_viewer else "owned")
        while True:
            stack._check_children()
            if viewer and viewer.poll() is not None:
                raise RuntimeError("HAADF viewer stopped unexpectedly")
            await asyncio.sleep(2)
    finally:
        if viewer and viewer.poll() is None:
            viewer.terminate()
            try:
                viewer.wait(timeout=5)
            except subprocess.TimeoutExpired:
                viewer.kill()
                viewer.wait()
        stack.stop()


if __name__ == "__main__":
    # EOF also cleans up when the desktop process disappears unexpectedly.
    def watch_parent():
        sys.stdin.readline()
        os.kill(os.getpid(), signal.SIGINT)

    threading.Thread(target=watch_parent, daemon=True).start()
    try:
        asyncio.run(run(Path(sys.argv[1]).resolve()))
    except KeyboardInterrupt:
        pass
    except Exception as error:
        report(phase="error", detail=str(error))
        sys.exit(1)
