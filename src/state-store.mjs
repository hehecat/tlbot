// src/state-store.mjs —— 内存状态树 + 协议白名单 + 未知包捕获（PRD §2）
//
// 职责：
//   1. 挂在唯一 ws 上，把所有下行包解析进内存状态树（不落库、不阻塞）
//   2. 维护 XP/h、Gold/h 速率（用于 Watchdog 判「卡死」）
//   3. 未知协议 → data/unknown_packets.jsonl（同 cmd 最多 5 条，防刷爆）
//   4. COMBAT_REWARD 掉落 → data/live_drops.json 累积（替代过期 drops.json）
//
// 用法：
//   const store = initStore(ws);            // ws = core/lib-ws.mjs createSession()
//   store.getSnapshot()                     // 给 tool 用的摘要
//   store.on('COMBAT_STATE', fn)            // 订阅
//   store.close()                           // 卸监听
//
// ⚠️ 本模块只读：任何情况下都不发包。

import fs from 'node:fs';
import path from 'node:path';

const DIR = import.meta.dirname;
const ROOT = path.resolve(DIR, '..');
const DATA = process.env.TL_DATA_DIR ? path.resolve(process.env.TL_DATA_DIR) : path.join(ROOT, 'data');
const UNKNOWN_F = path.join(DATA, 'unknown_packets.jsonl');
const DROPS_F = path.join(DATA, 'live_drops.json');
const MAPS_F = path.join(DATA, 'maps.json');

const MAX_UNKNOWN_PER_CMD = 5;
const RATE_WINDOW = 40;           // 保留最近 40 个采样点
const MIN_RATE_SPAN_MS = 60_000;  // 至少跨 1 分钟才算速率

// 已知协议白名单（AGENTS.md + combat_v5/goal_probe 实测到的）
const KNOWN = new Set([
  'LOGIN', 'LOGIN_RESPONSE', 'ENTER_GAME', 'ENTER_GAME_RESPONSE',
  'ENTER_MAP', 'ENTER_MAP_RESPONSE', 'CHANGE_MAP',
  'COMBAT_START', 'COMBAT_SYNC', 'COMBAT_STOP', 'COMBAT_STATE', 'COMBAT_REWARD', 'COMBAT_ERROR',
  'ERROR', 'NOTICE', 'CHAT', 'CHAT_MESSAGE', 'PLAYER_ONLINE', 'PLAYER_OFFLINE',
  'GET_LEADERBOARD', 'GET_LEADERBOARD_RESPONSE', 'LEADERBOARD_DATA',
  'PET_COMMAND', 'PET_RESPONSE',
  'TRIAL_COMMAND', 'TRIAL_RESPONSE',
  'ARENA_COMMAND', 'ARENA_RESPONSE',
  'SHOP_BUY', 'SHOP_BUY_RESPONSE', 'UPDATE_SETTINGS', 'UPDATE_SETTINGS_RESPONSE',
  'GEM_INLAY', 'GEM_INLAY_RESPONSE', 'SMITHY_APPRAISAL', 'SMITHY_APPRAISAL_RESPONSE',
  'UPGRADE_SKILL', 'UPGRADE_SKILL_RESPONSE', 'PET_RESPONSE',
  'ZL_STATUS_RESPONSE', 'ZL_CLAIM_TOKEN_RESPONSE', 'ZL_ENTER_RESPONSE',
  'CAMP_STATUS_RESPONSE', 'CAMP_ENTER_RESPONSE',
  'WUSHUANG_STATUS', 'WUSHUANG_STATUS_RESPONSE',
  'WUSHUANG_CLAIM', 'WUSHUANG_CLAIM_RESPONSE',
  'CONSIGNMENT_LIST', 'CONSIGNMENT_LIST_RESPONSE', 'CONSIGNMENT_BUY', 'CONSIGNMENT_BUY_RESPONSE',
  'CONSIGNMENT_CREATE', 'CONSIGNMENT_CREATE_RESPONSE',
  'CONSIGNMENT_RECORD_LIST', 'CONSIGNMENT_RECORD_LIST_RESPONSE',
  'SHOP_SELL', 'SHOP_SELL_RESPONSE', 'USE_ITEM', 'USE_ITEM_RESPONSE',
  'WAREHOUSE_DEPOSIT', 'WAREHOUSE_DEPOSIT_RESPONSE',
  'EQUIP_ITEM', 'EQUIP_ITEM_RESPONSE', 'UNEQUIP_ITEM', 'UNEQUIP_ITEM_RESPONSE',
  'APPRAISE', 'APPRAISE_RESPONSE', 'SMELT_START', 'SMELT_START_RESPONSE',
  'SMITHY_FORGE', 'SMITHY_FORGE_RESPONSE', 'SMITHY_FORGE_PREVIEW', 'SMITHY_FORGE_PREVIEW_RESPONSE',
  'ZL_STATUS', 'ZL_CLAIM_TOKEN', 'ZL_ENTER', 'CAMP_STATUS', 'CAMP_ENTER',
  'ROLE_SYNC', 'BAG_SYNC', 'SKILL_UP', 'SKILL_UP_RESPONSE',
  'PONG', 'PING', 'HEARTBEAT',
]);

