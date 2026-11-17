// 实战性能采样：按“当前装备组合”自动分组，统计真实单位时间收益。
// 不依赖服务器战力；exp/gold/kills 用相邻采样的正向增量（花费导致的负增量忽略）。
import fs from 'node:fs';

export function createPerformance({ maxPoints = 720 } = {}) {
  const points = [];
  let lastSave = 0;

  function loadoutOf(g, equipSource) {
    const eqs = g?.equipments || equipSource?.equipments || [];
    const ids = eqs.filter(x => x.isEquipped).map(x => String(x.id)).sort();
    return ids.join(',') || 'none';
  }

  function sample(g, equipSource) {
    if (!g) return null;
    const role = g.me || g.role || {};
    const combat = g.combat || {};
    const now = Date.now();
    const p = {
      at: now,
      exp: Number(role.exp ?? role.currentExp) || 0,
      gold: Number(role.gold ?? role.money) || 0,
      kills: Number(combat.defeated) || 0,
      cp: Number(role.power ?? role.combatPower) || 0,
      mapId: combat.mapId ?? role.mapId ?? null,
      loadout: loadoutOf(g, equipSource),
    };
    const prev = points[points.length - 1];
    if (prev && now - prev.at < 3000) { Object.assign(prev, p); return prev; }
    points.push(p);
    if (points.length > maxPoints) points.splice(0, points.length - maxPoints);
    return p;
  }

  function report(minutes = 60) {
    const since = Date.now() - minutes * 60_000;
    const ps = points.filter(p => p.at >= since);
    const groups = new Map();
    for (let i = 1; i < ps.length; i++) {
      const a = ps[i - 1], b = ps[i];
      const dtH = (b.at - a.at) / 3_600_000;
      const dtMin = (b.at - a.at) / 60_000;
      if (dtH <= 0 || dtH > 0.1) continue; // 间隔 >6min 视为断线，跳过
      const key = b.loadout;
      const g0 = groups.get(key) || { loadout: key, cp: b.cp, minutes: 0, exp: 0, gold: 0, kills: 0, samples: 0, mapIds: new Set() };
      g0.cp = b.cp; g0.minutes += dtMin; g0.samples++;
      g0.exp += Math.max(0, b.exp - a.exp);
      g0.gold += Math.max(0, b.gold - a.gold);
      if (b.kills >= a.kills) g0.kills += b.kills - a.kills;
      if (b.mapId != null) g0.mapIds.add(b.mapId);
      groups.set(key, g0);
    }
    const rows = [...groups.values()].map(x => ({
      loadout: x.loadout, cp: x.cp, minutes: +x.minutes.toFixed(1), samples: x.samples,
      mapIds: [...x.mapIds],
      xpPerHour: x.minutes > 0 ? Math.round(x.exp / (x.minutes / 60)) : 0,
      goldPerHour: x.minutes > 0 ? Math.round(x.gold / (x.minutes / 60)) : 0,
      killsPerMin: x.minutes > 0 ? +(x.kills / x.minutes).toFixed(1) : 0,
    })).sort((a, b) => b.minutes - a.minutes);
    return { at: new Date().toISOString(), windowMinutes: minutes, points: ps.length, rows };
  }

  function save(file) {
    const now = Date.now();
    if (now - lastSave < 30_000) return;
    lastSave = now;
    try { fs.writeFileSync(file, JSON.stringify(points.slice(-maxPoints))); } catch { }
  }

  return { sample, report, save, points };
}
