#!/usr/bin/env bash
# Delete files a previous deploy shipped that the current one no longer does.
# Run by scripts/deploy-lxc125.sh on the host, from the deploy directory,
# right after the new archive has been extracted over it.
#
# Why: extracting over the old tree never deleted anything, so a file removed
# from git stayed in the Docker build context and a deleted route kept serving
# (review 2026-09-24 C09).
#
# Inputs (in the current directory):
#   .deploy-manifest   files THIS deploy ships (inside the archive)
#   .deployed-files    files the PREVIOUS deploy shipped (absent the first time)
#
# First run (no .deployed-files): nothing is deleted unless PRUNE_UNTRACKED=1.
# It lists files present here that this deploy doesn't ship, so the owner can
# review them first. Host-owned paths are never deleted in either mode.
#
# On success .deploy-manifest becomes .deployed-files for the next deploy.
set -euo pipefail

PRUNE_UNTRACKED=${PRUNE_UNTRACKED:-0}

if [ ! -f .deploy-manifest ]; then
  echo "deploy-prune: no .deploy-manifest here; refusing to guess" >&2
  exit 1
fi

# Paths that belong to the host, not to git, whatever a list says.
host_owned() {
  case "$1" in
    data | data/* | backups | backups/* | node_modules/* | .git/* | .next/*) return 0 ;;
    .env* | Caddyfile | docker-compose.yml) return 0 ;;
    DEPLOYED_REVISION | .deployed-files | .deploy-manifest) return 0 ;;
    /* | *..*) return 0 ;; # never leave the deploy directory
    *) return 1 ;;
  esac
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
sort -u .deploy-manifest >"$work/new"

remove_listed() {
  local count=0 f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    host_owned "$f" && continue
    if [ -e "$f" ] || [ -L "$f" ]; then
      rm -f -- "$f"
      echo "  removed $f"
      count=$((count + 1))
    fi
  done <"$1"
  echo "  $count file(s) removed"
}

if [ -f .deployed-files ]; then
  sort -u .deployed-files >"$work/old"
  comm -23 "$work/old" "$work/new" >"$work/gone"
  remove_listed "$work/gone"
else
  echo "  first deploy with a manifest: files here that this deploy does not ship:"
  find . -type f -not -path './data/*' -not -path './backups/*' -not -path './node_modules/*' \
    -not -path './.git/*' -not -path './.next/*' | sed 's|^\./||' | sort >"$work/host"
  : >"$work/stale"
  while IFS= read -r f; do
    host_owned "$f" || echo "$f" >>"$work/stale"
  done < <(comm -23 "$work/host" "$work/new")
  if [ ! -s "$work/stale" ]; then
    echo "    (none)"
  else
    sed 's/^/    /' "$work/stale"
    if [ "$PRUNE_UNTRACKED" = "1" ]; then
      remove_listed "$work/stale"
    else
      echo "  NOT deleted. Review the list, then rerun the deploy with PRUNE_UNTRACKED=1 to delete them."
    fi
  fi
fi

# Directories emptied by the removals (never the host-owned ones).
find . -mindepth 1 -type d -empty \
  -not -path './data' -not -path './data/*' -not -path './backups' -not -path './backups/*' \
  -not -path './node_modules/*' -not -path './.git/*' -delete 2>/dev/null || true

mv .deploy-manifest .deployed-files
