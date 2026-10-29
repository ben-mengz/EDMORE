#!/bin/bash
#SBATCH --job-name=edmore-web
#SBATCH --gres=gpu:0
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=12G

# Run `bash edmore-slurm.sh` on the cluster: it submits itself with the
# partition, node and log paths from the deployment configuration. Site-specific
# values live in edmore.deploy.env (see edmore.deploy.env.example).

set -euo pipefail

deploy_env="${EDMORE_DEPLOY_ENV:-}"
if [[ -z "$deploy_env" ]]; then
  for candidate in "$(dirname "${BASH_SOURCE[0]}")/edmore.deploy.env" "$HOME/.config/edmore/deploy.env"; do
    if [[ -f "$candidate" ]]; then deploy_env="$candidate"; break; fi
  done
fi
[[ -f "$deploy_env" ]] || { echo 'Missing deployment config: install edmore.deploy.env or ~/.config/edmore/deploy.env' >&2; exit 1; }
deploy_env="$(cd "$(dirname "$deploy_env")" && pwd)/$(basename "$deploy_env")"
set -a
# shellcheck source=edmore.deploy.env.example
source "$deploy_env"
set +a

if [[ -z "${SLURM_JOB_ID:-}" ]]; then
  exec sbatch --export=ALL,EDMORE_DEPLOY_ENV="$deploy_env" \
    --partition="$EDMORE_SLURM_PARTITION" --nodelist="$EDMORE_SLURM_NODE" \
    --output="$EDMORE_BASE/edmore-%j.out" --error="$EDMORE_BASE/edmore-%j.err" \
    "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
fi

BASE="$EDMORE_BASE"
CONTAINER="$EDMORE_CONTAINER"
SOURCE="$BASE/source"
DATA="$EDMORE_DATA_DIR"
WORKSPACE="$EDMORE_WORKSPACE_DIR"
PORT="${EDMORE_PORT:-7380}"
WIKI_DATA="$EDMORE_WIKI_DATA_DIR"
WIKI_SYNC="$EDMORE_WIKI_SYNC_DIR"
EDMORE_WIKI_ENABLED=1

[[ -f "$CONTAINER" ]] || { echo "Missing container: $CONTAINER" >&2; exit 1; }
[[ -f "$SOURCE/client/package-lock.json" ]] || { echo "Sync the EDMORE source first: $SOURCE/client" >&2; exit 1; }
mkdir -p "$DATA" "$WORKSPACE"
chmod 700 "$DATA"
mkdir -p "$WIKI_DATA" "$WIKI_SYNC" "$WIKI_SYNC/imports" "$WIKI_SYNC/capabilities" "$WIKI_SYNC/runs" "$WIKI_SYNC/conversations" "$WIKI_SYNC/events" "$WIKI_SYNC/checkpoints"
chmod 700 "$WIKI_DATA" "$WIKI_SYNC"

# One backend owns this data directory, even when jobs land on different nodes.
exec 9>"$DATA/server.lock"
flock -n 9 || { echo 'Another EDMORE job already owns this data directory.' >&2; exit 1; }
WIKI_FRONTEND_BIND=()
if [[ -n "${WEKNORA_BINARY:-}" ]]; then
  [[ -x "$WEKNORA_BINARY" ]] || { echo 'Wiki binary override is not executable.' >&2; exit 1; }
  WIKI_FRONTEND_BIND+=(--bind "$WEKNORA_BINARY:/opt/weknora/WeKnora-lite:ro")
fi
if [[ "$EDMORE_WIKI_ENABLED" == 1 ]]; then
  [[ -f "$WIKI_DATA/server.env" ]] || { echo "Missing Wiki settings: $WIKI_DATA/server.env" >&2; exit 1; }
  [[ -f "$WIKI_DATA/harness.env" ]] || { echo "Missing Wiki Harness settings: $WIKI_DATA/harness.env" >&2; exit 1; }
  [[ -f "$WIKI_DATA/provision.json" ]] || { echo "Missing personal Wiki settings: $WIKI_DATA/provision.json" >&2; exit 1; }
  exec 8>"$WIKI_DATA/server.lock"
  flock -n 8 || { echo 'Another job already owns the Wiki data directory.' >&2; exit 1; }
  if [[ -f "$WIKI_DATA/frontend/index.html" ]]; then
    WIKI_FRONTEND_BIND+=(--bind "$WIKI_DATA/frontend:/opt/weknora/web:ro")
  fi
  if [[ -f "$WIKI_DATA/frontend-config.js" ]]; then
    WIKI_FRONTEND_BIND+=(--bind "$WIKI_DATA/frontend-config.js:/opt/weknora/web/config.js:ro")
  fi
