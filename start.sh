#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"

PORT="${PORT:-4173}"
SERVER_LOG="/tmp/nametag-server.log"
NGROK_LOG="/tmp/ngrok.log"
SERVER_PID="/tmp/nametag.pid"
SUP_PID="/tmp/ngrok-supervisor.pid"
QDIR="/sdcard/Download/DSH-Go"
mkdir -p "$QDIR" 2>/dev/null || QDIR="$(pwd)"

say() { printf '%s\n' "$*"; }

# 把主页面依赖打成单文件，避开不稳定隧道下的并发资源请求失败
node build-inline.mjs >> "$SERVER_LOG" 2>&1 || true

find_pid_prefix() {
  local prefix="$1" d c
  for d in /proc/[0-9]*; do
    c=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null) || continue
    case "$c" in "$prefix"*) echo "${d##*/}"; return 0;; esac
  done
  return 1
}

# 1) game server
if ! curl -sf --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  say "启动游戏服务器…"
  setsid node server.js >> "$SERVER_LOG" 2>&1 < /dev/null &
  sleep 1.2
  SP=$(find_pid_prefix "node server.js " || true)
  [ -n "$SP" ] && echo "$SP" > "$SERVER_PID"
  for i in 1 2 3 4 5 6 7 8; do
    sleep 0.5
    curl -sf --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  done
fi
if ! curl -sf --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  say "服务器启动失败，请查看 $SERVER_LOG"
  tail -20 "$SERVER_LOG" 2>/dev/null
  exit 1
fi

# 2) ngrok fixed domain
if [ ! -f ./.ngrok.env ]; then
  say "缺少 .ngrok.env（NGROK_AUTHTOKEN / NGROK_DOMAIN）"
  exit 1
fi
set -a
. ./.ngrok.env
set +a
if [ -z "${NGROK_AUTHTOKEN:-}" ] || [ -z "${NGROK_DOMAIN:-}" ]; then
  say ".ngrok.env 里缺少 NGROK_AUTHTOKEN 或 NGROK_DOMAIN"
  exit 1
fi
URL="https://${NGROK_DOMAIN}"

SUP=$(cat "$SUP_PID" 2>/dev/null || true)
HEALTH=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 -H 'ngrok-skip-browser-warning: true' "$URL/health" || true)
if [ -z "$SUP" ] || ! kill -0 "$SUP" 2>/dev/null || [ "$HEALTH" != "200" ]; then
  say "启动/重启 ngrok 固定隧道…"
  [ -n "$SUP" ] && kill "$SUP" 2>/dev/null || true
  for d in /proc/[0-9]*; do
    c=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null) || continue
    case "$c" in "node ngrok-tunnel.mjs"*) kill "${d##*/}" 2>/dev/null || true;; esac
  done
  rm -f "$SUP_PID"
  : > "$NGROK_LOG"
  setsid ./supervise-ngrok.sh >> "$NGROK_LOG" 2>&1 < /dev/null &
  echo $! > "$SUP_PID"
fi

say "等待 ngrok 固定域名生效…"
PUBLIC_OK=0
for i in $(seq 1 20); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H 'ngrok-skip-browser-warning: true' "$URL/health" || true)
  if [ "$CODE" = "200" ]; then PUBLIC_OK=1; break; fi
  sleep 3
done
if [ "$PUBLIC_OK" = "0" ]; then
  say "公网暂时没有返回 200，正在检查 ngrok 日志…"
  tail -20 "$NGROK_LOG" 2>/dev/null
  exit 1
fi

echo "$URL" > /tmp/nametag-url.txt
echo "$URL" > "$QDIR/猎名场-当前入口.txt"

if [ -f "使用说明.md" ]; then
  sed -i -E 's#https://[a-z0-9.-]+\.(trycloudflare\.com|lhr\.life|ngrok-free\.dev|ngrok-free\.app)#'"$URL"'#g' "使用说明.md"
  cp "使用说明.md" "$QDIR/猎名场-使用说明.md"
fi

node -e '
const QRCode = require("qrcode");
QRCode.toFile(process.argv[1], process.argv[2], {
  width: 1024, margin: 2, errorCorrectionLevel: "M",
  color: { dark: "#0b1009", light: "#ffffff" },
}).then(() => console.log("二维码已更新")).catch((e) => console.error("二维码生成失败", e.message));
' "$QDIR/猎名场-入口二维码.png" "$URL"

say ""
say "=============================================="
say "  猎名场已上线（固定网址）"
say "  $URL"
say "=============================================="
say "玩家二维码：$QDIR/猎名场-入口二维码.png"
say "第一次打开会出现 ngrok 提示页，点「Visit Site」即可。"
say "之后同一浏览器不会再提示。"
