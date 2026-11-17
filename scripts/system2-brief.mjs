#!/usr/bin/env node
// scripts/system2-brief.mjs —— System2 一次唤醒的紧凑决策简报
// 用法：node scripts/system2-brief.mjs
// 输出：一段 JSON（≤2KB），够 System2 决定「做/不做」什么，不需要再翻日志。

const B = process.env.TL_API || 'http://127.0.0.1:9527';
const j = async (p) => {
  const r = await fetch(B + p);
  if (!r.ok) throw new Error(`${p} HTTP ${r.status}`);
  return r.json();
};
const sec = (ms) => (ms == null ? null : Math.max(0, Math.round(ms / 1000)));

try {
  const [brief, plan, strat, pets, tower, drops] = await Promise.all([
    j('/status/brief'),
    j('/plan?live=1'),
    j('/strategy/state'),
    j('/pets'),
    j('/tower'),
    j('/drops?map=10027&limit=6'),
  ]);

  const p = pets || {};
  const list = p.pets || [];
  const active = list.find(x => x.pet?.id === p.activePetId) || null;
  const waiting = list.filter(x => x.pet?.status === 'WAITING' || x.pet?.status === 'BREEDING');
  const freeSlots = Math.max(0, (p.capacity || 6) - (p.reserved || 0) - list.length);
  const d = drops?.byMap?.['10027'] || drops?.byMap?.[10027] || drops || {};
  const topDrops = Object.entries(d.items || d.byItem || {}).slice(0, 6)
    .map(([k, v]) => `${k}:${typeof v === 'object' ? (v.count ?? v.n ?? JSON.stringify(v)) : v}`);

  const out = {
    at: new Date().toISOString(),
    brief: { level: brief.level, power: brief.power, exp: brief.exp, gold: brief.gold, yuanbao: brief.yuanbao, combat: brief.combat, daemon: brief.daemon, wsClosed: brief.wsClosed, halted: brief.halted },
    plan: {
      expAllocation: plan.expAllocation,
      top: (plan.plan || []).slice(0, 5),
      stableCpPerHour: plan.summary?.stableCpPerHour,
      oneOffStockEV: plan.summary?.oneOffStockEV,
      dataGaps: (plan.dataGaps || []).slice(0, 3),
    },
    strategy: {
      depositAt: strat.state?.depositAt || 0,
      breedDueInSec: strat.state?.depositAt ? sec(55 * 60 * 1000 - (Date.now() - strat.state.depositAt)) : null,
      lastClaimAt: strat.state?.lastClaimAt || 0,
      feeds: strat.state?.feeds || 0,
    },
    pets: {
      active: active ? { name: active.speciesName, level: active.pet.level, avg: active.average, cp: active.combatPower, form: active.pet.form, exp: active.pet.exp, nextExp: active.nextExp } : null,
      count: list.length, capacity: p.capacity, reserved: p.reserved, freeSlots,
      waiting: waiting.map(w => ({ id: w.pet.id, name: w.speciesName, avg: w.average })),
    },
    tower: { highest: tower.highestFloor, fee: tower.entryFee, seals: tower.balances?.seals },
    drops10027: { total: d.total ?? d.count ?? null, top: topDrops },
  };
  console.log(JSON.stringify(out, null, 1));
} catch (e) {
  console.log(JSON.stringify({ at: new Date().toISOString(), error: e?.message || String(e), hint: '引擎可能未启动：./enginectl.sh start 2' }));
  process.exitCode = 1;
}
