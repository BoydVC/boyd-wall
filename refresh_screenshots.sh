#!/usr/bin/env bash
# Regenerate every README screenshot (1920×1080) and the offline snapshot. Server must be running.
cd "$(dirname "$0")"
./screenshot.sh wall
for t in ravens terps chelsea orioles; do ./screenshot.sh "team-$t" "team=$t"; done
./screenshot.sh ambient "mode=ambient"
./screenshot.sh outage "simulate=outage"
./screenshot.sh gameday-preview "now=2026-10-10T09:41:00-04:00"
./screenshot.sh launch-imminent "now=2026-10-08T03:21:30-04:00"
python3 export_snapshot.py
URL="file://$PWD/dist/boyd-wall-snapshot.html?still=1" ./screenshot.sh snapshot-offline
