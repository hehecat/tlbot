// src/map-eval.mjs —— 地图挂机 EV/h（Expected ΔCP per hour）
//
// 对应「第二层：地图挂机效率德尔塔」。只用实测数据：
//   · 经验/h：state-store 按地图累计（map-stats.json）
//   · 金币/h、物品/h：live_drops.json 的 byMap（真实掉落，按 firstAt→lastAt 计窗口）
// 物品的 ΔV 需要实例品质（掉落记录只存名字/实例 id），暂不计入 CP/h，
// 只输出 drops 列表与 setHits（掉到当前未凑齐套装部件的次数），供 System2 人工判断。
//
// 权重默认值可由 /plan 的实测速率回填：xpCpPerMexp=24（当前喂 SECOND 的边际）。

import fs from 'node:fs';
import path from 'node:path';
import { computePower } from '../core/lib-power.mjs';

export const DEFAULT_MAP_WEIGHTS = {
  xpCpPerMexp: 24.2,   // 1M 角色经验 → 战力（由 /plan 实测覆盖）
  goldCpPer1000: 2,    // 1000 金币 → 战力（拍卖行近似）
  minHours: 0.25,      // 样本不足 15 分钟的图不出结论
  essenceCp: 629,      // 高级强化精华单颗精确边际（可由 planner 覆盖）
  eggEvCp: 450,        // 单颗珍兽蛋管线折现 CP
  anqiStoneExp: 500_000, // 飞蝗石折算暗器经验
  emaAlpha: 0.65,      // 近期窗口与累计均值的混合权重
};

// planner 可实时回写影子价格，避免 /maps/ev 自己猜边际
const DYNAMIC = {};
export function updateShadowWeights(patch = {}) {
  for (const k of ['xpCpPerMexp', 'goldCpPer1000', 'essenceCp', 'eggEvCp']) {
    const v = Number(patch[k]);
    if (Number.isFinite(v) && v >= 0) DYNAMIC[k] = v;
  }
  return { ...DEFAULT_MAP_WEIGHTS, ...DYNAMIC };
}
const effectiveWeights = overrides => ({ ...DEFAULT_MAP_WEIGHTS, ...DYNAMIC, ...(overrides || {}) });

function hoursBetween(a, b) {
  const t1 = Date.parse(a || 0), t2 = Date.parse(b || 0);
  if (!t1 || !t2 || t2 <= t1) return 0;
  return (t2 - t1) / 3_600_000;
}

// 用 computePower 精确差分每套缺件的边际 ΔCP；缺 2/3 件按接近度折减
function buildSetMarginals(equipSets, powerCtx, tmplById) {
  const map = new Map();
  const ctx = powerCtx || {};
  if (!ctx.role || !Array.isArray(ctx.levelTmpls) || !ctx.levelTmpls.length) return map;
  const worn = (ctx.equipments || []).filter(x => x.isEquipped);
  const owned = new Set(worn.map(x => Number(x.tmplId)));
  const base = {
    role: ctx.role, equipments: worn, gemInfo: ctx.gemInfo || [],
    bagItems: ctx.bagItems || [], skills: ctx.skills || [],
    levelTmpls: ctx.levelTmpls, equipSets: [],
  };
  const basePower = computePower(base).power;
  if (basePower == null) return map;
  for (const st of equipSets || []) {
    let ids = []; try { ids = JSON.parse(st.equipTmplIds || '[]').map(Number); } catch { }
    if (!ids.length) continue;
    const missing = ids.filter(id => !owned.has(id));
    if (!missing.length) continue;
    const mocks = missing.map(id => ({ tmplId: id, isEquipped: true, equipTmpl: tmplById.get(id) })).filter(x => x.equipTmpl);
    if (!mocks.length) continue;
    const withSet = computePower({ ...base, equipments: [...worn, ...mocks], equipSets: [st] }).power;
    if (withSet == null) continue;
    const bonus = Math.max(0, withSet - basePower);
    const discount = missing.length <= 1 ? 1 : missing.length === 2 ? 0.65 : 0.35;
    const per = Math.round(bonus / missing.length * discount);
    for (const id of missing) map.set(id, { set: st.name, missingCount: missing.length, setBonusCp: bonus, marginalCp: per });
  }
  return map;
}

function materialUnitCp(name, w) {
  if (!name) return 0;
  if (/高级强化精华/.test(name)) return w.essenceCp;
  if (/强化精华/.test(name)) return Math.round(w.essenceCp * 0.25);
  if (/飞蝗石/.test(name)) return +(w.anqiStoneExp / 1e6 * w.xpCpPerMexp).toFixed(1);
  if (/珍兽蛋/.test(name)) return w.eggEvCp;
  if (/宝石/.test(name)) return 120;
  return 0;
}

// 判断某物品名是否属于「当前缺的套装部件」
function setHitInfo(name, equipSets, equipped, tmplNameById) {
  if (!name || !Array.isArray(equipSets) || !tmplNameById?.size) return null;
  const owned = new Set((equipped || []).map(x => Number(x.tmplId ?? x.equipTmpl?.id)));
  for (const st of equipSets) {
    let ids = [];
    try { ids = JSON.parse(st.equipTmplIds || '[]').map(Number); } catch { }
    if (!ids.length) continue;
    for (const tmplId of ids) {
      if (tmplNameById.get(tmplId) === name) return { set: st.name, tmplId, ownedBefore: owned.has(tmplId) };
    }
  }
  return null;
}

