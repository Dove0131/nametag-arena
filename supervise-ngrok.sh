#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"
if [ -f ./.ngrok.env ]; then
  set -a
  . ./.ngrok.env
  set +a
fi
if [ -z "${NGROK_AUTHTOKEN:-}" ]; then
  echo "NGROK_AUTHTOKEN missing in .ngrok.env" >&2
  exit 1
fi
while true; do
  node ngrok-tunnel.mjs
  rc=$?
  echo "ngrok exited rc=$rc at $(date '+%F %T'), retrying in 3s..." >> /tmp/ngrok.log
  sleep 3
done
