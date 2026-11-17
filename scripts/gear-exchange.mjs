// 跨号装备交换扫描器（只读，不调拨）
// 用法: node scripts/gear-exchange.mjs [--min-q 3] [--json]
import fs from 'node:fs';
import { itemValue } from '../core/lib-value.mjs';

const PORTS = [9527, 9528, 9529];
const CLASS = {
  1: { name: '少林', kind: 'ext' }, 2: { name: '明教', kind: 'ext' }, 3: { name: '丐帮', kind: 'ext' },
  4: { name: '武当', kind: 'int' }, 5: { name: '峨眉', kind: 'int' }, 6: { name: '星宿', kind: 'int' },
  7: { name: '天龙', kind: 'bal' }, 8: { name: '天山', kind: 'ext' }, 9: { name: '逍遥', kind: 'int' },
};
const qi = process.argv.indexOf('--min-q');
const minQ = qi >= 0 ? Number(process.argv[qi + 1]) : 3;
const asJson = process.argv.includes('--json');
const APPLY = process.argv.includes('--apply');
const mi = process.argv.indexOf('--max');
const MAX = Math.min(5, mi >= 0 ? Math.max(1, Number(process.argv[mi + 1]) || 5) : 5);
const pi = process.argv.indexOf('--price');
const PRICE = pi >= 0 ? Number(process.argv[pi + 1]) || 100 : 100;

const parse = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : (s || {}); } catch { return {}; } };
const sum = (o, keys) => keys.reduce((a, k) => a + (Number(o[k]) || 0), 0);
const KIND_STATS = {
  int: ['int_atk', 'int_def', 'hp', 'mp', 'crit_rate', 'crit_def'],
  ext: ['ext_atk', 'ext_def', 'hp', 'mp', 'crit_rate', 'crit_def'],
  bal: ['ext_atk', 'int_atk', 'ext_def', 'int_def', 'hp', 'mp'],
};

const accounts = [];
for (const port of PORTS) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/raw`);
    if (!r.ok) { accounts.push({ port, error: `HTTP ${r.status}` }); continue; }
    const g = await r.json();
    const role = g.role || {};
    const sect = Number(role.sect || 0);
    let nickname = role.nickname || null, power = Number(role.combatPower || 0);
    let level = Number(role.level || 0);
    try {
      const st = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
      const me = st.me || st.store?.me || st.data?.me || {};
      nickname = nickname || me.nickname || null;
      power = power || Number(me.power || 0);
      level = level || Number(me.level || 0);
    } catch { }
    if (!nickname && role.id != null) {
      try { const p = await (await fetch(`http://127.0.0.1:${port}/player?roleId=${role.id}`)).json(); nickname = p?.data?.role?.nickname || p?.role?.nickname || null; } catch { }
    }
    accounts.push({
      port, roleId: role.id, nickname: nickname || `role${role.id}`, sect, className: CLASS[sect]?.name || '?', kind: CLASS[sect]?.kind || 'bal',
      level, power, mapId: role.mapId,
      equipments: (g.equipments || []).filter(x => x?.equipTmpl),
      gemInfo: g.gemInfo || null,
    });
  } catch (e) { accounts.push({ port, error: e?.message || String(e) }); }
}

const byId = new Map(accounts.filter(a => !a.error).map(a => [a.roleId, a]));
for (const a of accounts) {
  if (a.error) continue;
  a.worn = a.equipments.filter(x => x.isEquipped);
  a.wornBySlot = {};
  for (const x of a.worn) a.wornBySlot[x.equipTmpl.slotType] = x;
  a.bag = a.equipments.filter(x => !x.isEquipped);
}

const out = [];
for (const donor of accounts) {
  if (donor.error) continue;
  for (const x of donor.bag) {
    const q = Number(x.quality ?? 1);
    if (q < minQ || x.isBound) continue;
    const slot = x.equipTmpl.slotType;
    const req = Number(x.equipTmpl.reqLevel || 0);
    const iv = itemValue(x, { gemInfo: donor.gemInfo });
    const recips = [];
    for (const to of accounts) {
      if (to.error || to.roleId === donor.roleId) continue;
      if (to.level < req) continue;
      const cur = to.wornBySlot[slot];
      if (!cur) continue; // 只换已有部位，避免空槽乱塞
      const curIv = itemValue(cur, { gemInfo: to.gemInfo });
      const stats = parse(x.extraStats || x.equipTmpl.baseStats);
      const fit = sum(stats, KIND_STATS[to.kind] || KIND_STATS.bal);
      // 粗略门槛：本地价值至少不低于对方同槽现穿，且主属性有正向贡献
      if (iv <= curIv * 0.98 || fit <= 0) continue;
      recips.push({ to: to.nickname, port: to.port, cls: to.className, curName: cur.equipTmpl.name, curIv: Math.round(curIv), gain: Math.round(iv - curIv), fit });
    }
    if (recips.length) recips.sort((a, b) => b.gain - a.gain);
    if (recips.length) out.push({ from: donor.nickname, port: donor.port, id: String(x.id), name: x.equipTmpl.name, q, slot, req, iv: Math.round(iv), recips });
  }
}
out.sort((a, b) => (b.recips[0]?.gain || 0) - (a.recips[0]?.gain || 0));

