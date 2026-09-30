#!/usr/bin/env bash
# The upgrade matrix (SPA-189, ship-11): which published tags this commit is
# upgraded from. Pure — the published tag list comes in on stdin, one per
# line, exactly as GHCR's package-versions API lists them (`0.1.0`, `0.1`,
# `sha256-…`, `sha256-….sig`); only exact X.Y.Z versions count.
#
#   printf '0.1.0\n0.1\n' | scripts/upgrade-tags.sh --version 0.1.0 [--own-tag core@0.1.1]
#
# Prints, on stdout, the matrix as a JSON array of tags (`["0.1.0"]`) and,
# when there is nothing to upgrade from, the skip line the issue names —
# `upgrade-ci: one published tag (0.1.0), nothing to upgrade from — skipping`
# — with an empty array. Exit 0 both ways; the workflow reads the array.
#
# The window, pinned here (CONTEXT.md, Hosting, says the same):
#
#   N-1  the newest published tag other than the one being released, always
#   +    every other published tag with the same major as --version
#
# So while one prior tag exists the matrix is that tag; as a major
# accumulates patch and minor releases the matrix grows to all of them, and
# a new major starts again from N-1 alone. "Every prior release" would grow
# without bound and is not what runs.
#
# "Published" counts the tag being released, when there is one: on a
# `core@X.Y.Z` push the release workflow is publishing X.Y.Z concurrently,
# and the upgrade from N-1 to it is the whole point of the run. It is never
# upgraded from itself.
set -euo pipefail

VERSION=''
OWN=''
while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      shift
      VERSION="${1:?--version needs X.Y.Z}"
      ;;
    --version=*) VERSION="${1#--version=}" ;;
    --own-tag)
      shift
      OWN="${1:?--own-tag needs core@X.Y.Z}"
      ;;
    --own-tag=*) OWN="${1#--own-tag=}" ;;
    *)
      echo "upgrade-tags: unknown argument $1" >&2
      exit 2
      ;;
  esac
  shift
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "upgrade-tags: --version must be X.Y.Z (package.json's), got '${VERSION}'" >&2
  exit 2
}
OWN="${OWN#core@}"
if [ -n "$OWN" ] && [[ ! "$OWN" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "upgrade-tags: --own-tag must be core@X.Y.Z, got 'core@${OWN}'" >&2
  exit 2
fi

# Exact versions only, deduplicated, newest last.
mapfile -t PUBLISHED < <(grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -uV || true)

# The tag being released counts as published even if the registry does not
# list it yet; a tag the registry already lists is not counted twice.
ALL=("${PUBLISHED[@]}")
if [ -n "$OWN" ] && ! printf '%s\n' "${PUBLISHED[@]}" | grep -qx "$OWN"; then
  ALL+=("$OWN")
fi

CANDIDATES=()
for t in "${PUBLISHED[@]}"; do
  [ "$t" = "$OWN" ] || CANDIDATES+=("$t")
done

if [ "${#ALL[@]}" -lt 2 ] || [ "${#CANDIDATES[@]}" -eq 0 ]; then
  case "${#ALL[@]}" in
    0) echo 'upgrade-ci: no published tags, nothing to upgrade from — skipping' ;;
    1) echo "upgrade-ci: one published tag (${ALL[0]}), nothing to upgrade from — skipping" ;;
    *) echo "upgrade-ci: no published tag other than ${OWN}, nothing to upgrade from — skipping" ;;
  esac
  echo '[]'
  exit 0
fi

NEWEST="${CANDIDATES[${#CANDIDATES[@]} - 1]}"
MAJOR="${VERSION%%.*}"
MATRIX=()
for t in "${CANDIDATES[@]}"; do
  if [ "$t" = "$NEWEST" ] || [ "${t%%.*}" = "$MAJOR" ]; then
    MATRIX+=("$t")
  fi
done

echo "upgrade-ci: upgrading from ${MATRIX[*]} to ${VERSION} (window: newest prior tag ${NEWEST} plus every ${MAJOR}.x tag)" >&2
printf '%s\n' "${MATRIX[@]}" | jq -R . | jq -c -s .
