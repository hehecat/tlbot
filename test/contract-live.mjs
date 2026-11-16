// test/contract-live.mjs —— 实机验证：地图缓存 / 目标解析 / 任务契约 / 批次间重连
//
// 前置：v5 已停、TL_ENABLE_WS=1、无 .halt、无 v5 supervisor PID 文件
// 用法：TL_ENABLE_WS=1 node test/contract-live.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SUP_PID = '/tmp/tlbot-v5-supervisor.pid';
const fail = msg => { console.error('✖', msg); process.exit(1); };
if (process.env.TL_ENABLE_WS !== '1') fail('必须显式 TL_ENABLE_WS=1');
if (fs.existsSync(path.join(ROOT, '.halt'))) fail('存在 .halt');
if (fs.existsSync(SUP_PID) && process.env.TL_FORCE_WS !== '1') fail('检测到 v5 supervisor PID 文件');

const { createSession } = await import('../core/lib-ws.mjs');
const { initStore } = await import('../src/state-store.mjs');
const { CombatDaemon } = await import('../src/combat-daemon.mjs');
const { resolveTarget } = await import('../src/resolver.mjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = { at: new Date().toISOString(), ok: false, maps: 0, resolver: {}, contract: null, errors: [] };

let ws = null, store = null, daemon = null;
try {
  ws = createSession();
  const g = await ws.open();
  store = initStore(ws);
  store.ingest(g);

  // 1) 地图缓存
  if (Array.isArray(g.maps) && g.maps.length) {
    const byName = {};
    for (const m of g.maps) if (m?.name && m.id != null) byName[m.name] = m.id;
    fs.writeFileSync(path.join(ROOT, 'data', 'maps.json'), JSON.stringify(byName, null, 1));
    out.maps = Object.keys(byName).length;
  }

  // 2) 目标解析（真实数据）
  for (const t of ['神龙', '强化精华']) {
    const r = resolveTarget(t, g);
    out.resolver[t] = {
      ok: r.ok, missing: r.missing.length, farm: r.farm.length, unknown: r.unknown.length,
      primary: r.primaryFarm,
    };
  }

  // 3) 任务契约 + 批次间重连
  let ended = null;
  const ctx = { ws, store, daemon: null, reconnects: 0 };
  const reconnect = async () => {
    try { ctx.store?.close?.(); } catch { }
    try { ctx.ws?.close(); } catch { }
    await sleep(800);
    const nws = createSession();
    const ng = await nws.open();
    const nstore = initStore(nws);
    nstore.ingest(ng);
    ctx.ws = nws; ctx.store = nstore;
    if (ctx.daemon) { ctx.daemon.ws = nws; ctx.daemon.store = nstore; ctx.daemon.sessionAt = Date.now(); }
    ctx.reconnects++;
  };
  daemon = new CombatDaemon(ctx.ws, ctx.store, {
    log: m => console.log(m),
    maxSessionMs: 120_000,
    reconnect,
    onContractEnd: (c, r) => { ended = { c, r }; },
  });
  ctx.daemon = daemon;
  const exp0 = g.role.currentExp;
  daemon.startContract({
    target: '实机契约测试：10027 打 2.5 分钟',
    mapId: 10027,
    stopWhen: {},
    maxMinutes: 2.5,
    maxDeaths: 3,
    maxGoldSpend: 0,
  });
  const t0 = Date.now();
  while (!ended && Date.now() - t0 < 220_000) await sleep(2000);
  await daemon.stop();
  const snap = store.getSnapshot();
  out.contract = {
    ended: ended ? ended.r.reason : '超时未结束',
    batches: daemon.stats.batches,
    kills: daemon.stats.kills,
    reconnects: ctx.reconnects,
    expGain: (snap.me?.exp ?? 0) - (exp0 ?? 0),
    power: snap.me?.power,
    disconnect: false,
  };
  out.ok = !!ended && ctx.reconnects >= 1 && daemon.stats.batches >= 1;
} catch (e) {
  out.errors.push(e?.message || String(e));
} finally {
  try { await daemon?.stop?.(); } catch { }
  try { store?.close?.(); } catch { }
  try { ws?.close(); } catch { }
}

fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
const file = path.join(ROOT, 'logs', `contract-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, report: file }, null, 1));
process.exit(out.ok ? 0 : 1);
