// test/gap-live.mjs —— 榜一差距拆解（只读，会连真实 WS）
//
// 用法：TL_ENABLE_WS=1 node test/gap-live.mjs
// 前提：v5 已停、无 .halt、无 v5 supervisor PID 文件
//
// 输出：logs/gap-<timestamp>.json + 终端摘要

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const SUP_PID = '/tmp/tlbot-v5-supervisor.pid';
const fail = msg => { console.error('✖', msg); process.exit(1); };
if (process.env.TL_ENABLE_WS !== '1') fail('必须显式 TL_ENABLE_WS=1');
if (fs.existsSync(path.join(ROOT, '.halt'))) fail('存在 .halt');
if (fs.existsSync(SUP_PID) && process.env.TL_FORCE_WS !== '1') fail('检测到 v5 supervisor PID 文件');

const { createSession } = await import('../core/lib-ws.mjs');
const { itemValue, analyzeSets } = await import('../core/lib-value.mjs');
const { computePower } = await import('../core/lib-power.mjs');

const statSum = s => { let n = 0; try { for (const v of Object.values(JSON.parse(s || '{}'))) if (typeof v === 'number') n += v; } catch { } return n; };
const gemCount = x => { try { return JSON.parse(x.gemSlots || '[]').filter(v => v > 0).length; } catch { return 0; } };
const parse = s => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

function summarize(g, label) {
  const r = g.role || {};
  const all = g.equipments || [];
  const eq = all.filter(x => x.isEquipped);
  const bySlot = {};
  for (const x of eq) (bySlot[x.equipTmpl?.slotType] ||= []).push(x);
  const sets = analyzeSets(eq, g.equipSets || []);
  const petView = g.petView || g.pets || null;
  const pets = petView?.pets || [];
  const activePet = pets.find(p => p.pet?.id === petView?.activePetId) || null;
  const bestPet = [...pets].sort((a, b) => (b.combatPower || 0) - (a.combatPower || 0))[0] || null;
  let cp = null;
  try { cp = computePower(g); } catch { }
  return {
    label,
    nickname: r.nickname, level: r.level, power: r.combatPower,
    equipCount: eq.length,
    equipValue: Math.round(eq.reduce((a, x) => a + itemValue(x), 0)),
    stars: eq.reduce((a, x) => a + (x.starLevel || 0), 0),
    enhance: eq.reduce((a, x) => a + (x.enhanceLevel || 0), 0),
    gems: eq.reduce((a, x) => a + gemCount(x), 0),
    quality: (() => { const q = {}; eq.forEach(x => { const v = Number(x.quality ?? 1); q[v] = (q[v] || 0) + 1; }); return q; })(),
    reqAvg: eq.length ? Number((eq.reduce((a, x) => a + (x.equipTmpl?.reqLevel || 0), 0) / eq.length).toFixed(1)) : null,
    sets: sets.filter(s => s.have >= 2).map(s => ({ name: s.name, have: s.have, total: s.total, allAtk: s.allAtk })),
    slots: Object.entries(bySlot).map(([slot, arr]) => ({
      slot: Number(slot),
      items: arr.map(x => ({
        name: x.equipTmpl?.name, req: x.equipTmpl?.reqLevel, quality: x.quality,
        star: x.starLevel || 0, enhance: x.enhanceLevel || 0, gems: gemCount(x),
        value: Math.round(itemValue(x)), baseStats: x.equipTmpl?.baseStats, extraStats: x.extraStats,
      })),
    })).sort((a, b) => a.slot - b.slot),
    pets: {
      count: pets.length,
      activePetId: petView?.activePetId,
      active: activePet ? {
        name: activePet.speciesName, form: activePet.pet?.form, level: activePet.pet?.level,
        average: activePet.average, cp: activePet.combatPower, skills: activePet.pet?.skills,
      } : null,
      best: bestPet ? {
        name: bestPet.speciesName, form: bestPet.pet?.form, level: bestPet.pet?.level,
        average: bestPet.average, cp: bestPet.combatPower, skills: bestPet.pet?.skills,
      } : null,
      list: pets.map(p => ({ name: p.speciesName, form: p.pet?.form, lv: p.pet?.level, avg: p.average, cp: p.combatPower })),
    },
    skills: (g.skills || []).map(s => ({ name: s.skillDetail?.name, lv: s.currentLevel, max: s.skillDetail?.maxLevel, type: s.skillDetail?.type })),
    attrSum: eq.reduce((a, x) => a + statSum(x.equipTmpl?.baseStats) + statSum(x.extraStats), 0),
    computedPower: cp?.power ?? null,
    computedAttrs: cp?.attrs ?? null,
  };
}

