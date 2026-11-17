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
    // 宝石：subType 1..18 是客户端 GEM 属性表（BB）
    try {
      const slots = JSON.parse(it.gemSlots || '[]');
      const gemMap = {};
      for (const g of (data.gemInfo || [])) gemMap[g.itemId ?? g.id] = g;
      // ENTER_GAME 的 bagItems 里带 itemTmpl.subType/value，用它补全已镶嵌宝石
      if (!data.gemInfo?.length) {
        for (const b of (data.bagItems || [])) {
          const id = Number(b.itemId);
          if (id >= 4000 && id < 4100 && b.itemTmpl) gemMap[id] = { id, subType: b.itemTmpl.subType, value: b.itemTmpl.value };
        }
      }
      const attrMap = {
        1: 'hp', 2: 'mp', 3: 'ext_atk', 4: 'int_atk', 5: 'ext_def', 6: 'int_def',
        7: 'precision', 8: 'avoidance', 9: 'crit_rate', 10: 'crit_def',
        11: 'ice_atk', 12: 'fire_atk', 13: 'poison_atk', 14: 'holy_atk',
        15: 'ice_def', 16: 'fire_def', 17: 'poison_def', 18: 'holy_def',
      };
      for (const gid of slots) {
        const g = gemMap[gid];
        const key = g && attrMap[g.subType];
        if (key && typeof g.value === 'number') add(key, g.value);
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
        const lv = Math.max(1, Number(s.currentLevel) || 1);
        const grow = Number(eff.grow) || 0;
        const val = eff.calc === 'PLUS' ? Number(eff.base) + grow * (lv - 1) : Number(eff.base);
        if (eff.calc === 'MULTIPLY') x[c] = Math.ceil(x[c] * (1 + val));
        else if (eff.calc === 'PLUS') x[c] += val;
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


