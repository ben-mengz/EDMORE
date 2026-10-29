#!/usr/bin/env python3
"""Native EDMORE sidecars. No scheduler, container engine or privileged install."""
import argparse
import contextlib
import fcntl
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
VERSIONS = json.loads((HERE / "versions.json").read_text())


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + "." + secrets.token_hex(6) + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


def read_json(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def run(args, cwd=None, env=None):
    print("Running:", str(args[0]), str(args[1]) if len(args) > 1 else "", flush=True)
    subprocess.run([str(a) for a in args], cwd=cwd, env=env, check=True)


def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()


def extract(archive, target):
    target.mkdir(parents=True, exist_ok=True)
    root = target.resolve()
    def validate(item):
        path = (target / item.name).resolve()
        if (path != root and root not in path.parents) or not (item.isdir() or item.isfile() or item.issym() or item.islnk()):
            raise RuntimeError("Unsafe source archive member: " + item.name)
        if item.issym() or item.islnk():
            link = ((path.parent if item.issym() else root) / item.linkname).resolve()
            if Path(item.linkname).is_absolute() or (link != root and root not in link.parents):
                raise RuntimeError("Unsafe archive link: " + item.name)
    with tarfile.open(archive) as source:
        for item in source.getmembers():
            validate(item)
        # Recheck immediately before extraction, after earlier links may exist.
        for item in source.getmembers():
            validate(item)
            source.extract(item, target)


def source_hashes():
    return {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest()
            for name in ["versions.json", "weknora.patch", "tem-twin-source.tar.gz", "requirements.txt", "requirements.lock"]}


def copy_assets(source, destination):
    def writable_tree(root):
        if not root.exists():
            return
        for directory, _, files in os.walk(root):
            Path(directory).chmod(0o700)
            for name in files:
                (Path(directory) / name).chmod(0o600)
    # Go's module cache is read-only; do not transfer that immutability to updates.
    writable_tree(destination)
    shutil.copytree(source, destination, dirs_exist_ok=True, copy_function=shutil.copyfile)
    writable_tree(destination)


def download_archive(url, digest, destination):
    payload = fetch(url)
    if hashlib.sha256(payload).hexdigest() != digest:
        raise RuntimeError("Toolchain download checksum mismatch")
    destination.write_bytes(payload)


def toolchains(home):
    tools = home / "tools"
    tools.mkdir(exist_ok=True)
    system = {"Darwin": "darwin", "Linux": "linux"}.get(platform.system())
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "amd64"}.get(platform.machine())
    if not system or not arch:
        raise RuntimeError("Supported native hosts: macOS/Linux arm64 or x86_64; use Linux/WSL2 on Windows")
    node = tools / ("node-v%s-%s-%s" % (VERSIONS["node"], system, "x64" if arch == "amd64" else arch))
    if not (node / "bin/node").exists():
        print("Downloading and verifying Node " + VERSIONS["node"], flush=True)
        filename = node.name + ".tar.gz"
        base = "https://nodejs.org/dist/v" + VERSIONS["node"] + "/"
        hashes = dict(line.split()[::-1] for line in fetch(base + "SHASUMS256.txt").decode().splitlines())
        archive = tools / filename
        download_archive(base + filename, hashes[filename], archive)
        extract(archive, tools)
    go = tools / "go/bin/go"
    if not go.exists():
        print("Downloading and verifying Go " + VERSIONS["go"], flush=True)
        filename = "go%s.%s-%s.tar.gz" % (VERSIONS["go"], system, arch)
        versions = json.loads(fetch("https://go.dev/dl/?mode=json&include=all"))
        entry = next(f for release in versions for f in release["files"] if f["filename"] == filename)
        archive = tools / filename
        download_archive("https://go.dev/dl/" + filename, entry["sha256"], archive)
        extract(archive, tools)
    return node / "bin", go


def python_environment(home):
    uv = shutil.which("uv")
    if not uv:
        bootstrap = home / "bootstrap"
        if not (bootstrap / "bin/python").exists():
            run([sys.executable, "-m", "venv", bootstrap])
        run([bootstrap / "bin/python", "-m", "pip", "install", "uv==" + VERSIONS["uv"]])
        uv = str(bootstrap / "bin/uv")
    python = home / "venv/bin/python"
    if not python.exists():
        run([uv, "venv", "--python", VERSIONS["python"], home / "venv"])
    run([uv, "pip", "install", "--python", python, "-r", HERE / "requirements.lock"])
    return python


