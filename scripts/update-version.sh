#!/usr/bin/env bash
# Increment semantic frontend version in version.json for cache busting.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VERSION_FILE="${APP_ROOT}/version.json"

CURRENT_VERSION=""
if [ -f "${VERSION_FILE}" ]; then
    CURRENT_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${VERSION_FILE}" | head -n 1 || true)"
fi

if [[ "${CURRENT_VERSION}" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    MAJOR="${BASH_REMATCH[1]}"
    MINOR="${BASH_REMATCH[2]}"
    PATCH="${BASH_REMATCH[3]}"
    NEXT_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"
else
    NEXT_VERSION="0.1.0"
fi

cat > "${VERSION_FILE}" <<EOF
{
    "version": "${NEXT_VERSION}"
}
EOF

echo "Updated ${VERSION_FILE} -> ${NEXT_VERSION}"
