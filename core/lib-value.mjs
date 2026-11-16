import { ENH } from './lib-power.mjs';

// 装备价值：对齐实测结果（见 GEAR_RESEARCH.md）
// 核心修正：
//   1) 冰/玄元素攻是负收益（洛神图 -35%）
//   2) 火/毒元素攻 double（洛神图 +20%）
//   3) 防御权重上调（减伤实测比战力公式更值钱）
//   4) 套装效果并入总价值，前后对比（不做特殊惩罚）
const W = {
  extAtk: 4.0, intAtk: 4.0,
  extDef: 4.5, intDef: 4.5,
  hp: 0.9, mp: 0.2,
  critRate: 5, precision: 5,
  critDef: 2.0, avoidance: 2.0,      // 实测收益低于战力评估
  // 元素攻：洛神图 火/毒 +20%，冰/玄 -35%
  fireAtk: 4.0, poisonAtk: 4.0,
  iceAtk: -2.0, holyAtk: -2.0,
  iceDef: 1.5, fireDef: 1.5, poisonDef: 1.5, holyDef: 1.5,
};

// all_atk 是百分比：每 1% 折算多少分
// 依据：面板攻击约 3000，+1% 攻击 ≈ +30 攻击 ≈ 30×4 = 120 分；取 130 略偏保守
export const ALL_ATK_UNIT = 130;

// 基材会被强化/星级乘算，附加值不会 → 基材权重更高
const BASE_MULT = 1.6;
const EXTRA_MULT = 1.0;
// 星级对基材的乘算：每星 +4%（启发式，待 calibration 实测修正）
// 说明：强化倍率来自 lib-power.ENH（客户端公式已确认）；星级倍率暂无客户端公式，
//       先用保守 4%/星，避免高星件被当成垃圾卖掉。
export const STAR_BASE_MULT = 0.04;

const GEM_ATTR = { 0: 'extAtk', 1: 'intAtk', 2: 'extDef', 3: 'intDef' };

function gemScore(e, gemInfo) {
  if (!gemInfo || !e?.gemSlots) return 0;
  const map = Array.isArray(gemInfo)
    ? Object.fromEntries(gemInfo.map(g => [g.id, g]))
    : gemInfo;
  let slots = [];
  try { slots = JSON.parse(e.gemSlots || '[]'); } catch { return 0; }
  let s = 0;
  for (const gid of slots) {
    const g = map[gid];
    if (!g) continue;
    const attr = GEM_ATTR[g.subType];
    if (attr) s += (W[attr] || 0) * (Number(g.value) || 0);
  }
  return s;
}

function norm(k) { return k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }

function score(obj, mult) {
  let s = 0;
  try {
    const j = typeof obj === 'string' ? JSON.parse(obj || '{}') : (obj || {});
    for (const [k, v] of Object.entries(j)) {
      if (typeof v !== 'number') continue;
      const nk = norm(k);
      const w = W[nk] ?? 2;
      s += v * w;
    }
  } catch { }
  return s * mult;
}

export function itemValue(e, opts = {}) {
  if (!e || !e.equipTmpl) return 0;
  const enh = 1 + (ENH[e.enhanceLevel || 0] || 0) / 100;
  const star = 1 + STAR_BASE_MULT * (e.starLevel || 0);
  return score(e.equipTmpl.baseStats, BASE_MULT * enh * star)
    + score(e.extraStats, EXTRA_MULT)
    + score(e.appraisalStats, EXTRA_MULT)
    + gemScore(e, opts.gemInfo);
}

export function currentValue(e, opts = {}) {
  if (!e || !e.equipTmpl) return 0;
  const enh = 1 + (ENH[e.enhanceLevel || 0] || 0) / 100;
  const star = 1 + STAR_BASE_MULT * (e.starLevel || 0);
  return score(e.equipTmpl.baseStats, enh * star)
    + score(e.extraStats, 1)
    + score(e.appraisalStats, 1)
    + gemScore(e, opts.gemInfo);
}

export function baseValue(e) {
  return e?.equipTmpl ? score(e.equipTmpl.baseStats, 1) : 0;
}

// 套装效果 → 分数（all_atk 用百分比单位单独折算）
function effectScore(effects) {
  let s = 0;
  for (const [k, v] of Object.entries(effects || {})) {
    if (typeof v !== 'number') continue;
    if (k === 'all_atk') s += v * ALL_ATK_UNIT;
    else s += (W[norm(k)] ?? 2) * v;
  }
  return s;
}

