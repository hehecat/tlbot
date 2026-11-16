// src/resolver.mjs —— 递归目标解析器（Dependency Resolver）
//
// 目标：Pi 只说「我要凑齐某套 / 某件装备 / 某材料」，这里直接回答：
//   背包/仓库/已穿戴有没有？ → 差多少？
//   → 有配方就递归拆材料
//   → 没配方就查 drops.json + live_drops.json，返回 mapId / monsterId
//
// 数据文件（data/）：
//   templates.json  _tpl.json（装备模板）
//   setdata.json    套装定义
//   drops.json      地图 → 掉落表（旧数据，按地图名）
//   live_drops.json 实测掉落累积（按 mapId）
//   maps.json       可选：地图名 → mapId 缓存（ENTER_GAME 会自动补）
//   recipes.json    可选：{ [tmplId]: [{ itemId|name, count }] }
//
// 纯函数，不发包。供 logistics / tool 层调用。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = process.env.TL_DATA_DIR ? path.resolve(process.env.TL_DATA_DIR) : path.join(ROOT, 'data');

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();

// 已知地图兜底（完整表由 ENTER_GAME 的 maps 提供）
const KNOWN_MAPS = {
  丹霞岭: 10027, 玄武岛外滩: 20080, 伪宋军领地: 20051, 珍珑棋局: 20050,
  苏州: 5, 洛阳: 4, 无量山外围: 1, 剑阁外围: 2,
};

let cache = null;
export function loadResolverData(force = false) {
  if (cache && !force) return cache;
  const templates = readJson(path.join(DATA, 'templates.json')) || {};
  const setdata = readJson(path.join(DATA, 'setdata.json')) || {};
  const drops = readJson(path.join(DATA, 'drops.json')) || {};
  const live = readJson(path.join(DATA, 'live_drops.json')) || { byMap: {} };
  const maps = readJson(path.join(DATA, 'maps.json')) || {};
  const recipes = readJson(path.join(DATA, 'recipes.json')) || {};
  cache = { templates, sets: setdata.equipSets || [], drops, live, maps, recipes };
  return cache;
}

function buildMaps(game, data) {
  const byName = new Map();
  const byId = new Map();
  for (const [name, id] of Object.entries(data.maps || {})) byName.set(name, { name, id });
  for (const [name, id] of Object.entries(KNOWN_MAPS)) if (!byName.has(name)) byName.set(name, { name, id });
  for (const m of game?.maps || []) {
    if (!m?.name || m.id == null) continue;
    byName.set(m.name, m);
    byId.set(m.id, m);
  }
  return { byName, byId };
}

function warehouseItems(game) {
  const candidates = [
    game?.warehouseItems, game?.storageItems, game?.roleWarehouseItems,
    game?.warehouse?.items, game?.warehouse,
  ];
  for (const c of candidates) if (Array.isArray(c)) return c;
  return [];
}

function findTemplate(ref, templates) {
  if (ref == null) return null;
  if (typeof ref === 'number') return templates[ref] || null;
  if (typeof ref === 'object') {
    if (ref.tmplId != null && templates[ref.tmplId]) return templates[ref.tmplId];
    if (ref.id != null && templates[ref.id]) return templates[ref.id];
    ref = ref.name || ref.item;
  }
  const name = String(ref || '');
  if (templates[name]) return templates[name];
  const n = norm(name);
  for (const t of Object.values(templates)) if (norm(t.name) === n) return t;
  for (const t of Object.values(templates)) if (norm(t.name).includes(n) || n.includes(norm(t.name))) return t;
  return null;
}

function ownedCount(tmpl, game) {
  let n = 0;
  const name = norm(tmpl?.name);
  const match = (x) => {
    if (tmpl.id != null && (x.itemId === tmpl.id || x.tmplId === tmpl.id)) return true;
    if (tmpl.id == null && name && norm(x.itemTmpl?.name || x.name).includes(name)) return true;
    return false;
  };
  for (const e of game?.equipments || []) if (tmpl.id != null && e.tmplId === tmpl.id) n++;
  for (const b of game?.bagItems || []) if (match(b)) n += Number(b.count || 1);
  for (const w of warehouseItems(game)) if (match(w)) n += Number(w.count || 1);
  return n;
}

