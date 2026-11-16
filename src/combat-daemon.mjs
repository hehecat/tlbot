// src/combat-daemon.mjs —— 战斗循环（PRD §2 / D2：纯 JS，零 token）
//
// 设计：
//   · 只使用宿主传进来的唯一 ws（绝不自己 new WebSocket）
//   · 循环在 Node 内存里跑，不产生任何 LLM 调用
//   · pause/resume 是硬边界：后勤/日常执行前必须 pause，执行完 resume
//   · .halt 存在 → 立即停止主动发包（只保留 ws 原生心跳），5 秒内安静
//
// 禁忌（PRD §9）：
//   禁 pgrep/pkill/kill/launchctl；停进程用 .halt；不得自建第二条 WS 连接。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
export const HALT_FILE = process.env.TL_HALT_FILE ? path.resolve(process.env.TL_HALT_FILE) : path.join(ROOT, '.halt');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);

export function isHalted() {
  try { return fs.existsSync(HALT_FILE); } catch { return false; }
}

// ── 单场战斗 ────────────────────────────────────────────────
// mode:
//   batch  普通地图无尽刷怪：打满本批 total 或 idle 即结束（默认）
//   dungeon 副本：打满全部波次才算通关；idle 也结束
//   floor   塔：清层（seenLow 后打满）或 idle/死亡
// 返回 { why, kills, total, secs, started }
export function fightInMap(ws, store, mapId, {
  mode = 'batch', secsMax = 200_000, label = '战斗', signal = null, onTick = null,
} = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let done = false, started = false, idle = 0, lastStage = '', lastDef = -1;
    let seenLow = false, everHadProgress = false, lastChangeAt = Date.now();
    let sync = null;

    let guard = null;
    const cleanup = () => {
      if (sync) clearInterval(sync);
      if (guard) clearInterval(guard);
      clearTimeout(hardTimer);
      try { offState(); } catch { }
      try { offErr(); } catch { }
    };
    const fin = why => {
      if (done) return;
      done = true;
      cleanup();
      resolve({
        why, kills: Math.max(0, lastDef), started,
        secs: Math.round((Date.now() - t0) / 1000),
      });
    };

    // 硬兜底：一批 80 只实测 ~140 秒
    const hardTimer = setTimeout(() => fin('超时'), secsMax);
    sync = setInterval(() => {
      if (done) return;
      if (isHalted() || signal?.aborted) return fin(isHalted() ? 'halt' : 'aborted');
      try { ws.send('COMBAT_SYNC'); } catch { }
    }, 300);

    const offState = store.on('COMBAT_STATE', d => {
      if (done) return;
      const D = d.data || {};
      const p = D.combatProgress || {};
      const stage = D.stage || '';
      const hp = D.player?.currentHp;
      if (onTick) { try { onTick(D); } catch { } }

      if (p.defeated != null) {
        const def = Number(p.defeated) || 0;
        const total = Number(p.total) || 0;
        if (def !== lastDef) { lastDef = def; lastChangeAt = Date.now(); }
        if (def > 0 && total > 0 && def < total) { seenLow = true; everHadProgress = true; }
        if (total > 0 && def >= total && (mode === 'dungeon' || seenLow)) return fin('打满');
      }
      if (stage === 'running' || stage === 'preparing') started = true;

      if (stage !== lastStage) {
        lastStage = stage;
        idle = 0;
      }

      if (stage === 'idle') {
        idle++;
        if (idle >= 3 && everHadProgress) return fin('idle');
        // 从未开打就一直 idle → 重发 START（每 ~2 秒一次）
        if (!started && !everHadProgress) {
          if (idle % 6 === 0) {
            if (isHalted()) return fin('halt');
            try { ws.send('COMBAT_START', { mapId }); } catch { }
          }
          if (Date.now() - t0 > 45_000) return fin('未进入战斗');
        }
      } else idle = 0;

      // preparing 超 25 秒 → 重发
      if (stage === 'preparing' && Date.now() - t0 > 25_000) {
        if (isHalted()) return fin('halt');
        try { ws.send('COMBAT_START', { mapId }); } catch { }
        started = false;
      }

      // 死亡 → 停止，交给 daemon 重进
      if (started && hp != null && hp <= 0) return fin('死亡');
    });

    const offErr = store.on('COMBAT_ERROR', d => {
      if (done) return;
      const m = d.message || '';
      if (/地图不一致/.test(m)) return;       // 瞬时错误，忽略
      if (/等级不足|无法识别/.test(m)) return fin('致命错误');
    });

    // 进度哨兵：running 且 60 秒无进度 → 换批；还没开打且 25 秒无状态 → 判定被踢
    guard = setInterval(() => {
      if (done) return;
      if (isHalted() || signal?.aborted) return fin(isHalted() ? 'halt' : 'aborted');
      const silent = Date.now() - lastChangeAt;
      if (!started && Date.now() - t0 > 25_000) return fin('无战斗状态');
      if (lastStage === 'running' && silent > 60_000) return fin('无进度');
    }, 2000);

    setTimeout(() => {
      if (done) return;
      if (isHalted()) return fin('halt');
      try { ws.send('COMBAT_START', { mapId }); } catch { }
    }, 400);
  });
}

