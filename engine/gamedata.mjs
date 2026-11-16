// engine/gamedata.mjs —— 游戏元数据的自动发现与同步
//
// 核心洞察：ENTER_GAME 的返回里**已经包含了整个游戏的定义**，
// 不需要我们去反编译前端包，也不需要维护写死的地图/装备/套装表。
//
// 服务端下发的内容：
//   maps[42]              地图（含 monsterConfig / dropConfig / npcs / reqLevel）
//   allEquipTemplates[5078] 装备模板（含 baseStats / slotType / reqLevel / quality）
//   equipSets[52]         套装定义
//   shopItems[76]         商城
//   skills[6]             角色技能（含 expCost 每级需求）
//   levelTmpls            等级模板
//   defConstants[56]      游戏数值常量（战力权重等很可能在这里）
//   bagItems / equipments / warehouse   角色实时数据
//
// 所以「游戏更新了怎么办」的答案是：什么都不用做。
// 每次 ENTER_GAME 拿到的就是最新定义，我们只要把它落盘并核对差异即可。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = process.env.TL_DATA_DIR ? path.resolve(process.env.TL_DATA_DIR) : path.join(ROOT, 'data');
const SNAPSHOT = path.join(DATA, 'gamedata.json');
const HISTORY = path.join(DATA, 'gamedata-changes.jsonl');

function safeParse(s, fallback = []) {
  try { return JSON.parse(s); } catch { return fallback; }
}

/** 从 ENTER_GAME 的 data 里抽出元数据（不含角色实时状态） */
export function extractMeta(game) {
  if (!game) return null;
  return {
    at: new Date().toISOString(),
    maps: (game.maps || []).map(m => ({
      id: m.id, name: m.name, reqLevel: m.reqLevel, mapType: m.mapType, region: m.region,
      description: m.description,
      monsters: safeParse(m.monsterConfig),
      drops: safeParse(m.dropConfig),
      costs: safeParse(m.costConfig),
      npcs: safeParse(m.npcs).map(n => ({ id: n.id, name: n.name })),
    })),
    equipSets: game.equipSets || [],
    shopItems: game.shopItems || [],
    defConstants: game.defConstants || [],
    levelTmpls: game.levelTmpls || [],
    templateCount: (game.allEquipTemplates || []).length,
    // 装备模板太大（5078 件），单独存
    skills: (game.skills || []).map(s => ({
      id: s.id, name: s.skillDetail?.name, level: s.currentLevel,
      maxLevel: s.skillDetail?.maxLevel,
      nextExp: safeParse(s.skillDetail?.expCost).find(x => x.skill_level === s.currentLevel + 1)?.exp ?? null,
    })),
  };
}

/** 读上次快照 */
export function loadSnapshot() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')); } catch { return null; }
}

/** 保存快照 */
export function saveSnapshot(meta) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(SNAPSHOT, JSON.stringify(meta, null, 1));
  } catch { }
}

