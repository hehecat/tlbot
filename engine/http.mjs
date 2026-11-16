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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method || 'GET';

    try {
      // ── 只读 ──
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
