#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ "$#" -eq 0 ]; then
  set -- up
fi
exec "${EDMORE_BOOTSTRAP_PYTHON:-python3}" deploy.py "$@"
