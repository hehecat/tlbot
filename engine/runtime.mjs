// engine/runtime.mjs —— 挂机引擎（纯 node，不依赖任何 agent）
//
// 设计原则：
//   · 唯一 WS 持有者。所有业务模块共享同一个 ws 实例。
//   · 战斗 / 后勤 / 副本 / 日常全部在 Node 内存里跑，零 LLM 调用。
//   · 对外只暴露 actions + 状态查询，通过 HTTP 给任意 agent 遥控。
//   · agent 死了不影响挂机；挂机崩了由 supervisor 拉起。
//
// 用法：
//   TL_STAGE=2 node engine/runtime.mjs
//
// 环境变量：
//   TL_STAGE        0=只读 1=接管战斗 2=全量（默认 2）
//   TL_MAP          挂机地图（默认 10027）
//   TL_PORT         HTTP 端口（默认 9527，0 = 不开）
//   TL_MAINT_MS     后勤间隔毫秒（默认 30 分钟）
//   TL_AUTOPILOT    off = 只跑循环不自动日常

import fs from 'node:fs';
import path from 'node:path';
import { createSession } from '../core/lib-ws.mjs';
import { initStore } from '../src/state-store.mjs';
import { CombatDaemon, isHalted } from '../src/combat-daemon.mjs';
import { createLogistics } from '../src/logistics.mjs';
import { createActivities } from '../src/activities.mjs';
import { decideActions, loadState as loadSched, saveState as saveSched, dateKey } from '../src/scheduler.mjs';
import { scanAllSlots, bestInSlot, clearCache as clearEvalCache } from '../src/evaluate.mjs';
import * as gamedata from './gamedata.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
export const HALT_FILE = path.join(ROOT, '.halt');

const STAGE = Number(process.env.TL_STAGE ?? 2);
const AUTOPILOT = String(process.env.TL_AUTOPILOT ?? 'on').toLowerCase() !== 'off';
const PORT = Number(process.env.TL_PORT ?? 9527);
const MAINT_MS = Number(process.env.TL_MAINT_MS || 30 * 60_000);
const DAILY_HOUR = Number(process.env.TL_DAILY_HOUR ?? 0);
const DAILY_MINUTE = Number(process.env.TL_DAILY_MINUTE ?? 5);

const LOG_FILE = path.join(ROOT, 'logs', 'engine.log');
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

