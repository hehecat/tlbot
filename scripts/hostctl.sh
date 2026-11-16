#!/bin/sh
# scripts/hostctl.sh —— 常驻 pi host 控制
#
#   scripts/hostctl.sh start [stage]   # 默认 stage=1
#   scripts/hostctl.sh stop
#   scripts/hostctl.sh status
#   scripts/hostctl.sh logs
#
# 注意：start 前必须确认旧 v5 已停，否则 extension 的防踢闸门会拒绝连接。
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE=${NODE:-/Applications/Alma.app/Contents/Resources/alma-server/runtime/node}
PIDFILE=${TL_HOST_PIDFILE:-/tmp/tlbot-pi-host.pid}
OUT="$ROOT/logs/host.out"
LOG="$ROOT/logs/host.log"
V5PID=/tmp/tlbot-v5-supervisor.pid

alive() { [ -f "$PIDFILE" ] && P=$(cat "$PIDFILE" 2>/dev/null) && [ -n "$P" ] && ps -p "$P" >/dev/null 2>&1; }

case "${1:-status}" in
  start)
    STAGE=${2:-${TL_STAGE:-1}}
    if alive; then echo "host 已在跑 pid=$(cat "$PIDFILE")"; exit 0; fi
    if [ -f "$V5PID" ] && ps -p "$(cat "$V5PID" 2>/dev/null)" >/dev/null 2>&1; then
      echo "⚠️ 检测到 v5 supervisor 仍在跑（$(cat "$V5PID")）。先停 v5 并删除 $V5PID，否则 extension 拒绝连接。"
      exit 1
    fi
    mkdir -p "$ROOT/logs"
    cd "$ROOT" || exit 1
    # 避免旧会话在服务器端还没释放就重连（会触发 Session replaced）
    sleep "${TL_HOST_START_DELAY:-3}"
    TL_STAGE="$STAGE" TL_ENABLE_WS=1 nohup "$NODE" scripts/pi-host.mjs >> "$OUT" 2>&1 &
    sleep 3
    if alive; then echo "host 已启动 pid=$(cat "$PIDFILE") stage=$STAGE"; else echo "host 启动失败，看 $OUT"; exit 1; fi
    ;;
  stop)
    if ! alive; then echo "host 未在跑"; rm -f "$PIDFILE"; exit 0; fi
    P=$(cat "$PIDFILE")
    echo "停止 host pid=$P"
    "$NODE" -e "try{process.kill($P,'SIGTERM')}catch(e){console.log(e.code)}"
    i=0
    while [ $i -lt 20 ]; do
      if ! ps -p "$P" >/dev/null 2>&1; then break; fi
      sleep 1
      i=$((i+1))
    done
    if ps -p "$P" >/dev/null 2>&1; then echo "⚠️ host 20s 未退出 pid=$P"; exit 1; fi
    rm -f "$PIDFILE"
    echo "host 已停止"
    ;;
  status)
    if alive; then
      P=$(cat "$PIDFILE")
      echo "host 在跑 pid=$P stage=${TL_STAGE:-?}"
      ps -p "$P" -o pid,etime,command
    else
      echo "host 未在跑"
    fi
    echo "--- 最近 host.log ---"
    tail -8 "$LOG" 2>/dev/null || true
    ;;
  logs)
    tail -f "$LOG"
    ;;
  *)
    echo "用法: $0 {start [stage]|stop|status|logs}"
    exit 2
    ;;
esac
