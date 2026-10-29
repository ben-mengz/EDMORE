#!/bin/bash
#SBATCH --job-name=wiki-move-fix
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=24G
# Run `bash build-wiki-move-fix.sh` on the cluster; site values come from
# ~/.config/edmore/deploy.env (see edmore.deploy.env.example).
set -euo pipefail
deploy_env="${EDMORE_DEPLOY_ENV:-$HOME/.config/edmore/deploy.env}"
[[ -f "$deploy_env" ]] || { echo "Missing deployment config: $deploy_env" >&2; exit 1; }
set -a
source "$deploy_env"
set +a
if [[ -z "${SLURM_JOB_ID:-}" ]]; then
  exec sbatch --export=ALL,EDMORE_DEPLOY_ENV="$deploy_env" \
    --partition="$EDMORE_SLURM_PARTITION" --nodelist="$EDMORE_SLURM_NODE" \
    --output="$WEKNORA_ROOT/move-fix-%j.log" \
    "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
fi
ROOT="$WEKNORA_ROOT"
exec apptainer exec --contain --cleanenv --bind "$ROOT:/build" "$EDMORE_BUILD_CONTAINER" bash -eu -c '
  TEMP=$(mktemp -d /dev/shm/weknora-build.XXXXXX)
  trap '\''chmod -R u+w "$TEMP"; rm -rf "$TEMP"'\'' EXIT
  tar -mxzf /build/toolchain/go.tar.gz -C "$TEMP"
  mkdir -p "$TEMP/source"
  tar -mxzf /build/source.tar.gz -C "$TEMP/source"
  cp /build/source/internal/application/service/knowledge.go /build/source/internal/application/service/knowledge_clone_move.go /build/source/internal/application/service/knowledge_move_lite_test.go "$TEMP/source/internal/application/service/"
  mkdir -p "$TEMP/tmp"
  export PATH="$TEMP/go/bin:$PATH" GOPATH="$TEMP/gopath" GOCACHE="$TEMP/cache" GOTMPDIR="$TEMP/tmp" TMPDIR="$TEMP/tmp"
  export GOMAXPROCS=4 CGO_ENABLED=1 CGO_CFLAGS="-I/build/toolchain/sqlite-headers"
  cd "$TEMP/source"
  gofmt -w internal/application/service/knowledge.go internal/application/service/knowledge_clone_move.go internal/application/service/knowledge_move_lite_test.go
  go test -p 4 -tags sqlite_fts5 ./internal/application/service -run "TestLiteMoveProgress|TestMoveWiki" -count=1
  go build -p 4 -tags sqlite_fts5 -ldflags="-w -s -X google.golang.org/protobuf/reflect/protoregistry.conflictPolicy=warn -X github.com/Tencent/WeKnora/internal/handler.Edition=lite -X github.com/Tencent/WeKnora/internal/handler.Version=v0.8.2" -o /build/build/WeKnora-lite-move-fix ./cmd/server
  echo MOVE_FIX_BUILD_OK
'
