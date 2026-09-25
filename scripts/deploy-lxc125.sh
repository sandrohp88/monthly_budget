#!/usr/bin/env bash
# Deploy origin/main to production: LXC 125 (/opt/budget) on pve-7050.
#
# Linux/macOS counterpart of the (gitignored) Windows scripts/redeploy.py.
# No secrets: it uses the `pve-7050` SSH alias from ~/.ssh/config.
#
#   scripts/deploy-lxc125.sh
#
# What it does, in order:
#   1. Refuses to trust pve-7050 blindly: if its host key isn't known yet, it
#      is taken from the Proxmox cluster's own record (via pve-7070, which
#      must already be trusted) and only then added to known_hosts.
#   2. Packages COMMITTED origin/main with `git archive`, excluding files the
#      host owns: Caddyfile (shared front door for other *.bluefalls.home
#      vhosts), docker-compose.yml (host copy differs) and .env*.
#   3. Takes a pre-deploy backup with VACUUM INTO in the budget-backup
#      container (backups/adhoc/budget-predeploy-<ts>.db). Ad-hoc backups keep
#      the newest 20, separately from the 14 nightly ones (scripts/backup.sh).
#   4. Extracts over /opt/budget, deletes files the previous deploy shipped
#      that this one no longer does (scripts/deploy-prune.sh), records
#      DEPLOYED_REVISION, builds the image explicitly (compose's `app` has no
#      build section, so `up --build` is a silent no-op) and recreates ONLY
#      the app service. Caddy is untouched.
#   5. Waits for public /api/health and prints recent app logs.
#
# The first deploy after deploy-prune.sh was added only LISTS stale files on
# the host and deletes nothing. After reviewing that list:
#
#   PRUNE_UNTRACKED=1 scripts/deploy-lxc125.sh
#
# Migrations run on the first page render; the startup check fails loudly if
# migration tracking is out of sync (see CLAUDE.md §7). Load /login after a
# deploy and check the logs.
set -euo pipefail

HOST=pve-7050
HOST_IP=10.10.88.11
CT=125
PUBLIC_URL=https://budget.sherrera.dev
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! ssh-keygen -F "$HOST_IP" >/dev/null; then
  echo "==> pve-7050 host key unknown; verifying against the cluster record"
  cluster_key=$(ssh -o BatchMode=yes pve-7070 "cat /etc/pve/nodes/pve-7050/ssh_known_hosts")
  live_fp=$(ssh-keyscan -t rsa "$HOST_IP" 2>/dev/null | ssh-keygen -lf - | awk '{print $2}')
  cluster_fp=$(echo "$cluster_key" | ssh-keygen -lf - | awk '{print $2}')
  if [ -z "$live_fp" ] || [ "$live_fp" != "$cluster_fp" ]; then
    echo "host key mismatch (live=$live_fp cluster=$cluster_fp); refusing to deploy" >&2
    exit 1
  fi
  echo "$cluster_key" | awk -v ip="$HOST_IP" '{print ip ",pve-7050 " $2 " " $3}' >> ~/.ssh/known_hosts
fi

cd "$REPO"
git fetch -q origin
REV=$(git rev-parse --short origin/main)
TS=$(date +%Y%m%d-%H%M%S)
TAR=$(mktemp -t "budget-$REV-XXXX.tar.gz")
echo "==> deploying origin/main $REV"

EXCLUDES=(':!Caddyfile' ':!docker-compose.yml' ':!.env.example' ':!.env.fixture')
# Ship the list of files this deploy contains, for scripts/deploy-prune.sh.
MANIFEST_DIR=$(mktemp -d)
trap 'rm -f "$TAR" "${TAR%.gz}"; rm -rf "$MANIFEST_DIR"' EXIT
git archive --format=tar -o "${TAR%.gz}" origin/main -- . "${EXCLUDES[@]}"
# The manifest is the archive's own file list (git ls-tree can't take the
# exclude pathspecs above), so it matches what ships exactly.
tar -tf "${TAR%.gz}" | grep -v '/$' >"$MANIFEST_DIR/.deploy-manifest"
tar -rf "${TAR%.gz}" -C "$MANIFEST_DIR" .deploy-manifest
gzip -c "${TAR%.gz}" >"$TAR"
if tar -tzf "$TAR" | grep -qE '^(Caddyfile|docker-compose\.yml)$'; then
  echo "archive still contains host-owned files; refusing to deploy" >&2
  exit 1
fi

REMOTE_TAR=/tmp/budget-$REV.tar.gz
scp -q "$TAR" "$HOST:$REMOTE_TAR"
ssh "$HOST" "pct push $CT $REMOTE_TAR $REMOTE_TAR && rm $REMOTE_TAR"

ssh "$HOST" "pct exec $CT -- bash -s" <<EOF
# (Unquoted heredoc: \$REMOTE_TAR, \$TS, \$REV and \${PRUNE_UNTRACKED} expand locally.)
set -euo pipefail
cd /opt/budget
echo "==> pre-deploy backup"
mkdir -p backups/adhoc
docker exec budget-backup sh -c 'sqlite3 /data/budget.db "VACUUM INTO '"'"'/backups/adhoc/budget-predeploy-$TS.db'"'"'"'
ls -la backups/adhoc/budget-predeploy-$TS.db
ls -1t backups/adhoc/*.db | awk 'NR>20' | xargs -r rm -v
echo "==> extract"
tar -xzf $REMOTE_TAR -C /opt/budget
rm $REMOTE_TAR
echo "==> removed files"
PRUNE_UNTRACKED=${PRUNE_UNTRACKED:-0} bash scripts/deploy-prune.sh
echo "$REV" > /opt/budget/DEPLOYED_REVISION
echo "==> build"
docker build -q -t budget-app:latest .
echo "==> recreate app"
docker compose up -d app
EOF

code=000
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_URL/api/health" || true)
  [ "$code" = 200 ] && break
  sleep 4
done
echo "public /api/health: $code"
curl -s -o /dev/null -w "public /login: %{http_code}\n" "$PUBLIC_URL/login"
ssh "$HOST" "pct exec $CT -- bash -c 'docker ps --filter name=budget-app --format \"{{.Names}} {{.Status}}\"; docker logs --since 5m budget-app 2>&1 | tail -15'"
[ "$code" = 200 ]
