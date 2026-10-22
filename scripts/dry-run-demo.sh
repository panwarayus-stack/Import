#!/usr/bin/env bash
# End-to-end local demo with no external credentials.
#
# It exercises: comment sanitising → offline brief → site generation → static
# validation → local deployment → script → narration → (browser) recording →
# subtitles → FFmpeg render → upload gate.
#
# Requirements: Node 22+, FFmpeg. Chromium is optional: without it the run stops at
# `record_site` and tells you how to install it (it will never fabricate footage).
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Tip: copy .env.example to .env before running this for real: cp .env.example .env"
  echo "Continuing with development defaults."
fi

export DEPLOY_PROVIDER=local
export DRY_RUN=true
export DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD:-changeme}"
# A machine without Chromium cannot record a website. Instead of failing the demo,
# finish with the site + script + narration and an explicit "no video" warning.
export ALLOW_SKIP_VIDEO_WITHOUT_BROWSER="${ALLOW_SKIP_VIDEO_WITHOUT_BROWSER:-true}"

echo
echo "== 1/4 Environment =="
node src/cli.js init
node src/cli.js doctor

echo
echo "== 2/4 Demo comments =="
node src/cli.js seed-demo

echo
echo "== 3/4 Full pipeline for one manual comment =="
node src/cli.js generate \
  --comment "Could you build a tiny site that turns my saved hiking routes into a printable one-page map for the weekend?" \
  --author "@demo_viewer" \
  --max-attempts 1 || true

echo
echo "== 4/4 Artifacts =="
find generated-sites -maxdepth 3 -name index.html 2>/dev/null | head -5
find generated-videos recordings -maxdepth 3 -type f \
  \( -name '*.mp4' -o -name '*.srt' -o -name '*.ass' -o -name '*.wav' \) 2>/dev/null | head -10

cat <<'EOF'

Next steps:
  npm start                      # dashboard on http://localhost:3000
  node src/cli.js doctor         # what still needs real credentials
  npx playwright install --with-deps chromium   # enable browser tests + recording
EOF