def initialize(home, offset, services):
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    config = read_json(home / "settings.json")
    if config:
        if offset is not None and offset != config["offset"]:
            raise RuntimeError("This data directory already has ports; choose a new --home to use another offset")
        return config
    offset = offset or 0
    ports = dict(wiki=8080+offset, database=10000+offset, device=10001+offset,
                 http_device=10002+offset, mcp=8767+offset, twin=8768+offset,
                 native=8769+offset, autoscript=7521+offset)
    if any(not 1024 <= port <= 65535 for port in ports.values()):
        raise RuntimeError("Invalid port offset")
    config = {"version": 1, "offset": offset, "services": services, "ports": ports, "twin": False}
    for relative in ["logs", "tango", "wiki/data", "wiki-sync/imports", "wiki-sync/harness", "wiki-sync/checkpoints"]:
        (home / relative).mkdir(parents=True, exist_ok=True, mode=0o700)
    write_json(home / "settings.json", config)
    write_json(home / "tango/devices.json", {})
    write_json(home / "tango/http-nodes.json", {})
    write_json(home / "wiki/environment.json", {
        "SERVER_HOST": "127.0.0.1", "SERVER_PORT": str(ports["wiki"]),
        "GIN_MODE": "release", "LOG_LEVEL": "warn", "DB_DRIVER": "sqlite",
        "DB_PATH": str(home / "wiki/data/weknora.db"), "RETRIEVE_DRIVER": "sqlite",
        "STORAGE_TYPE": "local", "LOCAL_STORAGE_BASE_DIR": str(home / "wiki/data/files"),
        "STREAM_MANAGER_TYPE": "memory", "NEO4J_ENABLE": "false", "ENABLE_GRAPH_RAG": "false",
        "WEKNORA_SANDBOX_MODE": "disabled", "DISABLE_REGISTRATION": "false",
        "SYSTEM_AES_KEY": secrets.token_hex(16), "JWT_SECRET": secrets.token_hex(32),
    })
    return config


