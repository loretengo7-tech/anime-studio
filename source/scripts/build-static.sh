#!/usr/bin/env bash
# ANIME STUDIO — Static export build (for free hosting: Netlify / Cloudflare Pages / GitHub Pages)
#
# Produces dist-static/ — a fully client-side build:
#   - media stays in the browser (IndexedDB), AI runs direct from the browser
#   - API routes are stashed away because static hosting has no server
#
# Usage:  bash scripts/build-static.sh
# Optional: NEXT_PUBLIC_BASE_PATH=/my-repo bash scripts/build-static.sh  (GitHub Pages subpath)
set -e
cd "$(dirname "$0")/.."

API_STASHED=""
if [ -d src/app/api ]; then
  rm -rf /tmp/as-api-backup
  mkdir -p /tmp/as-api-backup
  mv src/app/api /tmp/as-api-backup/api
  API_STASHED=1
fi

restore() {
  if [ -n "$API_STASHED" ] && [ -d /tmp/as-api-backup/api ]; then
    mv /tmp/as-api-backup/api src/app/api
    echo "API routes restored."
  fi
}
trap restore EXIT

echo "Building static export (this runs next build with STATIC_EXPORT=1)..."
STATIC_EXPORT=1 NEXT_PUBLIC_STATIC_MODE=1 NEXT_PUBLIC_BASE_PATH="${NEXT_PUBLIC_BASE_PATH:-}" \
  ./node_modules/.bin/next build

echo
# GitHub Pages needs this file or it ignores _next/ (Jekyll processing breaks the app).
touch dist-static/.nojekyll
echo "Done → dist-static/"
echo "Deploy: drag dist-static/ to Netlify Drop, or push it to Cloudflare Pages / GitHub Pages."
