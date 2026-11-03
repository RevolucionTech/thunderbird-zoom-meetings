#!/usr/bin/env bash
# Packages the extension as dist/zoom-meetings.xpi
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')
mkdir -p dist
rm -f dist/zoom-meetings.xpi
zip -qr -X dist/zoom-meetings.xpi manifest.json background.html background.js api lib ui options icons _locales
echo "Built dist/zoom-meetings.xpi (version $version)"
