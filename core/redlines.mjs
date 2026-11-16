// core/redlines.mjs —— 红线断言（PRD D3：红线写进代码，不写在 Markdown 里）
//
// 设计原则：
//   1. 纯函数 + 显式抛错，绝不偷偷"降级为允许"
//   2. 每个写操作发包前必须过一遍 assertSafe({ action, ... })
//   3. 不确定的输入（缺 item / 缺 owned 列表）→ 宁可拒绝，不可放行
//
// 六条红线（从 GOAL.md 迁移）：
//   R1 同槽战力前 2 强 → 永不卖 / 永不分解 / 永不放生
//   R2 珍兽最高资质个体 → 永不放生
//   R3 单次消耗元宝 > 0 → 必须先 dry-run 报告，等确认
//   R4 单次金币消耗 > 当前总额 30% → 拒绝
//   R5 摘除已穿戴装备 → 必须先备份物品 ID 快照
//   R6 不可逆操作（熔炼 / 鉴定重掷 / 出售 / 放生）→ 先 dry-run，后执行
//
// 禁忌（继承 AGENTS.md / PRD §9）：
//   禁 pgrep/pkill/kill/launchctl；停进程用 .halt；不得自建第二条 WS 连接。

import { itemValue } from './lib-value.mjs';

export const REDLINE_VERSION = '1.0.0';

export class RedlineError extends Error {
  constructor(code, message, details = {}) {
    super(`[红线 ${code}] ${message}`);
    this.name = 'RedlineError';
    this.code = code;
    this.details = details;
  }
}

const deny = (code, msg, details) => { throw new RedlineError(code, msg, details); };

// ── R1：同槽战力前 N 强 ──────────────────────────────────────
// owned: 服务端 g.equipments（含 isEquipped / equipTmpl.slotType）
// 返回 Set<itemId>
export function topGearIds(owned, { perSlot = 2 } = {}) {
  const bySlot = new Map();
  for (const e of owned || []) {
    const slot = e?.equipTmpl?.slotType;
    if (slot == null) continue;
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(e);
  }
  const out = new Set();
  for (const arr of bySlot.values()) {
    arr
      .slice()
      .sort((a, b) => itemValue(b) - itemValue(a))
      .slice(0, perSlot)
      .forEach(e => out.add(e.id));
  }
  return out;
}

// 若待处理装备属于「同槽前 2 强」，拒绝
// 原则：设备件（有 equipTmpl）但拿不到 owned 列表 → 无法确认 → 拒绝
export function assertNotTopGear({ action, itemId, item, owned, perSlot = 2 }) {
  const id = itemId ?? item?.id;
  if (id == null) deny('R1', `${action}：缺少 itemId，无法确认是否前 2 强 → 拒绝`, { action });
  const isEquip = !!(item?.equipTmpl || item?.slotType != null);
  if (isEquip && (!Array.isArray(owned) || owned.length === 0)) {
    deny('R1', `${action}：物品 ${id} 是装备，但没给 owned 列表，无法确认是否前 ${perSlot} 强 → 拒绝`, {
      action, itemId: id,
    });
  }
  const top = topGearIds(owned, { perSlot });
  if (top.has(id)) {
    deny('R1', `${action}：物品 ${id}（${item?.equipTmpl?.name || item?.itemName || '?'}）是该槽位前 ${perSlot} 强，禁止卖/分解/放生`, {
      action, itemId: id,
    });
  }
  return true;
}

// ── R2：珍兽最高资质 ────────────────────────────────────────
export function bestPet(pets) {
  const arr = (pets || []).filter(p => p && typeof p.average === 'number');
  if (!arr.length) return null;
  return arr.slice().sort((a, b) => b.average - a.average)[0];
}

export function assertNotBestPet({ action, petId, pet, pets }) {
  const best = bestPet(pets);
  const id = petId ?? pet?.pet?.id ?? pet?.id;
  if (best && best.pet?.id === id) {
    deny('R2', `${action}：珍兽 ${id} 是最高资质个体（${best.average}%），禁止放生`, {
      action, petId: id, bestAverage: best.average,
    });
  }
  return true;
}

// ── R3：元宝 ───────────────────────────────────────────────
// 任何 > 0 的元宝消耗都必须先 dry-run 报告并拿到确认
export function assertNoYuanbaoSpend({ action, cost = 0, yuanbao = 0, dryRun = false, confirmed = false }) {
  const c = Number(cost) || 0;
  if (c <= 0) return true;
  if (dryRun) return { dryRun: true, action, cost: c, yuanbao };
  if (!confirmed) {
    deny('R3', `${action}：要消耗 ${c} 元宝（余额 ${yuanbao}），必须先 dry-run 报告并等确认`, {
      action, cost: c, yuanbao, need: 'dryRun+confirmed',
    });
  }
  if (c > yuanbao) {
    deny('R3', `${action}：要消耗 ${c} 元宝但余额只有 ${yuanbao}`, { action, cost: c, yuanbao });
  }
  return true;
}