function log(...a) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ` + a.map(x =>
    typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { }
  try { console.log(line); } catch { }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 运行时状态 ─────────────────────────────────────────────
const state = {
  startedAt: new Date().toISOString(),
  ws: null, store: null, daemon: null, logistics: null, activities: null,
  schedState: loadSched(),
  schedBusy: false,
  lastMaintainAt: 0,
  lastDailyKey: '',
  pausedBySystem: false,
  lastAliveAt: Date.now(),
};

// ── 连接管理 ───────────────────────────────────────────────
async function connect() {
  const ws = createSession({ trace: false });
  let g = null;
  await ws.open();

  // ENTER_GAME 首帧经常没有 role（会话还在服务端注册），重试几次
  for (let i = 0; i < 6; i++) {
    if (i) await sleep(1500);
    try {
      const r = await ws.req('ENTER_GAME', {}, { ms: 14000, revision: false });
      g = r?.data;
      if (g?.role) break;
    } catch (e) {
      log(`ENTER_GAME 第 ${i + 1} 次失败: ${e?.message || e}`);
    }
  }
  if (!g?.role) throw new Error('ENTER_GAME 始终无 role');

  const store = initStore(ws);
  store.ingest(g);
  log(`✓ 已登录 ${g.role.nickname || g.role.id} Lv.${g.role.level} 战力 ${g.role.combatPower}`);

  // 自动同步游戏元数据：地图/套装/商城/技能/数值常量
  // 游戏更新后这里会自动发现差异并记录，不需要人工维护写死的表
  try {
    const r = gamedata.sync(g, log);
    state.gamedata = r?.meta || null;
    state.gamedataChanges = r?.changes || [];
  } catch (e) {
    log('[gamedata] 同步失败:', e?.message || e);
  }

  return { ws, store, game: g };
}

// ── 重新组装服务（换 ws 后所有模块要跟着换）────────────────
async function rebuild() {
  // 2026-11-16 修：原来直接覆盖 state.daemon，旧的 daemon 实例还活在自己的
  // loop + 心跳里，随着每次重连不断堆积（实测 57 个 start、722 条心跳日志、
  // 批次号在不同地图间乱跳）。重建前必须先彻底停掉旧实例。
  if (state.daemon) {
    try {
      state.daemon.stop?.();
      log('[engine] 旧 daemon 已停止');
    } catch (e) { log('[engine] 停旧 daemon 失败:', e?.message || e); }
    // 给旧循环一点时间退出，避免它用已关闭的 ws 继续发包
    await sleep(300);
  }

  const { ws, store, game } = await connect();

  state.ws = ws;
  state.store = store;
  state.connectedAt = Date.now();

  state.daemon = new CombatDaemon(ws, store, {
    log,
    defaultMapId: Number(process.env.TL_MAP || 10027),
    reconnect: async () => { await reconnect('batch'); },
  });

  state.logistics = createLogistics(ws, store, {
    log, stage: STAGE, allowWrite: STAGE >= 2,
  });

  state.activities = createActivities(ws, store, {
    log, stage: STAGE, allowWrite: STAGE >= 2,
  });

  state.game = game;
  return game;
}

let reconnectPromise = null;
async function reconnect(reason = 'manual') {
  if (reconnectPromise) return reconnectPromise;
  reconnectPromise = (async () => {
    log(`重连（原因：${reason}）`);
    try { state.store?.close?.(); } catch { }
    try { state.ws?.close?.(); } catch { }
    await sleep(2500);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const g = await rebuild();
        log(`✓ 重连成功（第 ${attempt + 1} 次尝试）`);
        // 重连后恢复战斗
        if (state.daemon && !isHalted()) {
          state.daemon.start();
          log('战斗循环已恢复');
        }
        return g;
      } catch (e) {
        log(`重连失败（第 ${attempt + 1} 次）: ${e?.message || e}`);
        await sleep(3000 * (attempt + 1));
      }
    }
    log('❌ 重连彻底失败，60 秒后重试');
    setTimeout(() => { reconnectPromise = null; reconnect('retry-after-fail').catch(() => { }); }, 60_000);
  })().finally(() => { reconnectPromise = null; });
  return reconnectPromise;
}

// ── 后勤 / 日常（纯 JS，零 token）──────────────────────────
async function runMaintain() {
  if (state.schedBusy || isHalted() || !state.logistics) return null;
  state.schedBusy = true;
  const wasRunning = state.daemon?.running;
  try {
    if (wasRunning) { state.daemon.pause('activity'); await state.daemon.whenIdle?.(20_000); }
    const rep = await state.logistics.maintain();
    state.lastMaintainAt = Date.now();
    state.schedState.lastMaintainAt = state.lastMaintainAt;
    saveSched(state.schedState);
    log(`[maint] 完成 actions=${rep?.actions?.length || 0} errors=${rep?.errors?.length || 0} power=${rep?.after?.power ?? '?'}`);
    return rep;
  } catch (e) {
    log(`[maint] 异常: ${e?.message || e}`);
    return null;
  } finally {
    if (wasRunning) state.daemon?.resume?.();
    state.schedBusy = false;
  }
}

async function runDaily() {
  if (state.schedBusy || isHalted() || !state.activities) return null;
  state.schedBusy = true;
  const wasRunning = state.daemon?.running;
  try {
    if (wasRunning) { state.daemon.pause('activity'); await state.daemon.whenIdle?.(20_000); }
    const res = await state.activities.dailyTasks();
    state.schedState.lastDailyKey = dateKey(Date.now());
    saveSched(state.schedState);
    log(`[daily] 完成 ${res?.activities?.length || 0} 项`);
    return res;
  } catch (e) {
    log(`[daily] 异常: ${e?.message || e}`);
    return null;
  } finally {
    if (wasRunning) state.daemon?.resume?.();
    state.schedBusy = false;
  }
}

// ── 主循环调度（纯 JS）────────────────────────────────────
setInterval(async () => {
  if (STAGE < 2 || !AUTOPILOT || isHalted()) return;
  if (!state.store || state.ws?.state?.closed) return;
  if (state.schedBusy) return;
  try {
    const actions = decideActions(state.schedState, Date.now(), {
      maintenanceMs: MAINT_MS, dailyHour: DAILY_HOUR, dailyMinute: DAILY_MINUTE,
    });
    for (const a of actions) {
      if (a === 'maintain') await runMaintain();
      else if (a === 'daily') await runDaily();
    }
  } catch (e) { log(`[sched] 异常: ${e?.message || e}`); }
}, 60_000).unref?.();

// ── .halt 监听（5 秒内安静）────────────────────────────────
let haltLatched = false;
setInterval(() => {
  const h = isHalted();
  if (h && !haltLatched) {
    haltLatched = true;
    log('.halt 检测到 → 暂停一切主动发包');
    try { state.daemon?.pause?.('halt'); } catch { }
    try { state.ws?.send?.('COMBAT_STOP'); } catch { }
  } else if (!h && haltLatched) {
    haltLatched = false;
    log('.halt 已移除 → 恢复');
    try { state.daemon?.start?.(); } catch { }
  }
}, 1000).unref?.();

// ── 自愈看门狗（daemon 停摆超 3 分钟就拉起）────────────────
setInterval(() => {
  try {
    if (STAGE < 1 || isHalted()) return;
    const c = state.store?.getSnapshot?.()?.combat || {};
    const fresh = c.lastStateAt && (Date.now() - Date.parse(c.lastStateAt) < 90_000);
    const progressing = c.stage === 'running' || c.stage === 'preparing';

    if (progressing && fresh) { state.lastAliveAt = Date.now(); return; }

    const deadFor = Date.now() - state.lastAliveAt;
    if (!state.daemon?.running && deadFor > 180_000) {
      log(`⏰ daemon 停摆 ${Math.round(deadFor / 1000)}s → 自愈启动`);
      state.daemon?.start?.();
      state.lastAliveAt = Date.now();
      return;
    }
    // 连接断了但 daemon 以为自己在跑
    if (state.ws?.state?.closed && deadFor > 90_000) {
      log(`⏰ 连接已断 ${Math.round(deadFor / 1000)}s → 强制重连`);
      reconnect('watchdog').catch(() => { });
      state.lastAliveAt = Date.now();
    }
  } catch { }
}, 60_000).unref?.();

// ── 状态落盘 ───────────────────────────────────────────────
const STATUS_FILE = path.join(ROOT, 'tl_status.json');
setInterval(() => {
  try {
    if (!state.store) return;
    const snap = state.store.getSnapshot();
    const ds = state.daemon?.status?.() || null;
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      at: new Date().toISOString(),
      engine: 'standalone',
      stage: STAGE,
      autopilot: AUTOPILOT,
      halted: isHalted(),
      ws: { closed: !!state.ws?.state?.closed, connectedAt: state.connectedAt },
      daemon: ds,
      me: snap.me,
      combat: snap.combat,
      rates: snap.rates,
      pets: snap.pets,
      health: { unknown: snap.health?.unknown, packets: snap.health?.packets, stalled: snap.health?.stalled },
      sched: { lastMaintainAt: state.lastMaintainAt, lastDailyKey: state.schedState.lastDailyKey, busy: state.schedBusy },
    }, null, 1));
  } catch { }
}, 30_000).unref?.();

// ── 导出给 HTTP 层用 ────────────────────────────────────────
export const engine = {
  state, log, sleep,
  get game() { return state.game; },
  async refresh() {
    const r = await state.ws.req('ENTER_GAME', {}, { ms: 14000, revision: false });
    const d = r?.data;
    if (d?.role) {
      state.game = d;
      state.store?.ingest?.(d);
      // 每次全量刷新都顺带核对元数据（游戏热更新也能被发现）
      try {
        const gd = gamedata.sync(d, log);
        state.gamedata = gd?.meta || state.gamedata;
        if (gd?.changes?.length) state.gamedataChanges = gd.changes;
      } catch { }
    }
    return d;
  },
  gamedata,
  maintain: runMaintain,
  daily: runDaily,
  reconnect,
  evaluate: { scanAllSlots, bestInSlot, clearCache: clearEvalCache },
};

// ── PID 文件（供 enginectl.sh 判断）────────────────────────
const PIDFILE = process.env.TL_ENGINE_PIDFILE || '/tmp/tlbot-engine.pid';
function writePid() {
  try {
    // 单实例：已有活着的 engine 就退出
    if (fs.existsSync(PIDFILE)) {
      const old = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
      if (old && old !== process.pid) {
        try { process.kill(old, 0); log(`已有 engine 在跑 pid=${old}，退出`); process.exit(0); } catch { }
      }
    }
    fs.writeFileSync(PIDFILE, String(process.pid));
  } catch (e) { log('写 pidfile 失败:', e?.message); }
}
function cleanPid() {
  try {
    const cur = fs.readFileSync(PIDFILE, 'utf8').trim();
    if (Number(cur) === process.pid) fs.unlinkSync(PIDFILE);
  } catch { }
}
process.on('exit', cleanPid);
process.on('SIGTERM', () => { log('收到 SIGTERM，退出'); cleanPid(); process.exit(0); });
process.on('SIGINT', () => { log('收到 SIGINT，退出'); cleanPid(); process.exit(0); });

// ── 启动 ───────────────────────────────────────────────────
export async function boot() {
  writePid();
  log(`=== engine 启动 stage=${STAGE} map=${process.env.TL_MAP || 10027} ===`);
  await rebuild();
  if (STAGE >= 1 && !isHalted()) {
    state.daemon.start();
    log('战斗循环已启动');
  }
  return engine;
}

// 直接运行才 boot
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  boot()
    .then(() => {
      if (PORT > 0) {
        import('./http.mjs').then(m => m.startHttp(engine, PORT));
      }
    })
    .catch(e => { log('❌ 启动失败:', e?.message || e); process.exit(1); });
}
