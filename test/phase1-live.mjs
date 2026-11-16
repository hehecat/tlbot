// test/phase1-live.mjs —— 阶段 1 实机接管挂机（会连接真实游戏 WS！）
//
// 前置：v5 已停、TL_ENABLE_WS=1、无 .halt
// 行为：启动 CombatDaemon 打 10027，直到完成 1 批（最多 TL_PHASE1_SECONDS 秒），
//       记录 XP/Gold/战力变化，然后 COMBAT_STOP 并关闭连接。
//
// 用法：
//   TL_ENABLE_WS=1 node test/phase1-live.mjs
//   TL_ENABLE_WS=1 TL_PHASE1_SECONDS=220 node test/phase1-live.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SUP_PID = '/tmp/tlbot-v5-supervisor.pid';
const OUT_DIR = path.join(ROOT, 'logs');
const DURATION = Number(process.env.TL_PHASE1_SECONDS || 220);

const fail = msg => { console.error('✖', msg); process.exit(1); };
if (process.env.TL_ENABLE_WS !== '1') fail('必须显式 TL_ENABLE_WS=1');
if (fs.existsSync(path.join(ROOT, '.halt'))) fail('存在 .halt');
if (fs.existsSync(SUP_PID) && process.env.TL_FORCE_WS !== '1') {
  fail(`检测到 v5 supervisor PID 文件 (${fs.readFileSync(SUP_PID, 'utf8').trim()})，先确认 v5 已停`);
}

const { createSession } = await import('../core/lib-ws.mjs');
const { initStore } = await import('../src/state-store.mjs');
const { CombatDaemon, isHalted } = await import('../src/combat-daemon.mjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mapId = Number(process.env.TL_MAP || 10027);

const out = {
  at: new Date().toISOString(), mapId, durationMaxSec: DURATION,
  ok: false, started: false, batches: 0, kills: 0,
  before: null, after: null, deltas: null,
  disconnect: false, halted: false, errors: [], ticks: [],
};

let ws = null, store = null, daemon = null;
try {
  ws = createSession();
  const g = await ws.open();
  store = initStore(ws);
  store.ingest(g);
  out.before = {
    level: g.role.level, exp: g.role.currentExp, gold: g.role.money,
    power: g.role.combatPower, mapId: g.role.mapId,
  };
  daemon = new CombatDaemon(ws, store, { log: m => console.log(m) });
  daemon.configure({ mapId });
  daemon.start();

  const t0 = Date.now();
  let maxKills = 0;
  while (Date.now() - t0 < DURATION * 1000) {
    await sleep(5000);
    const st = daemon.status();
    const snap = store.getSnapshot();
    const def = Number(snap.combat?.defeated || 0);
    maxKills = Math.max(maxKills, def, st.stats.lastBatch?.kills || 0);
    if (snap.combat?.stage === 'running' || snap.combat?.stage === 'preparing') out.started = true;
    if (isHalted()) { out.halted = true; break; }
    if (ws.state.closed) { out.disconnect = true; break; }
    const tick = {
      t: Math.round((Date.now() - t0) / 1000),
      stage: snap.combat?.stage, progress: snap.combat?.progress,
      batches: st.stats.batches, kills: maxKills,
      exp: snap.me?.exp, gold: snap.me?.gold, power: snap.me?.power,
      silentSec: snap.combat?.silentSec,
    };
    out.ticks.push(tick);
    console.log(`[${tick.t}s] stage=${tick.stage} ${tick.progress} batches=${tick.batches} kills=${tick.kills} exp=${tick.exp} power=${tick.power}`);
    if (st.stats.batches >= 1) break;
  }

  const st = daemon.status();
  out.batches = st.stats.batches;
  out.kills = maxKills;
  await daemon.stop();
  daemon = null;

  const g2 = await ws.req('ENTER_GAME', {}, { ms: 9000, revision: false }).catch(() => null);
  if (g2?.data?.role) {
    store.ingest(g2.data);
    out.after = {
      level: g2.data.role.level, exp: g2.data.role.currentExp, gold: g2.data.role.money,
      power: g2.data.role.combatPower, mapId: g2.data.role.mapId,
    };
    out.deltas = {
      exp: (out.after.exp ?? 0) - (out.before.exp ?? 0),
      gold: (out.after.gold ?? 0) - (out.before.gold ?? 0),
      power: (out.after.power ?? 0) - (out.before.power ?? 0),
      level: (out.after.level ?? 0) - (out.before.level ?? 0),
    };
  }
  out.ok = !out.disconnect && !out.halted && out.started && (out.batches >= 1 || out.kills > 0) && out.errors.length === 0;
} catch (e) {
  out.errors.push(e?.message || String(e));
} finally {
  try { await daemon?.stop?.(); } catch { }
  try { store?.close?.(); } catch { }
  try { ws?.close?.(); } catch { }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, `phase1-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(JSON.stringify({
  ok: out.ok, started: out.started, batches: out.batches, kills: out.kills,
  before: out.before, after: out.after, deltas: out.deltas,
  disconnect: out.disconnect, halted: out.halted, errors: out.errors, report: file,
}, null, 1));
process.exit(out.ok ? 0 : 1);
