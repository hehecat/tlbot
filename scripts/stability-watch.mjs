// scripts/stability-watch.mjs —— 1-2 小时稳定性复测看门狗
//
// 通过：跑满 TL_WATCH_MINUTES，写 logs/stability-pass-*.json，host 保持运行。
// 失败：停 host → 启动 v5 supervisor，写 logs/stability-fail-*.json。
//
// 失败判据：
//   · host 进程消失 > 2 分钟
//   · 日志 15 分钟没有任何新行（卡死）
//   · WS 断开后 5 分钟没有重连成功
//   · 战力相对基线下跌 > 5%（10 分钟宽限后）
//   · 连续 3 次后勤 errors>0
//
// 用法：nohup node scripts/stability-watch.mjs >> logs/stability-watch.out 2>&1 &

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const OLD = path.resolve(ROOT, '..', 'tlbot');
const NODE = process.env.NODE || '/Applications/Alma.app/Contents/Resources/alma-server/runtime/node';
const HOST_PID = '/tmp/tlbot-pi-host.pid';
const V5_PID = '/tmp/tlbot-v5-supervisor.pid';
const EXT_LOG = path.join(ROOT, 'logs', 'extension.log');
const HOST_LOG = path.join(ROOT, 'logs', 'host.log');
const WATCH_LOG = path.join(ROOT, 'logs', 'stability-watch.log');

const MINUTES = Number(process.env.TL_WATCH_MINUTES || 90);
const INTERVAL = Number(process.env.TL_WATCH_INTERVAL_MS || 30_000);
const POWER_DROP = Number(process.env.TL_WATCH_POWER_DROP || 0.05);
const NO_LOG_MIN = Number(process.env.TL_WATCH_NO_LOG_MIN || 15);
const DISCONNECT_MIN = Number(process.env.TL_WATCH_DISCONNECT_MIN || 5);
const HOST_DOWN_MIN = Number(process.env.TL_WATCH_HOST_DOWN_MIN || 2);
const GRACE_MS = Number(process.env.TL_WATCH_GRACE_MIN || 10) * 60_000;

const startAt = Date.now();
const deadline = startAt + MINUTES * 60_000;
let extOffset = 0;
try { extOffset = fs.statSync(EXT_LOG).size; } catch { }

