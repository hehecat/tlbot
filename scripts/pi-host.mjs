// scripts/pi-host.mjs —— 常驻 pi RPC 宿主（PRD D1：pi 进程就是宿主）
//
// 职责：
//   · 以 RPC 模式拉起 pi（项目级 .pi/extensions/tlbot.ts 自动加载）
//   · 保持 stdin 打开，pi 常驻；extension 在 session_start 里启动 CombatDaemon
//   · pi 退出 → 指数退避重启（3s/6s/12s/30s）
//   · .halt 由 extension 自己处理（停止主动发包，进程不退出）
//   · 日志写 logs/host.log；stdout 只用于 RPC 协议，不打印业务日志
//
// 用法：
//   TL_STAGE=2 nohup node scripts/pi-host.mjs >> logs/host.out 2>&1 &
//   scripts/hostctl.sh stop

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PI = process.env.PI_BIN || 'pi';
const PIDFILE = process.env.TL_HOST_PIDFILE || '/tmp/tlbot-pi-host.pid';
const LOG = path.join(ROOT, 'logs', 'host.log');
const STAGE = process.env.TL_STAGE || '1';
const KICKOFF = process.env.TL_HOST_KICKOFF === '1';
const RESTART_DELAYS = [3000, 6000, 12000, 30000];

fs.mkdirSync(path.dirname(LOG), { recursive: true });
const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] [host] ` + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  try { fs.appendFileSync(LOG, line + '\n'); } catch { }
  try { console.error(line); } catch { }
};

// 单实例
try {
  if (fs.existsSync(PIDFILE)) {
    const old = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
    if (old && old !== process.pid) {
      try { process.kill(old, 0); log(`已有 host 在跑 pid=${old}，退出`); process.exit(0); } catch { }
    }
  }
} catch { }
fs.writeFileSync(PIDFILE, String(process.pid));

let child = null;
let stopping = false;
let attempt = 0;
let kickoffTimer = null;

function send(obj) {
  try { child?.stdin.write(JSON.stringify(obj) + '\n'); } catch (e) { log('stdin write 失败', e?.message); }
}

function handleRecord(line) {
  if (!line.trim()) return;
  let j;
  try { j = JSON.parse(line); } catch { log('非 JSON 输出', line.slice(0, 300)); return; }

  // 扩展 UI：notify 记录；dialog 一律取消，避免无人值守卡住
  if (j.type === 'extension_ui_request') {
    if (j.method === 'notify') { log('notify', j.message); return; }
    log('ui request', j.method, j.title || j.message || '');
    send({ type: 'extension_ui_response', id: j.id, cancelled: true });
    return;
  }
  if (j.type === 'response' && j.success === false) {
    log('rpc error', j.command, j.error || '');
    return;
  }
  // 记录 watchdog 唤醒后的 assistant 文本，便于复盘
  if (j.type === 'message_end' && j.message?.role === 'assistant') {
    const text = (j.message.content || []).filter(x => x.type === 'text').map(x => x.text).join(' ').slice(0, 500);
    if (text) log('assistant:', text);
    return;
  }
  if (j.type === 'agent_settled') log('agent_settled');
}

function start() {
  if (stopping) return;
  log(`拉起 pi --mode rpc (stage=${STAGE}, enableWs=1, kickoff=${KICKOFF})`);
  child = spawn(PI, ['--mode', 'rpc', '--offline', '--no-session', '--approve'], {
    cwd: ROOT,
    env: { ...process.env, TL_STAGE: STAGE, TL_ENABLE_WS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buf = '';
  child.stdout.on('data', d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      try { handleRecord(line); } catch (e) { log('handleRecord 异常', e?.message); }
    }
  });
  child.stderr.on('data', d => {
    const s = d.toString('utf8').trim();
    if (s) { try { fs.appendFileSync(LOG, s + '\n'); } catch { } }
  });
  child.on('error', e => log('spawn error', e?.message));
  child.on('exit', (code, sig) => {
    log(`pi 退出 code=${code} sig=${sig}`);
    child = null;
    if (stopping) return;
    const delay = RESTART_DELAYS[Math.min(attempt, RESTART_DELAYS.length - 1)];
    attempt++;
    log(`${delay / 1000}s 后重启 pi（第 ${attempt} 次）`);
    setTimeout(start, delay);
  });

  if (KICKOFF) {
    if (kickoffTimer) clearTimeout(kickoffTimer);
    kickoffTimer = setTimeout(() => {
      if (!child || stopping) return;
      log('发送启动巡检 prompt');
      send({
        id: `kickoff-${Date.now()}`,
        type: 'prompt',
        message: '开始一次标准巡检：先调用 bot_status_and_benchmark，然后只在有实测依据时执行 1 件最有价值的事。若连续两轮无实质变化，只回一行「无变化」。工具调用不超过 8 次。',
      });
    }, 15000);
  }
}

function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log('shutdown:', reason);
  if (kickoffTimer) clearTimeout(kickoffTimer);
  try { child?.stdin.end(); } catch { }
  setTimeout(() => {
    try { child?.kill('SIGTERM'); } catch { }
    try { fs.unlinkSync(PIDFILE); } catch { }
    process.exit(0);
  }, 8000).unref?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('exit', () => { try { fs.unlinkSync(PIDFILE); } catch { } });

start();
