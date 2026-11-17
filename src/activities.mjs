// src/activities.mjs —— 日常 / 塔 / 刷蛋（PRD §2）
//
// 调用方（extension）负责：pause CombatDaemon → 调这里 → resume
// 本模块假设战斗已暂停；每个 activity 返回战报。
//
// 所有写操作过 core/redlines.mjs；.halt 时立即停。

import crypto from 'node:crypto';
import { audit } from '../core/audit.mjs';
import fsx from 'node:fs';
import pathx from 'node:path';
const TL_DATA_DIR = process.env.TL_DATA_DIR ? pathx.resolve(process.env.TL_DATA_DIR) : pathx.resolve(process.cwd(), 'data');
const fs_append = (p, s) => { try { fsx.mkdirSync(pathx.dirname(p), { recursive: true }); fsx.appendFileSync(p, s); } catch { } };
const path_join = (...a) => pathx.join(...a);

import { assertSafe, RedlineError, safeSnapshot } from '../core/redlines.mjs';
import { goMap, fightInMap, isHalted, sleep } from './combat-daemon.mjs';

const LUOYANG = 4;
const SUZHOU = 5;
const TOWER_MAP = 20070;
const MAP_XUANWU = 20080;
const MAP_ZL = 20050;          // 珍珑棋局（BOSS 90002）
const MAP_CAMP = 20051;        // 伪宋军领地（50 小怪 + 10 精英 + BOSS 90103）
const MAP_BEAR = 20052;        // 熊林（BOSS 90202，需除熊害令牌 51002）
const ITEM_BEAR_TOKEN = 51002; // 除熊害令牌，伪宋军首领 40% 掉落

