#!/bin/sh
# Nightly SQLite backup using VACUUM INTO. Keeps the last 14 nightly files.
set -eu

SRC="${SRC:-/data/budget.db}"
DEST_DIR="${DEST_DIR:-/backups}"
KEEP="${KEEP:-14}"

stamp="$(date +%Y%m%d-%H%M%S)"
out="${DEST_DIR}/budget-${stamp}.db"

mkdir -p "${DEST_DIR}"

if [ ! -f "${SRC}" ]; then
  echo "[backup] source not found: ${SRC}" >&2
  exit 0
fi

sqlite3 "${SRC}" "VACUUM INTO '${out}';"
echo "[backup] wrote ${out}"

# Prune oldest NIGHTLY backups only: keep the most recent N. The pattern must
# match only this script's own names (budget-YYYYMMDD-HHMMSS.db). A broader
# budget-*.db also caught pre-deploy and manual backups, so a day with several
# deploys pushed nightly history out (review 2026-09-24 C10). Ad-hoc backups
# live in ${DEST_DIR}/adhoc with their own retention (scripts/deploy-lxc125.sh).
ls -1t "${DEST_DIR}"/budget-[0-9]*.db 2>/dev/null | awk -v keep="${KEEP}" 'NR>keep' | xargs -r rm -v
