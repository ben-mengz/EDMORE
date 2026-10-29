"""Explicit integration smoke test for a disposable, already-installed deployment."""
import argparse
import hashlib
import json
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", required=True, help="Disposable deployment; creates a smoke account and restarts services")
    args = parser.parse_args()
    home = Path(args.home).resolve()
    config = json.loads((home / "settings.json").read_text())
    assert set(config["services"]) == {"wiki", "tango"} and not config["twin"], "Use an empty, combined test deployment"

    def command(name):
        result = subprocess.run([sys.executable, ROOT / "deploy.py", name, "--home", home], capture_output=True, text=True, timeout=180)
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or "Lifecycle command failed")
        return json.loads(result.stdout)

    base = "http://127.0.0.1:%s" % config["ports"]["wiki"]

    def request(path, body=None):
        req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.load(response)

    try:
        started = command("up")
        assert started["phase"] == "running"
        again = command("up")
        assert again["instance"] == started["instance"], "Repeated up must not spawn another owner"
        assert again["services"] == started["services"]
        assert request("/health")["status"] == "ok"
        with urllib.request.urlopen(base + "/config.js", timeout=5) as response:
            assert "DEFAULT_LOCALE: 'en-US'" in response.read().decode()
        owner = json.loads((home / "control.json").read_text())
        try:
            urllib.request.urlopen(owner["url"] + "/status", timeout=5)
            raise AssertionError("Unauthenticated lifecycle control was accepted")
        except urllib.error.HTTPError as error:
            assert error.code == 403
        subprocess.run([home / "venv/bin/python", ROOT / "verify_mcp.py", "http://127.0.0.1:%s/mcp" % config["ports"]["mcp"], "--empty"], check=True, timeout=30)
        suffix = secrets.token_hex(5)
        identity = {"username": "smoke" + suffix, "email": "smoke" + suffix + "@example.invalid", "password": "Aa1!" + secrets.token_hex(12)}
        request("/api/v1/auth/register", identity)
        credentials = {key: identity[key] for key in ["email", "password"]}
        before = request("/api/v1/auth/login", credentials)
        assert before.get("token") and before.get("user", {}).get("id")
        secret_hash = hashlib.sha256((home / "wiki/environment.json").read_bytes()).hexdigest()
        assert command("stop")["phase"] == "stopped"
        for name in ["wiki", "database", "mcp"]:
            with socket.socket() as probe:
                assert probe.connect_ex(("127.0.0.1", config["ports"][name])) != 0, name + " did not stop"
        restarted = command("start")
        assert restarted["phase"] == "running" and restarted["instance"] != started["instance"]
        after = request("/api/v1/auth/login", credentials)
        assert after["user"]["id"] == before["user"]["id"], "Account was lost on restart"
        assert secret_hash == hashlib.sha256((home / "wiki/environment.json").read_bytes()).hexdigest()
        subprocess.run([home / "venv/bin/python", ROOT / "verify_mcp.py", "http://127.0.0.1:%s/mcp" % config["ports"]["mcp"], "--empty"], check=True, timeout=30)
        print("PASS: combined startup, repeated up, HTTP health, English default, private lifecycle, MCP, account/key persistence and restart")
    finally:
        result = command("stop")
        assert result["phase"] == "stopped"
        print("PASS: all test sidecars stopped; data retained")


if __name__ == "__main__":
    main()