export function createActivities(ws, store, { log = () => { }, stage = 0, allowWrite = false } = {}) {
  const canWrite = () => allowWrite && stage >= 2 && !isHalted();
  const out = { at: new Date().toISOString(), activities: [], errors: [], blocked: [], dryRun: !canWrite() };

  const note = (activity, msg, extra = {}) => {
    const row = { activity, at: new Date().toISOString().slice(11, 19), msg, ...extra };
    out.activities.push(row);
    log(`[${activity}] ${msg}`);
  };

  async function guarded(activity, req, fn) {
    if (isHalted()) throw new Error('halt：已停止主动发包');
    if (!canWrite()) {
      out.activities.push({
        activity, at: new Date().toISOString().slice(11, 19),
        msg: `DRY_RUN ${req.action}`, dryRun: true, op: req.op || req.action,
      });
      return { skipped: true, reason: 'DRY_RUN/阶段未到' };
    }
    try { assertSafe(req); } catch (e) {
      if (e instanceof RedlineError) {
        out.blocked.push({ activity, action: req.action, code: e.code, reason: e.message });
        log(`[${activity}] ⛔ ${e.message}`);
        return { blocked: true, code: e.code };
      }
      throw e;
    }
    return fn();
  }

  const refresh = async () => {
    const r = await ws.req('ENTER_GAME', {}, { ms: 9000, revision: false });
    if (r?.data) store?.ingest?.(r.data);
    return r?.data;
  };

  async function ensureMap(mapId) {
    const r = await goMap(ws, store, mapId);
    return r?.game || (await refresh());
  }

  // ── 暗器（洛阳）─────────────────────────────────────────────
  async function taskAnqi(g) {
    const A = 'daily_tasks';
    if (g?.role?.mapId !== LUOYANG) {
      g = await ensureMap(LUOYANG);
      note(A, `回洛阳（map=${g?.role?.mapId}）`);
    }
    const stt = await ws.req('TRIAL_COMMAND', { action: 'status', requestId: crypto.randomUUID() }, { ms: 9000 });
    let tr = stt?.data?.trial;
    if (!tr) { out.errors.push('TRIAL_COMMAND status 无响应'); return; }
    note(A, `暗器 Lv.${tr.level}/100 品质${tr.weapon?.quality ?? '-'}% 元素${tr.weapon?.element || '-'}`);

    if (!tr.claimed) {
      const r = await guarded(A,
        { action: 'TRIAL_COMMAND', op: 'TRIAL_CLAIM', itemId: null },
        () => ws.req('TRIAL_COMMAND', { action: 'claim', element: 'fire', revision: tr.revision, requestId: crypto.randomUUID() }, { ms: 9000 }));
      if (r?.success) note(A, '领取暗器 ✓ 火属性');
      else if (r?.message) note(A, '领取暗器失败: ' + r.message);
      await sleep(600);
      const s2 = await ws.req('TRIAL_COMMAND', { action: 'status', requestId: crypto.randomUUID() }, { ms: 9000 });
      tr = s2?.data?.trial || tr;
    }

    // 装备 slot12
    const hw = (g?.equipments || []).find(x => x.equipTmpl?.slotType === 12);
    if (hw && !hw.isEquipped) {
      const snap = safeSnapshot({ ...g, role: g?.role, equipments: g?.equipments || [] });
      const r = await guarded(A,
        { action: 'EQUIP_ITEM', op: 'EQUIP_ITEM', unequip: true, snapshot: snap, itemId: hw.id, item: hw, owned: g?.equipments || [] },
        () => ws.req('EQUIP_ITEM', { roleEquipId: hw.id }, { ms: 6000 }));
      if (r?.success) note(A, '装备暗器 ' + hw.equipTmpl.name);
    }
  }

  // ── 无双 / 双倍 ─────────────────────────────────────────────
  async function taskWushuang() {
    const A = 'daily_tasks';
    const st0 = await ws.req('WUSHUANG_STATUS', {}, { ms: 6000 });
    const d0 = st0?.data || {};
    note(A, `天灵丹 ${d0.tianlingCount ?? '?'} 个 | 今日已领 ${d0.claimedToday} | 剩余双倍 ${Math.round((d0.remainingSeconds || 0) / 60)} 分钟`);
    if (!d0.claimedToday) {
      const r = await guarded(A, { action: 'WUSHUANG_CLAIM', op: 'WUSHUANG_CLAIM' },
        () => ws.req('WUSHUANG_CLAIM', {}, { ms: 6000 }));
      if (r?.success) note(A, '领取双倍 ✓');
      await sleep(500);
    }
    if ((d0.remainingSeconds || 0) <= 0) {
      const g = await refresh();
      const tl = (g?.bagItems || []).filter(b => b.itemId === 51003 || /天灵丹/.test(b.itemTmpl?.name || ''));
      if (tl.length) {
        const r = await guarded(A, { action: 'USE_ITEM', op: 'USE_ITEM', itemId: tl[0].id, item: tl[0] },
          () => ws.req('USE_ITEM', { bagItemId: tl[0].id, count: 1 }, { ms: 6000 }));
        if (r?.success) note(A, '使用天灵丹 ✓ 双倍开启');
      } else note(A, '双倍已过期且背包无天灵丹');
    }
  }

  // ── 比武 ────────────────────────────────────────────────────
  async function taskArena() {
    const A = 'daily_tasks';
    const lb = await ws.req('ARENA_COMMAND', { action: 'list', requestId: crypto.randomUUID(), nearby: false, page: 0 }, { ms: 9000 });
    const board = lb?.data?.board;
    if (!board) { out.errors.push('ARENA list 无响应'); return; }
    note(A, `比武名次 #${board.ownRank ?? '?'} | 已点赞 ${board.likedRoleId || '无'}`);

    const target = (board.rows || []).find(r => r.canLike);
    if (target) {
      const r = await guarded(A, { action: 'ARENA_COMMAND', op: 'ARENA_LIKE' },
        () => ws.req('ARENA_COMMAND', {
          action: 'like', requestId: crypto.randomUUID(), nearby: false,
          page: 0, token: lb.data.token, targetId: target.roleId, date: board.date,
        }, { ms: 9000 }));
      if (r?.success) note(A, '点赞 ' + target.nickname + ' ✓ 演武礼包×1');
    }

    const op = await ws.req('ARENA_COMMAND', { action: 'open', requestId: crypto.randomUUID(), nearby: true, page: 0 }, { ms: 9000 });
    const opBoard = op?.data?.board || {};
    const tok2 = op?.data?.token || lb.data.token;
    const date2 = opBoard.date || board.date;
    const cl = await guarded(A, { action: 'ARENA_COMMAND', op: 'ARENA_CLAIM' },
      () => ws.req('ARENA_COMMAND', {
        action: 'claim', requestId: crypto.randomUUID(), nearby: true, page: 0, token: tok2, date: date2,
      }, { ms: 9000 }));
    if (cl?.success) note(A, '领名次奖励 ✓');

    // 开演武礼包
    const g2 = await refresh();
    const packs = (g2?.bagItems || []).filter(b => /演武礼包/.test(b.itemTmpl?.name || ''));
    for (const pk of packs) {
      const r = await guarded(A, { action: 'USE_ITEM', op: 'USE_ITEM', itemId: pk.id, item: pk },
        () => ws.req('USE_ITEM', { bagItemId: pk.id, count: pk.count || 1 }, { ms: 6000 }));
      if (r?.success) note(A, `开演武礼包 ×${pk.count || 1}`);
      await sleep(400);
    }
  }

  // ── 珍兽日常 ────────────────────────────────────────────────
  async function taskPet() {
    const A = 'daily_tasks';
    ws.send('COMBAT_STOP');
    await sleep(600);
    const r = await ws.req('PET_COMMAND', { action: 'list', requestId: crypto.randomUUID() }, { ms: 8000 });
    const st = r?.data?.state;
    if (!st) { out.errors.push('PET list 无响应'); return; }
    const pets = st.pets || [];
    note(A, `珍兽 ${pets.length}/${st.capacity} 只`);

    for (const p of pets.filter(x => !x.pet.appraised).slice(0, 5)) {
      const rr = await guarded(A, { action: 'PET_COMMAND', op: 'PET_APPRAISE', petId: p.pet.id, pet: p, pets },
        () => ws.req('PET_COMMAND', { action: 'appraise', petId: p.pet.id, requestId: crypto.randomUUID() }, { ms: 8000 }));
      if (rr?.success) note(A, '鉴定珍兽 ' + p.speciesName);
      await sleep(400);
    }

    const best = [...pets].sort((a, b) => (b.combatPower || 0) - (a.combatPower || 0))[0];
    if (best && best.pet.id !== st.activePetId) {
      const sm = await guarded(A, { action: 'PET_COMMAND', op: 'PET_SUMMON', petId: best.pet.id, pet: best, pets },
        () => ws.req('PET_COMMAND', { action: 'summon', petId: best.pet.id, requestId: crypto.randomUUID() }, { ms: 8000 }));
      if (sm?.success) note(A, '出战 ' + best.speciesName + ' ✓');
    }
  }

  // ── 每日副本：珍珑棋局 + 伪宋军 + 熊林 ───────────────────────
  //
  // 2026-11-16 修正三处：
  //   ① 伪宋军次数改读服务端的 remainingToday（原本用 dailyMaxEntries-enteredToday 自己算）
  //   ② 补上熊林（BEAR_ENTER）—— 之前完全漏掉，它是伪宋军首领掉落令牌开启的下一环
  //   ③ 熊林打之前先确认背包里有「除熊害令牌 51002」，没有就跳过并说明原因
  async function taskDungeon() {
    const A = 'daily_tasks';
    // ── 副本执行追踪（2026-11-16 加）──
    // 之前的日志太粗，只记"进入成功/次数已用完"，看不出到底发生了什么。
    // 这里把每一步都记下来：进入前后地图/dungeon状态、COMBAT_STATE 首末帧、
    // 结束原因、击杀数。额度消耗一次就必须留下完整证据链。
    const trace = [];
    const T = (msg, extra) => {
      const row = { at: new Date().toISOString().slice(11, 19), msg, ...(extra || {}) };
      trace.push(row);
      note(A, msg);
      fs_append(pathx.join(TL_DATA_DIR, 'dungeon-trace.jsonl'),
        JSON.stringify({ date: new Date().toISOString().slice(0, 10), ...row }) + '\n');
    };
    const snapBefore = async (label) => {
      const g = await refresh();
      const before = {
        mapId: g?.role?.mapId, level: g?.role?.level,
        dungeon: g?.role?.dungeonData ? (typeof g.role.dungeonData === 'string' ? g.role.dungeonData.slice(0, 120) : JSON.stringify(g.role.dungeonData).slice(0, 120)) : null,
      };
      T(`[${label}] 进入前 mapId=${before.mapId} dungeon=${before.dungeon || '无'}`);
      return before;
    };
    const snapAfter = async (label) => {
      const g = await refresh();
      T(`[${label}] 进入后 mapId=${g?.role?.mapId} dungeon=${g?.role?.dungeonData ? '有' : '无'}`);
      return g?.role?.mapId;
    };

    // ── 1. 珍珑棋局 ──
    try {
      const zl = await ws.req('ZL_STATUS', {}, { ms: 8000 });
      const z = zl?.data || {};
      note(A, `珍珑棋局 令牌${z.tokenCount ?? '?'} 今日已领${z.claimedToday ?? '?'}`);
      if (!z.claimedToday) {
        const cl = await guarded(A, { action: 'ZL_CLAIM_TOKEN', op: 'ZL_CLAIM_TOKEN' },
          () => ws.req('ZL_CLAIM_TOKEN', {}, { ms: 8000 }));
        if (cl?.success) note(A, '领棋局令牌 ✓');
      }
      // 有令牌才进
      const z2 = await ws.req('ZL_STATUS', {}, { ms: 6000 }).catch(() => null);
      const tokens = z2?.data?.tokenCount ?? z.tokenCount ?? 0;
      if (tokens > 0) {
        const en = await guarded(A, { action: 'ZL_ENTER', op: 'ZL_ENTER' },
          () => ws.req('ZL_ENTER', {}, { ms: 10000 }));
        if (en?.success) {
          note(A, '进珍珑棋局 ✓');
          await sleep(800);
          const res = await fightInMap(ws, store, MAP_ZL, { mode: 'dungeon', secsMax: 480_000, label: '珍珑棋局' });
          note(A, `珍珑棋局 ${res.why} ${res.kills} 只 ${res.secs}s`);
        } else {
          note(A, '进珍珑棋局失败: ' + (en?.message || '未知'));
        }
      } else {
        note(A, '珍珑棋局无令牌，跳过');
      }
    } catch (e) {
      out.errors.push({ activity: A, msg: '珍珑棋局异常: ' + (e?.message || e) });
    }

    // ── 2. 伪宋军（每天 5 次）──
    for (let i = 0; i < 5; i++) {
      if (isHalted()) break;
      let remaining;
      try {
        const st = await ws.req('CAMP_STATUS', {}, { ms: 6000 });
        const sd = st?.data || {};
        // 服务端直接给剩余次数，不要再拿 max-entered 自己算
        remaining = Number(sd.remainingToday ?? 0);
        if (i === 0) note(A, `伪宋军 剩余 ${remaining}/${sd.dailyMaxEntries ?? '?'} 次（今日已进 ${sd.enteredToday ?? '?'}）`);
      } catch (e) {
        note(A, 'CAMP_STATUS 失败: ' + (e?.message || e));
        break;
      }
      if (remaining <= 0) { if (i === 0) note(A, '伪宋军次数已用完'); break; }

      const before = await snapBefore(`伪宋军#${i + 1}`);
      const r = await guarded(A, { action: 'CAMP_ENTER', op: 'CAMP_ENTER' },
        () => ws.req('CAMP_ENTER', {}, { ms: 10000 }));
      if (!r?.success) { T(`进伪宋军失败: ${r?.message || ''}`); break; }
      await sleep(1200);
      // 关键：用 CAMP_ENTER 返回的 role.mapId，不要用硬编码 20051。
      // 实测 COMBAT_START{20051} 会被拒绝：「战斗地图与角色所在地图不一致」，
      // 于是额度消耗了但一只怪都没打 —— 这就是历史上 5/5 全废的根因。
      const realMap = Number(r?.data?.role?.mapId) || Number((await refresh())?.role?.mapId) || 0;
      T(`CAMP_ENTER 后 mapId ${before.mapId} → ${realMap}${realMap ? '' : ' ❌ 拿不到'}`);
      if (!realMap) { T('❌ 无法确定副本内地图 id，中止（避免继续浪费额度）'); break; }

      const res = await fightInMap(ws, store, realMap, { mode: 'dungeon', secsMax: 480_000, label: `伪宋军#${i + 1}` });
      T(`伪宋军 #${i + 1} 结束 why=${res.why} kills=${res.kills} secs=${res.secs} started=${res.started ?? '?'}`);
      const mapAfterFight = (await refresh())?.role?.mapId;
      T(`战斗后 mapId=${mapAfterFight}（如果还在副本说明没打出来）`);
      await sleep(600);
    }

    // ── 3. 熊林（需要除熊害令牌，由伪宋军首领掉落）──
    try {
      const g = await refresh();
      const tokenCount = (g?.bagItems || [])
        .filter(b => b.itemId === ITEM_BEAR_TOKEN)
        .reduce((a, b) => a + (b.count || 1), 0);
      if (tokenCount <= 0) {
        note(A, `熊林跳过：无除熊害令牌（伪宋军首领 40% 掉落，今日未获得）`);
      } else if ((g?.role?.level ?? 0) < 30) {
        note(A, `熊林跳过：等级不足（当前 ${g?.role?.level}，需 30）`);
      } else {
        note(A, `熊林 令牌 ${tokenCount} 个 → 进入`);
        const en = await guarded(A, { action: 'BEAR_ENTER', op: 'BEAR_ENTER' },
          () => ws.req('BEAR_ENTER', {}, { ms: 10000 }));
        if (en?.success) {
          const realMap = Number(en?.data?.role?.mapId) || MAP_BEAR;
          T(`进熊林 ✓ 实际地图=${realMap}`);
          await sleep(1000);
          const res = await fightInMap(ws, store, realMap, { mode: 'dungeon', secsMax: 480_000, label: '熊林' });
          T(`熊林 结束 why=${res.why} kills=${res.kills} secs=${res.secs}`);
        } else {
          T('进熊林失败: ' + (en?.message || '未知'));
        }
      }
    } catch (e) {
      out.errors.push({ activity: A, msg: '熊林异常: ' + (e?.message || e) });
    }
  }

  async function dailyTasks(options = {}) {
    out.at = new Date().toISOString();
    out.activities = []; out.errors = []; out.blocked = []; out.halted = false;
    const g = await refresh();
    const tasks = [
      ['anqi', () => taskAnqi(g)],
      ['wushuang', () => taskWushuang()],
      ['arena', () => taskArena()],
      ['pet', () => taskPet()],
      ['dungeon', () => taskDungeon()],
    ];
    for (const [name, fn] of tasks) {
      if (isHalted()) { out.halted = true; break; }
      if (options.skip?.includes(name)) continue;
      try { await fn(); } catch (e) { out.errors.push(`${name}: ${e?.message || e}`); }
    }
    out.dryRun = !canWrite();
    return out;
  }

  // ── 伪宋军单次/多次（可控测试，不跑其他日常）──────────────
  async function campRun(options = {}) {
    const A = 'camp';
    const maxRuns = Math.max(1, Math.min(5, Number(options.maxRuns ?? 1)));
    out.at = new Date().toISOString();
    out.activities = []; out.errors = []; out.blocked = []; out.halted = false;
    const results = [];
    const g0 = await refresh();
    const before = { gold: g0?.role?.money ?? null, exp: g0?.role?.currentExp ?? null, bag: (g0?.bagItems || []).length };
    for (let i = 0; i < maxRuns; i++) {
      if (isHalted()) { out.halted = true; break; }
      let remaining = 0;
      try {
        const st = await ws.req('CAMP_STATUS', {}, { ms: 6000 });
        remaining = Number(st?.data?.remainingToday ?? 0);
        note(A, `第${i + 1}次：剩余 ${remaining}/${st?.data?.dailyMaxEntries ?? '?'} 次`);
      } catch (e) { out.errors.push('CAMP_STATUS: ' + (e?.message || e)); break; }
      if (remaining <= 0) { note(A, '次数已用完'); break; }
      const en = await guarded(A, { action: 'CAMP_ENTER', op: 'CAMP_ENTER' },
        () => ws.req('CAMP_ENTER', {}, { ms: 10000 }));
      if (!en?.success) { out.errors.push('CAMP_ENTER: ' + (en?.message || '')); break; }
      await sleep(1200);
      const realMap = Number(en?.data?.role?.mapId) || Number((await refresh())?.role?.mapId) || 0;
      note(A, `进入副本 map=${realMap || '?'}（额度 ${remaining}→${remaining - 1}）`);
      if (!realMap) { out.errors.push('拿不到副本内 mapId，中止以避免浪费额度'); break; }
      const trace = []; let lastTrace = 0;
      const res = await fightInMap(ws, store, realMap, { mode: 'dungeon', secsMax: 480_000, label: `伪宋军#${i + 1}`, onTick: (D) => {
        if (Date.now() - lastTrace < 10_000) return;
        lastTrace = Date.now();
        trace.push({ t: new Date().toISOString().slice(11, 19), stage: D.stage, def: D.combatProgress?.defeated, total: D.combatProgress?.total, hp: D.player?.currentHp, map: D.mapId });
        if (trace.length > 12) trace.shift();
      } });
      const endRole = (await refresh().catch(() => null))?.role;
      results.push({ run: i + 1, remainingBefore: remaining, realMap, why: res?.why, kills: res?.kills, secs: res?.secs, started: res?.started, endMap: endRole?.mapId, endHp: endRole?.currentHp, trace });
      note(A, `第${i + 1}次结束 why=${res?.why} kills=${res?.kills} ${res?.secs}s`);
      await sleep(800);
    }
    const g1 = await refresh();
    const after = { gold: g1?.role?.money ?? null, exp: g1?.role?.currentExp ?? null, bag: (g1?.bagItems || []).length };
    return { at: new Date().toISOString(), ok: out.errors.length === 0, maxRuns, results, before, after, activities: out.activities, errors: out.errors, mapId: g1?.role?.mapId };
  }

  // ── 塔 ──────────────────────────────────────────────────────
  async function tower(options = {}) {
    const A = 'tower';
    const maxFloors = Number(options.maxFloors ?? 5);
    out.at = new Date().toISOString();
    out.activities = []; out.errors = []; out.blocked = []; out.halted = false;

    let g = await refresh();
    if (g?.role?.mapId !== LUOYANG) {
      g = await ensureMap(LUOYANG);
      note(A, `回洛阳 map=${g?.role?.mapId}`);
    }
    ws.send('COMBAT_STOP');
    await sleep(800);

    const towerStatus = async () => (await ws.req('TRIAL_COMMAND', { action: 'status', requestId: crypto.randomUUID() }, { ms: 9000 }))?.data?.trial;
    const t0 = await towerStatus();
    if (!t0) { out.errors.push('塔状态无响应'); return out; }
    note(A, `最高层=${t0.highestFloor} 起点=${t0.startFloor} 门票=${t0.entryFee} 剩余=${t0.historyRemaining}`);
    if ((g?.role?.money || 0) < (t0.entryFee || 0)) { out.errors.push('金币不足，无法入塔'); return out; }

    const en = await guarded(A,
      { action: 'TRIAL_COMMAND', op: 'TRIAL_ENTER', goldCost: t0.entryFee || 0, money: g?.role?.money || 0, currency: 'gold' },
      () => ws.req('TRIAL_COMMAND', { action: 'enter', revision: t0.revision, requestId: crypto.randomUUID() }, { ms: 12000 }));
    if (!en?.success) { out.errors.push('入塔失败: ' + (en?.message || '')); return out; }
    note(A, '入塔 ✓');
    await sleep(2000);
    g = await refresh();
    if (g?.role?.mapId !== TOWER_MAP) { out.errors.push(`enter 后地图=${g?.role?.mapId}（应为 ${TOWER_MAP}）`); return out; }

    for (let floor = 1; floor <= maxFloors; floor++) {
      if (isHalted()) { out.halted = true; break; }
      const before = await towerStatus();
      const fn = before?.floor?.number;
      note(A, `第 ${fn} 层（${before?.floor?.kind}，${(before?.floor?.enemies || []).length} 只）`);
      const res = await fightInMap(ws, store, TOWER_MAP, { mode: 'floor', secsMax: 180_000, label: `塔${fn}` });
      note(A, `第 ${fn} 层 ${res.why} 击杀${res.kills} ${res.secs}s`);
      if (res.why !== '打满') { note(A, '未清层，停止'); break; }
      await sleep(1200);
      const nxt = await towerStatus();
      if (!nxt?.floor || nxt.floor.number <= fn) { note(A, '没有下一层了'); break; }
    }

    const stNow = await towerStatus();
    const sr = await guarded(A, { action: 'TRIAL_COMMAND', op: 'TRIAL_SURRENDER' },
      () => ws.req('TRIAL_COMMAND', { action: 'surrender', revision: stNow?.revision, requestId: crypto.randomUUID() }, { ms: 10000 }));
    if (sr?.success) note(A, '认负结算 ✓');
    await sleep(1200);
    await ensureMap(Number(process.env.TL_MAP || 10027));
    const tf = await towerStatus();
    note(A, `塔最高层=${tf?.highestFloor} sand=${tf?.balances?.sand} seals=${tf?.balances?.seals}`);
    out.dryRun = !canWrite();
    return out;
  }

  // ── 刷珍兽蛋（玄武岛）───────────────────────────────────────
  async function huntPet(options = {}) {
    const A = 'hunt_pet';
    const rounds = Number(options.rounds ?? 20);
    const target = Number(options.target ?? 150);
    const keep = Number(options.keep ?? 6);
    out.at = new Date().toISOString();
    out.activities = []; out.errors = []; out.blocked = []; out.halted = false;
    let best = 0, hatched = 0;

    for (let i = 1; i <= rounds; i++) {
      if (isHalted()) { out.halted = true; break; }
      try {
        await ensureMap(MAP_XUANWU);
        await sleep(600);
        const res = await fightInMap(ws, store, MAP_XUANWU, { mode: 'batch', secsMax: 180_000, label: `玄武岛#${i}` });
        note(A, `第${i}轮 ${res.why} ${res.kills}只 ${res.secs}s`);

        ws.send('COMBAT_STOP');
        await sleep(500);
        await ensureMap(SUZHOU);
        await sleep(600);

        // 容量满 → 放生最差（R2 保护最高资质）
        let st = (await ws.req('PET_COMMAND', { action: 'list', requestId: crypto.randomUUID() }, { ms: 8000 }))?.data?.state;
        if (st && st.pets.length >= st.capacity) {
          const sorted = [...st.pets].sort((a, b) => a.average - b.average);
          const worst = sorted[0];
          if (worst && worst.average < target) {
            if (st.activePetId === worst.pet.id) {
              await guarded(A, { action: 'PET_COMMAND', op: 'PET_SUMMON', petId: worst.pet.id, pet: worst, pets: st.pets },
                () => ws.req('PET_COMMAND', { action: 'summon', active: false, petId: worst.pet.id, requestId: crypto.randomUUID() }, { ms: 6000 }));
              await sleep(400);
            }
            if (worst.pet.locked) {
              await guarded(A, { action: 'PET_COMMAND', op: 'PET_UNLOCK', petId: worst.pet.id, pet: worst, pets: st.pets },
                () => ws.req('PET_COMMAND', { action: 'lock', locked: false, petId: worst.pet.id, requestId: crypto.randomUUID() }, { ms: 6000 }));
            }
            const rel = await guarded(A,
              { action: 'PET_COMMAND', op: 'PET_RELEASE', petId: worst.pet.id, pet: worst, pets: st.pets, dryRun: false, confirmed: true },
              () => ws.req('PET_COMMAND', { action: 'release', confirm: true, petId: worst.pet.id, requestId: crypto.randomUUID() }, { ms: 6000 }));
            if (rel?.success) note(A, `容量满，放生最差 ${worst.speciesName} ${worst.average}%`);
          }
        }

        // 孵蛋
        const g2 = await refresh();
        for (const e of (g2?.bagItems || []).filter(x => /珍兽蛋/.test(x.itemTmpl?.name || ''))) {
          const r = await guarded(A, { action: 'USE_ITEM', op: 'USE_ITEM', itemId: e.id, item: e },
            () => ws.req('USE_ITEM', { bagItemId: e.id, count: 1, requestId: crypto.randomUUID() }, { ms: 8000 }));
          if (r?.success) { hatched++; note(A, `孵化 ${e.itemTmpl?.name}`); }
          else if (/容量|满/.test(r?.message || '')) { note(A, '容量满，下次先放生'); break; }
          await sleep(600);
        }

        st = (await ws.req('PET_COMMAND', { action: 'list', requestId: crypto.randomUUID() }, { ms: 8000 }))?.data?.state;
        const top = st ? [...st.pets].sort((a, b) => b.average - a.average)[0] : null;
        if (top && top.average > best) {
          best = top.average;
          note(A, `★ 当前最好 ${top.speciesName} ${top.pet.form} ${top.average}% 战力${top.combatPower}`);
        }
        if (top && top.average >= target) { note(A, `🎉 达标 ${top.average}% >= ${target}%`); break; }
      } catch (e) { out.errors.push(`round${i}: ${e?.message || e}`); }
      await sleep(500);
    }

    note(A, `结束：孵化 ${hatched} 个，最好资质 ${best}%（保留线 ${keep}）`);
    out.dryRun = !canWrite();
    return out;
  }


  // ── 宝石合成 ────────────────────────────────────────────────
  //
  // 规则（2026-11-16 从前端包确认）：
  //   成功率 = base + per × (宝石数 - 2)，放 2~5 颗
  //     1→2: base 20, per 30, 上限 100
  //     2→3: base 20, per 18, 上限 74（有符 99）
  //     3→4: base 15, per 15, 上限 60（有符 85）
  //     4→5: base 12.5, per 12.5, 上限 50（有符 75）
  //     5→6: base 10, per 10, 上限 40（有符 65）
  //   合成符：1-4 级用低级符(5058)，5 级用高级符(5059)，放符 +25%
  //
  // 接口：GEM_SYNTH { gemBagItemIds: [同一个堆栈 id 重复 N 次], charmBagItemId? }
  //   实测：同一个 bagItemId 重复 5 次 = 从该堆栈取 5 颗，能成功。
  //
  // 策略：优先 1→2 级（放 5 颗必成），把散碎的 1 级宝石聚成 2 级；
  //       2 级以上不主动合（成功率会掉，且符有限）。
  async function synthesizeGems({ fromLevel = 1, toLevel = 2, maxRounds = 40 } = {}) {
    const A = 'gems';
    let rounds = 0, gained = 0;
    const TARGET = fromLevel;

    while (rounds < maxRounds) {
      if (isHalted()) break;
      const g = await refresh();
      if (!g?.role) break;

      // 按宝石类型分组，找数量 >= 5 的
      const groups = {};
      for (const b of (g.bagItems || [])) {
        const n = b.itemTmpl?.name || '';
        const m = n.match(/^(.+?)\((\d)级\)$/);
        if (!m) continue;
        if (Number(m[2]) !== TARGET) continue;
        // 跳过"纯净"系列（那是雕琢过的，价值更高，别拿去合）
        if (m[1].startsWith('纯净')) continue;
        (groups[m[1]] ||= []).push(b);
      }

      // 找可合成的：单一堆栈 count >= 5，或多堆栈合计 >= 5
      let picked = null;
      for (const [base, stacks] of Object.entries(groups)) {
        const total = stacks.reduce((a, b) => a + (b.count || 0), 0);
        if (total < 5) continue;
        // 优先用 count 最大的堆栈
        const big = stacks.slice().sort((a, b) => (b.count || 0) - (a.count || 0))[0];
        const take = Math.min(5, big.count || 0);
        // 如果单个堆栈不足 5，就用多个堆栈凑
        const ids = [];
        if ((big.count || 0) >= 5) {
          for (let i = 0; i < 5; i++) ids.push(big.id);
        } else {
          for (const st of stacks.sort((a,b)=>(b.count||0)-(a.count||0))) {
            for (let i = 0; i < (st.count || 0) && ids.length < 5; i++) ids.push(st.id);
          }
        }
        if (ids.length < 5) continue;
        picked = { base, ids, total };
        break;
      }
      if (!picked) break;

      const r = await ws.req('GEM_SYNTH', { gemBagItemIds: picked.ids }, { ms: 12000 }).catch(e => ({ success: false, message: e?.message }));
      rounds++;
      if (r?.success || /成功/.test(r?.message || '')) {
        gained++;
        note(A, `合成 ${picked.base} ${fromLevel}→${toLevel} 成功（第 ${rounds} 次）`);
        audit.log('gem_synth', { cat: 'craft', reason: `${fromLevel}级→${toLevel}级 放5颗必成`,
          cost: [{ item: `${picked.base}(${fromLevel}级)`, n: 5 }],
          gain: [{ item: `${picked.base}(${toLevel}级)`, n: 1 }] });
      } else {
        note(A, `合成 ${picked.base} 失败: ${r?.message || '未知'}`);
        await sleep(800);
      }
      await sleep(900);
    }

    if (rounds === 0) note(A, `${fromLevel} 级宝石不足 5 颗，无需合成`);
    else note(A, `本轮合成 ${gained}/${rounds} 次成功`);
    return { ok: true, rounds, gained };
  }


  // ── 苏州在线抽奖（快活叁）─────────────────────────────────
  //
  // 机制（2026-11-16 实测）：
  //   · 必须在苏州 mapId=5 才能抽
  //   · 每在线 30 分钟给 1 次，每日上限 12 次
  //   · 奖励可能是金币（实测一次 59 万）、宝石、装备等
  //
  // 协议：ONLINE_LOTTERY_COMMAND { action, page, requestId }
  //   action = "query" | "history" | "draw"
  // 状态：ONLINE_LOTTERY_STATE { enabled, balance, grantedToday, dailyLimit, nextInMillis }
  // 结果：ONLINE_LOTTERY_RESPONSE { success, receipt: { reward }, ... }
  //
  // 抽完自动回原地图继续挂机。
  async function lottery({ maxDraws = 20 } = {}) {
    const A = 'lottery';
    const g0 = await refresh();
    if (!g0?.role) { out.errors.push('lottery: 无角色状态'); return { ok: false }; }
    const homeMap = Number(g0.role.mapId) || 10027;

    // 1. 去苏州
    if (Number(g0.role.mapId) !== SUZHOU) {
      try { await goMap(ws, store, SUZHOU, { ms: 12000 }); } catch { }
      await sleep(1200);
    }

    // 2. 查状态
    let state = null;
    const off = ws.on('ONLINE_LOTTERY_STATE', m => { if (m?.data) state = m.data; });
    await ws.req('ONLINE_LOTTERY_COMMAND', { action: 'query', page: 0, requestId: crypto.randomUUID() }, { ms: 10000 })
      .catch(() => null);
    await sleep(800);
    try { off?.(); } catch { }

    if (!state) {
      note(A, '未拿到抽奖状态');
      if (Number(g0.role.mapId) !== homeMap) { await goMap(ws, store, homeMap, { ms: 12000 }).catch(() => {}); }
      return { ok: false, reason: 'no-state' };
    }

    note(A, `抽奖状态 启用=${state.enabled} 余额=${state.balance} 今日已抽 ${state.grantedToday}/${state.dailyLimit}`);
    if (!state.enabled) {
      note(A, '抽奖功能未启用');
      if (Number(g0.role.mapId) !== homeMap) { await goMap(ws, store, homeMap, { ms: 12000 }).catch(() => {}); }
      return { ok: true, draws: 0, rewards: [] };
    }
    if ((state.balance ?? 0) <= 0) {
      note(A, `没有可用的抽奖次数（${state.grantedToday}/${state.dailyLimit}，下次恢复 ${state.nextInMillis}ms）`);
      if (Number(g0.role.mapId) !== homeMap) { await goMap(ws, store, homeMap, { ms: 12000 }).catch(() => {}); }
      return { ok: true, draws: 0, rewards: [] };
    }

    // 3. 抽
    const rewards = [];
    let draws = 0;
    for (let i = 0; i < maxDraws; i++) {
      if (isHalted()) break;
      // 复查余额
      let cur = null;
      const off2 = ws.on('ONLINE_LOTTERY_STATE', m => { if (m?.data) cur = m.data; });
      await ws.req('ONLINE_LOTTERY_COMMAND', { action: 'query', page: 0, requestId: crypto.randomUUID() }, { ms: 8000 }).catch(() => null);
      await sleep(600);
      try { off2?.(); } catch { }
      const bal = cur?.balance ?? 0;
      if (bal <= 0) { note(A, `余额不足，停止（已抽 ${draws} 次）`); break; }

      // 发抽奖
      let result = null;
      const off3 = ws.on('ONLINE_LOTTERY_RESPONSE', m => {
        const b = m?.data;
        if (b?.action === 'draw' || b?.receipt) result = b;
      });
      const r = await ws.req('ONLINE_LOTTERY_COMMAND', { action: 'draw', requestId: crypto.randomUUID() }, { ms: 15000 }).catch(e => ({ success: false, message: e?.message }));
      await sleep(800);
      try { off3?.(); } catch { }

      const ok = r?.success || result?.success || r?.receipt || result?.receipt;
      if (ok) {
        draws++;
        const rw = (r?.receipt || result?.receipt || r?.data?.receipt)?.reward;
        if (rw) {
          const label = rw.kind === 'GOLD' ? `${rw.amount} 金币` : `${rw.name || rw.key} ×${rw.count || 1}`;
          rewards.push(label);
          note(A, `抽奖第 ${draws} 次: ${label}`);
          audit.log('lottery_draw', { cat: 'lottery', reason: '在线时长赠送的免费次数',
            cost: [{ item: '抽奖次数', n: 1 }], gain: [{ item: label }] });
        } else {
          note(A, `抽奖第 ${draws} 次成功（无回执明细）`);
        }
      } else {
        note(A, `抽奖失败: ${r?.message || '未知'}`);
        break;
      }
      await sleep(700);
    }

    // 4. 回原地图
    if (homeMap !== SUZHOU) {
      await goMap(ws, store, homeMap, { ms: 12000 }).catch(() => {});
      note(A, `已回地图 ${homeMap}`);
    }
    return { ok: true, draws, rewards };
  }


  // ── 材料加工（纯收益，不消耗装备）──────────────────────────
  //
  // 三件事，每天自动跑：
  //   ① 宝石合成    1级 → 2级（放 5 颗 100% 成功）
  //   ② 布/银合成   碎片 → 1级（5 个 100% 成功）
  //   ③ 强化        有精华就强化当前装备
  //   ④ 熔炼投经验  已启动的熔炼，经验够了就投
  //
  // 这些都是"只进不出"的操作：材料变高级、装备变强、经验投给熔炼。
  async function craftMaterials() {
    const A = 'craft';
    const result = { gems: null, cotton: null, enhance: null, smelt: null };

    // ① 宝石合成
    try { result.gems = await synthesizeGems({ fromLevel: 1, toLevel: 2, maxRounds: 60 }); }
    catch (e) { out.errors.push('gems: ' + (e?.message || e)); }

    // ② 布/银合成
    try { result.cotton = await synthesizeCotton(); }
    catch (e) { out.errors.push('cotton: ' + (e?.message || e)); }

    // ③ 强化
    try { result.enhance = await enhanceGear(); }
    catch (e) { out.errors.push('enhance: ' + (e?.message || e)); }

    // ④ 熔炼投经验
    try { result.smelt = await investSmelting(); }
    catch (e) { out.errors.push('smelt: ' + (e?.message || e)); }

    return result;
  }

  // 布/银合成：碎片(5007/5016) → 1级(5008/5017)，5 个一次，100% 成
  async function synthesizeCotton() {
    const A = 'craft';
    let cotton = 0, mithril = 0;
    const cnt = (g, id) => (g.bagItems || []).filter(b => b.itemId === id).reduce((a, b) => a + (b.count || 0), 0);

    // 棉布
    for (let i = 0; i < 30; i++) {
      if (isHalted()) break;
      const g = await refresh();
      if (cnt(g, 5007) < 5) break;
      const r = await ws.req('SYNTHESIZE_COTTON', { materialType: 'COTTON', targetLevel: 1, count: 1 }, { ms: 12000 }).catch(e => ({ success: false, message: e?.message }));
      if (r?.success || /成功/.test(r?.message || '')) {
        cotton++;
        audit.log('cotton_synth', { cat: 'craft', reason: '碎片5个→1级成品(100%)',
          cost: [{ item: '棉布碎片', n: 5 }], gain: [{ item: '1级棉布', n: 1 }] });
      } else break;
      await sleep(600);
    }
    // 秘银
    for (let i = 0; i < 30; i++) {
      if (isHalted()) break;
      const g = await refresh();
      if (cnt(g, 5016) < 5) break;
      const r = await ws.req('SYNTHESIZE_COTTON', { materialType: 'MITHRIL', targetLevel: 1, count: 1 }, { ms: 12000 }).catch(e => ({ success: false, message: e?.message }));
      if (r?.success || /成功/.test(r?.message || '')) {
        mithril++;
        audit.log('mithril_synth', { cat: 'craft', reason: '碎片5个→1级成品(100%)',
          cost: [{ item: '秘银碎片', n: 5 }], gain: [{ item: '1级秘银', n: 1 }] });
      } else break;
      await sleep(600);
    }
    if (cotton || mithril) note(A, `布银合成 棉布+${cotton} 秘银+${mithril}`);
    return { cotton, mithril };
  }

  // 强化：用强化精华强化当前穿戴（40 级以上只能用高级精华）
  async function enhanceGear() {
    const A = 'craft';
    let ok = 0, fail = 0;
    for (let i = 0; i < 8; i++) {
      if (isHalted()) break;
      const g = await refresh();
      // 只找高级精华（低级精华对 40 级以上装备无效）
      const ess = (g.bagItems || []).filter(b => /高级强化精华/.test(b.itemTmpl?.name || '') && (b.count || 0) > 0);
      if (!ess.length) break;
      // 挑品质高的、强化低的
      const target = (g.equipments || [])
        .filter(e => e.isEquipped && (e.enhanceLevel || 0) < 9)
        .sort((a, b) => (b.equipTmpl?.qualityBase || 1) - (a.equipTmpl?.qualityBase || 1))[0];
      if (!target) break;
      const r = await ws.req('SMITHY_ENHANCE', { roleEquipId: target.id, materialBagId: ess[0].id }, { ms: 12000 }).catch(e => ({ success: false, message: e?.message }));
      if (r?.success || /成功/.test(r?.message || '')) {
        ok++;
        note(A, `强化 ${target.equipTmpl?.name} → +${(target.enhanceLevel || 0) + 1}`);
        audit.log('enhance', { cat: 'craft', reason: '品质最高的可强化装备',
          cost: [{ item: ess[0].itemTmpl?.name || '强化精华', n: 1 }],
          gain: [{ item: `${target.equipTmpl?.name} +${(target.enhanceLevel || 0) + 1}` }] });
      }
      else { fail++; note(A, `强化 ${target.equipTmpl?.name} 失败: ${r?.message || ''}`); }
      await sleep(1000);
    }
    return { ok, fail };
  }

  // 熔炼：如果已启动，把多余经验投进去（留 2000 万给日常）
  async function investSmelting() {
    const A = 'craft';
    // 规划器结论：升星约 0.28 CP/M exp，远低于喂珍兽(1.55)与升级(1.11)。
    // 默认不自动烧经验；需要时显式设 TL_SMELT_BUDGET=<经验数>（如 10000000）。
    const budget = Number(process.env.TL_SMELT_BUDGET || 0);
    if (budget <= 0) return { active: false, skipped: 'TL_SMELT_BUDGET=0（低 ROI，默认不投）' };
    const g = await refresh();
    if (!g?.role?.smeltingItemId) return { active: false };
    const target = g.role.smeltingTargetExp || 0;
    const cur = g.role.smeltingExp || 0;
    if (cur >= target) {
      note(A, '熔炼经验已满，尝试完成');
      const r = await ws.req('SMITHY_SMELT_COMPLETE', {}, { ms: 12000 }).catch(e => ({ success: false, message: e?.message }));
      return { active: true, completed: !!r?.success, message: r?.message };
    }
    const spare = (g.role.currentExp || 0) - 20_000_000;
    if (spare <= 0) return { active: true, invested: 0, progress: `${cur}/${target}` };
    const amount = Math.min(spare, budget);
    const r = await ws.req('SMITHY_SMELT_INVEST', { expAmount: amount }, { ms: 15000 }).catch(e => ({ success: false, message: e?.message }));
    note(A, `熔炼投经验 ${amount.toLocaleString()}（进度 ${(cur + (r?.success ? amount : 0)).toLocaleString()}/${target.toLocaleString()}）`);
    if (r?.success) audit.log('smelt_invest', { cat: 'craft', reason: '熔炼进度未满，投入多余经验',
      cost: [{ item: '角色经验', n: amount }],
      extra: { progress: `${cur + amount}/${target}`, itemId: g.role.smeltingItemId } });
    return { active: true, invested: r?.success ? amount : 0, progress: `${cur}/${target}` };
  }

  return { dailyTasks, campRun, tower, huntPet, synthesizeGems, synthesizeCotton, enhanceGear, investSmelting, craftMaterials, lottery, out, refresh };
}