const ws = createSession();
let out = { at: new Date().toISOString(), ok: false, error: null, me: null, top1: null, top2: null, gap: null, leaderboard: null };
try {
  const g = await ws.open();
  out.me = summarize(g, 'me');
  const lb = await ws.req('GET_LEADERBOARD', {}, { ms: 9000 });
  const arr = Array.isArray(lb?.data) ? lb.data : (lb?.data?.list || []);
  const sorted = arr.slice().sort((a, b) => (b.combatPower || 0) - (a.combatPower || 0));
  out.leaderboard = sorted.map((x, i) => ({ rank: i + 1, name: x.nickname, level: x.level, power: x.combatPower, roleId: x.roleId }));
  const top1 = sorted[0], top2 = sorted[1];
  const meRow = sorted.find(x => x.nickname === out.me.nickname) || null;
  const fetchInfo = async row => {
    if (!row?.roleId) return null;
    const r = await ws.req('GET_PLAYER_INFO', { roleId: row.roleId }, { ms: 10000 });
    return r?.data ? summarize(r.data, row.nickname) : null;
  };
  out.top1 = await fetchInfo(top1);
  out.top2 = await fetchInfo(top2);

  const mePower = out.me.power ?? meRow?.combatPower ?? 0;
  const t1 = out.top1;
  out.gap = {
    power: (t1?.power ?? top1.combatPower) - mePower,
    level: (t1?.level ?? top1.level) - out.me.level,
    equipCount: (t1?.equipCount ?? 0) - out.me.equipCount,
    equipValue: (t1?.equipValue ?? 0) - out.me.equipValue,
    stars: (t1?.stars ?? 0) - out.me.stars,
    enhance: (t1?.enhance ?? 0) - out.me.enhance,
    gems: (t1?.gems ?? 0) - out.me.gems,
    attrSum: (t1?.attrSum ?? 0) - out.me.attrSum,
    activePetCp: (t1?.pets?.active?.cp ?? 0) - (out.me.pets?.active?.cp ?? 0),
    bestPetAverage: (t1?.pets?.best?.average ?? 0) - (out.me.pets?.best?.average ?? 0),
    meRank: meRow ? sorted.indexOf(meRow) + 1 : null,
    top1Name: top1.nickname,
    top1Power: top1.combatPower,
    mePower,
  };
  out.ok = !!out.top1;
} catch (e) {
  out.error = e?.message || String(e);
} finally {
  try { ws.close(); } catch { }
}

fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
const file = path.join(ROOT, 'logs', `gap-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));

const fmtSlot = s => s.items.map(x => `${x.name}(q${x.quality} ★${x.star} +${x.enhance} 宝石${x.gems} 值${x.value})`).join(' / ');
console.log(JSON.stringify({ ok: out.ok, error: out.error, gap: out.gap, report: file }, null, 1));
if (out.me) {
  console.log('\n=== 我 ===');
  console.log(`Lv.${out.me.level} 战力 ${out.me.power} 装备值 ${out.me.equipValue} 件${out.me.equipCount} 星${out.me.stars} 强${out.me.enhance} 宝石${out.me.gems}`);
  for (const s of out.me.slots) console.log(`  slot${s.slot}: ${fmtSlot(s)}`);
  console.log(`  出战珍兽: ${JSON.stringify(out.me.pets?.active)}`);
  console.log(`  套装: ${JSON.stringify(out.me.sets)}`);
}
if (out.top1) {
  console.log('\n=== 榜一 ===');
  console.log(`Lv.${out.top1.level} 战力 ${out.top1.power} 装备值 ${out.top1.equipValue} 件${out.top1.equipCount} 星${out.top1.stars} 强${out.top1.enhance} 宝石${out.top1.gems}`);
  for (const s of out.top1.slots) console.log(`  slot${s.slot}: ${fmtSlot(s)}`);
  console.log(`  出战珍兽: ${JSON.stringify(out.top1.pets?.active)}`);
  console.log(`  套装: ${JSON.stringify(out.top1.sets)}`);
  console.log(`  技能: ${JSON.stringify(out.top1.skills)}`);
}
process.exit(out.ok ? 0 : 1);
