#!/usr/bin/env bash
# Run unit tests + browser smoke test. The server must be running (./run.sh).
set -e
cd "$(dirname "$0")/.."
python3 -W ignore tests/test_collect.py
node --experimental-websocket --no-warnings tests/smoke.mjs "$@"
