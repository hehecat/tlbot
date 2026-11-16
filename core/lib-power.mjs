// 战力计算共享库（公式来源：客户端 ESM 包）
export const ENH = { 1: 10, 2: 20, 3: 30, 4: 45, 5: 65, 6: 90, 7: 120, 8: 155, 9: 195 };
const BASE_KEYS = ['hp', 'mp', 'extAtk', 'intAtk', 'extDef', 'intDef', 'critRate', 'critDef', 'avoidance', 'precision',
  'iceAtk', 'fireAtk', 'poisonAtk', 'holyAtk', 'iceDef', 'fireDef', 'poisonDef', 'holyDef'];

// 名称归一化：ext_atk / extAtk / EXT_ATK → extAtk
const canon = s => {
  const k = String(s).replace(/[_-]/g, '').toLowerCase();
  const map = { hp: 'hp', mp: 'mp', extatk: 'extAtk', intatk: 'intAtk', extdef: 'extDef', intdef: 'intDef', critrate: 'critRate', critdef: 'critDef', avoidance: 'avoidance', precision: 'precision', iceatk: 'iceAtk', fireatk: 'fireAtk', poisonatk: 'poisonAtk', holyatk: 'holyAtk', icedef: 'iceDef', firedef: 'fireDef', poisndef: 'poisonDef', holydef: 'holyDef', allatk: 'all_atk', alldef: 'all_def' };
  return map[k] || null;
};

export function computePower(data) {
  const x = {}; BASE_KEYS.forEach(k => x[k] = 0);
  const lv = (data.levelTmpls || []).find(t => t.level === data.role.level);
  if (!lv) return { power: null, attrs: x, note: '缺少等级模板' };
  BASE_KEYS.forEach(k => { if (typeof lv[k] === 'number') x[k] = lv[k]; });
  x.level = data.role.level;

  const add = (key, v) => {
    const c = canon(key);
    if (!c) return;
    if (c === 'all_atk') { x.iceAtk += v; x.fireAtk += v; x.holyAtk += v; x.poisonAtk += v; return; }
    if (c === 'all_def') { x.iceDef += v; x.fireDef += v; x.holyDef += v; x.poisonDef += v; return; }
    if (x[c] !== undefined) x[c] += v;
  };

  const equipped = (data.equipments || []).filter(e => e.isEquipped);
  for (const it of equipped) {
    const t = it.equipTmpl || {};
    const mult = 1 + (ENH[it.enhanceLevel || 0] || 0) / 100;
    try {
      const b = JSON.parse(t.baseStats || '{}');
      for (const [k, v] of Object.entries(b)) {
        const num = typeof v === 'number' ? v : Number(v) || 0;
        add(k, Math.round(num * mult));
      }
    } catch { }
    try {
      const ex = JSON.parse(it.extraStats || '{}');
      for (const [k, v] of Object.entries(ex)) if (typeof v === 'number') add(k, v);
    } catch { }
    // 宝石
    try {
      const slots = JSON.parse(it.gemSlots || '[]');
      const gemMap = {};
      for (const g of (data.gemInfo || [])) gemMap[g.id] = g;
      for (const gid of slots) {
        const g = gemMap[gid];
        if (g && typeof g.value === 'number') {
          const attrMap = { 0: 'extAtk', 1: 'intAtk', 2: 'extDef', 3: 'intDef' };
          const key = attrMap[g.subType];
          if (key) x[key] += g.value;
        }
      }
    } catch { }
  }

  // 被动技能
  for (const s of (data.skills || [])) {
    if (s.skillDetail?.type !== 3 || !s.skillDetail?.effectConfig) continue;
    try {
      for (const eff of JSON.parse(s.skillDetail.effectConfig)) {
        if (eff.type !== 'PASSIVE_STAT') continue;
        const c = canon(eff.attr);
        if (!c || x[c] === undefined) continue;
        if (eff.calc === 'MULTIPLY') x[c] = Math.ceil(x[c] * (1 + eff.base));
        else if (eff.calc === 'PLUS') x[c] += eff.base;
      }
    } catch { }
  }

  // 套装（必须集齐整套）
  for (const set of (data.equipSets || [])) {
    let ids = []; try { ids = JSON.parse(set.equipTmplIds || '[]'); } catch { }
    if (!ids.length) continue;
    const own = ids.filter(id => equipped.some(e => e.tmplId === id));
    if (own.length !== ids.length) continue;
    try {
      for (const [k, v] of Object.entries(JSON.parse(set.effects || '{}'))) if (typeof v === 'number') add(k, v);
    } catch { }
  }

  const power = Math.floor(
    x.hp * 0.3 + x.mp * 0.2
    + (x.extAtk + x.intAtk) * 4
    + (x.extDef + x.intDef) * 3
    + (x.critRate + x.precision) * 5
    + (x.critDef + x.avoidance) * 3
    + (x.iceAtk + x.fireAtk + x.poisonAtk + x.holyAtk) * 2
    + (x.iceDef + x.fireDef + x.poisonDef + x.holyDef) * 1.5
  );
  return { power, attrs: x, note: '' };
}