/** 对比两次快照，返回差异（这是"游戏更新了"的自动检测） */
export function diffMeta(oldMeta, newMeta) {
  if (!oldMeta) return { firstRun: true, changes: [] };
  const changes = [];

  // 地图：新增 / 删除 / 改名 / 改等级要求 / 改怪物
  const oldMaps = new Map((oldMeta.maps || []).map(m => [m.id, m]));
  const newMaps = new Map((newMeta.maps || []).map(m => [m.id, m]));

  for (const [id, m] of newMaps) {
    const o = oldMaps.get(id);
    if (!o) { changes.push({ kind: 'map_added', id, name: m.name, reqLevel: m.reqLevel }); continue; }
    if (o.name !== m.name) changes.push({ kind: 'map_renamed', id, from: o.name, to: m.name });
    if (o.reqLevel !== m.reqLevel) changes.push({ kind: 'map_level', id, name: m.name, from: o.reqLevel, to: m.reqLevel });
    const om = JSON.stringify(o.monsters || []), nm = JSON.stringify(m.monsters || []);
    if (om !== nm) changes.push({ kind: 'map_monsters', id, name: m.name, note: '怪物配置变化' });
    const od = JSON.stringify(o.drops || []), nd = JSON.stringify(m.drops || []);
    if (od !== nd) changes.push({ kind: 'map_drops', id, name: m.name, note: '掉落配置变化' });
  }
  for (const [id, o] of oldMaps) {
    if (!newMaps.has(id)) changes.push({ kind: 'map_removed', id, name: o.name });
  }

  // 套装
  const oldSets = new Set((oldMeta.equipSets || []).map(s => s.id));
  const newSets = new Set((newMeta.equipSets || []).map(s => s.id));
  for (const s of (newMeta.equipSets || [])) {
    if (!oldSets.has(s.id)) changes.push({ kind: 'set_added', id: s.id, name: s.name });
  }
  for (const s of (oldMeta.equipSets || [])) {
    if (!newSets.has(s.id)) changes.push({ kind: 'set_removed', id: s.id, name: s.name });
  }

  // 商城
  const oldShop = new Set((oldMeta.shopItems || []).map(s => s.id));
  const newShop = new Set((newMeta.shopItems || []).map(s => s.id));
  for (const s of (newMeta.shopItems || [])) {
    if (!oldShop.has(s.id)) changes.push({ kind: 'shop_added', id: s.id, name: s.itemName || s.name });
  }
  for (const s of (oldMeta.shopItems || [])) {
    if (!newShop.has(s.id)) changes.push({ kind: 'shop_removed', id: s.id, name: s.itemName || s.name });
  }

  // 装备模板数量（新增装备会变）
  if (oldMeta.templateCount !== newMeta.templateCount) {
    changes.push({ kind: 'templates_count', from: oldMeta.templateCount, to: newMeta.templateCount });
  }

  // 数值常量（战力公式可能就在这）
  const oc = JSON.stringify(oldMeta.defConstants || []), nc = JSON.stringify(newMeta.defConstants || []);
  if (oc !== nc) changes.push({ kind: 'def_constants', note: '游戏常量变化（可能影响战力公式）' });

  return { firstRun: false, changes };
}

/** 记录变更历史 */
export function recordChanges(changes) {
  if (!changes?.length) return;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(HISTORY, JSON.stringify({ at: new Date().toISOString(), changes }) + '\n');
  } catch { }
}

/**
 * 同步：抽元数据 → 比对 → 保存 → 记录变更
 * 每次 ENTER_GAME 都可调用，开销很小（纯内存比对 + 一次写盘）
 */
export function sync(game, log = () => { }) {
  const meta = extractMeta(game);
  if (!meta) return null;
  const old = loadSnapshot();
  const { firstRun, changes } = diffMeta(old, meta);

  if (firstRun) {
    log(`[gamedata] 首次同步：${meta.maps.length} 张地图 / ${meta.equipSets.length} 个套装 / ${meta.templateCount} 件装备模板`);
  } else if (changes.length) {
    log(`[gamedata] 检测到 ${changes.length} 处变化：`);
    for (const c of changes.slice(0, 20)) log(`  · ${c.kind} ${c.name || c.id || ''} ${c.from != null ? `${c.from}→${c.to}` : ''}`);
    recordChanges(changes);
  }
  saveSnapshot(meta);
  return { meta, changes, firstRun };
}

// ── 查询辅助（给上层用，不再硬编码）───────────────

/** 找适合当前等级的最高收益地图 */
export function bestMapForLevel(level, { excludeDungeons = true } = {}) {
  const meta = loadSnapshot();
  if (!meta) return null;
  return (meta.maps || [])
    .filter(m => m.reqLevel <= level)
    .filter(m => !excludeDungeons || m.id < 20000)  // 20000+ 是副本
    .filter(m => (m.monsters || []).length > 0)
    .sort((a, b) => b.reqLevel - a.reqLevel)[0] || null;
}

/** 按名字找地图 */
export function findMap(nameOrId) {
  const meta = loadSnapshot();
  if (!meta) return null;
  const q = String(nameOrId);
  return (meta.maps || []).find(m => String(m.id) === q || m.name === q || (m.name || '').includes(q)) || null;
}

/** 某地图的怪物 ID 列表 */
export function monstersIn(mapId) {
  const meta = loadSnapshot();
  const m = (meta?.maps || []).find(x => x.id === Number(mapId));
  return m?.monsters || [];
}

/** 技能升级建议（按性价比排序） */
export function skillUpgradePlan() {
  const meta = loadSnapshot();
  if (!meta) return [];
  return (meta.skills || [])
    .filter(s => s.nextExp != null && s.level < s.maxLevel)
    .sort((a, b) => a.nextExp - b.nextExp);
}

export const paths = { SNAPSHOT, HISTORY };