// ── R4：金币预算 ───────────────────────────────────────────
export const GOLD_BUDGET_RATIO = 0.3;
export function assertGoldBudget({ action, cost = 0, money = 0, ratio = GOLD_BUDGET_RATIO }) {
  const c = Number(cost) || 0;
  const m = Number(money) || 0;
  if (c <= 0) return true;
  if (m <= 0) deny('R4', `${action}：要花 ${c} 金币但金币余额未知/为 0`, { action, cost: c, money: m });
  if (c > m * ratio) {
    deny('R4', `${action}：单次花 ${c} 金币 > 总额 ${m} 的 ${Math.round(ratio * 100)}%（上限 ${Math.floor(m * ratio)}）`, {
      action, cost: c, money: m, ratio,
    });
  }
  return true;
}

// ── R5：摘除已穿戴装备前必须有 ID 快照 ───────────────────────
export function assertEquipSnapshot({ action, snapshot }) {
  const ids = snapshot?.equippedIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    deny('R5', `${action}：摘除已穿戴装备前必须先生成 equippedIds 快照（safeSnapshot）`, { action });
  }
  return true;
}

// ── R6：不可逆操作必须先 dry-run ────────────────────────────
export const IRREVERSIBLE = new Set([
  'SHOP_SELL', 'SMELT_START', 'SMELT', 'APPRAISE_REROLL', 'REAPPRAISE',
  'PET_RELEASE', 'ITEM_DECOMPOSE', 'DECOMPOSE', 'SMITHY_FORGE',
]);
export function assertDryRunFirst({ action, op, dryRun = false, confirmed = false }) {
  const o = op || action;
  if (!IRREVERSIBLE.has(o)) return true;
  if (dryRun) return { dryRun: true, op: o };
  if (!confirmed) deny('R6', `${o} 是不可逆操作，必须先 dry-run 出报告再执行`, { op: o });
  return true;
}

// ── 快照 ───────────────────────────────────────────────────
// 用于 T5（bot_safe_ws_probe）前后对比，以及 R5 的 ID 备份
export function safeSnapshot(source = {}) {
  const role = source.role || source.roleInfo?.role || source.me || source || {};
  const owned = source.equipments || source.owned || [];
  const pets = source.pets?.list || source.pets || [];
  const equipped = owned.filter(x => x?.isEquipped);
  const best = bestPet(pets);
  return {
    at: new Date().toISOString(),
    level: role.level ?? null,
    power: role.combatPower ?? role.power ?? null,
    yuanbao: role.yuanbao ?? role.gold_ingot ?? 0,
    gold: role.money ?? 0,
    exp: role.currentExp ?? null,
    equippedIds: equipped.map(x => x.id),
    equippedSlots: equipped.map(x => x.equipTmpl?.slotType).sort((a, b) => a - b),
    topGearIds: [...topGearIds(owned)],
    petIds: pets.map(p => p?.pet?.id ?? p?.id).filter(x => x != null),
    bestPetId: best?.pet?.id ?? best?.id ?? null,
    bagCount: (source.bagItems || source.bag || []).length,
  };
}

// ── 动作作用域（避免把「装备/存仓/出战」误判成破坏性操作）──
// R1 只约束「会永久失去物品」的动作；存仓/换装/出战都不算。
export const R1_ACTIONS = new Set([
  'SHOP_SELL', 'SELL', 'ITEM_DECOMPOSE', 'DECOMPOSE', 'DISCARD',
]);
// R2 只约束放生；召唤/喂食/鉴定都不算。
export const R2_ACTIONS = new Set(['PET_RELEASE', 'RELEASE_PET']);

