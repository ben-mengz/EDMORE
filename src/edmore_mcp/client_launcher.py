"""Launch the Node EDMORE client from an editable checkout or configured path."""

import os
from pathlib import Path
import shutil
import sys


def main() -> None:
    root = Path(os.environ.get("EDMORE_CLIENT_DIR", str(Path(__file__).resolve().parents[2] / "client"))).expanduser()
    if not (root / "start.mjs").is_file():
        raise SystemExit("EDMORE client not found. Set EDMORE_CLIENT_DIR to the installed client directory.")
    node = shutil.which("node")
    if node is None:
        raise SystemExit("EDMORE client requires Node.js 22.19+ or 24+.")
    os.chdir(root)
    os.execv(node, [node, "--import", "tsx/esm", "start.mjs", *sys.argv[1:]])


if __name__ == "__main__":
    main()
