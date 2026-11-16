#!/bin/sh
# enginectl.sh —— 独立引擎控制（不依赖 pi / 任何 agent）
#
#   ./enginectl.sh start [stage]   # 默认 stage=2
#   ./enginectl.sh stop
#   ./enginectl.sh restart
#   ./enginectl.sh status
#   ./enginectl.sh logs
#   ./enginectl.sh api             # 打印 API 帮助

set -u
ROOT=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE:-/Applications/Alma.app/Contents/Resources/alma-server/runtime/node}
PIDFILE=${TL_ENGINE_PIDFILE:-/tmp/tlbot-engine.pid}
PORT=${TL_PORT:-9527}

alive() {
  [ -f "$PIDFILE" ] && P=$(cat "$PIDFILE" 2>/dev/null) && [ -n "$P" ] && ps -p "$P" >/dev/null 2>&1
}

case "${1:-status}" in
  start)
    STAGE=${2:-${TL_STAGE:-2}}
    if alive; then echo "engine 已在跑 pid=$(cat "$PIDFILE")"; exit 0; fi
    # 检查是否有 pi-host 在抢唯一的 WS 连接
    if [ -f /tmp/tlbot-pi-host.pid ] && ps -p "$(cat /tmp/tlbot-pi-host.pid 2>/dev/null)" >/dev/null 2>&1; then
      echo "⚠️ 检测到 pi-host 仍在跑（$(cat /tmp/tlbot-pi-host.pid)）。先停它并删除 /tmp/tlbot-pi-host.pid"
      exit 1
    fi
    mkdir -p "$ROOT/logs"
    cd "$ROOT" || exit 1
    sleep "${TL_START_DELAY:-3}"
    TL_STAGE="$STAGE" TL_PORT="$PORT" nohup "$NODE" engine/runtime.mjs >> "$ROOT/logs/engine.out" 2>&1 &
    sleep 4
    if alive; then
      echo "engine 已启动 pid=$(cat "$PIDFILE") stage=$STAGE port=$PORT"
    else
      echo "engine 启动失败，看 logs/engine.out"
      exit 1
    fi
    ;;
  stop)
    if ! alive; then echo "engine 未在跑"; rm -f "$PIDFILE"; exit 0; fi
    P=$(cat "$PIDFILE")
    echo "停止 engine pid=$P"
    "$NODE" -e "try{process.kill($P,'SIGTERM')}catch(e){console.log(e.code)}"
    i=0
    while [ $i -lt 20 ]; do
      ps -p "$P" >/dev/null 2>&1 || break
      sleep 1; i=$((i+1))
    done
    if ps -p "$P" >/dev/null 2>&1; then echo "⚠️ 20s 未退出 pid=$P"; exit 1; fi
    rm -f "$PIDFILE"
    echo "engine 已停止"
    ;;
  restart)
    "$0" stop; sleep 2; "$0" start "$2"
    ;;
  status)
    if alive; then
      echo "engine 运行中 pid=$(cat "$PIDFILE")"
      echo "--- brief ---"
      curl -s "http://127.0.0.1:$PORT/status/brief" 2>/dev/null || \
        "$NODE" -e "
          fetch('http://127.0.0.1:$PORT/status/brief')
            .then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,1)))
            .catch(e=>console.log('API 不可达:',e.message))
        "
    else
      echo "engine 未在跑"
    fi
    ;;
  logs)
    tail -"${2:-40}" "$ROOT/logs/engine.log"
    ;;
  watch)
    # 服务器恢复守护：探测 DNS/HTTP/WS，恢复后自动拉起引擎
    WPIDFILE=/tmp/tlbot-watchdog.pid
    if [ -f "$WPIDFILE" ] && ps -p "$(cat "$WPIDFILE" 2>/dev/null)" >/dev/null 2>&1; then
      echo "守护已在跑 pid=$(cat "$WPIDFILE")"; exit 0
    fi
    mkdir -p "$ROOT/logs"
    cd "$ROOT" || exit 1
    nohup "$NODE" engine/watchdog.mjs >> "$ROOT/logs/watchdog.out" 2>&1 &
    sleep 2
    if [ -f "$WPIDFILE" ] || ps -p $! >/dev/null 2>&1; then
      echo "守护已启动（每 5 分钟探测一次）"
    else
      echo "守护启动失败，看 logs/watchdog.out"
    fi
    ;;
  unwatch)
    WPIDFILE=/tmp/tlbot-watchdog.pid
    if [ -f "$WPIDFILE" ]; then
      P=$(cat "$WPIDFILE")
      "$NODE" -e "try{process.kill($P,'SIGTERM')}catch(e){}" 2>/dev/null
      rm -f "$WPIDFILE"
      echo "守护已停止"
    else
      echo "守护未在跑"
    fi
    ;;
  wlogs)
    tail -"${2:-40}" "$ROOT/logs/watchdog.log"
    ;;
  api)
    "$NODE" -e "
      fetch('http://127.0.0.1:$PORT/help')
        .then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,1)))
        .catch(e=>console.log('API 不可达:',e.message))
    "
    ;;
  *)
    echo "用法：$0 {start [stage]|stop|restart|status|logs [n]|api}"
    exit 1
    ;;
esac