export function evalMaps({ drops, mapStats, equipSets, equipped, templates, weights = {}, powerCtx = null } = {}) {
  const w = effectiveWeights(weights);
  const tmplById = new Map((templates || []).map(t => [Number(t.id), t]));
  const tmplNameById = new Map((templates || []).map(t => [Number(t.id), t.name]));
  const setMarginal = buildSetMarginals(equipSets, powerCtx, tmplById);
  const byMap = drops?.byMap || {};
  const out = [];
  for (const [mapId, bucket] of Object.entries(byMap)) {
    if (!bucket || typeof bucket !== 'object') continue;
    const times = Object.values(bucket)
      .flatMap(e => [e?.firstAt, e?.lastAt]).filter(Boolean).map(Date.parse).filter(Number.isFinite);
    if (!times.length) continue;
    const hours = Math.max(0.01, (Math.max(...times) - Math.min(...times)) / 3_600_000);
    const gold = Number(bucket['金币']?.count || 0);
    const items = Object.entries(bucket).filter(([n]) => n !== '金币')
      .map(([name, e]) => {
        const sh = setHitInfo(name, equipSets, equipped, tmplNameById);
        const sm = sh ? setMarginal.get(Number(sh.tmplId)) : null;
        const mat = materialUnitCp(name, w);
        const unitEv = (sm && !sh.ownedBefore ? sm.marginalCp : 0) + mat;
        const perHour = Number(e.count || 0) / hours;
        return { name, count: Number(e.count || 0), perHour, setHit: sh, setMarginal: sm || null, unitEvCp: unitEv, evCpPerHour: perHour * unitEv };
      })
      .sort((a, b) => b.evCpPerHour - a.evCpPerHour || b.perHour - a.perHour);

    const ms = mapStats?.[mapId];
    const xpHours = ms ? hoursBetween(ms.firstAt, ms.lastAt) : 0;
    const xpReady = ms && xpHours >= w.minHours;
    // 近期窗口优先：mapStats.recent 是逐次采样，避免三天前低战力数据拉低均值
    let xpPerHour = xpReady ? Number(ms.exp || 0) / xpHours : 0;
    let xpWindowMin = xpReady ? Math.round(xpHours * 60) : 0;
    const rs = (ms?.recent || []).filter(x => Number.isFinite(x?.at) && Number.isFinite(x?.exp));
    const cutoff = Date.now() - 30 * 60_000;
    const tail = rs.filter(x => x.at >= cutoff);
    if (tail.length >= 2) {
      const rh = (tail[tail.length - 1].at - tail[0].at) / 3_600_000;
      if (rh >= 0.08) {
        const recent = tail.reduce((a, x) => a + x.exp, 0) / rh;
        // 近期优先；样本足够时按 alpha 与累计混合，防止单窗噪声
        xpPerHour = xpReady ? (w.emaAlpha * recent + (1 - w.emaAlpha) * (Number(ms.exp || 0) / xpHours)) : recent;
        xpWindowMin = Math.round(rh * 60);
      }
    }
    const goldPerHour = gold / hours;
    const dropHours = hours;
    const dropCpPerHour = dropHours >= w.minHours ? items.reduce((a, x) => a + (x.evCpPerHour || 0), 0) : 0;
    const cpPerHour = xpPerHour / 1e6 * w.xpCpPerMexp + goldPerHour / 1000 * w.goldCpPer1000 + dropCpPerHour;
    out.push({
      mapId, hours: Math.round(hours * 100) / 100,
      xpHours: Math.round(xpHours * 100) / 100,
      xpPerHour: Math.round(xpPerHour), xpWindowMin, xpReady: !!xpReady, goldPerHour: Math.round(goldPerHour),
      cpPerHour: Math.round(cpPerHour * 10) / 10,
      xpCpPerHour: Math.round(xpPerHour / 1e6 * w.xpCpPerMexp * 10) / 10,
      goldCpPerHour: Math.round(goldPerHour / 1000 * w.goldCpPer1000 * 10) / 10,
      dropCpPerHour: Math.round(dropCpPerHour * 10) / 10,
      enough: hours >= w.minHours && xpHours >= w.minHours,
      drops: items.slice(0, 8).map(x => ({ name: x.name, perHour: Math.round(x.perHour * 100) / 100, unitEvCp: x.unitEvCp || undefined, setHit: x.setHit || undefined })),
      setHits: items.filter(x => x.setHit && !x.setHit.ownedBefore).slice(0, 5).map(x => ({ name: x.name, set: x.setHit.set, perHour: Math.round(x.perHour * 100) / 100, missingCount: x.setMarginal?.missingCount, marginalCp: x.setMarginal?.marginalCp, evCpPerHour: Math.round((x.evCpPerHour || 0) * 10) / 10 })),
    });
  }
  return out.filter(x => x.mapId !== 'unknown').sort((a, b) => b.cpPerHour - a.cpPerHour);
}

export function loadMapStats(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'map-stats.json'), 'utf8')) || {}; } catch { return {}; }
}
