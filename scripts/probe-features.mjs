#!/usr/bin/env node
// scripts/probe-features.mjs —— 实测每个未实现功能的前置条件是否满足
//
// 只发只读查询，不做任何写操作。
// 会占用唯一的 WS 连接，跑之前先停引擎。

import { createSession } from '../core/lib-ws.mjs';

const s = createSession();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = { at: new Date().toISOString(), ready: {}, blocked: {}, unknown: {} };

await s.open();
let d;
for (let i = 0; i < 6; i++) {
  if (i) await sleep(1500);
  const g = await s.req('ENTER_GAME', {}, { ms: 14000, revision: false });
  d = g?.data;
  if (d?.role) break;
}
if (!d?.role) { console.log('❌ 无 role'); process.exit(1); }

const bag = d.bagItems || [];
const cnt = (pred) => bag.filter(pred).reduce((a, b) => a + (b.count || 0), 0);
const has = (re) => cnt(b => re.test(b.itemTmpl?.name || ''));
const money = d.role.money || 0;
const level = d.role.level || 0;

console.log(`角色 Lv.${level} 金币 ${money} 战力 ${d.role.combatPower}\n`);

// ── 逐项检查 ──
function check(name, fn) {
  try {
    const r = fn();
    if (r.ok) { out.ready[name] = r.detail; console.log(`✅ ${name.padEnd(24)} ${r.detail}`); }
    else { out.blocked[name] = r.detail; console.log(`⛔ ${name.padEnd(24)} ${r.detail}`); }
  } catch (e) {
    out.unknown[name] = e.message;
    console.log(`❓ ${name.padEnd(24)} ${e.message}`);
  }
}