// 切换地图：ENTER_MAP 会推进 persistenceRevision 但响应可能不带新值
// → 立刻用 ENTER_GAME 刷新 revision（同一连接，不新建 WS）
export async function goMap(ws, store, mapId, { ms = 10_000 } = {}) {
  if (isHalted()) return { success: false, message: 'halt' };
  const p = ws.wait('ENTER_MAP_RESPONSE', ms);
  ws.send('ENTER_MAP', { mapId });
  const r = await p;
  await sleep(500);
  // 刷新 revision + 状态树
  const g = await ws.req('ENTER_GAME', {}, { ms: 8000, revision: false });
  if (g?.data) store?.ingest?.(g.data);
  return { ...(r || {}), game: g?.data || null };
}

// ── CombatDaemon ────────────────────────────────────────────
export class CombatDaemon {
  constructor(ws, store, { log = () => { }, defaultMapId = 10027, reconnect = null, maxSessionMs = null, onContractEnd = null } = {}) {
    this.ws = ws;
    this.store = store;
    this.log = log;
    this.reconnectFn = reconnect;
    this.maxSessionMs = Number(maxSessionMs ?? process.env.TL_SESSION_MS ?? 120_000);
    this.sessionAt = Date.now();
    this.config = {
      mapId: Number(process.env.TL_MAP || defaultMapId),
      monsterId: null,
      potionThreshold: 70,
      freezeMs: 400,
    };
    this._running = false;
    this._paused = false;
    this._stopped = false;
    this._busy = false;
    this._abort = null;
    this._idleWaiters = [];
    this.stats = {
      startedAt: null, batches: 0, deaths: 0, kills: 0,
      lastBatchAt: null, lastBatch: null, lastError: null,
      mapId: null,
    };
    this._loopPromise = null;
    this._heartbeat = null;
    this.contract = null;
    this.onContractEnd = onContractEnd;
    this._contractTimer = null;
    this._contractStart = 0;
    this._contractGold0 = 0;
    this._contractDeaths0 = 0;
  }

  get paused() { return this._paused; }
  get running() { return this._running && !this._paused && !this._stopped; }
  get busy() { return this._busy; }

  configure(patch = {}) {
    if (patch.mapId != null) this.config.mapId = Number(patch.mapId);
    if (patch.monsterId !== undefined) this.config.monsterId = patch.monsterId;
    if (patch.potionThreshold != null) this.config.potionThreshold = Number(patch.potionThreshold);
    this.log(`[combat] 配置 ${JSON.stringify(this.config)}`);
    return this.status();
  }

  startContract(contract = {}) {
    const c = {
      id: contract.id || `c-${Date.now()}`,
      target: String(contract.target || ''),
      mapId: Number(contract.mapId ?? this.config.mapId),
      monsterId: contract.monsterId != null ? Number(contract.monsterId) : null,
      stopWhen: contract.stopWhen || {},
      maxGoldSpend: Number(contract.maxGoldSpend ?? 0) || 0,
      maxMinutes: Number(contract.maxMinutes ?? 30) || 30,
      maxDeaths: Number(contract.maxDeaths ?? 3) || 3,
      createdAt: new Date().toISOString(),
    };
    if (!Number.isFinite(c.mapId)) throw new Error('contract.mapId 无效');
    this.contract = c;
    this._contractStart = Date.now();
    this._contractGold0 = this.store?.st?.role?.money ?? 0;
    this._contractDeaths0 = this.stats.deaths;
    this.config.mapId = c.mapId;
    if (c.monsterId != null) this.config.monsterId = c.monsterId;
    if (this._contractTimer) clearInterval(this._contractTimer);
    this._contractTimer = setInterval(() => {
      const r = this._checkContract();
      if (r.done) this._finishContract(r);
    }, 5000);
    this._contractTimer.unref?.();
    this._paused = false;
    this.start();
    this.log(`[contract] 开始 ${c.id} target=${c.target} map=${c.mapId} stop=${JSON.stringify(c.stopWhen)}`);
    return { contract: c, status: this.status() };
  }