const isKnown = t => {
  if (!t) return false;
  if (KNOWN.has(t)) return true;
  // 约定：命令 XXX 的响应叫 XXX_RESPONSE
  if (t.endsWith('_RESPONSE')) return KNOWN.has(t.slice(0, -9));
  return false;
};

const ensureData = () => { try { fs.mkdirSync(DATA, { recursive: true }); } catch { } };

function loadDrops() {
  try { return JSON.parse(fs.readFileSync(DROPS_F, 'utf8')); } catch { return { updatedAt: null, byMap: {} }; }
}

export function initStore(ws, opts = {}) {
  const maxUnknown = opts.maxUnknownPerCmd ?? MAX_UNKNOWN_PER_CMD;
  ensureData();

  const st = {
    startedAt: new Date().toISOString(),
    packets: 0,
    unknown: 0,
    unknownByType: {},
    lastPacketAt: null,
    role: null,
    equipments: [],
    bagItems: [],
    equipSets: [],
    maps: [],            // ENTER_GAME.maps
    pets: null,          // { count, capacity, activePetId, list }
    combat: { stage: null, mapId: null, progress: null, defeated: null, total: null, lastDefeated: null, hp: null, lastStateAt: null, lastProgressAt: null, lastRewardAt: null },
    errors: [],          // 最近 20 条错误
    samples: [],         // [{t, exp, money, level, power}]
    drops: loadDrops(),
  };

  const subs = new Map();   // type -> Set<fn>
  const emit = (t, d) => { const s = subs.get(t); if (s) for (const fn of [...s]) { try { fn(d); } catch { } } };
  const subsAny = new Set();

  const pushError = msg => {
    if (!msg) return;
    st.errors.push({ at: new Date().toISOString(), msg: String(msg).slice(0, 200) });
    if (st.errors.length > 20) st.errors.shift();
  };

  const noteUnknown = (t, d) => {
    st.unknown++;
    st.unknownByType[t] = (st.unknownByType[t] || 0) + 1;
    if (st.unknownByType[t] > maxUnknown) return;   // 同 cmd 最多 5 条
    const line = JSON.stringify({
      at: new Date().toISOString(), type: t,
      payloadKeys: Object.keys(d || {}),
      sample: JSON.stringify(d).slice(0, 1200),
    });
    try { fs.appendFileSync(UNKNOWN_F, line + '\n'); } catch { }
  };

  // 掉落累积：{ byMap: { [mapId]: { [itemName]: {count, firstAt, lastAt, itemId} } } }
  const recordDrops = (drops, mapId) => {
    if (!Array.isArray(drops) || !drops.length) return;
    const m = String(mapId ?? st.combat.mapId ?? 'unknown');
    st.drops.byMap[m] ||= {};
    const bucket = st.drops.byMap[m];
    for (const x of drops) {
      const name = x?.name || x?.itemName || String(x?.itemId ?? 'unknown');
      const e = (bucket[name] ||= { count: 0, itemId: x?.itemId ?? null, firstAt: new Date().toISOString(), lastAt: null });
      e.count += Number(x?.count || 1);
      e.lastAt = new Date().toISOString();
    }
    st.drops.updatedAt = new Date().toISOString();
    try { fs.writeFileSync(DROPS_F, JSON.stringify(st.drops, null, 1)); } catch { }
  };

  const sample = role => {
    if (!role) return;
    st.samples.push({
      t: Date.now(),
      exp: role.currentExp ?? null,
      money: role.money ?? null,
      level: role.level ?? null,
      power: role.combatPower ?? null,
    });
    if (st.samples.length > RATE_WINDOW) st.samples.shift();
  };

  const handle = d => {
    const t = d?.type;
    if (!t) return;
    st.packets++;
    st.lastPacketAt = new Date().toISOString();

    if (!isKnown(t)) noteUnknown(t, d);
    if (t === 'ERROR' || t === 'COMBAT_ERROR') pushError(d.message);

    const data = d.data || {};
    const role = data.role || data.roleInfo?.role;
    if (role) { st.role = role; sample(role); }
    if (Array.isArray(data.equipments)) st.equipments = data.equipments;
    if (Array.isArray(data.bagItems)) st.bagItems = data.bagItems;
    if (Array.isArray(data.equipSets)) st.equipSets = data.equipSets;
    if (Array.isArray(data.maps) && data.maps.length) {
      st.maps = data.maps;
      try {
        const byName = {};
        for (const m of data.maps) if (m?.name && m.id != null) byName[m.name] = m.id;
        fs.writeFileSync(MAPS_F, JSON.stringify(byName, null, 1));
      } catch { }
    }

    if (t === 'PET_RESPONSE' && data.state) {
      const s = data.state;
      st.pets = {
        count: s.pets?.length ?? 0,
        capacity: s.capacity ?? null,
        activePetId: s.activePetId ?? null,
        list: (s.pets || []).map(p => ({
          id: p.pet?.id, name: p.speciesName || p.pet?.name, form: p.pet?.form,
          level: p.pet?.level, average: p.average, quality: p.quality,
          cp: p.combatPower, active: s.activePetId === p.pet?.id,
        })),
      };
    }

    if (t === 'COMBAT_STATE') {
      const c = data.combatState || data.state || data;
      const cp = data.combatProgress || c.combatProgress || {};
      st.combat.stage = data.stage ?? c.stage ?? st.combat.stage;
      st.combat.mapId = data.mapId ?? c.mapId ?? st.combat.mapId;
      st.combat.defeated = cp.defeated ?? c.defeated ?? c.killCount ?? st.combat.defeated;
      st.combat.total = cp.total ?? c.total ?? st.combat.total;
      st.combat.progress = st.combat.defeated != null && st.combat.total != null
        ? `${st.combat.defeated}/${st.combat.total}` : (c.progress ?? st.combat.progress);
      st.combat.hp = data.player?.currentHp ?? st.combat.hp;
      st.combat.lastStateAt = new Date().toISOString();
      st.combat.lastProgressAt = st.combat.lastDefeated !== st.combat.defeated
        ? new Date().toISOString() : st.combat.lastProgressAt;
      st.combat.lastDefeated = st.combat.defeated;
    }

    if (t === 'COMBAT_REWARD') {
      recordDrops(data.drops, data.mapId);
      st.combat.lastRewardAt = new Date().toISOString();
    }

    emit(t, d);
    for (const fn of [...subsAny]) { try { fn(d); } catch { } }
  };

  // 挂载：优先用 lib-ws 的通配监听
  let detach = () => { };
  if (typeof ws.onAny === 'function') {
    const off = ws.onAny(handle);
    detach = () => { try { off(); } catch { } };
  } else {
    const types = [...KNOWN];
    const offs = types.filter(t => typeof ws.on === 'function').map(t => ws.on(t, handle));
    detach = () => offs.forEach(f => { try { f(); } catch { } });
  }

  const rates = () => {
    const s = st.samples;
    if (s.length < 2) return { xpPerHour: null, goldPerHour: null, spanMs: 0 };
    const a = s[0], b = s[s.length - 1];
    const spanMs = b.t - a.t;
    if (spanMs < MIN_RATE_SPAN_MS) return { xpPerHour: null, goldPerHour: null, spanMs };
    const h = spanMs / 3_600_000;
    const dExp = (b.exp ?? 0) - (a.exp ?? 0);
    const dGold = (b.money ?? 0) - (a.money ?? 0);
    return {
      xpPerHour: Math.round(dExp / h),
      goldPerHour: Math.round(dGold / h),
      spanMs,
    };
  };

  const getSnapshot = () => {
    const r = st.role || {};
    const eqs = (st.equipments || []).filter(x => x.isEquipped);
    const petList = st.pets?.list || [];
    const best = petList.slice().sort((a, b) => (b.average || 0) - (a.average || 0))[0] || null;
    const rt = rates();
    const silentMs = st.combat.lastStateAt ? Date.now() - Date.parse(st.combat.lastStateAt) : null;
    return {
      at: new Date().toISOString(),
      uptimeSec: Math.round((Date.now() - Date.parse(st.startedAt)) / 1000),
      me: {
        level: r.level ?? null,
        exp: r.currentExp ?? null,
        gold: r.money ?? null,
        yuanbao: r.yuanbao ?? 0,
        power: r.combatPower ?? null,
        equips: eqs.length,
        bagCount: (st.bagItems || []).length,
      },
      pets: st.pets ? {
        count: st.pets.count, capacity: st.pets.capacity,
        activePetId: st.pets.activePetId,
        best: best ? { id: best.id, name: best.name, form: best.form, average: best.average, cp: best.cp } : null,
        hasMutant: petList.some(p => p.form === 'MUTANT'),
      } : null,
      combat: { ...st.combat, silentSec: silentMs == null ? null : Math.round(silentMs / 1000) },
      rates: rt,
      health: {
        packets: st.packets,
        unknown: st.unknown,
        unknownByType: st.unknownByType,
        lastPacketAt: st.lastPacketAt,
        recentErrors: st.errors.slice(-5),
        // Watchdog 三条件之一：COMBAT_STATE 静默超 30 分钟
        stalled: silentMs != null && silentMs > 30 * 60_000,
      },
      drops: {
        updatedAt: st.drops.updatedAt,
        maps: Object.keys(st.drops.byMap || {}),
        top: topDrops(st.drops, 5),
      },
    };
  };

  // 手动灌入一份完整状态（例如 ENTER_GAME_RESPONSE 的 data），用于首帧建立状态树
  const ingest = d => {
    if (!d) return;
    handle({ type: 'ENTER_GAME_RESPONSE', data: d, success: true });
  };

  return {
    st,
    ingest,
    getSnapshot,
    rates,
    on: (type, fn) => {
      if (!subs.has(type)) subs.set(type, new Set());
      subs.get(type).add(fn);
      return () => subs.get(type)?.delete(fn);
    },
    onAny: fn => { subsAny.add(fn); return () => subsAny.delete(fn); },
    recordDrops,
    close: () => { detach(); subs.clear(); subsAny.clear(); },
    paths: { unknown: UNKNOWN_F, drops: DROPS_F, maps: MAPS_F },
  };
}

// 「某物品在哪张图掉率最高」—— live_drops.json 的查询口径
export function topDrops(drops, limit = 5) {
  const out = [];
  for (const [mapId, bucket] of Object.entries(drops?.byMap || {})) {
    for (const [name, e] of Object.entries(bucket || {})) {
      out.push({ mapId, name, count: e.count, itemId: e.itemId });
    }
  }
  return out.sort((a, b) => b.count - a.count).slice(0, limit);
}

// 查单个物品的最佳地图（PRD §8 数据验收项）
export function bestMapForItem(drops, name) {
  const rows = [];
  for (const [mapId, bucket] of Object.entries(drops?.byMap || {})) {
    const e = bucket?.[name];
    if (e) rows.push({ mapId, count: e.count });
  }
  return rows.sort((a, b) => b.count - a.count)[0] || null;
}

export const STORE_PATHS = { DATA, UNKNOWN_F, DROPS_F };
