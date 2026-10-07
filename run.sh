#!/usr/bin/env bash
# Start Boyd Wall in the background (idempotent) and print the URLs.
#   ./run.sh           start (or report already running)
#   ./run.sh restart   stop the running copy and start fresh
#   ./run.sh stop      stop it
cd "$(dirname "$0")"
PORT=$(python3 -c "import json;print(json.load(open('config.json')).get('port',4848))")
stop() { [ -f data/server.pid ] && kill "$(cat data/server.pid)" 2>/dev/null; rm -f data/server.pid; sleep 1; }
case "${1:-start}" in
  stop) stop; echo "Boyd Wall stopped"; exit 0;;
  restart) stop;;
esac
if curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "Boyd Wall already running: http://127.0.0.1:$PORT  (kiosk: http://127.0.0.1:$PORT/kiosk)"; exit 0
fi
mkdir -p data
setsid nohup python3 server.py > data/server.log 2>&1 &
echo $! > data/server.pid
for i in $(seq 1 20); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
echo "Boyd Wall started (pid $!): http://127.0.0.1:$PORT"
echo "  kiosk:   http://127.0.0.1:$PORT/kiosk"
echo "  ambient: http://127.0.0.1:$PORT/ambient"
