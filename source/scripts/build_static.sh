#!/usr/bin/env bash
# ANIME STUDIO — static single-page export build
# Parks the API routes (they can't exist in a static export), builds with
# output:'export', then restores them. Dev server (distDir .next) unaffected.
set -euo pipefail
cd /home/z/my-project

rm -rf /tmp/api_park && mkdir -p /tmp/api_park
mv src/app/api /tmp/api_park/api

restore() { mv /tmp/api_park/api src/app/api; }
trap restore EXIT

rm -rf dist-static
STATIC_EXPORT=1 NEXT_PUBLIC_STATIC_MODE=1 npx next build --webpack

echo "--- static build output ---"
ls dist-static | head -20
