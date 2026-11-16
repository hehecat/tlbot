// src/activities.mjs —— 日常 / 塔 / 刷蛋（PRD §2）
//
// 调用方（extension）负责：pause CombatDaemon → 调这里 → resume
// 本模块假设战斗已暂停；每个 activity 返回战报。
//
// 所有写操作过 core/redlines.mjs；.halt 时立即停。

import crypto from 'node:crypto';
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

      const r = await guarded(A, { action: 'CAMP_ENTER', op: 'CAMP_ENTER' },
        () => ws.req('CAMP_ENTER', {}, { ms: 10000 }));
      if (!r?.success) { note(A, '进伪宋军失败: ' + (r?.message || '')); break; }
      await sleep(800);
      const res = await fightInMap(ws, store, MAP_CAMP, { mode: 'dungeon', secsMax: 480_000, label: `伪宋军#${i + 1}` });
      note(A, `伪宋军 #${i + 1} ${res.why} ${res.kills} 只 ${res.secs}s`);
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
          await sleep(800);
          const res = await fightInMap(ws, store, MAP_BEAR, { mode: 'dungeon', secsMax: 480_000, label: '熊林' });
          note(A, `熊林 ${res.why} ${res.kills} 只 ${res.secs}s`);
        } else {
          note(A, '进熊林失败: ' + (en?.message || '未知'));
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

  return { dailyTasks, tower, huntPet, out, refresh };
}