const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] [watch] ` + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  try { fs.appendFileSync(WATCH_LOG, line + '\n'); } catch { }
  console.log(line);
};

const pidAlive = (file) => {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
};

let lastLogAt = Date.now();
let lastHeartbeatAt = 0;
let lastDisconnectAt = 0;
let lastReconnectAt = 0;
let baselinePower = 0;
let currentPower = 0;
let consecutiveMaintErrors = 0;
let hostDownSince = 0;
let failed = false;
let totalBatches = 0;
let totalReconnects = 0;
let totalDisconnects = 0;

function readNew(file, offset) {
  try {
    const st = fs.statSync(file);
    if (st.size <= offset) return { text: '', offset: st.size };
    const fd = fs.openSync(file, 'r');
    const len = st.size - offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    fs.closeSync(fd);
    return { text: buf.toString('utf8'), offset: st.size };
  } catch { return { text: '', offset }; }
}

function fail(reason, extra = {}) {
  if (failed) return;
  failed = true;
  log('FAIL:', reason);
  const tail = (() => { try { return fs.readFileSync(EXT_LOG, 'utf8').slice(-4000); } catch { return ''; } })();
  const out = {
    at: new Date().toISOString(), result: 'FAIL', reason,
    elapsedMin: Number(((Date.now() - startAt) / 60000).toFixed(1)),
    baselinePower, currentPower, totalBatches, totalReconnects, totalDisconnects,
    extra, recentLog: tail,
  };
  try { fs.writeFileSync(path.join(ROOT, 'logs', `stability-fail-${Date.now()}.json`), JSON.stringify(out, null, 1)); } catch { }

  // 停 host（用 hostctl，内部用 node process.kill，不走 shell kill）
  try { spawnSync('sh', ['scripts/hostctl.sh', 'stop'], { cwd: ROOT, timeout: 30_000, stdio: 'ignore' }); } catch { }
  // 等 host 退出
  const t0 = Date.now();
  while (pidAlive(HOST_PID) && Date.now() - t0 < 20_000) {
    try { spawnSync('sleep', ['1']); } catch { }
  }
  // 启动 v5
  try {
    fs.rmSync(path.join(OLD, '.halt'), { force: true });
    const child = spawn('/bin/sh', ['./supervise_v5.sh'], { cwd: OLD, detached: true, stdio: 'ignore' });
    child.unref();
    log('已启动 v5 supervisor');
  } catch (e) { log('启动 v5 失败', e?.message || String(e)); }
  process.exit(1);
}

function pass() {
  const out = {
    at: new Date().toISOString(), result: 'PASS',
    elapsedMin: Number(((Date.now() - startAt) / 60000).toFixed(1)),
    baselinePower, currentPower, totalBatches, totalReconnects, totalDisconnects,
  };
  try { fs.writeFileSync(path.join(ROOT, 'logs', `stability-pass-${Date.now()}.json`), JSON.stringify(out, null, 1)); } catch { }
  log('PASS', out);
  process.exit(0);
}

log(`开始：${MINUTES} 分钟，interval=${INTERVAL}ms，baselinePower=${baselinePower || '待首帧'}`);

const timer = setInterval(() => {
  const now = Date.now();

  // host 存活
  if (!pidAlive(HOST_PID)) {
    if (!hostDownSince) hostDownSince = now;
    if (now - hostDownSince > HOST_DOWN_MIN * 60_000) return fail(`host 进程消失超过 ${HOST_DOWN_MIN} 分钟`);
  } else hostDownSince = 0;

  // 读 extension 新日志
  const r = readNew(EXT_LOG, extOffset);
  extOffset = r.offset;
  if (r.text.trim()) {
    lastLogAt = now;
    for (const line of r.text.split('\n')) {
      if (!line.trim()) continue;
      if (/WS 已断开/.test(line)) { totalDisconnects++; lastDisconnectAt = now; }
      if (/WS 已重连|WS 已连接/.test(line)) { totalReconnects++; lastReconnectAt = now; }
      if (/第\d+批 打满/.test(line)) totalBatches++;
      const hb = line.match(/♥.*战力=(\d+)/);
      if (hb) {
        lastHeartbeatAt = now;
        currentPower = Number(hb[1]);
        if (!baselinePower) {
          baselinePower = currentPower;
          log(`基线战力 ${baselinePower}`);
        }
      }
      if (/\[sched\] 后勤完成/.test(line)) {
        const m = line.match(/errors=(\d+)/);
        const errs = m ? Number(m[1]) : 0;
        consecutiveMaintErrors = errs > 0 ? consecutiveMaintErrors + 1 : 0;
        if (consecutiveMaintErrors >= 3) return fail('连续 3 次后勤 errors>0');
      }
    }
  }

  // 卡死：日志 15 分钟无新行
  if (now - lastLogAt > NO_LOG_MIN * 60_000) return fail(`${NO_LOG_MIN} 分钟日志无新行`);

  // 断连未恢复
  if (lastDisconnectAt > lastReconnectAt && now - lastDisconnectAt > DISCONNECT_MIN * 60_000) {
    return fail(`WS 断开后 ${DISCONNECT_MIN} 分钟未重连`);
  }

  // 战力回撤（10 分钟宽限）
  if (baselinePower && currentPower && now - startAt > GRACE_MS) {
    const drop = (baselinePower - currentPower) / baselinePower;
    if (drop > POWER_DROP) return fail(`战力回撤 ${(drop * 100).toFixed(1)}% (${baselinePower} -> ${currentPower})`);
  }

  if (now >= deadline) return pass();
}, INTERVAL);

process.on('SIGTERM', () => { clearInterval(timer); log('watch 收到 SIGTERM，退出（不改变 host）'); process.exit(0); });
process.on('SIGINT', () => { clearInterval(timer); log('watch 收到 SIGINT，退出（不改变 host）'); process.exit(0); });