// 套装分析：给定「已装备列表」，返回各套装进度与已激活档位
export function analyzeSets(equipped, equipSets) {
  const tmplIds = new Set(equipped.map(x => x.tmplId));
  const out = [];
  for (const st of equipSets || []) {
    let ids = [];
    try { ids = JSON.parse(st.equipTmplIds || '[]'); } catch { }
    const tiers = Array.isArray(st.bonusTiers) ? st.bonusTiers : [];
    const have = ids.filter(id => tmplIds.has(id)).length;
    if (have === 0) continue;
    const active = tiers.filter(t => t.pieces <= have);
    const next = tiers.find(t => t.pieces > have);
    out.push({
      name: st.name, have, total: ids.length, ids, active, next,
      allAtk: active.reduce((a, t) => a + (t.effects?.all_atk || 0), 0),
      score: active.reduce((a, t) => a + effectScore(t.effects), 0),
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

// 当前所有套装的合计分数（不区分档位，只算已激活的）
export function totalSetScore(equipped, equipSets) {
  return analyzeSets(equipped, equipSets).reduce((a, s) => a + s.score, 0);
}

// 换装评估：装上 candidate（替换同槽位当前件）后，总价值变化
// 总价值 = Σ 装备自身价值 + Σ 已激活套装效果价值
export function swapDelta(equipped, candidate, equipSets, opts = {}) {
  const slot = candidate.equipTmpl?.slotType;
  if (!slot) return { delta: 0, reason: '' };

  const cur = equipped.find(x => x.isEquipped && x.equipTmpl?.slotType === slot);

  const beforeItem = equipped.reduce((a, x) => a + itemValue(x, opts), 0);
  const beforeSet = totalSetScore(equipped, equipSets);
  const beforeSets = analyzeSets(equipped, equipSets);

  const after0 = cur ? equipped.map(x => (x === cur ? candidate : x)) : [...equipped, candidate];
  const afterItem = after0.reduce((a, x) => a + itemValue(x, opts), 0);
  const afterSet = totalSetScore(after0, equipSets);
  const afterSets = analyzeSets(after0, equipSets);

  const itemDelta = afterItem - beforeItem;
  const setDelta = afterSet - beforeSet;

  // 文字说明：哪些套装档位变了
  const bits = [];
  for (const a of afterSets) {
    const b = beforeSets.find(x => x.name === a.name);
    const bHave = b ? b.have : 0;
    if (a.active.length > (b ? b.active.length : 0)) {
      const gain = a.score - (b ? b.score : 0);
      bits.push(`${a.name}${bHave}→${a.have}件 +${Math.round(gain)}`);
    }
  }
  for (const b of beforeSets) {
    const a = afterSets.find(x => x.name === b.name);
    if (b.active.length > (a ? a.active.length : 0)) {
      const loss = b.score - (a ? a.score : 0);
      bits.push(`${b.name}${b.have}→${a ? a.have : 0}件 -${Math.round(loss)}`);
    }
  }

  return {
    delta: itemDelta + setDelta,
    itemDelta, setDelta,
    reason: bits.join(' '),
  };
}

// 全装备总价值 = Σ装备 + Σ套装修正。用于在所有可能组合里挑最优
export function totalValue(equipped, equipSets, opts = {}) {
  return equipped.reduce((a, x) => a + itemValue(x, opts), 0) + totalSetScore(equipped, equipSets);
}

// 贪心配装：反复找出「单件替换能最大化总价值」的操作，直到没有增益
// opts: { minGain = 50, maxSteps = 12 }
export function bestLoadout(owned, equipSets, copper = false, opts = {}) {
  const { minGain = 50, maxSteps = 12 } = opts;
  // 按槽取当前已穿，起始状态
  const bySlot = {};
  for (const e of owned) {
    const sl = e.equipTmpl?.slotType;
    if (!sl) continue;
    (bySlot[sl] ||= []).push(e);
  }
  // 起点：每槽优先取「已装备」的那件；若某槽一件都没穿，就用该槽最强件作为基线
  // （这种情况说明状态异常，不能当空槽处理，否则会把整套卸掉）
  let equipped = [];
  for (const arr of Object.values(bySlot)) {
    const cur = arr.find(x => x.isEquipped);
    if (cur) equipped.push(cur);
    else {
      const strongest = arr.slice().sort((a, b) => itemValue(b, opts) - itemValue(a, opts))[0];
      if (strongest) equipped.push(strongest);
    }
  }

  const steps = [];
  let base = totalValue(equipped, equipSets, opts);

  for (let i = 0; i < maxSteps; i++) {
    let best = null;
    const curBySlot = {};
    for (const e of equipped) curBySlot[e.equipTmpl?.slotType] = e;

    for (const [sl, arr] of Object.entries(bySlot)) {
      const cur = curBySlot[sl];
      for (const cand of arr) {
        if (cur && cand.id === cur.id) continue;
        const next = cur
          ? equipped.map(x => (x.id === cur.id ? cand : x))
          : [...equipped, cand];
        const v = totalValue(next, equipSets, opts);
        const gain = v - base;
        if (gain > (best ? best.gain : minGain)) {
          best = { cand, from: cur, next, gain, slot: Number(sl) };
        }
      }
    }
    if (!best) break;
    equipped = best.next;
    base = totalValue(equipped, equipSets, opts);
    steps.push({ name: best.cand.equipTmpl?.name, slot: best.slot, gain: best.gain });
  }

  return { equipped, value: base, steps };
}

// 「就差一件」的套装价值：装上这件能让哪个套装补到下一档，值多少分
// 用于商城扫货、以及在多件候选里优先补套
export function setCompletionValue(candidate, equipped, equipSets) {
  const slot = candidate.equipTmpl?.slotType;
  if (!slot) return { value: 0, detail: '' };

  const cur = equipped.find(x => x.isEquipped && x.equipTmpl?.slotType === slot);
  const after0 = cur ? equipped.map(x => (x === cur ? candidate : x)) : [...equipped, candidate];

  const before = analyzeSets(equipped, equipSets);
  const after = analyzeSets(after0, equipSets);

  let value = 0;
  const detail = [];
  for (const a of after) {
    const b = before.find(x => x.name === a.name);
    const bActive = b ? b.active.length : 0;
    if (a.active.length > bActive) {
      const gain = a.score - (b ? b.score : 0);
      value += gain;
      const piece = a.active[a.active.length - 1];
      detail.push(`${a.name} ${b ? b.have : 0}→${a.have}件 (+${piece.pieces}件档 +${Math.round(gain)})`);
    }
  }
  return { value, detail: detail.join('; ') };
}

// ── 挂售定价 ──
// 依据实测行情（2026-11-14 商城样本）：
//   荒毒之暗香链 req47 2571分 → 473,000金  (184金/分)
//   水轮护符     req35 2264分 → 253,000金  (112金/分)
//   玉女之青峨腕 req54 4902分 → 405,000金  (83金/分)
//   无极之化血凝碧剑 req53 7534分 → 500,100金 (66金/分)
// 规律：金/分 随分数上升而下降（高端件单价效率低但总价高）
//
// 定价函数：分段线性，越贵的件每分单价越低
export function suggestPrice(item, opts = {}) {
  const v = itemValue(item, opts);
  const req = item.equipTmpl?.reqLevel || 1;
  if (v <= 0) return 1000;

  // 金/分的基准（分数越高越便宜）
  let perPoint;
  if (v < 1500) perPoint = 120;        // 低端：120 金/分
  else if (v < 3000) perPoint = 100;   // 中途
  else if (v < 5000) perPoint = 80;    // 中高
  else if (v < 8000) perPoint = 63;    // 高端
  else perPoint = 55;                   // 顶级

  let price = v * perPoint;

  // 等级加权：req50+ 更好卖（终局装备）
  if (req >= 50) price *= 1.15;
  else if (req < 30) price *= 0.5;

  // 心理价位取整
  const round = n => {
    if (n >= 1e6) return Math.round(n / 1e5) * 1e5;
    if (n >= 1e5) return Math.round(n / 1e4) * 1e4;
    if (n >= 1e4) return Math.round(n / 1e3) * 1e3;
    if (n >= 1e3) return Math.round(n / 100) * 100;
    return Math.round(n / 10) * 10;
  };
  return Math.max(500, round(price));
}
