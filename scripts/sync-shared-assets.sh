#!/usr/bin/env bash
# Sync shared frontend assets into pulse.porchlogic.com so deploy output is self-contained.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SOURCE_CSS="${REPO_ROOT}/shared/styles/foundation.css"
TARGET_DIR="${SCRIPT_DIR}/../assets/styles"
TARGET_CSS="${TARGET_DIR}/foundation.css"

mkdir -p "${TARGET_DIR}"
cp "${SOURCE_CSS}" "${TARGET_CSS}"

echo "Synced ${SOURCE_CSS} -> ${TARGET_CSS}"
