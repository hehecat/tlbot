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

export const DEFAULT_MAP_WEIGHTS = {
  xpCpPerMexp: 24.2,   // 1M 角色经验 → 战力（当前练 SECOND 实测 24.2 CP/M）
  goldCpPer1000: 2,    // 1000 金币 → 战力（拍卖行可买装备的近似折算）
  minHours: 0.25,      // 样本不足 15 分钟的图不出结论
};

function hoursBetween(a, b) {
  const t1 = Date.parse(a || 0), t2 = Date.parse(b || 0);
  if (!t1 || !t2 || t2 <= t1) return 0;
  return (t2 - t1) / 3_600_000;
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

export function evalMaps({ drops, mapStats, equipSets, equipped, templates, weights = {} } = {}) {
  const w = { ...DEFAULT_MAP_WEIGHTS, ...weights };
  const tmplNameById = new Map((templates || []).map(t => [Number(t.id), t.name]));
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
      .map(([name, e]) => ({
        name, count: Number(e.count || 0), perHour: Number(e.count || 0) / hours,
        setHit: setHitInfo(name, equipSets, equipped, tmplNameById),
      }))
      .sort((a, b) => b.perHour - a.perHour);

    const ms = mapStats?.[mapId];
    const xpHours = ms ? hoursBetween(ms.firstAt, ms.lastAt) : 0;
    const xpReady = ms && xpHours >= w.minHours;
    const xpPerHour = xpReady ? Number(ms.exp || 0) / xpHours : 0;
    const goldPerHour = gold / hours;
    const cpPerHour = xpPerHour / 1e6 * w.xpCpPerMexp + goldPerHour / 1000 * w.goldCpPer1000;
    out.push({
      mapId, hours: Math.round(hours * 100) / 100,
      xpHours: Math.round(xpHours * 100) / 100,
      xpPerHour: Math.round(xpPerHour), xpReady: !!xpReady, goldPerHour: Math.round(goldPerHour),
      cpPerHour: Math.round(cpPerHour * 10) / 10,
      enough: hours >= w.minHours && xpHours >= w.minHours,
      drops: items.slice(0, 8).map(x => ({ name: x.name, perHour: Math.round(x.perHour * 100) / 100, setHit: x.setHit || undefined })),
      setHits: items.filter(x => x.setHit && !x.setHit.ownedBefore).slice(0, 5).map(x => ({ name: x.name, set: x.setHit.set, perHour: Math.round(x.perHour * 100) / 100 })),
    });
  }
  return out.sort((a, b) => b.cpPerHour - a.cpPerHour);
}

export function loadMapStats(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'map-stats.json'), 'utf8')) || {}; } catch { return {}; }
}
