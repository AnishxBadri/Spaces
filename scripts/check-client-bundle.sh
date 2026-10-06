#!/usr/bin/env bash
# The client bundle carries no drizzle schema, and no web chunk carries the
# local model's runtime. Run after the web build:
#
#   scripts/check-client-bundle.sh [assets dir]   (default apps/web/.output/public/assets)
#
# - `drizzle:` is the prefix of drizzle-orm's entity symbols
#   (`Symbol.for("drizzle:Name")`), so any table or drizzle helper that
#   reaches the browser trips it; the three table names are the ones the
#   leak was first found by.
# - The lint fence (NO_DB_IN_CLIENT) stops a client module importing
#   @spaces/db; this catches what lint cannot see — a module-level table
#   reference in a server module the server-fns barrel re-exports.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${1:-$ROOT/apps/web/.output/public/assets}"

if ! compgen -G "$DIR/*.js" >/dev/null; then
  echo "No client chunks under $DIR — run \`turbo run build --filter=@spaces/web\` first." >&2
  exit 1
fi

if grep -lE 'drizzle:|pending_blob|entity_alias|fx_rate' "$DIR"/*.js >&2; then
  echo "The chunks above carry the drizzle schema to the browser. A client module (or a server-fns module at its top level) reaches @spaces/db — read enum lists from @spaces/core, keep table references inside handler bodies." >&2
  exit 1
fi

echo "Client bundle: no drizzle schema in $(find "$DIR" -maxdepth 1 -name '*.js' | wc -l | tr -d ' ') chunks."

# The local embedding model runs in the worker only (D50): no web chunk —
# client or server — may name transformers.js or the ONNX runtime. The lint
# fence (WEB_NEVER_LOADS_A_MODEL) stops the import; this proves the output.
OUTPUT="$(cd "$DIR/../.." && pwd)"
if grep -rlE '@huggingface/transformers|onnxruntime' "$OUTPUT" --include='*.js' --include='*.mjs' >&2; then
  echo "The files above pull the local model's runtime into the web build. Web asks the worker for vectors through the embed_request seam (requestLocalEmbeddingProgram)." >&2
  exit 1
fi
echo "Web build: no local-model runtime under $OUTPUT."