// ── 统一入口 ───────────────────────────────────────────────
// 用法：
//   assertSafe({ action:'SHOP_SELL', itemId, item, owned })
//   assertSafe({ action:'BUY', goldCost, money })
//   assertSafe({ action:'PET_COMMAND', op:'PET_RELEASE', petId, pets })
//
// 返回 { ok, dryRun, snapshot, notes }；不通过直接 throw RedlineError
export function assertSafe(req = {}) {
  const {
    action = 'UNKNOWN',
    op = null,
    itemId, item, owned,
    petId, pet, pets,
    cost = 0, yuanbao = 0, money = 0, goldCost = null,
    dryRun = false, confirmed = false,
    snapshot = null,
    unequip = false,
  } = req;

  const notes = [];
  const snap = snapshot || safeSnapshot(req);

  // 货币语义：goldCost 明确给了就是金币；否则 cost 默认按元宝算
  const currency = req.currency || (goldCost != null ? 'gold' : 'yuanbao');
  const yuanbaoCost = currency === 'yuanbao' ? Number(cost) || 0 : 0;
  const goldCostNum = currency === 'gold' ? Number(goldCost ?? cost) || 0 : 0;

  // R3 元宝（含 0 元宝硬约束：GOAL.md「不花元宝」）
  if (yuanbaoCost > 0) {
    const r = assertNoYuanbaoSpend({ action, cost: yuanbaoCost, yuanbao: yuanbao ?? snap.yuanbao, dryRun, confirmed });
    if (r && r.dryRun) notes.push(`元宝消耗 ${yuanbaoCost} → DRY_RUN`);
  }

  // R4 金币
  if (goldCostNum) assertGoldBudget({ action, cost: goldCostNum, money: money || snap.gold });

  const opName = op || action;

  // R1 装备：只对「卖/分解/丢弃」生效（存仓/换装/出战不拦）
  if (R1_ACTIONS.has(opName) && (itemId != null || item != null)) {
    assertNotTopGear({ action, itemId, item, owned: owned || req.equipments });
  }

  // R2 珍兽：只对「放生」生效（召唤/喂食/鉴定不拦）
  if (R2_ACTIONS.has(opName) && (petId != null || pet != null)) {
    assertNotBestPet({ action, petId, pet, pets: pets || req.pets });
  }

  // R5 摘装备
  if (unequip) assertEquipSnapshot({ action, snapshot: snap });

  // R6 不可逆
  const dr = assertDryRunFirst({ action, op, dryRun, confirmed });
  if (dr && dr.dryRun) notes.push(`${dr.op} → DRY_RUN`);

  return { ok: true, dryRun: dryRun || notes.length > 0, snapshot: snap, notes };
}

// ── 永久禁调表（T5 用）─────────────────────────────────────
const LOCKED = new Set();
export function lockCmd(cmd, reason = '') { LOCKED.add(cmd); return { cmd, reason }; }
export function isLocked(cmd) { return LOCKED.has(cmd); }
export function lockedCmds() { return [...LOCKED]; }
export function assertNotLocked(cmd) {
  if (LOCKED.has(cmd)) deny('LOCK', `命令 ${cmd} 已被永久禁用（曾造成非预期消耗/装备丢失）`, { cmd });
  return true;
}

// ── 自测（node -e 'import("./core/redlines.mjs").then(m=>m.selfTest())'）──
export function selfTest() {
  const owned = [
    { id: 1, isEquipped: true, equipTmpl: { slotType: 1, name: 'W1' }, equipTmpl2: null, extraStats: '{"ext_atk":500}' },
    { id: 2, equipTmpl: { slotType: 1, name: 'W2' }, extraStats: '{"ext_atk":400}' },
    { id: 3, equipTmpl: { slotType: 1, name: 'W3' }, extraStats: '{"ext_atk":100}' },
  ];
  const pets = [
    { pet: { id: 10 }, average: 197 },
    { pet: { id: 11 }, average: 120 },
  ];
  const cases = [];
  const expect = (name, fn, shouldThrow) => {
    let threw = false, err = null;
    try { fn(); } catch (e) { threw = true; err = e; }
    cases.push({ name, pass: threw === shouldThrow, msg: err?.message || '' });
  };
  expect('R1 拒绝卖前2强(1)', () => assertSafe({ action: 'SHOP_SELL', op: 'SHOP_SELL', itemId: 1, item: owned[0], owned, dryRun: true }), true);
  expect('R1 拒绝卖前2强(2)', () => assertSafe({ action: 'SHOP_SELL', op: 'SHOP_SELL', itemId: 2, item: owned[1], owned, dryRun: true }), true);
  expect('R1 允许卖弱件(3)', () => assertSafe({ action: 'SHOP_SELL', op: 'SHOP_SELL', itemId: 3, item: owned[2], owned, dryRun: true }), false);
  expect('R2 拒绝放生最高资质', () => assertSafe({ action: 'PET_COMMAND', op: 'PET_RELEASE', petId: 10, pets, dryRun: true }), true);
  expect('R2 允许放生低资质', () => assertSafe({ action: 'PET_COMMAND', op: 'PET_RELEASE', petId: 11, pets, dryRun: true }), false);
  expect('R3 元宝需确认', () => assertSafe({ action: 'BUY', cost: 300, yuanbao: 500 }), true);
  expect('R3 元宝 dry-run 放行', () => assertSafe({ action: 'BUY', cost: 300, yuanbao: 500, dryRun: true }), false);
  expect('R4 超 30% 金币拒绝', () => assertSafe({ action: 'BUY', goldCost: 4000, money: 10000 }), true);
  expect('R4 30% 内放行', () => assertSafe({ action: 'BUY', goldCost: 2000, money: 10000 }), false);
  expect('R5 摘装备需快照', () => assertSafe({ action: 'EQUIP', unequip: true, snapshot: { equippedIds: [] } }), true);
  expect('R6 不可逆需 dry-run', () => assertSafe({ action: 'SMELT_START', op: 'SMELT_START' }), true);
  expect('LOCK 禁调', () => { lockCmd('EVIL'); assertNotLocked('EVIL'); }, true);
  const failed = cases.filter(c => !c.pass);
  return { total: cases.length, failed: failed.length, cases };
}