// ── 自动交换：投递 → 对方官方评分 → 装备或退回 ──────────────
const j = async (port, path, opt) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, opt); return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) }; };
const post = (port, path, body) => j(port, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const nickOf = a => a.nickname;
const applied = [];
async function findListing(port, sellerId, name, price) {
  for (let p = 1; p <= 60; p++) {
    const au = await j(port, `/auction?page=${p}&size=100`);
    const arr = au.body?.items || [];
    const hit = arr.find(x => String(x.sellerRoleId) === String(sellerId) && x.itemName === name && Number(x.price) === price);
    if (hit) return hit.id;
    if (arr.length < 6) break;
  }
  return null;
}
if (APPLY) {
  for (const o of out) {
    if (applied.length >= MAX) break;
    if ((o.recips[0]?.gain || 0) < 300) continue;
    const donor = accounts.find(a => a.port === o.port); if (!donor) continue;
    const rec = o.recips[0]; const to = accounts.find(a => a.port === rec.port); if (!to) continue;
    const item = donor.bag.find(x => String(x.id) === o.id); if (!item || item.isBound || item.isEquipped) continue;
    // 重新确认：扫描后 maintain 可能已自动穿上同名件，旧 id 失效
    let fresh;
    try { fresh = await (await fetch(`http://127.0.0.1:${donor.port}/raw`)).json(); } catch { fresh = null; }
    const live = (fresh?.equipments || []).find(x => !x.isEquipped && !x.isBound && String(x.tmplId) === String(item.tmplId));
    if (!live) { applied.push({ item: o.name, to: to.nickname, error: '已穿戴或已不存在，跳过' }); continue; }
    if (to.bag.length >= 90) { applied.push({ item: o.name, skip: '目标背包接近上限' }); continue; }
    const preRaw = await j(to.port, '/raw');
    const preIds = new Set((preRaw.body?.equipments || []).map(x => String(x.id)));
    const preSt = await j(to.port, '/status');
    const powerBefore = Number(preSt.body?.me?.power || 0);
    const lst = await post(donor.port, '/consignment/list', { roleEquipId: live.id, price: PRICE, targetNickname: to.nickname });
    if (!lst.body?.ok) { applied.push({ item: o.name, error: '上架失败', detail: lst.body?.message || lst.body }); continue; }
    const cid = await findListing(donor.port, donor.roleId, o.name, PRICE);
    if (!cid) { applied.push({ item: o.name, error: '找不到刚上的挂单' }); continue; }
    const buy = await post(to.port, '/trade/designated/buy', { consignmentId: cid, dryRun: false });
    if (!buy.body?.ok) { applied.push({ item: o.name, error: '购买失败', detail: buy.body?.message || buy.body }); continue; }
    await j(to.port, '/settings').catch(() => { });
    const r2 = await j(to.port, '/raw');
    const newItem = (r2.body?.equipments || []).find(x => !preIds.has(String(x.id)) && String(x.tmplId) === String(item.tmplId));
    if (!newItem) { applied.push({ item: o.name, to: to.nickname, error: '购买成功但背包未看到新件' }); continue; }
    const gear = await j(to.port, '/gear');
    const sug = (gear.body?.suggestions || []).find(x => Number(x.slot) === Number(o.slot) && String(x.to || '') === o.name);
    if (!sug) {
      // 官方不推荐：不再退回原号；按用户规则原地卖掉（NPC 直卖，已 confirmed）
      const sold = await post(to.port, '/inventory/sell', { roleEquipId: newItem.id, confirmed: true });
      applied.push({ item: o.name, to: to.nickname, result: sold.body?.ok ? 'sold' : 'sell_failed', why: '官方评分未推荐，按规则卖掉', slot: o.slot, sale: sold.body?.message || sold.body?.error || null });
      continue;
    }
    const eq = await post(to.port, '/inventory/equip', { roleEquipId: newItem.id });
    const st2 = await j(to.port, '/status');
    const powerAfter = Number(st2.body?.me?.power || 0);
    applied.push({ item: o.name, to: to.nickname, result: eq.body?.ok ? 'equipped' : 'equip_failed', damagePct: sug.damagePct, powerBefore, powerAfter, delta: powerAfter - powerBefore, detail: eq.body?.message });
  }
}

if (APPLY && applied.length) {
  try { fs.appendFileSync('data/gear-exchange.jsonl', applied.map(x => JSON.stringify({ at: new Date().toISOString(), ...x })).join('\n') + '\n'); } catch { }
}
const table = accounts.map(a => a.error ? { port: a.port, error: a.error } : { port: a.port, name: a.nickname, cls: a.className, level: a.level, power: a.power, worn: a.worn.length, bag: a.bag.length });
if (asJson) console.log(JSON.stringify({ table, candidates: out.slice(0, 30), applied }, null, 2));
else {
  console.log('账号表:'); for (const t of table) console.log(' ', JSON.stringify(t));
  console.log(`候选(>=q${minQ}, 只读): ${out.length}`);
  for (const o of out.slice(0, 12)) console.log(` ${o.from}→${o.recips.map(r => `${r.to}(${r.cls})`).join('/')} ${o.name} q${o.q} slot${o.slot} iv${o.iv} ${o.recips[0] ? `Δ${o.recips[0].gain}` : ''}`);
}