  _checkContract() {
    const c = this.contract;
    if (!c) return { done: false };
    const st = this.store?.st || {};
    const bag = st.bagItems || [];
    const gold = st.role?.money ?? 0;
    const elapsedMin = (Date.now() - this._contractStart) / 60_000;
    const sw = c.stopWhen || {};

    if (elapsedMin >= c.maxMinutes) return { done: true, reason: `超时 ${c.maxMinutes} 分钟`, elapsedMin };
    if (c.maxGoldSpend > 0 && this._contractGold0 - gold > c.maxGoldSpend) {
      return { done: true, reason: `金币消耗超预算 ${c.maxGoldSpend}`, spent: this._contractGold0 - gold };
    }
    if (this.stats.deaths - this._contractDeaths0 >= c.maxDeaths) {
      return { done: true, reason: `死亡 ${this.stats.deaths - this._contractDeaths0} 次` };
    }
    if (sw.bagFull && bag.length >= Number(process.env.TL_BAG_CAP || 60)) {
      return { done: true, reason: `背包满 ${bag.length}` };
    }
    if (sw.bagCount != null && bag.length >= Number(sw.bagCount)) {
      return { done: true, reason: `背包 ${bag.length} >= ${sw.bagCount}` };
    }
    if (sw.itemId != null || sw.itemName) {
      const want = Number(sw.count ?? 1) || 1;
      let have = 0;
      if (sw.itemId != null) have = bag.filter(b => b.itemId === Number(sw.itemId)).reduce((a, b) => a + (b.count || 0), 0);
      else {
        const n = String(sw.itemName).replace(/\s+/g, '').toLowerCase();
        have = bag.filter(b => String(b.itemTmpl?.name || '').replace(/\s+/g, '').toLowerCase().includes(n))
          .reduce((a, b) => a + (b.count || 0), 0);
      }
      if (have >= want) return { done: true, reason: `目标达成 ${sw.itemName || sw.itemId} ${have}/${want}` };
      return { done: false, progress: { have, want } };
    }
    return { done: false };
  }

  _finishContract(result) {
    const c = this.contract;
    if (!c) return;
    this.contract = null;
    if (this._contractTimer) { clearInterval(this._contractTimer); this._contractTimer = null; }
    this._paused = true;
    if (!isHalted()) { try { this.ws.send('COMBAT_STOP'); } catch { } }
    this.log(`[contract] 结束 ${c.id}: ${result?.reason || 'done'}`);
    try { this.onContractEnd?.(c, result || {}); } catch { }
  }

  start() {
    if (this._loopPromise) { this._paused = false; return this.status(); }
    this._stopped = false;
    this._running = true;
    this._paused = false;
    this.stats.startedAt = new Date().toISOString();
    this.sessionAt = Date.now();
    this._loopPromise = this._loop().finally(() => { this._loopPromise = null; });
    if (this._heartbeat) clearInterval(this._heartbeat);
    this._heartbeat = setInterval(() => {
      if (this._stopped || this._paused) return;
      const s = this.store?.getSnapshot?.();
      const c = s?.combat || {};
      this.log(`[combat] ♥ stage=${c.stage || '-'} ${c.progress || ''} 批次=${this.stats.batches} 击杀=${this.stats.kills} exp=${s?.me?.exp ?? '?'} 战力=${s?.me?.power ?? '?'}`);
    }, 60_000);
    this._heartbeat.unref?.();
    this.log(`[combat] 启动 map=${this.config.mapId}`);
    return this.status();
  }

  pause(reason = 'manual') {
    this._paused = true;
    if (this._abort) this._abort('paused');
    if (!isHalted()) { try { this.ws.send('COMBAT_STOP'); } catch { } }
    this.log(`[combat] 暂停（${reason}）`);
    return this.status();
  }

  resume() {
    if (!this._loopPromise) return this.start();
    this._paused = false;
    this.log('[combat] 恢复');
    return this.status();
  }

  async stop() {
    this._stopped = true;
    this.contract = null;
    if (this._contractTimer) { clearInterval(this._contractTimer); this._contractTimer = null; }
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
    this._running = false;
    this._paused = false;
    if (this._abort) this._abort('stopped');
    if (!isHalted()) { try { this.ws.send('COMBAT_STOP'); } catch { } }
    await this._loopPromise?.catch(() => { });
    return this.status();
  }