fi
TANGO_BIND=()
if [[ -n "${EDMORE_TANGO_ACCESS_DIR:-}" ]]; then
  TANGO_BIND+=(--bind "$EDMORE_TANGO_ACCESS_DIR:/tango-access:ro")
fi

PUBLIC_URL="http://$(hostname -s).$EDMORE_PUBLIC_DOMAIN:$PORT"
echo "EDMORE node: $(hostname)"
echo "Job: ${SLURM_JOB_ID:-manual}"
echo "Bonsai API: http://127.0.0.1:2888/v1"
echo "Wiki: required (personal accounts enabled)"
if [[ -n "${EDMORE_STRATA_TUNNEL:-}" ]] && ! curl -fsS --max-time 3 http://127.0.0.1:2889/health >/dev/null; then
  ssh -N -i "$HOME/.ssh/strata-harness-tunnel" -o IdentitiesOnly=yes -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
    -L 127.0.0.1:2889:127.0.0.1:2889 "$EDMORE_STRATA_TUNNEL" &
fi
echo "School network / VPN URL: $PUBLIC_URL/edmore/"

exec apptainer exec --cleanenv \
  "${WIKI_FRONTEND_BIND[@]}" \
  --bind "$SOURCE:/opt/edmore" \
  --bind "$DATA:/data" \
  --bind "$WORKSPACE:/workspace" \
  --bind "$WIKI_DATA:/wiki-data" \
  --bind "$WIKI_SYNC:/wiki-sync" \
  "${TANGO_BIND[@]}" \
  --env DSH_HOME=/data \
  --env EDMORE_WORKSPACE=/workspace \
  --env EDMORE_CLIENT_HOST=0.0.0.0 \
  --env EDMORE_CLIENT_PORT="$PORT" \
  --env EDMORE_WIKI_ENABLED=1 \
  --env 'EDMORE_FEATURE_PACKAGES=["@edmore/plugin-wiki","@edmore/plugin-remote","@edmore/plugin-hu","@edmore/plugin-bonsai","@edmore/plugin-strata","@edmore/plugin-tango"]' \
  --env EDMORE_TANGO_ACCESS_FILE=/tango-access/harness-access.json \
  --env EDMORE_TANGO_SERVER_NAME=tem_twin \
  --env EDMORE_WIKI_STARTUP_TIMEOUT_MS="${EDMORE_WIKI_STARTUP_TIMEOUT_MS:-180000}" \
  --env WEKNORA_SYNC_DIR=/wiki-sync \
  --env EDMORE_DISABLE_COMPUTER_USE=1 \
  --env EDMORE_DISABLE_NIONSWIFT=1 \
  --env EDMORE_AUTH="${EDMORE_AUTH:-1}" \
  --env EDMORE_ADMIN_USER="$EDMORE_ADMIN_USER" \
  --env EDMORE_MAX_USERS="${EDMORE_MAX_USERS:-4}" \
  --env EDMORE_PUBLIC_URL="$PUBLIC_URL" \
  --env npm_config_cache=/data/npm-cache \
  --env EDMORE_INSTALL_DEPS="${EDMORE_INSTALL_DEPS:-auto}" \
  --pwd /opt/edmore/client \
  "$CONTAINER" bash -eu -c '
    dependency_hash=$(sha256sum package.json package-lock.json packages/*/package.json | sha256sum | cut -d " " -f 1)
    installed_hash=$(cat node_modules/.edmore-dependency-hash 2>/dev/null || true)
    check_dependencies() {
      node --import tsx/esm --input-type=module -e '\''await import("@deepseek-ai/dsh/lib/bin.js")'\''
    }
    if [[ "$EDMORE_INSTALL_DEPS" == 1 || "$installed_hash" != "$dependency_hash" ]] || ! check_dependencies; then
      echo "Installing Linux dependencies inside the container..."
      npm ci --no-audit --no-fund
      check_dependencies
      printf "%s\n" "$dependency_hash" > node_modules/.edmore-dependency-hash
    fi
    if [[ "$EDMORE_AUTH" == 1 && ! -f "$DSH_HOME/auth/accounts.json" ]]; then
      node --import tsx/esm packages/auth/src/cli.mjs bootstrap "$EDMORE_ADMIN_USER"
    fi
    exec node scripts/run-services.mjs
  '
