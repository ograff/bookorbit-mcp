#!/usr/bin/env bash
# Fetch the pinned BookOrbit source (only packages/types) and build @bookorbit/types.
set -euo pipefail
cd "$(dirname "$0")/.."
git submodule update --init --depth 1 vendor/bookorbit
git -C vendor/bookorbit sparse-checkout set --cone packages/types
(cd vendor/bookorbit/packages/types && npx --no-install tsc -p .)
