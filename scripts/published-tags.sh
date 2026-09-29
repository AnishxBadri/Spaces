#!/usr/bin/env bash
# The published tag list (SPA-189, ship-11), one tag per line on stdout, as
# GHCR holds it — the input `upgrade-tags.sh` turns into the upgrade matrix.
#
#   scripts/published-tags.sh [owner] [package]      (default anishxbadri spaces)
#
# Two sources, the first that answers wins, and stderr says which:
#
#   1. GHCR's package-versions API — the list the release workflow is the
#      only writer of (`.github/workflows/release.yml`, "ship-11 keys on the
#      list of published tags"). Needs a token with `packages: read`
#      (GH_TOKEN / GITHUB_TOKEN); every version's `metadata.container.tags`.
#   2. The registry's own tag list (`/v2/<owner>/<package>/tags/list`) with
#      an anonymous pull token — the package is public, so this needs no
#      credentials at all. Same tags, plus the `sha256-…` signature and
#      attestation tags cosign and the provenance step add, which
#      `upgrade-tags.sh` ignores because they are not X.Y.Z.
#
# Exit 1 with nothing on stdout when neither answers, so a caller never
# mistakes "the registry was unreachable" for "no tags are published".
set -euo pipefail

OWNER="${1:-anishxbadri}"
PACKAGE="${2:-spaces}"
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

if [ -n "$TOKEN" ]; then
  if OUT="$(curl -fsS --max-time 30 \
    -H "Authorization: Bearer $TOKEN" -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/users/$OWNER/packages/container/$PACKAGE/versions?per_page=100" 2>/dev/null)" &&
    TAGS="$(jq -r '.[].metadata.container.tags[]?' <<<"$OUT" 2>/dev/null)" && [ -n "$TAGS" ]; then
    echo "published-tags: GHCR package-versions API answered for $OWNER/$PACKAGE" >&2
    printf '%s\n' "$TAGS"
    exit 0
  fi
  echo "published-tags: the package-versions API did not answer; trying the registry's tag list" >&2
fi

PULL="$(curl -fsS --max-time 30 "https://ghcr.io/token?scope=repository:$OWNER/$PACKAGE:pull" | jq -r .token)"
if OUT="$(curl -fsS --max-time 30 -H "Authorization: Bearer $PULL" \
  "https://ghcr.io/v2/$OWNER/$PACKAGE/tags/list")" &&
  TAGS="$(jq -r '.tags[]?' <<<"$OUT")" && [ -n "$TAGS" ]; then
  echo "published-tags: the registry's tag list answered for $OWNER/$PACKAGE" >&2
  printf '%s\n' "$TAGS"
  exit 0
fi

echo "published-tags: could not read the published tags of ghcr.io/$OWNER/$PACKAGE from either source" >&2
exit 1
