// engine/watchdog.mjs —— 服务器恢复守护
//
// 用途：游戏服务器下线/域名解析失败时，引擎连不上。
// 这个守护每 N 分钟探一次，一旦恢复就自动拉起引擎。
//
// 探测顺序（由轻到重）：
//   1. DNS 能否解析 tl.jayczee.top
//   2. HTTPS 首页能否打开（200）
//   3. WebSocket 能否握手
//
// 只有三步都通过才启动引擎 —— 避免服务器半死不活时引擎疯狂重连。
//
// 用法：
//   node engine/watchdog.mjs            # 前台跑（调试）
//   nohup node engine/watchdog.mjs &    # 后台跑
//
// 环境变量：
//   TL_PROBE_URL   探测的 HTTPS 地址（默认 https://tl.jayczee.top:1212/）
//   TL_WS_URL      WS 地址（默认 wss://tl.jayczee.top:1212/ws）
//   TL_PROBE_MS    探测间隔毫秒（默认 5 分钟）
//   TL_ENGINE_SH   引擎启动脚本（默认 ./enginectl.sh）

import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import https from 'node:https';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOG = path.join(ROOT, 'logs', 'watchdog.log');
const ENGINE_PID = process.env.TL_ENGINE_PIDFILE || '/tmp/tlbot-engine.pid';

const HOST = process.env.TL_HOST || 'tl.jayczee.top';
const PORT = Number(process.env.TL_PORT_REMOTE || 1212);
const PROBE_URL = process.env.TL_PROBE_URL || `https://${HOST}:${PORT}/`;
const WS_URL = process.env.TL_WS_URL || `wss://${HOST}:${PORT}/ws`;
const PROBE_MS = Number(process.env.TL_PROBE_MS || 5 * 60_000);
const ENGINECTL = process.env.TL_ENGINECTL || path.join(ROOT, 'enginectl.sh');
const NODE = process.env.NODE || '/Applications/Alma.app/Contents/Resources/alma-server/runtime/node';

fs.mkdirSync(path.dirname(LOG), { recursive: true });
function log(...a) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ` + a.map(x =>
    typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  try { fs.appendFileSync(LOG, line + '\n'); } catch { }
  try { console.log(line); } catch { }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 探测 ───────────────────────────────────────────────────
// 用公共 DNS 查真实 IP —— 系统 DNS 在 fake-ip 模式下只会返回 198.18.x.x，
// 那个地址不能被当作「服务器可达」的证据（它永远解析得到）。
async function resolveRealIp() {
  try {
    const r = new dns.Resolver();
    r.setServers(['223.5.5.5', '119.29.29.29']);
    const addrs = await Promise.race([
      r.resolve4(HOST),
      sleep(10_000).then(() => { throw new Error('DNS 超时'); }),
    ]);
    const real = (addrs || []).filter(a => !a.startsWith('198.18.') && !a.startsWith('198.19.'));
    if (!real.length) return { ok: false, error: 'DNS: 只拿到 fake-ip' };
    return { ok: true, address: real[0] };
  } catch (e) {
    return { ok: false, error: `DNS: ${e.code || e.message}` };
  }
}

function probeHttp(ip) {
  return new Promise(resolve => {
    const t = Date.now();
    const opts = { rejectUnauthorized: false, timeout: 12_000, servername: HOST };
    if (ip) { opts.host = ip; opts.port = PORT; opts.path = '/'; }
    const req = ip
      ? https.get({ ...opts, headers: { Host: HOST } }, handle)
      : https.get(PROBE_URL, opts, handle);
    function handle(res) {
      res.resume();
      resolve({ ok: res.statusCode === 200, status: res.statusCode, ms: Date.now() - t });
    }
    req.on('error', e => resolve({ ok: false, error: `HTTP: ${e.code || e.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'HTTP 超时' }); });
  });
}

function probeWs(ip) {
  return new Promise(resolve => {
    const t = Date.now();
    let done = false;
    let ws = null;
    const finish = r => { if (done) return; done = true; try { ws?.close(); } catch { } resolve(r); };
    try { ws = new WebSocket(WS_URL); } catch (e) { return finish({ ok: false, error: `WS 构造失败: ${e.message}` }); }
    const timer = setTimeout(() => finish({ ok: false, error: 'WS 握手超时' }), 12_000);
    ws.onopen = () => { clearTimeout(timer); finish({ ok: true, ms: Date.now() - t }); };
    ws.onerror = e => { clearTimeout(timer); finish({ ok: false, error: `WS: ${e?.message || 'error'}` }); };
  });
}

