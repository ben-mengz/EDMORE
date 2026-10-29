#!/bin/bash
set -euo pipefail

usage() {
  echo 'Usage: bash sync-server.sh [--dry-run]'
  echo 'Sync EDMORE source from this Mac to server; preview with --dry-run.'
}

dry_run=false
case "${1:-}" in
  '') ;;
  --dry-run) dry_run=true ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then usage >&2; exit 2; fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
deploy_env="${EDMORE_DEPLOY_ENV:-$root/edmore.deploy.env}"
[[ -f "$deploy_env" ]] || { echo "Missing deployment config: copy edmore.deploy.env.example to $deploy_env" >&2; exit 1; }
# shellcheck source=edmore.deploy.env.example
source "$deploy_env"
remote="$EDMORE_SSH_HOST"
base="$EDMORE_BASE"
destination="$base/source"
backup="$base/sync-backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"

for command in git rsync ssh; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
if [ "$(git -C "$root" rev-parse --show-toplevel)" != "$root" ]; then
  echo 'This script must be located at the EDMORE repository root.' >&2
  exit 1
fi

staging=$(mktemp -d "${TMPDIR:-/tmp}/edmore-sync.XXXXXX")
trap 'rm -rf "$staging"' EXIT
mkdir "$staging/source"

# Snapshot tracked and non-ignored new files, excluding locally deleted files.
git -C "$root" ls-files --cached --others --exclude-standard -z > "$staging/candidates"
while IFS= read -r -d '' path; do
  if [ -f "$root/$path" ] || [ -L "$root/$path" ]; then
    printf '%s\0' "$path"
  fi
done < "$staging/candidates" > "$staging/files"

excludes=(
  --exclude='.git/' --exclude='node_modules/' --exclude='.venv/'
  --exclude='__pycache__/' --exclude='.pytest_cache/' --exclude='.DS_Store'
  --exclude='.runtime/' --exclude='.dsh/' --exclude='coverage/'
  --exclude='dist/' --exclude='build/' --exclude='release/'
  --exclude='.env' --exclude='.env.*' --exclude='*credentials*'
  --exclude='*.pem' --exclude='*.key' --exclude='*-api-keys.txt'
  --exclude='*.sif' --exclude='*.gguf' --exclude='*.log'
)
rsync -rlt --from0 --files-from="$staging/files" "${excludes[@]}" \
  "$root/" "$staging/source/"
if [ ! -f "$staging/source/client/package.json" ] || [ ! -f "$staging/source/client/package-lock.json" ]; then
  echo 'Incomplete source snapshot; refusing to sync.' >&2
  exit 1
fi

options=(-rltz --checksum --delete-delay --backup --backup-dir="$backup" --itemize-changes --stats)
if "$dry_run"; then
  options+=(--dry-run)
else
  ssh -o ConnectTimeout=15 "$remote" "mkdir -p '$destination' ~/.config/edmore && chmod 700 ~/.config/edmore"
  # The cluster launcher reads the same private configuration.
  rsync -t --chmod=F600 -e 'ssh -o ConnectTimeout=15' "$deploy_env" "$remote:.config/edmore/deploy.env"
fi
echo "Source: $root"
echo "Target: $remote:$destination/"
rsync "${options[@]}" "${excludes[@]}" -e 'ssh -o ConnectTimeout=15' \
  "$staging/source/" "$remote:$destination/"
if "$dry_run"; then
  echo 'Preview complete. No remote files changed.'
else
  echo "Sync complete. Replaced/deleted files, if any, are backed up in $backup"
  echo 'Containers and running services were not rebuilt or restarted.'
fi
