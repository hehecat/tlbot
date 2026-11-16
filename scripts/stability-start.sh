#!/bin/sh
# scripts/stability-start.sh [minutes]
# 停 v5 → 启动 host stage2 → 启动稳定性看门狗（默认 90 分钟）
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OLD=$(cd "$ROOT/.." && pwd)/tlbot
NODE=${NODE:-/Applications/Alma.app/Contents/Resources/alma-server/runtime/node}
MINUTES=${1:-${TL_WATCH_MINUTES:-90}}
PIDFILE=/tmp/tlbot-v5-supervisor.pid
v5_pids() { ps -eo pid,args | awk '$2 ~ /runtime\/node$/ && $3 ~ /combat_v5\.mjs/ {print $1}'; }
v5_count() { v5_pids | wc -l | tr -d ' '; }
sup_alive() { [ -f "$PIDFILE" ] || return 1; P=$(cat "$PIDFILE" 2>/dev/null); [ -n "$P" ] && ps -p "$P" >/dev/null 2>&1; }

echo "=== 停 v5 ==="
SUP=$(cat "$PIDFILE" 2>/dev/null || true)
if [ -n "$SUP" ] && ps -p "$SUP" >/dev/null 2>&1; then
  "$NODE" -e "try{process.kill($SUP,'SIGTERM');console.log('SIGTERM supervisor')}catch(e){console.log(e.code)}"
fi
sleep 1
touch "$OLD/.halt"
i=0
while [ $i -lt 60 ]; do
  N=$(v5_count); [ "$N" -eq 0 ] && break
  if [ $((i % 6)) -eq 0 ]; then echo "  $(date +%H:%M:%S) v5=$N"; fi
  sleep 5; i=$((i+1))
done
N=$(v5_count); echo "v5=$N"
if [ "$N" -ne 0 ]; then echo "ERROR: v5 未退出"; exit 1; fi
rm -f "$PIDFILE" "$OLD/.halt"
sleep 3

echo "=== 启动 host stage2 ==="
cd "$ROOT" || exit 1
TL_AUTOBOT=on \
TL_SESSION_MS=120000 \
TL_MAINTENANCE_MS=1800000 \
TL_PATROL_MS=3600000 \
TL_DAILY_HOUR=0 TL_DAILY_MINUTE=5 \
  sh scripts/hostctl.sh start 2 || { echo "host 启动失败"; exit 1; }

sleep 15
if ! sh scripts/hostctl.sh status | head -1 | grep -q "host 在跑"; then
  echo "ERROR: host 未存活"; sh scripts/hostctl.sh stop >/dev/null 2>&1 || true
  cd "$OLD" && nohup ./supervise_v5.sh >/dev/null 2>&1 &
  exit 1
fi

echo "=== 启动稳定性看门狗 ${MINUTES} 分钟 ==="
rm -f logs/stability-watch.out
nohup "$NODE" scripts/stability-watch.mjs >> logs/stability-watch.out 2>&1 &
sleep 2
echo "watch pid=$!"
echo "--- host ---"; sh scripts/hostctl.sh status | head -4
echo "--- extension tail ---"; tail -12 logs/extension.log
echo "--- 监控 ---"
echo "  tail -f $ROOT/logs/stability-watch.log"
echo "  tail -f $ROOT/logs/extension.log"
