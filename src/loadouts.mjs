// 双配装快照（Farm / Peak）：只负责记录与对比，不自动换装。
// 自动切换必须整套验证（官方评分/实战 KPM），否则会掉进单件局部最优。
import fs from 'node:fs';
import path from 'node:path';
import { computePower } from '../core/lib-power.mjs';

const DATA = process.env.TL_DATA_DIR || path.resolve(import.meta.dirname, '..', 'data');
const F = path.join(DATA, 'loadouts.json');
const load = () => { try { return JSON.parse(fs.readFileSync(F, 'utf8')) || {}; } catch { return {}; } };
const save = o => { try { fs.writeFileSync(F, JSON.stringify(o, null, 1)); } catch { } };

export function snapshot(g, name = 'current') {
  const worn = (g.equipments || []).filter(x => x.isEquipped).map(x => ({
    id: x.id, tmplId: x.tmplId, name: x.equipTmpl?.name, slot: x.equipTmpl?.slotType,
    q: x.quality, enh: x.enhanceLevel, star: x.starLevel,
  }));
  const power = computePower({
    role: g.role, equipments: g.equipments, gemInfo: g.gemInfo, bagItems: g.bagItems || [], skills: g.skills,
    equipSets: g.equipSets, levelTmpls: g.levelTmpls,
  }).power;
  const all = load();
  all[name] = { name, at: new Date().toISOString(), power, worn };
  save(all);
  return all[name];
}

export function list() { return load(); }

export function diff(a, b) {
  const all = load();
  const A = all[a], B = all[b];
  if (!A || !B) return { error: '缺少配装' };
  const slots = [];
  for (let s = 1; s <= 12; s++) {
    const x = A.worn.find(w => w.slot === s), y = B.worn.find(w => w.slot === s);
    if (x?.id !== y?.id) slots.push({ slot: s, a: x?.name || null, b: y?.name || null });
  }
  return { a: { name: a, power: A.power }, b: { name: b, power: B.power }, slots };
}