def install(home, config, args):
    if control(home):
        raise RuntimeError("Stop this deployment before installing or updating its runtime")
    config["installed"] = False
    write_json(home / "settings.json", config)
    if "tango" in config["services"]:
        python = python_environment(home)
        source = home / "sources" / ("tem-twin-" + source_hashes()["tem-twin-source.tar.gz"][:12])
        if not source.exists():
            extract(HERE / "tem-twin-source.tar.gz", source)
        run([python, "-m", "compileall", "-q", source / "tem_twin_autoscript"])
        # Source is private to this deployment; no sibling checkout is needed.
        config["tango_source"] = str(source)
        if args.autoscript_wheels:
            wheels = sorted(Path(args.autoscript_wheels).resolve().glob("*.whl"))
            if not wheels:
                raise RuntimeError("No licensed AutoScript wheels supplied")
            uv = shutil.which("uv") or str(home / "bootstrap/bin/uv")
            run([uv, "pip", "install", "--python", python, *wheels])
        if args.with_twin:
            run([python, "-c", "import autoscript_tem_microscope_client, autoscript_core, thermoscientific_logging"])
            node_bin, _ = toolchains(home)
            env = {**os.environ, "PATH": str(node_bin) + os.pathsep + os.environ.get("PATH", "")}
            run([node_bin / "npm", "ci", "--ignore-scripts"], cwd=source / "tem_twin_autoscript/backend", env=env)
            config["node"] = str(node_bin / "node")
            config["twin"] = True
    if "wiki" in config["services"]:
        if not shutil.which("cc") or not shutil.which("git"):
            raise RuntimeError("Install C/C++ compiler and git first (macOS: xcode-select --install; Linux: build-essential, git, pkg-config)")
        node_bin, go = toolchains(home)
        source = home / "sources/weknora"
        if not source.exists():
            source.parent.mkdir(exist_ok=True)
            origin = str(Path(args.wiki_source).resolve()) if args.wiki_source else VERSIONS["wiki"]["repository"]
            run(["git", "clone", "--no-checkout", origin, source])
            run(["git", "checkout", "--detach", VERSIONS["wiki"]["commit"]], cwd=source)
        elif subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip() != VERSIONS["wiki"]["commit"]:
            raise RuntimeError("Wiki source revision changed; refusing an implicit upgrade")
        applied = subprocess.run(["git", "apply", "--reverse", "--check", str(HERE / "weknora.patch")], cwd=source, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if applied.returncode:
            run(["git", "apply", "--check", HERE / "weknora.patch"], cwd=source)
            run(["git", "apply", HERE / "weknora.patch"], cwd=source)
        runtime = home / "wiki/runtime"
        runtime.mkdir(exist_ok=True)
        env = {**os.environ, "PATH": str(node_bin) + os.pathsep + str(go.parent) + os.pathsep + os.environ.get("PATH", ""), "CGO_ENABLED": "1", "GOMAXPROCS": "4"}
        run([node_bin / "npm", "ci", "--ignore-scripts"], cwd=source / "frontend", env=env)
        run([node_bin / "npm", "run", "build"], cwd=source / "frontend", env=env)
        flags = "-w -s -X google.golang.org/protobuf/reflect/protoregistry.conflictPolicy=warn -X github.com/Tencent/WeKnora/internal/handler.Edition=lite -X github.com/Tencent/WeKnora/internal/handler.Version=v0.8.2"
        run([go, "build", "-p", "4", "-tags", "sqlite_fts5", "-ldflags="+flags, "-o", runtime / "WeKnora-lite", "./cmd/server"], cwd=source, env=env)
        for name, origin in [("config", source / "config"), ("migrations", source / "migrations"), ("web", source / "frontend/dist")]:
            copy_assets(origin, runtime / name)
        shutil.copy2(source / "LICENSE", runtime / "LICENSE")
        gomodcache = Path(subprocess.check_output([go, "env", "GOMODCACHE"], cwd=source, env=env, text=True).strip())
        dictionaries = list(gomodcache.glob("github.com/yanyiwu/gojieba@*/deps/cppjieba/dict"))
        if not dictionaries:
            raise RuntimeError("Built Wiki has no Jieba dictionary assets")
        copy_assets(dictionaries[-1], runtime / "jieba-dict")
        config["node"] = str(node_bin / "node")
    config["installed"] = True
    config["source_hashes"] = source_hashes()
    write_json(home / "settings.json", config)
    endpoints = {}
    if "tango" in config["services"]:
        endpoints["EDMORE_TANGO_MCP_URL"] = "http://127.0.0.1:%s/mcp" % config["ports"]["mcp"]
    if "wiki" in config["services"]:
        endpoints.update(WEKNORA_BASE_URL="http://127.0.0.1:%s" % config["ports"]["wiki"],
                         WEKNORA_SYNC_DIR=str(home / "wiki-sync"),
                         WEKNORA_IMPORT_DIR=str(home / "wiki-sync/imports"))
    connection = home / "endpoints.env"
    connection.write_text("# Endpoints only: Wiki keys and library IDs must be configured separately.\n" +
                          "".join("export %s=%s\n" % (key, shlex.quote(value)) for key, value in endpoints.items()))
    connection.chmod(0o600)
    print("Installed native sidecars. Existing databases, keys and imports were preserved.")


def control(home, action="status"):
    record = read_json(home / "control.json")
    if not record:
        return None
    request = urllib.request.Request(record["url"] + "/" + action,
        data=b"" if action == "stop" else None, headers={"Authorization": "Bearer " + record["token"]})
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            result = json.load(response)
            return result if result.get("instance") == record["instance"] else None
    except (OSError, ValueError):
        return None


def check_ports(config):
    names = (["wiki"] if "wiki" in config["services"] else [])
    if "tango" in config["services"]:
        names += ["database", "mcp"] + (["device", "http_device", "twin", "native", "autoscript"] if config["twin"] else [])
    for name in names:
        with socket.socket() as probe:
            # Closed HTTP connections can remain in TIME_WAIT after a clean stop.
            # This allows rebinding them, but never shares a live listening port.
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", config["ports"][name]))
            except OSError as error:
                raise RuntimeError("Port %s (%s) is already owned. No process will be stopped; use a new --home and --offset." % (config["ports"][name], name)) from error


def ready(url):
    try:
        with urllib.request.urlopen(url, timeout=1) as response:
            return response.status == 200
    except OSError:
        return False


def supervise(home):
    config = read_json(home / "settings.json")
    lock = (home / "owner.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    check_ports(config)
    token, instance = secrets.token_hex(32), secrets.token_hex(16)
    stop = threading.Event()
    state = {"instance": instance, "phase": "starting", "services": {}}
    children = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.respond(False)

        def do_POST(self):
            self.respond(True)

        def respond(self, mutation):
            if not secrets.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                self.send_error(403); return
            if self.path not in ("/status", "/stop") or mutation != (self.path == "/stop"):
                self.send_error(404); return
            if mutation:
                state["phase"] = "stopping"
                stop.set()
            payload = json.dumps(state).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    write_json(home / "control.json", {"url": "http://127.0.0.1:%s" % server.server_port, "token": token, "instance": instance})
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())

    def launch(name, args, cwd, env):
        with (home / "logs" / (name + ".log")).open("ab") as output:
            child = subprocess.Popen([str(a) for a in args], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                     stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        children.append((name, child))
        state["services"][name] = {"pid": child.pid}

    def wait_for(check, seconds=180):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and not stop.is_set():
            if any(child.poll() is not None for _, child in children):
                raise RuntimeError("A sidecar exited; inspect the private deployment logs")
            try:
                if check():
                    return
            except subprocess.TimeoutExpired:
                pass
            time.sleep(.25)
        raise RuntimeError("Startup timed out or was cancelled")

    try:
        env = dict(os.environ)
        python = home / "venv/bin/python"
        if "wiki" in config["services"]:
            runtime = home / "wiki/runtime"
            wiki_env = {**env, **read_json(home / "wiki/environment.json"), "JIEBA_DICT_DIR": str(runtime / "jieba-dict"), "WEKNORA_WEB_DIR": str(runtime / "web")}
            # Deployment credentials may not widen this local-only listener.
            wiki_env.update(SERVER_HOST="127.0.0.1", SERVER_PORT=str(config["ports"]["wiki"]))
            launch("wiki", [runtime / "WeKnora-lite"], runtime, wiki_env)
            wait_for(lambda: ready("http://127.0.0.1:%s/health" % config["ports"]["wiki"]))
        if "tango" in config["services"]:
            env.update(TANGO_HOST="127.0.0.1:%s" % config["ports"]["database"], PYTHONPATH=config["tango_source"])
            if config["twin"]:
                env["TEM_TWIN_NODE"] = config["node"]
                args = [python, "-m", "tem_twin_autoscript.cloud", "--host", "127.0.0.1", "--tango-data-dir", home / "tango", "--state-file", home / "tango/twin-state.json"]
                for flag, name in [("--port", "twin"), ("--mcp-port", "mcp"), ("--native-port", "native"), ("--autoscript-port", "autoscript"), ("--tango-db-port", "database"), ("--tango-device-port", "device"), ("--tango-http-device-port", "http_device")]:
                    args += [flag, str(config["ports"][name])]
                args += ["--tango-http-nodes", home / "tango/http-nodes.json",
                         "--tango-extra-devices", home / "tango/devices.json"]
                launch("tango-twin", args, home / "tango", env)
                wait_for(lambda: ready("http://127.0.0.1:%s/health" % config["ports"]["twin"]))
            else:
                launch("tango-database", [python, "-m", "tango.databaseds.database", "2", "-ORBendPoint", "giop:tcp:127.0.0.1:%s" % config["ports"]["database"]], home / "tango", env)
                def database_ready():
                    return subprocess.run([python, "-c", "from tango import Database; Database().get_device_name('*','*')"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10).returncode == 0
                wait_for(database_ready, 60)
                launch("tango-mcp", [python, HERE / "tango_gateway.py", "--devices", home / "tango/devices.json", "--port", str(config["ports"]["mcp"])], home / "tango", env)
            def mcp_ready():
                return subprocess.run([python, HERE / "verify_mcp.py", "http://127.0.0.1:%s/mcp" % config["ports"]["mcp"]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15).returncode == 0
            wait_for(mcp_ready, 60)
        state["phase"] = "running"
        while not stop.wait(.5):
            if any(child.poll() is not None for _, child in children):
                raise RuntimeError("A sidecar exited; stopping this deployment's remaining services")
    except Exception as error:
        state.update(phase="failed", error=str(error))
        write_json(home / "last-error.json", state)
        raise
    finally:
        for _, child in reversed(children):
            # A failed parent may leave grandchildren in its owned process group.
            with contextlib.suppress(ProcessLookupError):
                os.killpg(child.pid, signal.SIGTERM)
            if child.poll() is None:
                try:
                    child.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=10)
        server.shutdown(); server.server_close()
        current = read_json(home / "control.json", {})
        if current.get("instance") == instance:
            (home / "control.json").unlink(missing_ok=True)
        lock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", default="up", choices=["install", "up", "start", "stop", "status", "doctor", "_supervise"])
    parser.add_argument("--home", default=os.environ.get("EDMORE_NATIVE_HOME", str(Path.home() / ".local/share/edmore-native")))
    parser.add_argument("--offset", type=int)
    parser.add_argument("--services", nargs="+", choices=["wiki", "tango"], help="Defaults to both on first install; preserves existing selection thereafter")
    parser.add_argument("--wiki-source", help="Optional local clean base repository; deployment patches are applied to a private clone")
    parser.add_argument("--with-twin", action="store_true", help="Explicitly enable the simulated TEM; requires licensed AutoScript SDK wheels")
    parser.add_argument("--autoscript-wheels", help="Private directory containing licensed SDK wheels; never copied into the repository")
    args = parser.parse_args()
    home = Path(args.home).expanduser().resolve()
    os.umask(0o077)
    if args.command == "_supervise":
        supervise(home); return
    if args.command in ["status", "stop"]:
        current = control(home, args.command)
        if args.command == "stop" and current:
            for _ in range(240):
                if not control(home):
                    break
                time.sleep(.5)
            else:
                raise RuntimeError("Owner is still shutting down; no unrelated process was killed")
        print(json.dumps(control(home) or {"phase": "stopped", "home": str(home)}, indent=2)); return
    if args.command == "doctor":
        print(json.dumps({"platform": platform.platform(), "home": str(home), "git": shutil.which("git"), "compiler": shutil.which("cc"), "uv": shutil.which("uv"), "configuration": read_json(home / "settings.json"), "runtime": control(home)}, indent=2)); return
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    operation_lock = (home / "operation.lock").open("a")
    try:
        fcntl.flock(operation_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        raise RuntimeError("Another install/start operation owns this deployment") from error
    config = initialize(home, args.offset, args.services or ["wiki", "tango"])
    if args.services and set(args.services) != set(config["services"]):
        raise RuntimeError("Service selection belongs to this data directory; choose a new --home")
    if control(home):
        if args.command == "install":
            raise RuntimeError("Stop this deployment before installing")
        print(json.dumps(control(home), indent=2)); return
    if args.command != "install":
        check_ports(config)
    if args.command in ["install", "up"] and (args.command == "install" or not config.get("installed")):
        install(home, config, args)
    if args.command == "install":
        return
    if not config.get("installed"):
        raise RuntimeError("Run install or up first")
    if args.with_twin and not config.get("twin"):
        raise RuntimeError("Enable the simulator explicitly with install --with-twin --autoscript-wheels PATH")
    if config.get("source_hashes") != source_hashes():
        raise RuntimeError("Deployment sources changed; run install before starting this runtime")
    check_ports(config)
    with (home / "logs/supervisor.log").open("ab") as output:
        child = subprocess.Popen([sys.executable, str(HERE / "deploy.py"), "_supervise", "--home", str(home)], stdout=output, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    for _ in range(300):
        current = control(home)
        if current and current["phase"] == "running":
            print(json.dumps({**current, "ports": config["ports"], "home": str(home)}, indent=2)); return
        if child.poll() is not None:
            raise RuntimeError("Startup failed; inspect " + str(home / "logs/supervisor.log"))
        time.sleep(1)
    control(home, "stop")
    child.wait(timeout=120)
    raise RuntimeError("Startup timed out; shutdown requested through its owner")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
        print("Deployment failed:", error, file=sys.stderr)
        sys.exit(1)
