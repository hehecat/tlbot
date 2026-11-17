// engine/http.mjs —— 引擎的 HTTP 控制面（任意 agent 都能接）
//
// 设计：
//   · 只依赖 node 内置 http，零第三方库
//   · 只监听 127.0.0.1，不对外暴露
//   · 只读接口大量，写接口少而明确
//   · 所有写操作走 engine 的红线检查，HTTP 层不绕过
//
// 给 agent 用的最小接口集：
//   GET  /status              完整状态快照
//   GET  /status/brief        一行摘要（省 token）
//   GET  /gear                当前配装 + 官方评分建议
//   GET  /drops?map=&limit=   掉落统计
//   POST /maintain            立刻跑一次后勤
//   POST /daily               立刻跑一次日常
//   POST /combat/{start|pause|resume}
//   POST /config              改地图/喝药阈值
//   POST /reconnect           强制重连
//   POST /halt                写 .halt（5 秒内静默）
//   POST /unhalt              删 .halt

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildPlan, collectCtx } from '../src/planner.mjs';
import { itemValue } from '../core/lib-value.mjs';
import { evalMaps, DEFAULT_MAP_WEIGHTS } from '../src/map-eval.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const HALT_FILE = path.join(ROOT, '.halt');

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 1);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

export function startHttp(engine, port = 9527) {
  const { state, log } = engine;

  // 独占执行：暂停战斗 → 执行 → 回图 → 恢复（System2 动作统一入口）
  const exclusive = async (fn) => {
    if (state.schedBusy) return { busy: true, error: '调度忙' };
    if (!state.strategy) return { error: 'strategy 未初始化' };
    state.schedBusy = true;
    const was = !!state.daemon?.running;
    try {
      if (was) { state.daemon.pause('strategy'); await state.daemon.whenIdle?.(15_000); }
      await new Promise(r => setTimeout(r, 600));
      return await fn();
    } finally {
      try {
        const want = map0;
        await state.strategy.refresh();
        if (state.game?.role?.mapId && state.game.role.mapId !== want) {
          state.ws.send('ENTER_MAP', { mapId: want });
          await new Promise(r => setTimeout(r, 1200));
          await state.strategy.refresh();
        }
      } catch { }
      try { if (was) state.daemon.resume(); } catch { }
      state.schedBusy = false;
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method || 'GET';

    try {
      // ── 只读 ──
      if (method === 'GET' && p === '/sects') {
        return json(res, 200, { at: new Date().toISOString(), sects: state.loginMeta?.sects || [] });
      }
      if (method === 'GET' && p === '/performance') {
        const u = new URL(req.url, 'http://127.0.0.1');
        const minutes = Math.min(240, Math.max(5, Number(u.searchParams.get('minutes')) || 60));
        return json(res, 200, state.perf ? state.perf.report(minutes) : { rows: [] });
      }
      if (method === 'GET' && p === '/status') {
        const snap = state.store?.getSnapshot?.() || {};
        return json(res, 200, {
          at: new Date().toISOString(),
          engine: 'standalone',
          halted: fs.existsSync(HALT_FILE),
          ws: { closed: !!state.ws?.state?.closed, connectedAt: state.connectedAt },
          daemon: state.daemon?.status?.() || null,
          me: snap.me, combat: snap.combat, rates: snap.rates, pets: snap.pets,
          health: { unknown: snap.health?.unknown, packets: snap.health?.packets, stalled: snap.health?.stalled },
          sched: { lastMaintainAt: state.lastMaintainAt, lastDailyKey: state.schedState.lastDailyKey, busy: state.schedBusy },
          errors: snap.health?.recentErrors || [],
        });
      }

      if (method === 'GET' && p === '/status/brief') {
        const snap = state.store?.getSnapshot?.() || {};
        const me = snap.me || {};
        const c = snap.combat || {};
        const d = state.daemon?.status?.() || {};
        return json(res, 200, {
          at: new Date().toISOString(),
          level: me.level, power: me.power, gold: me.gold, exp: me.exp,
          combat: `${c.stage || '-'} ${c.progress || ''} hp=${Math.round(c.hp || 0)}`,
          daemon: d.running ? 'running' : (d.paused ? 'paused' : 'stopped'),
          batches: d.stats?.batches, deaths: d.stats?.deaths, kills: d.stats?.kills,
          bag: me.bagCount, halted: fs.existsSync(HALT_FILE),
          wsClosed: !!state.ws?.state?.closed,
        });
      }

      if (method === 'GET' && p === '/gear') {
        const g = engine.game || await engine.refresh();
        if (!g?.role) return json(res, 503, { error: 'ER 无状态' });
        const reports = await engine.evaluate.scanAllSlots(state.ws, g);
        const swaps = reports.filter(r => r.shouldSwap).map(r => ({
          slot: r.slot,
          from: r.equippedNow?.equipTmpl?.name || '空',
          to: r.best?.item?.equipTmpl?.name,
          damagePct: r.best?.raw?.damagePct,
          power: r.best?.raw?.equipmentPower,
        }));
        return json(res, 200, {
          power: g.role.combatPower,
          worn: (g.equipments || []).filter(e => e.isEquipped)
            .map(e => ({ slot: e.equipTmpl?.slotType, name: e.equipTmpl?.name, enhance: e.enhanceLevel, star: e.starLevel })),
          suggestions: swaps,
          slots: reports.map(r => ({ slot: r.slot, shouldSwap: r.shouldSwap, why: r.why })),
        });
      }

      if (method === 'GET' && p === '/drops') {
        const map = url.searchParams.get('map');
        const limit = Number(url.searchParams.get('limit') || 20);
        const f = path.join(ROOT, 'data', 'live_drops.json');
        let d = {};
        try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { }
        const byMap = d.byMap || {};
        if (map && byMap[map]) {
          const items = Object.entries(byMap[map])
            .sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0)).slice(0, limit);
          return json(res, 200, { map, items: Object.fromEntries(items) });
        }
        return json(res, 200, {
          maps: Object.keys(byMap),
          top: Object.entries(byMap).slice(0, 10).map(([m, items]) => ({
            map: m, kinds: Object.keys(items).length,
          })),
        });
      }

      // ── 审计日志 ──
      if (method === 'GET' && p === '/audit') {
        const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
        const action = url.searchParams.get('action');
        const cat = url.searchParams.get('cat');
        const limit = Number(url.searchParams.get('limit') || 100);
        let rows = engine.audit?.read?.(date) || [];
        if (action) rows = rows.filter(r => r.action === action);
        if (cat) rows = rows.filter(r => r.cat === cat);
        return json(res, 200, { date, count: rows.length, rows: rows.slice(-limit) });
      }

      if (method === 'GET' && p === '/audit/summary') {
        const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
        return json(res, 200, engine.audit?.summary?.(date) || { error: '审计模块未加载' });
      }

      // ── 游戏元数据（自动同步的成果）──
      if (method === 'GET' && p === '/gamedata') {
        const gd = engine.gamedata;
        const meta = gd?.loadSnapshot?.() || engine.state.gamedata;
        if (!meta) return json(res, 503, { error: '尚未同步（等首次 ENTER_GAME）' });
        return json(res, 200, {
          at: meta.at,
          maps: meta.maps?.length, sets: meta.equipSets?.length,
          shop: meta.shopItems?.length, templates: meta.templateCount,
          skills: meta.skills,
          recentChanges: engine.state.gamedataChanges || [],
        });
      }

      if (method === 'GET' && p === '/gamedata/maps') {
        const meta = engine.gamedata?.loadSnapshot?.() || engine.state.gamedata;
        if (!meta) return json(res, 503, { error: '尚未同步' });
        const filter = url.searchParams.get('type') || 'normal';
        let maps = meta.maps || [];
        if (filter === 'normal') maps = maps.filter(m => m.id < 20000);
        else if (filter === 'dungeon') maps = maps.filter(m => m.id >= 20000);
        return json(res, 200, maps.map(m => ({
          id: m.id, name: m.name, reqLevel: m.reqLevel,
          monsters: (m.monsters || []).length, drops: (m.drops || []).length,
        })));
      }

      if (method === 'GET' && p === '/gamedata/best-map') {
        const snap = engine.state.store?.getSnapshot?.();
        const lv = snap?.me?.level || 1;
        const m = engine.gamedata?.bestMapForLevel?.(lv);
        return json(res, 200, { level: lv, best: m ? { id: m.id, name: m.name, reqLevel: m.reqLevel } : null });
      }

      if (method === 'GET' && p === '/gamedata/skills') {
        const meta = engine.gamedata?.loadSnapshot?.() || engine.state.gamedata;
        if (!meta) return json(res, 503, { error: '尚未同步' });
        const plan = engine.gamedata?.skillUpgradePlan?.() || [];
        const exp = engine.state.store?.getSnapshot?.()?.me?.exp || 0;
        return json(res, 200, {
          currentExp: exp,
          plan: plan.map(s => ({
            name: s.name, level: s.level, maxLevel: s.maxLevel,
            nextExp: s.nextExp, affordable: exp >= s.nextExp,
          })),
        });
      }

      // ── 写操作 ──
      // ── 塔只读状态 ──
      if (method === 'GET' && p === '/tower') {
        try {
          const r = await state.ws.req('TRIAL_COMMAND', { action: 'status', requestId: crypto.randomUUID() }, { ms: 9000 });
          return json(res, 200, r?.data?.trial || r?.data || r || {});
        } catch (e) { return json(res, 502, { error: e?.message || String(e) }); }
      }

      // ── 无双（双倍经验）状态 ──
      if (method === 'GET' && p === '/wushuang') {
        try {
          const r = await state.ws.req('WUSHUANG_STATUS', {}, { ms: 6000 });
          return json(res, 200, r?.data || r || {});
        } catch (e) { return json(res, 502, { error: e?.message || String(e) }); }
      }

      // ── 跑塔（独占战斗）──
      if (method === 'POST' && p === '/tower/run') {
        if (state.schedBusy) return json(res, 409, { error: '调度忙' });
        const body = await readBody(req);
        const maxFloors = Math.max(1, Math.min(20, Number(body.maxFloors || 5)));
        const was = !!state.daemon?.running;
        try {
          if (was) state.daemon.pause('tower');
          await new Promise(r => setTimeout(r, 1500));
          const out = await state.activities.tower({ maxFloors });
          return json(res, 200, out);
        } catch (e) {
          return json(res, 500, { error: e?.message || String(e) });
        } finally {
          if (was) { try { state.daemon.resume(); } catch { } }
        }
      }


      // ── System2 动作（独占执行）──
      if (method === 'GET' && p === '/strategy/state') {
        return json(res, 200, { at: new Date().toISOString(), state: state.strategy?.state || null });
      }

      // ── 每日副本/日常只读状态（ZL/CAMP/WUSHUANG/TRIAL）──
      if (method === 'GET' && p === '/daily/status') {
        const out = { at: new Date().toISOString() };
        const rd = async (alias, cmd, body) => {
          try { const r = await state.ws.req(cmd, body || {}, { ms: 8000 }); out[alias] = r?.data ?? r; }
          catch (e) { out[alias] = { error: e?.message || String(e) }; }
        };
        await rd('zl', 'ZL_STATUS');
        await rd('camp', 'CAMP_STATUS');
        await rd('wushuang', 'WUSHUANG_STATUS');
        await rd('trial', 'TRIAL_COMMAND', { action: 'status' });
        return json(res, 200, out);
      }
      // ── Max ΔCP/h 规划（纯只读；live=1 时额外查珍兽/塔）──
      if (method === 'GET' && p === '/plan') {
        try {
          const live = url.searchParams.get('live') === '1';
          const ctx = await collectCtx(engine, { live });
          return json(res, 200, buildPlan(ctx));
        } catch (e) { return json(res, 500, { error: e?.message || String(e) }); }
      }
      // ── 只读协议调试（仓库列表探测；仅白名单）──
      if (method === 'POST' && p === '/debug/req') {
        const body = await readBody(req);
        const allow = new Set(['GET_WAREHOUSE', 'WAREHOUSE_LIST', 'WAREHOUSE_INFO', 'GET_WAREHOUSE_LIST', 'WAREHOUSE_OPEN', 'EQUIP_ITEM', 'GET_SECT_LIST']);
        if (!allow.has(body.type)) return json(res, 400, { error: 'type not allowed' });
        try { return json(res, 200, await state.ws.req(body.type, body.payload || {}, { ms: 8000 })); }
        catch (e) { return json(res, 500, { error: e?.message || String(e) }); }
      }
      // ── 自动喝药：立即应用并回读服务端 settings ──
      if (method === 'GET' && p === '/settings') {
        try {
          const applied = await state.logistics.applyPotionSettings();
          const g = await engine.refresh();
          let parsed = null; try { parsed = JSON.parse(g?.role?.settings || 'null'); } catch {}
          return json(res, 200, { applied, settings: parsed, raw: g?.role?.settings ?? null });
        } catch (e) { return json(res, 500, { error: e?.message || String(e) }); }
      }
      if (method === 'POST' && p === '/settings/potions') {
        try { return json(res, 200, await state.logistics.applyPotionSettings()); }
        catch (e) { return json(res, 500, { error: e?.message || String(e) }); }
      }
      // ── 背包/仓库整理：只读计划 ──
      if (method === 'GET' && p === '/inventory/plan') {
        try { return json(res, 200, await state.logistics.auditInventory()); }
        catch (e) { return json(res, 500, { error: e?.message || String(e) }); }
      }
      // ── 仓库取出一件装备（WITHDRAW 协议来自前端 bundle）──
      if (method === 'POST' && p === '/inventory/withdraw') {
        const body = await readBody(req);
        if (!body.roleEquipId) return json(res, 400, { error: 'roleEquipId required' });
        try { return json(res, 200, await state.logistics.withdrawItem(body.roleEquipId)); }
        catch (e) { return json(res, 500, { error: e?.message || String(e) }); }
      }
      // ── NPC 直卖单件（默认 dry-run）──
      if (method === 'POST' && p === '/inventory/sell') {
        const body = await readBody(req);
        if (!body.roleEquipId) return json(res, 400, { error: 'roleEquipId required' });
        return json(res, 200, await state.logistics.sellItem(body.roleEquipId, { confirmed: body.confirmed === true }));
      }
      // ── 换上一件背包装备（官方写包 + 掉战力回滚）──
      if (method === 'POST' && p === '/inventory/equip') {
        const body = await readBody(req);
        if (!body.roleEquipId) return json(res, 400, { error: 'roleEquipId required' });
        return json(res, 200, await exclusive(() => state.logistics.equipItem(body.roleEquipId)));
      }
      // ── 单次整理背包/仓库（用户明确要求“单次清理”，不随 maintain 常驻）──
      if (method === 'POST' && p === '/inventory/tidy') {
        const body = await readBody(req);
        const dryRun = body.dryRun !== false;
        if (dryRun) {
          const plan = await state.logistics.auditInventory();
          return json(res, 200, { dryRun: true, summary: plan.summary, sellBag: plan.sellBag, sellWarehouse: plan.sellWarehouse, upgrade: plan.upgrade });
        }
        return json(res, 200, await exclusive(() => state.logistics.tidyInventory(undefined, { upgrades: false })));
      }
      // ── 挂单 5 折满 3 小时 → 3 折（手动触发；runtime 也会自动做一次）──
      if (method === 'POST' && p === '/consignment/clearance/followup') {
        const body = await readBody(req);
        return json(res, 200, await exclusive(() => state.strategy.clearanceFollowup({ factor: Number(body.factor || 0.3) })));
      }
      // ── 挂单下架 + 折价重挂（默认 dry-run）──
      if (method === 'POST' && p === '/consignment/clearance') {
        const body = await readBody(req);
        const dryRun = body.dryRun !== false;
        return json(res, 200, await exclusive(() => state.strategy.clearanceListings({ factor: Number(body.factor || 0.5), dryRun, max: Number(body.max || 25) })));
      }
      // ── 伪宋军受控测试（每次消耗 1/5 额度，可 1-5 连跑）──
      if (method === 'POST' && p === '/daily/camp') {
        const body = await readBody(req);
        return json(res, 200, await exclusive(() => state.activities.campRun({ maxRuns: Number(body.maxRuns || 1) })));
      }
      // ── 暗器（飞蝗石）经验喂养：用户确认的 NPC 直接经验升级 ──
      if (method === 'POST' && p === '/anqi/feed') {
        return json(res, 200, await exclusive(async () => {
          const g0 = await state.strategy.refresh();
          const p0 = g0?.role?.combatPower ?? null;
          const mv = await state.ws.req('ENTER_MAP', { mapId: 4 }, { ms: 8000 });
          if (mv && mv.success === false) return { error: '去洛阳失败: ' + (mv.message || '') };
          await new Promise(r => setTimeout(r, 700));
          const st0 = await state.ws.req('TRIAL_COMMAND', { action: 'status', requestId: crypto.randomUUID() }, { ms: 9000 });
          const t0 = st0?.data?.trial;
          if (!t0) return { error: 'TRIAL_COMMAND status 无响应' };
          const before = { level: t0.level, quality: t0.weapon?.quality, exp: t0.weapon?.experience, next: t0.nextLevelExp, power: p0, sand: t0.balances?.sand, jade: t0.balances?.jade };
          const target = Number(t0.level || 0) + 1;
          const r = await state.ws.req('TRIAL_COMMAND', { action: 'feed', targetLevel: target, revision: t0.revision, requestId: crypto.randomUUID() }, { ms: 12000 });
          await new Promise(r2 => setTimeout(r2, 600));
          const g1 = await state.strategy.refresh();
          const st1 = await state.ws.req('TRIAL_COMMAND', { action: 'status', requestId: crypto.randomUUID() }, { ms: 9000 });
          const t1 = st1?.data?.trial || t0;
          return {
            ok: !!r?.success, message: r?.message, target,
            before, after: { level: t1.level, quality: t1.weapon?.quality, exp: t1.weapon?.experience, next: t1.nextLevelExp, power: g1?.role?.combatPower ?? null },
            gainPower: (g1?.role?.combatPower ?? 0) - (p0 ?? 0), trial: t1,
          };
        }));
      }
      if (method === 'POST' && p === '/strategy/breed/deposit') {
        const body = await readBody(req);
        return json(res, 200, await exclusive(() => state.strategy.breedDeposit({ petId: body.petId || null })));
      }
      if (method === 'POST' && p === '/strategy/breed/claim') {
        const body = await readBody(req);
        return json(res, 200, await exclusive(() => state.strategy.breedClaim({ force: !!body.force })));
      }
      if (method === 'POST' && p === '/strategy/summon') {
        const body = await readBody(req);
        return json(res, 200, await exclusive(() => state.strategy.summonPet({ petId: body.petId || null })));
      }
      if (method === 'POST' && p === '/strategy/hatch') {
        const body = await readBody(req);
        return json(res, 200, await exclusive(() => state.strategy.hatchEggs({ max: Number(body.max || 3), release: body.release !== false })));
      }
      if (method === 'POST' && p === '/strategy/feed') {
        const body = await readBody(req);
        return json(res, 200, await exclusive(() => state.strategy.feedPet({ amount: Number(body.amount || 5_000_000), petId: body.petId || null })));
      }
      if (method === 'POST' && p === '/strategy/wushuang') {
        const body = await readBody(req);
        return json(res, 200, await exclusive(() => state.strategy.wushuang({ use: body.use !== false })));
      }

      if (method === 'POST' && p === '/consignment/cancel') {
        const body = await readBody(req);
        return json(res, 200, await exclusive(async () => {
          const id = Number(body.id);
          if (!id) return { error: 'id 必填' };
          const r = await state.ws.req('CONSIGNMENT_CANCEL', { consignmentId: id }, { ms: 8000 });
          return { id, ok: !!r?.success, message: r?.message || null };
        }));
      }

      // ── 清垃圾装备（直卖 NPC，腾背包；只卖明显弱于已穿的白/蓝装）──
      if (method === 'POST' && p === '/sell/junk') {
        const body = await readBody(req);
        const max = Math.min(30, Math.max(1, Number(body.max || 15)));
        return json(res, 200, await exclusive(async () => {
          const g = engine.game;
          if (!g?.role) return { error: 'ER 无状态' };
          const all = (g.equipments || []).filter(x => x?.equipTmpl);
          const iv = x => itemValue(x, { gemInfo: g.gemInfo });
          const bestWorn = {};
          for (const x of all) if (x.isEquipped) { const sl = x.equipTmpl.slotType; bestWorn[sl] = Math.max(bestWorn[sl] || 0, iv(x)); }
          const bySlot = {};
          for (const x of all) { const sl = x.equipTmpl.slotType; (bySlot[sl] ||= []).push(x); }
          const top2 = new Set();
          for (const arr of Object.values(bySlot)) arr.slice().sort((a, b) => iv(b) - iv(a)).slice(0, 2).forEach(x => top2.add(x.id));
          const setTmpl = new Set();
          for (const st0 of (g.equipSets || [])) { try { for (const id of JSON.parse(st0.equipTmplIds || '[]')) setTmpl.add(Number(id)); } catch { } }
          const cand = all.filter(x => {
            if (x.isEquipped) return false;
            if (x.equipTmpl.slotType === 1) return false;
            if (setTmpl.has(Number(x.equipTmpl.id))) return false;
            if (top2.has(x.id)) return false;
            const q = Number(x.quality ?? 1);
            const b = bestWorn[x.equipTmpl.slotType] || 0;
            if (q <= 1) return iv(x) < b * 0.8;
            if (q === 2) return iv(x) < b * 0.5;
            return false;
          }).sort((a, b) => iv(a) - iv(b)).slice(0, max);
          const out = [];
          for (const x of cand) {
            const r = await state.ws.req('SHOP_SELL', { roleEquipId: x.id, count: 1 }, { ms: 6000 });
            out.push({ id: x.id, name: x.equipTmpl?.name, q: x.quality, iv: Math.round(iv(x)), ok: !!r?.success, msg: r?.message || null });
            await new Promise(r => setTimeout(r, 250));
          }
          return { tried: out.length, sold: out.filter(o => o.ok).length, results: out };
        }));
      }

      if (method === 'POST' && p === '/sell/good') {
        const body = await readBody(req);
        const max = Math.min(10, Math.max(1, Number(body.max || 5)));
        return json(res, 200, await exclusive(() => state.strategy.sellUnusedGear({ dryRun: body.dryRun !== false, max })));
      }

      if (method === 'POST' && p === '/maintain') {
        const r = await engine.maintain();
        return json(res, 200, r || { error: '未执行（busy 或 halted）' });
      }

      if (method === 'POST' && p === '/daily') {
        const r = await engine.daily();
        return json(res, 200, r || { error: '未执行（busy 或 halted）' });
      }

      if (method === 'POST' && p === '/combat/start') {
        if (fs.existsSync(HALT_FILE)) return json(res, 409, { error: 'halt 存在，拒绝启动' });
        state.daemon?.start?.();
        return json(res, 200, { ok: true, daemon: state.daemon?.status?.() });
      }

      if (method === 'POST' && p === '/combat/pause') {
        state.daemon?.pause?.('http');
        return json(res, 200, { ok: true, daemon: state.daemon?.status?.() });
      }

      if (method === 'POST' && p === '/combat/resume') {
        if (fs.existsSync(HALT_FILE)) return json(res, 409, { error: 'halt 存在，拒绝恢复' });
        state.daemon?.resume?.();
        return json(res, 200, { ok: true, daemon: state.daemon?.status?.() });
      }

      if (method === 'POST' && p === '/config') {
        const body = await readBody(req);
        const patch = {};
        if (body.mapId != null) patch.mapId = Number(body.mapId);
        if (body.potionThreshold != null) patch.potionThreshold = Number(body.potionThreshold);
        if (Object.keys(patch).length) state.daemon?.configure?.(patch);
        return json(res, 200, { ok: true, config: state.daemon?.status?.()?.config });
      }

      if (method === 'POST' && p === '/reconnect') {
        engine.reconnect('http').catch(() => { });
        return json(res, 200, { ok: true, note: '重连已触发（异步）' });
      }

      if (method === 'POST' && p === '/halt') {
        fs.writeFileSync(HALT_FILE, new Date().toISOString());
        return json(res, 200, { ok: true, note: '5 秒内停止一切主动发包' });
      }

      if (method === 'POST' && p === '/unhalt') {
        try { fs.unlinkSync(HALT_FILE); } catch { }
        return json(res, 200, { ok: true });
      }

      // ── 原始状态（规划器/System2 用；不含凭证）──
      if (method === 'GET' && p === '/raw') {
        const g = engine.game || await engine.refresh();
        if (!g?.role) return json(res, 503, { error: 'ER 无状态' });
        const r = g.role || {};
        return json(res, 200, {
          at: new Date().toISOString(),
          role: {
            id: r.id, name: r.name, level: r.level, exp: r.currentExp, gold: r.money,
            yuanbao: r.yuanbao ?? r.goldIngot, power: r.combatPower, mapId: r.mapId, sect: r.sect ?? null, class: r.class ?? null, settings: r.settings ?? null,
            smeltingItemId: r.smeltingItemId, smeltingExp: r.smeltingExp,
            smeltingTargetExp: r.smeltingTargetExp, persistenceRevision: r.persistenceRevision,
          },
          equipments: g.equipments || [],
          bagItems: g.bagItems || [],
          pets: state.store?.st?.pets || g.pets || g.petList || null,
          petsLive: g.pets || g.petList || null,
          petDetail: g.petDetail || null,
          skills: g.skillDetail || g.skills || null,
          trial: g.trial || null,
          store: {
            mapId: state.store?.st?.role?.mapId,
            combat: state.store?.st?.combat,
            pets: state.store?.st?.pets,
          },
          keys: Object.keys(g),
          counts: {
            equipments: (g.equipments || []).length,
            bagItems: (g.bagItems || []).length,
            pets: (state.store?.st?.pets?.list || g.pets || g.petList || []).length,
          },
        });
      }

      // 自己/他人资料原始视图（查门派等）
      if (method === 'GET' && p === '/player') {
        const roleId = Number(url.searchParams.get('roleId') || engine.game?.role?.id);
        const rr = await state.ws.req('GET_PLAYER_INFO', { roleId }, { ms: 10000 });
        return json(res, 200, { roleId, msg: rr?.message, data: rr?.data || null });
      }
      // ── 排行榜 / 榜一对比（只读，参照用户要求）──
      if (method === 'GET' && (p === '/leaderboard' || p === '/compare')) {
        const lb = await state.ws.req('GET_LEADERBOARD', {}, { ms: 9000 });
        const arr = Array.isArray(lb?.data) ? lb.data : (lb?.data?.list || []);
        const sorted = arr.slice().sort((a, b) => (b.combatPower || 0) - (a.combatPower || 0))
          .map((x, i) => ({ rank: i + 1, name: x.nickname, level: x.level, power: x.combatPower, roleId: x.roleId }));
        if (p === '/leaderboard') return json(res, 200, { at: new Date().toISOString(), list: sorted });
        const meRow = sorted.find(x => x.name === engine.game?.role?.nickname) || null;
        const top1 = sorted[0];
        if (!top1?.roleId) return json(res, 404, { error: 'no top1 roleId' });
        const rr = await state.ws.req('GET_PLAYER_INFO', { roleId: top1.roleId }, { ms: 10000 });
        const pg = rr?.data;
        if (!pg) return json(res, 404, { error: 'GET_PLAYER_INFO empty', msg: rr?.message });
        const parse = (x) => { try { return JSON.parse(x || '{}'); } catch { return {}; } };
        const gemN = (x) => { try { return JSON.parse(x.gemSlots || '[]').filter(v => v > 0).length; } catch { return 0; } };
        const sum = (g) => {
          const eq = (g.equipments || []).filter(x => x.isEquipped);
          const pets = g.petView?.pets || g.pets?.pets || g.pets || [];
          const activeId = g.petView?.activePetId;
          const active = pets.find(p => p.pet?.id === activeId) || [...pets].sort((a, b) => (b.combatPower || 0) - (a.combatPower || 0))[0];
          return {
            name: g.role?.nickname, level: g.role?.level, power: g.role?.combatPower,
            equipCount: eq.length,
            equipValue: Math.round(eq.reduce((a, x) => a + itemValue(x), 0)),
            stars: eq.reduce((a, x) => a + (x.starLevel || 0), 0),
            enhance: eq.reduce((a, x) => a + (x.enhanceLevel || 0), 0),
            gems: eq.reduce((a, x) => a + gemN(x), 0),
            slots: eq.map(x => ({
              slot: x.equipTmpl?.slotType, name: x.equipTmpl?.name, req: x.equipTmpl?.reqLevel,
              q: x.quality, star: x.starLevel || 0, enh: x.enhanceLevel || 0, gems: gemN(x),
              value: Math.round(itemValue(x)), base: parse(x.equipTmpl?.baseStats), extra: parse(x.extraStats),
            })).sort((a, b) => (a.slot || 0) - (b.slot || 0)),
            activePet: active ? { name: active.speciesName, form: active.pet?.form, level: active.pet?.level, avg: active.average, cp: active.combatPower } : null,
            skills: (g.skills || []).map(s => ({ name: s.skillDetail?.name, lv: s.currentLevel, max: s.skillDetail?.maxLevel })),
          };
        };
        const mine = sum(engine.game || {});
        const theirs = sum(pg);
        return json(res, 200, {
          at: new Date().toISOString(), meRow, top1, mine, theirs,
          gap: {
            power: (theirs.power || 0) - (mine.power || 0),
            equipValue: theirs.equipValue - mine.equipValue,
            stars: theirs.stars - mine.stars, enhance: theirs.enhance - mine.enhance,
            gems: theirs.gems - mine.gems,
            petCp: (theirs.activePet?.cp || 0) - (mine.activePet?.cp || 0),
          },
        });
      }

      // ── 拍卖行只读列表（System2 用）──
      // ── 地图挂机 EV/h（第二层：经验/金币/套装掉落 折算 CP/h）──
      if (method === 'GET' && p === '/maps/ev') {
        const g = engine.game || {};
        const weights = {};
        for (const k of ['xpCpPerMexp', 'goldCpPer1000', 'minHours']) {
          const v = url.searchParams.get(k);
          if (v != null && Number.isFinite(Number(v))) weights[k] = Number(v);
        }
        const maps = evalMaps({
          drops: state.store?.st?.drops || {},
          mapStats: state.store?.st?.mapStats || {},
          equipSets: g.equipSets || [],
          equipped: g.equipments || [],
          templates: g.allEquipTemplates || [],
          weights,
        });
        return json(res, 200, {
          at: new Date().toISOString(),
          weights: { ...DEFAULT_MAP_WEIGHTS, ...weights },
          maps,
          dataGaps: [
            '物品 ΔV 需要掉落实例品质，live_drops 只存名字；暂不计入 CP/h',
            'mapStats 从本次引擎启动开始累计，重启会丢（每 30s 落盘）',
            '20080 尚无样本，需挂机 30-60 分钟后再比较',
          ],
        });
      }

      if (method === 'GET' && p === '/auction') {
        try {
          const q = url;
          const page = Math.max(1, Number(q.searchParams.get('page') || 1));
          const size = Math.min(100, Math.max(1, Number(q.searchParams.get('size') || 100)));
          const r = await state.ws.req('CONSIGNMENT_LIST', { page, size }, { ms: 10000 });
          const items = (r?.data?.items || []).map(x => ({
            id: x.id, itemId: x.itemId, itemType: x.itemType, price: x.price,
            itemName: x.itemName, count: x.count,
            sellerRoleId: x.sellerRoleId ?? x.sellerId ?? null, sellerName: x.sellerName ?? null,
            tmplId: x.equipTmpl?.id, name: x.equipTmpl?.name, slotType: x.equipTmpl?.slotType,
            qualityBase: x.equipTmpl?.qualityBase, reqLevel: x.equipTmpl?.reqLevel,
            suitType: x.equipTmpl?.suitType, baseStats: x.equipTmpl?.baseStats,
          }));
          return json(res, 200, { at: new Date().toISOString(), page, size, items, total: r?.data?.total ?? null });
        } catch (e) {
          return json(res, 502, { error: e?.message || String(e) });
        }
      }

      // ── 出售记录（只读，查成交币种/金额）──
      if (method === 'GET' && p === '/consignment/records') {
        try {
          const type = url.searchParams.get('type') || 'SELL';
          const page = Math.max(1, Number(url.searchParams.get('page') || 1));
          const size = Math.min(100, Math.max(1, Number(url.searchParams.get('size') || 50)));
          const r = await state.ws.req('CONSIGNMENT_RECORD_LIST', { page, size, type }, { ms: 8000 });
          return json(res, 200, { at: new Date().toISOString(), type, page, size, data: r?.data ?? r });
        } catch (e) {
          return json(res, 502, { error: e?.message || String(e) });
        }
      }

      // ── 聊天记录（世界/门派，System2 情报）──
      if (method === 'GET' && p === '/chat') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
        const ch = url.searchParams.get('channel');
        const all = state.store?.st?.chat || [];
        const list = all.filter(x => !ch || x.channel === ch).slice(-limit);
        return json(res, 200, { at: new Date().toISOString(), total: all.length, count: list.length, messages: list });
      }

      // ── 待售好装备（只读 dry-run：给 System2/用户看价格参考）──
      if (method === 'GET' && p === '/sell/good/candidates') {
        try {
          const max = Math.min(10, Math.max(1, Number(url.searchParams.get('max') || 5)));
          const out = await state.strategy.sellUnusedGear({ dryRun: true, max });
          return json(res, 200, out);
        } catch (e) { return json(res, 502, { error: e?.message || String(e) }); }
      }

      // ── 珍兽只读列表（PET_COMMAND list）──
      if (method === 'GET' && p === '/pets') {
        try {
          const r = await state.ws.req('PET_COMMAND', { action: 'list', requestId: crypto.randomUUID() }, { ms: 8000 });
          return json(res, 200, r?.data?.state || r?.data || r || {});
        } catch (e) {
          return json(res, 502, { error: e?.message || String(e) });
        }
      }

      // ── 自描述：告诉 agent 有哪些能力 ──
      if (method === 'GET' && (p === '/' || p === '/help')) {
        return json(res, 200, {
          name: 'tlbot engine',
          version: 1,
          endpoints: {
            'GET /status': '完整状态快照',
            'GET /status/brief': '一行摘要（省 token，推荐先看这个）',
            'GET /gear': '当前配装 + 官方评分建议（耗时 20-30s）',
            'GET /drops?map=&limit=': '掉落统计',
            'GET /audit?date=&action=&cat=&limit=': '审计日志（每次改状态的操作为一行，含 reason/cost/gain）',
            'GET /audit/summary?date=': '当天审计汇总（按 action 聚合 + 消耗/产出总计）',
            'GET /gamedata': '游戏元数据摘要（地图/套装/商城/技能数量 + 最近变化）',
            'GET /gamedata/maps?type=normal|dungeon': '地图列表',
            'GET /gamedata/best-map': '按当前等级推荐最高收益地图',
            'GET /gamedata/skills': '技能升级计划（含经验需求与是否够）',
            'POST /maintain': '立刻跑一次后勤（补药/清仓/配装/鉴定/珍兽/技能）',
            'POST /daily': '立刻跑一次日常（暗器/双倍/比武/珍兽/副本）',
            'POST /combat/start|pause|resume': '控制战斗循环',
            'POST /config {mapId,potionThreshold}': '改挂机配置',
            'POST /reconnect': '强制重连 WS',
            'POST /halt': '紧急停止（写 .halt）',
            'POST /unhalt': '清除停止',
          },
        });
      }

      json(res, 404, { error: `未知端点 ${method} ${p}` });
    } catch (e) {
      json(res, 500, { error: e?.message || String(e) });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    log(`✓ HTTP 控制面已启动 http://127.0.0.1:${port}`);
  });
  server.unref?.();
  return server;
}
