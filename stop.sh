#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"

# 停止 supervisor、ngrok、游戏服务器，以及历史遗留的隧道
for f in /tmp/ngrok-supervisor.pid /tmp/cloudflared.pid /tmp/lhr.pid /tmp/nametag.pid; do
  if [ -f "$f" ]; then
    pid=$(cat "$f" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi
    rm -f "$f"
  fi
done

for d in /proc/[0-9]*; do
  c=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null) || continue
  case "$c" in
    "node ngrok-tunnel.mjs"*|"bash ./supervise-ngrok.sh"*) kill "${d##*/}" 2>/dev/null || true;;
    *"nokey@localhost.run"*) kill "${d##*/}" 2>/dev/null || true;;
  esac
done

echo "已停止猎名场服务器和 ngrok 隧道。"
