// test/phase2-live.mjs —— 阶段 2 实机后勤（会写真实账号！）
//
// 前置：v5 已停、TL_ENABLE_WS=1、无 .halt
// 行为：跑一次 logistics.maintain()（补药/清仓/配装/商城/镶嵌/鉴定/珍兽/技能），
//       所有写操作过 core/redlines.mjs。输出前后战力/装备值/金币/经验。
//
// 用法：TL_ENABLE_WS=1 node test/phase2-live.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SUP_PID = '/tmp/tlbot-v5-supervisor.pid';
const OUT_DIR = path.join(ROOT, 'logs');

const fail = msg => { console.error('✖', msg); process.exit(1); };
if (process.env.TL_ENABLE_WS !== '1') fail('必须显式 TL_ENABLE_WS=1');
if (fs.existsSync(path.join(ROOT, '.halt'))) fail('存在 .halt');
if (fs.existsSync(SUP_PID) && process.env.TL_FORCE_WS !== '1') {
  fail(`检测到 v5 supervisor PID 文件 (${fs.readFileSync(SUP_PID, 'utf8').trim()})，先确认 v5 已停`);
}

const { createSession } = await import('../core/lib-ws.mjs');
const { initStore } = await import('../src/state-store.mjs');
const { createLogistics } = await import('../src/logistics.mjs');
const { itemValue } = await import('../core/lib-value.mjs');

function dumpEquip(g) {
  const all = g?.equipments || [];
  const eq = all.filter(x => x.isEquipped);
  const counts = {};
  for (const x of eq) { const sl = x.equipTmpl?.slotType; counts[sl] = (counts[sl] || 0) + 1; }
  return {
    equippedCount: eq.length,
    slotCounts: counts,
    multiSlots: Object.entries(counts).filter(([, n]) => n > 1).map(([sl]) => Number(sl)),
    equipped: eq.map(x => ({ id: x.id, slot: x.equipTmpl?.slotType, name: x.equipTmpl?.name, value: Math.round(itemValue(x)) }))
      .sort((a, b) => a.slot - b.slot),
  };
}

const out = { at: new Date().toISOString(), ok: false, before: null, after: null, deltas: null, report: null, errors: [] };
let ws = null, store = null;
try {
  ws = createSession();
  const g = await ws.open();
  store = initStore(ws);
  store.ingest(g);
  const eqs = (g.equipments || []).filter(x => x.isEquipped);
  out.before = {
    level: g.role.level, exp: g.role.currentExp, gold: g.role.money, power: g.role.combatPower,
    equipValue: Math.round(eqs.reduce((a, x) => a + itemValue(x), 0)),
    equips: eqs.length, bag: (g.bagItems || []).length,
    equipDetail: dumpEquip(g),
  };

  const logi = createLogistics(ws, store, { stage: 2, allowWrite: true, log: m => console.log(m) });
  const rep = await logi.maintain();
  out.report = rep;

  const g2 = await ws.req('ENTER_GAME', {}, { ms: 9000, revision: false });
  if (g2?.data?.role) {
    store.ingest(g2.data);
    const eqs2 = (g2.data.equipments || []).filter(x => x.isEquipped);
    out.after = {
      level: g2.data.role.level, exp: g2.data.role.currentExp, gold: g2.data.role.money, power: g2.data.role.combatPower,
      equipValue: Math.round(eqs2.reduce((a, x) => a + itemValue(x), 0)),
      equips: eqs2.length, bag: (g2.data.bagItems || []).length,
      equipDetail: dumpEquip(g2.data),
    };
    out.deltas = {
      exp: (out.after.exp ?? 0) - (out.before.exp ?? 0),
      gold: (out.after.gold ?? 0) - (out.before.gold ?? 0),
      power: (out.after.power ?? 0) - (out.before.power ?? 0),
      equipValue: (out.after.equipValue ?? 0) - (out.before.equipValue ?? 0),
      level: (out.after.level ?? 0) - (out.before.level ?? 0),
    };
  }
  out.ok = !ws.state.closed && !!out.after && out.errors.length === 0;
  out.errors.push(...(rep.errors || []));
} catch (e) {
  out.errors.push(e?.message || String(e));
} finally {
  try { store?.close?.(); } catch { }
  try { ws?.close(); } catch { }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, `phase2-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(JSON.stringify({
  ok: out.ok, before: out.before, after: out.after, deltas: out.deltas,
  actions: out.report?.actions?.length ?? 0,
  blocked: out.report?.blocked ?? [],
  errors: out.errors, report: file,
}, null, 1));
process.exit(out.ok ? 0 : 1);
