#!/usr/bin/env bash
# Render a 1920×1080 screenshot of the running wall with headless Chrome.
# Usage: ./screenshot.sh [name] [query-string]   e.g. ./screenshot.sh ambient "mode=ambient"
cd "$(dirname "$0")"
NAME=${1:-wall}; Q=${2:-}
PORT=$(python3 -c "import json;print(json.load(open('config.json')).get('port',4848))")
URL=${URL:-"http://127.0.0.1:$PORT/?still=1&$Q"}
google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1920,1080 --virtual-time-budget=${BUDGET:-5000} --user-data-dir=/tmp/boyd-wall-chrome-$$ \
  --screenshot="screenshots/$NAME.png" "$URL" 2>/dev/null
rm -rf /tmp/boyd-wall-chrome-$$
ls -la "screenshots/$NAME.png"
