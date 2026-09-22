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
#      container (backups/budget-predeploy-<ts>.db).
#   4. Extracts over /opt/budget, records DEPLOYED_REVISION, builds the image
#      explicitly (compose's `app` has no build section, so `up --build` is a
#      silent no-op) and recreates ONLY the app service. Caddy is untouched.
#   5. Waits for public /api/health and prints recent app logs.
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
trap 'rm -f "$TAR"' EXIT
echo "==> deploying origin/main $REV"

git archive --format=tar.gz -o "$TAR" origin/main -- . \
  ':!Caddyfile' ':!docker-compose.yml' ':!.env.example' ':!.env.fixture'
if tar -tzf "$TAR" | grep -qE '^(Caddyfile|docker-compose\.yml)$'; then
  echo "archive still contains host-owned files; refusing to deploy" >&2
  exit 1
fi

REMOTE_TAR=/tmp/budget-$REV.tar.gz
scp -q "$TAR" "$HOST:$REMOTE_TAR"
ssh "$HOST" "pct push $CT $REMOTE_TAR $REMOTE_TAR && rm $REMOTE_TAR"

ssh "$HOST" "pct exec $CT -- bash -s" <<EOF
set -euo pipefail
cd /opt/budget
echo "==> pre-deploy backup"
docker exec budget-backup sh -c 'sqlite3 /data/budget.db "VACUUM INTO '"'"'/backups/budget-predeploy-$TS.db'"'"'"'
ls -la backups/budget-predeploy-$TS.db
echo "==> extract"
tar -xzf $REMOTE_TAR -C /opt/budget
rm $REMOTE_TAR
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
