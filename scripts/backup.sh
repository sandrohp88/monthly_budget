#!/bin/sh
# Nightly SQLite backup using VACUUM INTO. Keeps last 14 days.
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

# Prune oldest: keep most recent N
ls -1t "${DEST_DIR}"/budget-*.db 2>/dev/null | awk -v keep="${KEEP}" 'NR>keep' | xargs -r rm -v