  // 等待当前这一批结束 / 循环进入空闲（供 withPaused 使用）
  async whenIdle(timeoutMs = 15_000) {
    if (!this._busy) return true;
    return new Promise(resolve => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this._idleWaiters.push(() => { clearTimeout(t); resolve(true); });
    });
  }

  status() {
    const snap = this.store?.getSnapshot?.();
    return {
      running: this.running,
      paused: this._paused,
      busy: this._busy,
      halted: isHalted(),
      config: this.config,
      stats: this.stats,
      rates: snap?.rates ?? null,
      combat: snap?.combat ?? null,
      health: snap?.health ?? null,
      contract: this.contract ? { ...this.contract, progress: this._checkContract() } : null,
    };
  }

  async _loop() {
    while (!this._stopped) {
      if (isHalted()) {
        this.stats.lastError = null;
        await sleep(1000);
        continue;
      }
      if (this._paused) {
        await sleep(500);
        continue;
      }
      try {
        await this._batch();
      } catch (e) {
        this.stats.lastError = e?.message || String(e);
        this.log('[combat] 异常', this.stats.lastError);
        await sleep(2000);
      }
      await sleep(this.config.freezeMs);
    }
  }

  async _batch() {
    this._busy = true;
    const mapId = this.config.mapId;
    this.stats.mapId = mapId;
    try {
      if (this.contract) {
        const cr = this._checkContract();
        if (cr.done) { this._finishContract(cr); return; }
      }
      // ★ 批次间主动重连：v5 的成熟做法，避免长连接被服务器踢（4001/1006）
      const closed = !!this.ws?.state?.closed;
      const aged = Date.now() - this.sessionAt > this.maxSessionMs;
      if (this.reconnectFn && (closed || aged)) {
        this.log(`[combat] 批次间重连（${closed ? '连接已关闭' : `会话 ${Math.round((Date.now() - this.sessionAt) / 1000)}s`}）`);
        try {
          await this.reconnectFn();
          this.sessionAt = Date.now();
        } catch (e) {
          this.stats.lastError = `重连失败: ${e?.message || e}`;
          this.log('[combat] 重连失败', this.stats.lastError);
          // 失败后冷却 30s，避免连续开新会话被服务器反复 1006
          await sleep(30_000);
          return;
        }
      }
      // 进图（角色不在目标图时才进）
      const cur = this.store?.st?.role?.mapId;
      if (cur !== mapId) {
        const r = await goMap(this.ws, this.store, mapId);
        if (!r?.success && r?.message !== 'halt') this.log(`[combat] 进图 ${mapId} 失败: ${r?.message || ''}`);
      }
      if (this._paused || this._stopped || isHalted()) return;

      const ac = new AbortController();
      const result = await new Promise(resolve => {
        this._abort = why => { try { ac.abort(); } catch { } resolve({ why: why || 'aborted', kills: 0, started: false, secs: 0 }); };
        fightInMap(this.ws, this.store, mapId, { mode: 'batch', label: 'batch', signal: ac.signal })
          .then(resolve, e => resolve({ why: '异常', error: e?.message }));
      });
      this._abort = null;

      this.stats.batches++;
      this.stats.lastBatchAt = new Date().toISOString();
      this.stats.lastBatch = result;
      if (result?.kills) this.stats.kills += result.kills;
      this.log(`[combat] 第${this.stats.batches}批 ${result?.why || '?'} 击杀${result?.kills ?? 0} ${result?.secs ?? '?'}s 战力${this.store?.st?.role?.combatPower ?? '?'}`);
      if (result?.why === '死亡') {
        this.stats.deaths++;
        this.log('[combat] 死亡 → 重进');
        if (!isHalted()) {
          try { this.ws.send('COMBAT_STOP'); } catch { }
          await sleep(500);
          await goMap(this.ws, this.store, mapId);
        }
      }
      if (result?.why === '无战斗状态') {
        // 可能被踢 / 半开连接 → 先尝试 ENTER_GAME；无响应就关闭 ws 触发上层重连
        this.log('[combat] 25 秒无状态，刷新 ENTER_GAME');
        const g = await this.ws.req('ENTER_GAME', {}, { ms: 8000, revision: false }).catch(() => null);
        if (!g?.data) {
          this.log('[combat] ENTER_GAME 无响应 → 关闭 WS 触发重连');
          try { this.ws.close(); } catch { }
        }
      }
    } finally {
      this._busy = false;
      const ws = this._idleWaiters.splice(0);
      ws.forEach(fn => { try { fn(); } catch { } });
    }
  }
}

// 供 activities 复用：打一张地图直到结束
export async function fightOnce(ws, store, mapId, opts = {}) {
  const r = await goMap(ws, store, mapId, { ms: opts.ms ?? 10_000 });
  if (!r?.success && r?.message !== 'halt') {
    return { ok: false, why: '进图失败', message: r?.message || '' };
  }
  const res = await fightInMap(ws, store, mapId, opts);
  return { ok: res.why === '打满' || res.why === 'idle', ...res };
}

export { sleep, now };
