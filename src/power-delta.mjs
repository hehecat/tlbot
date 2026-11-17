// 精确 ΔCP 差分：克隆当前快照，改一个变量后重算 computePower。
// 注意：computePower 不含星级/鉴定；技能等级不进入被动公式（effectConfig.base 固定），
// 所以这里只用于「强化 +1」「整套换装」这类 getBaseStats 可模拟的改动。
import { computePower, ENH } from '../core/lib-power.mjs';

const snap = g => ({
  role: { ...(g.role || {}) },
  equipments: (g.equipments || []).map(x => ({ ...x })),
  gemInfo: g.gemInfo || [],
  bagItems: g.bagItems || [],
  skills: g.skills || [],
  equipSets: g.equipSets || [],
  levelTmpls: g.levelTmpls || [],
});

export function powerOf(g) {
  const r = computePower(snap(g));
  return { power: r.power, note: r.note };
}

export function enhanceDelta(g, roleEquipId) {
  const before = powerOf(g);
  const s = snap(g);
  const it = s.equipments.find(x => String(x.id) === String(roleEquipId));
  if (!it) return { error: '找不到装备' };
  const from = Number(it.enhanceLevel || 0);
  if (from >= 9) return { error: '已 +9 封顶' };
  it.enhanceLevel = from + 1;
  const after = computePower(s);
  return {
    id: it.id, name: it.equipTmpl?.name, slot: it.equipTmpl?.slotType,
    from, to: from + 1, enhPct: ENH[from + 1],
    before: before.power, after: after.power,
    deltaCP: after.power == null ? null : after.power - before.power,
  };
}

export function enhanceCandidates(g) {
  const s = snap(g);
  const basePower = computePower(s).power;
  const out = [];
  for (const it of s.equipments.filter(x => x.isEquipped)) {
    const lv = Number(it.enhanceLevel || 0);
    if (lv >= 9) continue;
    it.enhanceLevel = lv + 1;
    const p = computePower(s).power;
    it.enhanceLevel = lv;
    if (p != null && basePower != null && p > basePower) out.push({ id: it.id, name: it.equipTmpl?.name, slot: it.equipTmpl?.slotType, from: lv, to: lv + 1, deltaCP: p - basePower });
  }
  return out.sort((a, b) => b.deltaCP - a.deltaCP);
}

export function greedyEnhance(g, steps = 1) {
  const s = snap(g);
  let cur = computePower(s).power;
  const chosen = [];
  for (let i = 0; i < steps; i++) {
    let best = null;
    for (const it of s.equipments.filter(x => x.isEquipped)) {
      const lv = Number(it.enhanceLevel || 0);
      if (lv >= 9) continue;
      it.enhanceLevel = lv + 1;
      const p = computePower(s).power;
      it.enhanceLevel = lv;
      const d = p != null && cur != null ? p - cur : 0;
      if (d > 0 && (!best || d > best.deltaCP)) best = { id: it.id, name: it.equipTmpl?.name, from: lv, to: lv + 1, deltaCP: d, item: it };
    }
    if (!best) break;
    best.item.enhanceLevel = best.to;
    cur += best.deltaCP;
    chosen.push({ id: best.id, name: best.name, from: best.from, to: best.to, deltaCP: best.deltaCP });
  }
  return { totalDeltaCP: chosen.reduce((a, x) => a + x.deltaCP, 0), steps: chosen };
}

export function equipSetDelta(g, roleEquipIds) {
  const before = powerOf(g);
  const s = snap(g);
  for (const id of roleEquipIds) {
    const it = s.equipments.find(x => String(x.id) === String(id));
    if (!it) return { error: `找不到装备 ${id}` };
    const slot = it.equipTmpl?.slotType;
    for (const e of s.equipments) if (e.equipTmpl?.slotType === slot) e.isEquipped = 0;
    it.isEquipped = 1;
  }
  const after = computePower(s);
  return { before: before.power, after: after.power, deltaCP: after.power == null ? null : after.power - before.power };
}
