#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/release-prod.sh [options]

Commits the current work (if needed), pushes the branch, fast-forward merges it
into main, runs release checks, builds the amd64 Docker image locally, uploads
the image and production compose file to the VM, restarts the production stack,
and verifies the deploy.

Options:
  -m, --message MSG   Commit message to use when the working tree is dirty
  --host HOST         Production SSH host (default: root@5.78.201.47)
  --app-dir DIR       Remote app directory (default: /srv/apps/randompick)
  --domain DOMAIN     Domain to verify after deploy (default: random.ziyang.li)
  --skip-tests        Skip local checks before build
  --skip-verify       Skip post-deploy verification checks
  -h, --help          Show this help text
EOF
}

log() {
  printf '[release] %s\n' "$*"
}

die() {
  printf '[release] ERROR: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

run() {
  log "$*"
  "$@"
}

remote_run() {
  local script=$1

  log "ssh $PROD_HOST <remote script>"
  ssh "$PROD_HOST" "bash -lc $(printf '%q' "$script")"
}

COMMIT_MESSAGE=""
PROD_HOST="root@5.78.201.47"
APP_DIR="/srv/apps/randompick"
DOMAIN="random.ziyang.li"
SKIP_TESTS=0
SKIP_VERIFY=0

while (($# > 0)); do
  case "$1" in
    -m|--message)
      (($# >= 2)) || die "missing value for $1"
      COMMIT_MESSAGE=$2
      shift 2
      ;;
    --host)
      (($# >= 2)) || die "missing value for $1"
      PROD_HOST=$2
      shift 2
      ;;
    --app-dir)
      (($# >= 2)) || die "missing value for $1"
      APP_DIR=$2
      shift 2
      ;;
    --domain)
      (($# >= 2)) || die "missing value for $1"
      DOMAIN=$2
      shift 2
      ;;
    --skip-tests)
      SKIP_TESTS=1
      shift
      ;;
    --skip-verify)
      SKIP_VERIFY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

need_cmd git
need_cmd docker
need_cmd ssh
need_cmd scp
need_cmd curl
need_cmd npm
need_cmd node

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this script inside the git repository"
cd "$REPO_ROOT"

ORIGINAL_BRANCH=$(git branch --show-current)
[[ -n "$ORIGINAL_BRANCH" ]] || die "detached HEAD is not supported"

TMP_DIR=$(mktemp -d /tmp/randompick-release.XXXXXX)

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

if [[ -n "$(git status --porcelain)" ]]; then
  [[ -n "$COMMIT_MESSAGE" ]] || die "working tree is dirty; pass --message to create the release commit"

  log "staging current changes on $ORIGINAL_BRANCH"
  run git add -A

  if [[ -n "$(git diff --cached --name-only)" ]]; then
    run git commit -m "$COMMIT_MESSAGE"
  else
    log "nothing was staged after git add -A; skipping commit"
  fi
else
  log "working tree is clean; skipping commit"
fi

git rev-parse --verify HEAD >/dev/null 2>&1 || die "no commits exist yet; create the initial commit before releasing"

HAS_REMOTE_MAIN=0
if git ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
  HAS_REMOTE_MAIN=1
fi

if [[ "$ORIGINAL_BRANCH" != "main" ]]; then
  if ((HAS_REMOTE_MAIN == 0)); then
    die "origin/main does not exist yet; run the initial release from local main"
  fi

  run git push -u origin "$ORIGINAL_BRANCH"
fi

if ((HAS_REMOTE_MAIN)); then
  run git fetch origin main
fi

if [[ "$ORIGINAL_BRANCH" != "main" ]]; then
  run git switch main
fi

if ((HAS_REMOTE_MAIN)); then
  run git pull --ff-only origin main
fi

if [[ "$ORIGINAL_BRANCH" != "main" ]]; then
  run git merge --ff-only "$ORIGINAL_BRANCH"
fi

if ((SKIP_TESTS == 0)); then
  run npm test
  run node --check backend/server.js
  run node --check backend/public/app.js
else
  log "skipping local checks"
fi

run git push origin main

SHORT_SHA=$(git rev-parse --short HEAD)
IMAGE_NAME="randompick:latest"
ARCHIVE_PATH="$TMP_DIR/randompick-${SHORT_SHA}.tar.gz"
REMOTE_ARCHIVE="$APP_DIR/$(basename "$ARCHIVE_PATH")"

run docker build --platform linux/amd64 -t "$IMAGE_NAME" -t "randompick:${SHORT_SHA}" .

log "saving release image to $ARCHIVE_PATH"
docker save "$IMAGE_NAME" | gzip > "$ARCHIVE_PATH"

remote_run "
set -euo pipefail
mkdir -p $(printf '%q' "$APP_DIR")
docker network create shared-edge >/dev/null 2>&1 || true
"

run scp \
  docker-compose.prod.yml \
  "$ARCHIVE_PATH" \
  "$PROD_HOST:$APP_DIR/"

remote_run "
set -euo pipefail
gunzip -c $(printf '%q' "$REMOTE_ARCHIVE") | docker load
cd $(printf '%q' "$APP_DIR")
docker compose -f docker-compose.prod.yml up -d --force-recreate app
rm -f $(printf '%q' "$REMOTE_ARCHIVE")
docker image prune -f
"

if ((SKIP_VERIFY == 0)); then
  remote_run "
set -euo pipefail
cd $(printf '%q' "$APP_DIR")
docker compose -f docker-compose.prod.yml ps
ok=''
for attempt in \$(seq 1 30); do
  if docker compose -f docker-compose.prod.yml exec -T app node --input-type=module -e \"const response = await fetch('http://127.0.0.1:8080/api/healthz'); if (!response.ok) process.exit(1); const body = await response.text(); if (!body.includes('ok')) process.exit(1);\" >/dev/null 2>&1; then
    ok='yes'
    break
  fi
  sleep 2
done
test \"\${ok}\" = 'yes'
"

  HTTP_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "https://${DOMAIN}/")
  case "$HTTP_STATUS" in
    2*|3*)
      log "verified https://${DOMAIN}/ returned HTTP ${HTTP_STATUS}"
      ;;
    *)
      die "deployment verification failed: https://${DOMAIN}/ returned HTTP ${HTTP_STATUS}"
      ;;
  esac
else
  log "skipping post-deploy verification"
fi

log "release complete"
log "deployed commit: $(git rev-parse HEAD)"
