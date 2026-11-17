// 套装联合求解：computePower 只在整套集齐时计入 set.effects，单件评估看不到。
// 这里枚举 52 套：已穿几件、缺几件、背包/仓库是否集齐缺件，模拟整套换装后的本地 ΔCP。
// 警告：computePower 不含星级/鉴定；结果只作候选，必须用官方评分或实战 KPM 复核。
import { computePower } from '../core/lib-power.mjs';

const clone = g => ({
  role: { ...(g.role || {}) },
  equipments: (g.equipments || []).map(x => ({ ...x, equipTmpl: x.equipTmpl || {} })),
  gemInfo: g.gemInfo || [], skills: g.skills || [],
  equipSets: g.equipSets || [], levelTmpls: g.levelTmpls || [],
});

export function planSets(g) {
  const base = clone(g);
  const cur = computePower(base).power;
  const equipped = base.equipments.filter(x => x.isEquipped);
  const pool = base.equipments.filter(x => !x.isEquipped);
  const out = [];
  for (const set of g.equipSets || []) {
    let ids = []; try { ids = JSON.parse(set.equipTmplIds || '[]').map(Number); } catch { }
    if (!ids.length) continue;
    const own = ids.filter(id => equipped.some(e => Number(e.tmplId) === id));
    const missing = ids.filter(id => !equipped.some(e => Number(e.tmplId) === id));
    if (!missing.length) continue;
    const picked = [];
    for (const id of missing) {
      const c = pool.find(x => Number(x.tmplId) === id) || equipped.find(x => Number(x.tmplId) === id);
      if (c) picked.push(c);
    }
    const completable = picked.length === missing.length;
    let deltaCP = null;
    if (completable) {
      const s = clone(g);
      for (const c of picked) {
        const slot = c.equipTmpl?.slotType;
        for (const e of s.equipments) if (e.equipTmpl?.slotType === slot) e.isEquipped = 0;
        const target = s.equipments.find(e => String(e.id) === String(c.id));
        if (target) target.isEquipped = 1;
      }
      deltaCP = computePower(s).power - cur;
    }
    out.push({
      set: set.name, id: set.id, need: ids.length, owned: own.length, missing: missing.length,
      missingTmplIds: missing, completable, deltaCP,
      pieces: picked.map(x => ({ id: x.id, name: x.equipTmpl?.name, slot: x.equipTmpl?.slotType })),
    });
  }
  return { power: cur, sets: out.sort((a, b) => (b.deltaCP ?? -1e9) - (a.deltaCP ?? -1e9)) };
}
