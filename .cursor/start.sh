#!/usr/bin/env bash
# Cursor cloud agent start step. Runs on every boot; nothing here is snapshotted.
set -euo pipefail

# The Build only proved the Docker client exists. This is the first moment a
# daemon can answer, so it is where the thing tinybird:local actually depends on
# gets proven: the socket reachable as this user, without sudo.
sudo service docker start

for _ in $(seq 60); do
  if docker info >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done

echo "start: the Docker daemon is not reachable after 60s. Its own error:" >&2
docker info >&2
exit 1