check('ONLINE_LOTTERY 抽奖', () => {
  return { ok: true, detail: '需在苏州(mapId=5)，跑一次 query 看 balance' };
});
check('YUCI_EXCHANGE 御赐兑换', () => {
  const n = has(/万灵石/);
  return n > 0 ? { ok: true, detail: `万灵石 ${n} 个，需 Lv≥10` } : { ok: false, detail: '无万灵石' };
});
check('YANHOU_EXCHANGE 燕侯兑换', () => {
  const n = has(/燕弦玉/);
  const need = 5;
  return n >= need ? { ok: true, detail: `燕弦玉 ${n} 个（需 ${need}）` } : { ok: false, detail: `燕弦玉 ${n}/${need}` };
});
check('YANHOU_REROLL 燕侯洗炼', () => {
  const n = has(/燕弦玉/);
  const yanhou = (d.equipments || []).filter(e => /燕侯/.test(e.equipTmpl?.name || ''));
  return n >= 1 && yanhou.length ? { ok: true, detail: `燕弦玉 ${n}，燕侯装备 ${yanhou.length} 件` }
    : { ok: false, detail: `燕弦玉 ${n}，燕侯装备 ${yanhou.length} 件` };
});
check('CRAFT_EQUIP 打造装备', () => {
  const cloth = has(/棉布/);
  const silver = has(/秘银/);
  return (cloth + silver) > 0 ? { ok: true, detail: `棉布类 ${cloth}，秘银类 ${silver}，金币 ${money}` }
    : { ok: false, detail: '无棉布/秘银' };
});
check('SYNTHESIZE_COTTON 布/银合成', () => {
  const frag = has(/棉布碎片/) + has(/秘银碎片/);
  return frag >= 5 ? { ok: true, detail: `碎片 ${frag} 个（5 个合成 1）` } : { ok: false, detail: `碎片 ${frag}（需 5）` };
});
check('GEM_SYNTH 宝石合成', () => {
  const gems = bag.filter(b => /晶石|玉|石/.test(b.itemTmpl?.name || '') && /级\)/.test(b.itemTmpl?.name || ''));
  const byLevel = {};
  for (const g of gems) {
    const m = (g.itemTmpl?.name || '').match(/\((\d)级\)/);
    if (m) byLevel[m[1]] = (byLevel[m[1]] || 0) + (g.count || 0);
  }
  const charm = has(/宝石合成符/);
  return { ok: true, detail: `各等级宝石 ${JSON.stringify(byLevel)}，合成符 ${charm}` };
});
check('GEM_DRILL 打孔', () => {
  const m = has(/打孔|钻孔/);
  return m > 0 ? { ok: true, detail: `打孔材料 ${m}` } : { ok: false, detail: '无打孔材料（元宝商城）' };
});
check('GEM_POLISH 宝石雕琢', () => {
  const charm = has(/雕琢符/);
  return charm > 0 ? { ok: true, detail: `雕琢符 ${charm}` } : { ok: false, detail: '无雕琢符' };
});
check('GEM_REMOVE 宝石摘除', () => {
  const charm = has(/摘除符/);
  return charm > 0 ? { ok: true, detail: `摘除符 ${charm}` } : { ok: false, detail: '无摘除符' };
});
check('SMITHY_ENHANCE 强化', () => {
  const ess = has(/强化精华/);
  const target = (d.equipments || []).filter(e => e.isEquipped && (e.enhanceLevel || 0) < 9);
  return ess > 0 ? { ok: true, detail: `精华 ${ess}，可强化装备 ${target.length} 件` } : { ok: false, detail: `精华 0` };
});
check('SMITHY_FORGE 神节打造', () => {
  const sect = bag.filter(b => b.itemId >= 5044 && b.itemId <= 5049);
  const n = sect.reduce((a, b) => a + (b.count || 0), 0);
  return n > 0 ? { ok: true, detail: `连戎神节 ${n} 个` } : { ok: false, detail: '无连戎神节(5044-5049)' };
});
check('SMITHY_REPAIR_ARTIFACT 神器修复', () => {
  const sect = bag.filter(b => b.itemId >= 5032 && b.itemId <= 5037).reduce((a, b) => a + (b.count || 0), 0);
  const talis = bag.filter(b => b.itemId >= 5038 && b.itemId <= 5043).reduce((a, b) => a + (b.count || 0), 0);
  return (sect && talis) ? { ok: true, detail: `神节 ${sect}，神符 ${talis}` }
    : { ok: false, detail: `神节 ${sect}，神符 ${talis}（都需 >0）` };
});
check('SMITHY_SMELT 熔炼', () => {
  const w = (d.equipments || []).filter(e => {
    if (e.equipTmpl?.slotType !== 1) return false;
    if ((e.equipTmpl?.reqLevel || 0) < 50) return false;
    let a = {};
    try { a = JSON.parse(e.appraisalStats || '{}'); } catch { }
    return (a.extScore || 0) > 1500 && (a.intScore || 0) > 1500;
  });
  const best = (d.equipments || []).filter(e => e.equipTmpl?.slotType === 1 && (e.equipTmpl?.reqLevel || 0) >= 50)
    .map(e => { try { const a = JSON.parse(e.appraisalStats || '{}'); return `${a.extScore}/${a.intScore}`; } catch { return '-'; } });
  return w.length ? { ok: true, detail: `双资质>1500 武器 ${w.length} 件` }
    : { ok: false, detail: `无合格武器（现有：${best.join(', ') || '无' }）` };
});
check('LEVEL_UP 升级', () => {
  const lv = (d.levelTmpls || []).find(x => x.level === level);
  const need = lv?.upgradeExp || 999999999;
  const cur = d.role.currentExp || 0;
  return cur >= need ? { ok: true, detail: `经验 ${cur}/${need}` } : { ok: false, detail: `经验 ${cur}/${need}（差 ${need - cur}）` };
});
check('WAREHOUSE_WITHDRAW 取仓', () => {
  const n = (d.warehouse?.items || []).length;
  return n > 0 ? { ok: true, detail: `仓库 ${n} 件` } : { ok: false, detail: '仓库空' };
});
check('CONSIGNMENT_CANCEL 下架', () => {
  return { ok: true, detail: '需查 CONSIGNMENT_LIST 看自己挂售的' };
});

console.log('\n=== GET_* 只读查询（都可直接调）===');
for (const p of ['GET_ARTIFACT_SKILLS', 'GET_PLAYER_INFO', 'GET_MONSTER_TMPL', 'GET_DUMMY_LEADERBOARD', 'GET_POTION_LIST', 'GET_SECT_LIST', 'GET_ONLINE_LIST']) {
  console.log(`  ${p}`);
}

s.close();
process.exit(0);
