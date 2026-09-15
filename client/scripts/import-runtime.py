"""Import a pinned, self-contained runtime snapshot from a built Harness checkout.

This is a maintainer migration tool, not part of installation or startup.
"""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

source = Path(sys.argv[1]).resolve()
target = Path(__file__).resolve().parents[1]
packages = {}
for pattern in ("packages/*/*/package.json", "vendor/*/package.json", "apps/*/package.json"):
    for manifest in source.glob(pattern):
        data = json.loads(manifest.read_text())
        packages[data["name"]] = (manifest.parent, data)

launcher_dependencies = [
    "@deepseek-ai/dsh-app-boot", "@deepseek-ai/dsh-home-paths",
    "@deepseek-ai/dsh-http-proxy", "@deepseek-ai/dsh-launch-environment",
    "@deepseek-ai/dsh-cmdline",
]
pending = launcher_dependencies + [
    "@deepseek-ai/dsh-edmore-backend-profile", "@deepseek-ai/dsh-edmore-conversation-title",
    "@deepseek-ai/dsh-host-webserver", "@deepseek-ai/dsh-llm-deepseek",
]
selected = set()
while pending:
    name = pending.pop()
    if name in selected or name not in packages:
        continue
    selected.add(name)
    _, data = packages[name]
    pending.extend(data.get("dependencies", {}))
    pending.extend(name for name in data.get("peerDependencies", {})
                   if not data.get("peerDependenciesMeta", {}).get(name, {}).get("optional"))

records = []
for name in sorted(selected | {"@deepseek-ai/dsh"}):
    directory, original = packages[name]
    owned = "/packages/edmore/" in str(directory)
    destination = target / ("packages" if owned else "runtime") / directory.name
    if destination.exists():
        raise SystemExit(f"Refusing to overwrite {destination}")
    destination.mkdir(parents=True)
    for item in directory.iterdir():
        if item.name in {"node_modules", ".DS_Store", "package.json", "tsconfig.json", "AGENTS.md"}:
            continue
        if item.is_dir() and item.name not in {"src", "lib", "static", "tests", "config", "presets"}:
            continue
        if item.is_dir():
            shutil.copytree(item, destination / item.name,
                            ignore=shutil.ignore_patterns("*.tsbuildinfo", "*.map", "__pycache__"))
        elif item.suffix in {".js", ".mjs", ".yml", ".json", ".md"} or item.name.startswith("LICENSE"):
            shutil.copy2(item, destination / item.name)
    data = dict(original)
    data.pop("devDependencies", None)
    data.pop("scripts", None)
    data.pop("bin", None)
    data["private"] = True
    if name == "@deepseek-ai/dsh":
        data["dependencies"] = {key: original["dependencies"][key] for key in launcher_dependencies}
        data["dependencies"]["commander"] = original["dependencies"]["commander"]
        data.pop("dsh", None)
    for field in ("dependencies", "peerDependencies", "optionalDependencies"):
        for dependency, version in list(data.get(field, {}).items()):
            if dependency == "@deepseek-ai/node-addon-system":
                native = json.loads((source / "native/system/packages/entry/package.json").read_text())
                data[field][dependency] = native["version"]
                continue
            if dependency in packages:
                if dependency not in selected:
                    if field == "peerDependencies" and data.get("peerDependenciesMeta", {}).get(dependency, {}).get("optional"):
                        del data[field][dependency]
                        continue
                    raise SystemExit(f"Unresolved local dependency: {name} -> {dependency}")
                data[field][dependency] = packages[dependency][1]["version"]
    if owned:
        data["main"] = "src/index.ts"
        data["types"] = "src/index.ts"
        data["exports"] = {".": "./src/index.ts", "./package.json": "./package.json", "./src/*": "./src/*"}
        if (directory / "cordis.patch.yml").exists():
            data["exports"]["./cordis.patch.yml"] = "./cordis.patch.yml"
        shutil.rmtree(destination / "lib", ignore_errors=True)
    (destination / "package.json").write_text(json.dumps(data, indent=2) + "\n")
    records.append(dict(name=name, version=original["version"], source=str(directory.relative_to(source)),
                        destination=str(destination.relative_to(target)),
                        manifest_sha256=hashlib.sha256((directory / "package.json").read_bytes()).hexdigest()))

shutil.copytree(source / "packages/edmore/skills", target / "skills")
shutil.copy2(source / "LICENSE", target / "runtime/LICENSE")
(target / "runtime/provenance.json").write_text(json.dumps(dict(
    upstream="https://github.com/deepseek-ai/deepseek-harness",
    commit=subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip(),
    note="Snapshot includes local EDMORE additions. Runtime lib files are prebuilt upstream artifacts.",
    packages=records,
), indent=2) + "\n")
print(f"Imported {len(records)} packages into {target}")