async function probeAll() {
  const d = await resolveRealIp();
  if (!d.ok) return { ok: false, stage: 'dns', detail: d };

  // 用真实 IP 探测 HTTP（绕过 fake-ip，才能反映服务器真实状态）
  const h = await probeHttp(d.address);
  if (!h.ok) return { ok: false, stage: 'http', detail: h, dns: d };

  // WS 走真实 IP + SNI，与引擎实际连接方式一致
  const w = await probeWs(d.address);
  if (!w.ok) return { ok: false, stage: 'ws', detail: w, dns: d, http: h };
  return { ok: true, dns: d, http: h, ws: w };
}

// ── 引擎状态 ───────────────────────────────────────────────
function engineAlive() {
  try {
    if (!fs.existsSync(ENGINE_PID)) return null;
    const pid = Number(fs.readFileSync(ENGINE_PID, 'utf8').trim());
    if (!pid) return null;
    try { process.kill(pid, 0); return pid; } catch { return null; }
  } catch { return null; }
}

async function startEngine() {
  log('→ 启动引擎');
  return new Promise(resolve => {
    const child = spawn('sh', [ENGINECTL, 'start', '2'], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, NODE },
    });
    child.unref();
    setTimeout(() => {
      const pid = engineAlive();
      if (pid) log(`✓ 引擎已启动 pid=${pid}`);
      else log('❌ 引擎启动失败，看 logs/engine.out');
      resolve(!!pid);
    }, 15_000);
  });
}

// ── 主循环 ─────────────────────────────────────────────────
let failStreak = 0;
let lastState = null;

async function tick() {
  try {
    const pid = engineAlive();
    if (pid) {
      // 引擎在跑，只做轻量心跳，不重复启动
      if (lastState !== 'engine-running') {
        log(`引擎运行中 pid=${pid}，守护进入观察模式`);
        lastState = 'engine-running';
      }
      return;
    }

    const r = await probeAll();

    if (r.ok) {
      if (failStreak > 0) log(`✓ 服务器已恢复（之前连续失败 ${failStreak} 次）`);
      failStreak = 0;
      log(`服务器可用 dns=${r.dns.address} http=${r.http.status}(${r.http.ms}ms) ws=${r.ws.ms}ms`);
      await startEngine();
      lastState = 'starting';
    } else {
      failStreak++;
      // 只在状态变化或每 12 次（约 1 小时）记一次，避免刷屏
      const brief = `${r.stage}: ${r.detail?.error || r.detail?.status || '失败'}`;
      if (lastState !== brief || failStreak % 12 === 0) {
        log(`服务器不可用（第 ${failStreak} 次）${brief}`);
      }
      lastState = brief;
    }
  } catch (e) {
    log('守护异常:', e?.message || e);
  }
}

// PID 文件（供 enginectl.sh watch/unwatch 管理）
const WPID = process.env.TL_WATCHDOG_PIDFILE || '/tmp/tlbot-watchdog.pid';
try {
  if (fs.existsSync(WPID)) {
    const old = Number(fs.readFileSync(WPID, 'utf8').trim());
    if (old && old !== process.pid) {
      try { process.kill(old, 0); log(`已有守护在跑 pid=${old}，退出`); process.exit(0); } catch { }
    }
  }
  fs.writeFileSync(WPID, String(process.pid));
} catch { }
process.on('exit', () => {
  // 只删自己写的 pidfile —— 否则一个实例退出会把另一个实例的 pidfile 删掉
  try {
    const cur = fs.readFileSync(WPID, 'utf8').trim();
    if (Number(cur) === process.pid) fs.unlinkSync(WPID);
  } catch { }
});
process.on('SIGTERM', () => { log('收到 SIGTERM，退出'); process.exit(0); });
process.on('SIGINT', () => { log('收到 SIGINT，退出'); process.exit(0); });

log(`=== 服务器恢复守护启动 ===`);
log(`探测目标 ${PROBE_URL}`);
log(`间隔 ${Math.round(PROBE_MS / 60_000)} 分钟`);
tick();
setInterval(tick, PROBE_MS).unref();