function buildDropIndex(drops) {
  const byItem = new Map();
  for (const [mapName, m] of Object.entries(drops || {})) {
    for (const d of m?.drops || []) {
      const key = norm(d.item);
      if (!byItem.has(key)) byItem.set(key, []);
      byItem.get(key).push({
        mapName, mapReq: m.req ?? null, cat: d.cat, monsterId: d.monsterId,
        item: d.item, rate: d.rate, count: d.count,
      });
    }
  }
  return byItem;
}

function liveCount(live, mapId, itemName) {
  const bucket = live?.byMap?.[String(mapId)] || live?.byMap?.[mapId];
  if (!bucket) return 0;
  const exact = bucket[itemName]?.count || 0;
  if (exact) return exact;
  const n = norm(itemName);
  for (const [k, v] of Object.entries(bucket)) if (norm(k) === n) return v?.count || 0;
  return 0;
}

function findSources(tmpl, data, maps, game) {
  const dropIndex = buildDropIndex(data.drops);
  const roleLevel = game?.role?.level ?? 1;
  const names = new Set();
  if (tmpl?.name) names.add(norm(tmpl.name));
  // 装备类掉落常写成「50级装备」「套装」而不是具体名字
  const req = tmpl?.reqLevel;
  const candidates = [];
  for (const [key, arr] of dropIndex) {
    let hit = names.has(key);
    if (!hit && tmpl?.name && (key.includes(norm(tmpl.name)) || norm(tmpl.name).includes(key))) hit = true;
    // 「46-56级装备」这类区间掉落：装备模板的 reqLevel 落在区间内即算
    if (!hit && req && /装备/.test(key)) {
      const m = key.match(/(\d+)\s*-\s*(\d+)级装备/);
      if (m && req >= Number(m[1]) && req <= Number(m[2])) hit = true;
      const one = key.match(/(\d+)级装备/);
      if (!hit && one && req === Number(one[1])) hit = true;
      if (!hit && tmpl?.suitType && /套装/.test(key)) hit = true;
    }
    if (!hit) continue;
    for (const d of arr) {
      const map = maps.byName.get(d.mapName);
      const mapId = map?.id ?? null;
      const reqOk = d.mapReq == null || d.mapReq <= roleLevel + 5;
      candidates.push({
        mapId, mapName: d.mapName, monsterId: d.monsterId, cat: d.cat,
        item: d.item, mapReq: d.mapReq, reqOk,
        live: mapId != null ? liveCount(data.live, mapId, d.item) : 0,
      });
    }
  }
  // 去重
  const seen = new Set();
  const uniq = candidates.filter(c => {
    const k = `${c.mapId}|${c.monsterId}|${c.item}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  // 排序：实测掉落量 > 等级适配 > 地图等级高 > LEADER 优先
  uniq.sort((a, b) => {
    if (b.live !== a.live) return b.live - a.live;
    if (a.reqOk !== b.reqOk) return a.reqOk ? -1 : 1;
    if ((b.mapReq ?? 0) !== (a.mapReq ?? 0)) return (b.mapReq ?? 0) - (a.mapReq ?? 0);
    if (a.cat !== b.cat) return a.cat === 'LEADER' ? -1 : 1;
    return 0;
  });
  return uniq.map(c => ({
    ...c,
    reason: c.live
      ? `live_drops 实测 ${c.live} 个`
      : `${c.mapName}${c.cat === 'LEADER' ? ' 首领' : ' 小怪'}掉落`,
  }));
}

function findRecipe(tmpl, data) {
  const r = data.recipes?.[tmpl.id] || data.recipes?.[tmpl.name];
  if (Array.isArray(r) && r.length) return r;
  for (const k of ['needItems', 'materials', 'recipe', 'craftItems', 'composeItems']) {
    const v = tmpl[k];
    if (Array.isArray(v) && v.length) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); if (Array.isArray(p) && p.length) return p; } catch { } }
  }
  return null;
}

// 主入口
export function resolveTarget(target, game, opts = {}) {
  const data = opts.data || loadResolverData();
  const maps = buildMaps(game, data);
  const count = Number(target?.count ?? opts.count ?? 1) || 1;
  const out = {
    target: typeof target === 'object' ? { ...target } : target,
    ok: false, have: [], missing: [], farm: [], steps: [], unknown: [],
    mapsResolved: maps.byName.size,
  };
  const visited = new Set();

  const resolveOne = (ref, need, depth, parent) => {
    if (depth > 6) { out.unknown.push({ item: String(ref), reason: '递归过深' }); return; }
    let tmpl = findTemplate(ref, data.templates);
    if (!tmpl) {
      const name = typeof ref === 'object' ? (ref.name || ref.item) : (typeof ref === 'string' ? ref : null);
      if (!name) {
        out.unknown.push({ item: JSON.stringify(ref), reason: '模板未找到', parent });
        return;
      }
      // 非装备模板（材料/消耗品）：用名字做伪模板，仍可查掉落
      tmpl = { id: null, name, reqLevel: null };
    }
    const vkey = tmpl.id != null ? `id:${tmpl.id}` : `name:${norm(tmpl.name)}`;
    if (visited.has(vkey)) return;
    visited.add(vkey);

    const have = ownedCount(tmpl, game);
    const missing = Math.max(0, need - have);
    if (missing === 0) {
      out.have.push({ item: tmpl.name, tmplId: tmpl.id, need, have });
      return;
    }
    out.missing.push({ item: tmpl.name, tmplId: tmpl.id, need, have, missing, parent });

    const recipe = findRecipe(tmpl, data);
    if (recipe) {
      out.steps.push({ type: 'craft', item: tmpl.name, tmplId: tmpl.id, missing, recipe });
      for (const r of recipe) {
        const childRef = r.itemId ?? r.tmplId ?? r.name ?? r.item;
        const childCount = Number(r.count ?? r.num ?? 1) || 1;
        resolveOne(childRef, childCount * missing, depth + 1, tmpl.name);
      }
      return;
    }

    const sources = findSources(tmpl, data, maps, game);
    if (sources.length) {
      const best = sources[0];
      out.farm.push({ item: tmpl.name, tmplId: tmpl.id, need: missing, ...best });
      out.steps.push({
        type: 'farm', item: tmpl.name, tmplId: tmpl.id, need: missing,
        mapId: best.mapId, mapName: best.mapName, monsterId: best.monsterId,
        cat: best.cat, reason: best.reason,
      });
    } else {
      out.unknown.push({ item: tmpl.name, tmplId: tmpl.id, need: missing, parent, reason: '无配方且无掉落记录' });
    }
  };

  // 目标：套装名 / 装备名 / tmplId / { name, count }
  const targetName = typeof target === 'string' ? target : (target?.name || target?.set);
  const set = data.sets?.find(s => s.name === targetName);
  if (set) {
    let ids = [];
    try { ids = JSON.parse(set.equipTmplIds || '[]'); } catch { }
    out.set = { name: set.name, total: ids.length, ids };
    for (const id of ids) resolveOne({ tmplId: id }, 1, 0, set.name);
  } else {
    resolveOne(target, count, 0, null);
  }

  out.ok = out.unknown.length === 0 && (out.missing.length === 0 || out.farm.length > 0 || out.steps.some(s => s.type === 'craft'));
  out.primaryFarm = out.farm.slice().sort((a, b) => b.need - a.need)[0] || null;
  return out;
}

export const RESOLVER_DATA = { DATA, KNOWN_MAPS };
