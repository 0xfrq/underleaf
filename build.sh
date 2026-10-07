#!/usr/bin/env bash
# Build the frontend bundle, then the single self-contained server binary.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> building frontend"
(cd web && npm install --no-audit --no-fund && npm run build)

echo "==> building server"
cargo build --release

echo
echo "done: target/release/underleaf ($(du -h target/release/underleaf | cut -f1))"
