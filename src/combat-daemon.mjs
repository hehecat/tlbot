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

// 判定「卡住」的正确口径。
//
// 实测（2026-11-16）：服务端 COMBAT_STATE 约 7 包/秒，而 defeated 约 10 秒才 +1
// （取决于伤害）。所以「多少个包没变」不能用小数字——35 包只等于 5 秒，完全正常。
//
// 真正的判据应该是「多久没有一次击杀」，并以本批已观测到的击杀节奏为基准：
//   · 记下最近一次 defeated 推进的时刻
//   · 用本批平均击杀间隔 × 倍数作为容忍窗口（击杀慢的批次自动放宽）
//   · 从没击杀过（刚开批）时用下限兜底
const KILL_GAP_TOLERANCE = Number(process.env.TL_KILL_GAP_FACTOR || 6); // 平均间隔的 6 倍
const MIN_STALL_MS = Number(process.env.TL_MIN_STALL_MS || 90_000);    // 至少容忍 90 秒

// preparing 阶段收到第几个状态包时补发一次 COMBAT_START。
// 服务端进入 preparing 约 5 秒转 running；这里按包数而不是秒数计。
const PREP_STATES_BEFORE_RETRY = Number(process.env.TL_PREP_RETRY || 12);

// ── 单场战斗 ────────────────────────────────────────────────
// mode:
//   batch  普通地图无尽刷怪：打满本批 total 或 idle 即结束（默认）
//   dungeon 副本：打满全部波次才算通关；idle 也结束
//   floor   塔：清层（seenLow 后打满）或 idle/死亡
// 返回 { why, kills, total, secs, started }
export function fightInMap(ws, store, mapId, {
  // 2026-11-16：secsMax 从 200s 提到 480s。丹霞岭一批 80 只实测要 3-4 分钟，
  // 200 秒会在快打满时被砍掉（实测打到 63/80 就被判超时）。
  // 这个值现在只是最后一道防死锁的保险，正常结束靠状态判据（打满/idle/无进度包）。
  mode = 'batch', secsMax = 480_000, label = '战斗', signal = null, onTick = null,
} = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let done = false, started = false, idle = 0, lastStage = '', lastDef = -1;
    let seenLow = false, everHadProgress = false, lastChangeAt = Date.now();
    let staleStates = 0;   // 连续多少个 COMBAT_STATE 没有 defeated 推进
    let prepStates = 0;    // 连续收到多少个 preparing 状态包
    const killGaps = [];   // 本批击杀间隔样本（自适应卡死阈值）
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
        // 用「连续多少个状态包 defeated 没变」判断卡住，而不是用秒数。
        // 服务端在 running 时持续推 COMBAT_STATE；只要 defeated 推进，
        // 不管多慢都说明在打，不该中断。
        if (def !== lastDef) {
          const t = Date.now();
          if (lastDef >= 0 && def > lastDef) {
            // 记录击杀间隔，用于自适应卡死判定
            const gap = t - lastChangeAt;
            killGaps.push(gap);
            if (killGaps.length > 8) killGaps.shift();
          }
          lastDef = def; lastChangeAt = t; staleStates = 0;
        } else if (stage === 'running') {
          staleStates++;
        }
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
        // 从未开打就一直 idle → 每第 6 个 idle 包重发一次 START
        // （按包数而不是时钟：服务端推 idle 的节奏就是它的真实节拍）
        if (!started && !everHadProgress) {
          if (idle % 6 === 0) {
            if (isHalted()) return fin('halt');
            try { ws.send('COMBAT_START', { mapId }); } catch { }
          }
          if (idle >= 60) return fin('未进入战斗');
        }
      } else idle = 0;

      // preparing 停留过久 → 重发一次 START。
      // 2026-11-16 修：原写法 `Date.now() - t0 > 25_000` 一旦成立就永久成立，
      // 之后每来一个状态包都重发 START，等于自己反复打断自己的战斗。
      // 改为按「连续收到多少个 preparing 包」计，且只重发一次。
      if (stage === 'preparing') {
        prepStates++;
        if (prepStates === PREP_STATES_BEFORE_RETRY) {
          if (isHalted()) return fin('halt');
          try { ws.send('COMBAT_START', { mapId }); } catch { }
        }
      } else prepStates = 0;

      // 死亡 → 停止，交给 daemon 重进
      if (started && hp != null && hp <= 0) return fin('死亡');
    });

    const offErr = store.on('COMBAT_ERROR', d => {
      if (done) return;
      const m = d.message || '';
      if (/地图不一致/.test(m)) return;       // 瞬时错误，忽略
      if (/等级不足|无法识别/.test(m)) return fin('致命错误');
    });

    // 进度哨兵 —— 只看状态，不看时钟。
    // 2026-11-16 修：原逻辑「running 且 60 秒无进度 → 换批」会误杀慢波次：
    // 丹霞岭一批 80 只正常要 2-3 分钟，只要一波打得慢就退出重来，
    // 而后台勤每重开一次都补药 600 + 喂珍兽 500 万经验 + 重新配装。
    // 实测触发 286 次 → 金币从 834 万烧到 188 万，死亡从 4 累计到 830。
    //
    // 现在改为纯状态判据：
    //   · defeated 推进 → 一定在打，绝不中断
    //   · defeated 连续 STALE_STATES_LIMIT 个状态包都没变 → 判定卡住
    //   · 一个状态包都没收到（连接断了）→ 由 ws 层的静默检测负责
    guard = setInterval(() => {
      if (done) return;
      if (isHalted() || signal?.aborted) return fin(isHalted() ? 'halt' : 'aborted');
      // 从未开打：靠 idle 计数和 START 重发自愈，不用时钟
      if (!started) return;
      if (lastStage !== 'running') return;

      // 自适应窗口：本批平均击杀间隔 × 倍数，但不低于 MIN_STALL_MS。
      // 打得快的批次窗口小、打得慢的自动放宽，不会因为伤害低被误杀。
      const avgGap = killGaps.length
        ? killGaps.reduce((a, b) => a + b, 0) / killGaps.length
        : MIN_STALL_MS;
      const windowMs = Math.max(MIN_STALL_MS, avgGap * KILL_GAP_TOLERANCE);

      if (Date.now() - lastChangeAt > windowMs) {
        return fin(`无击杀${Math.round((Date.now() - lastChangeAt) / 1000)}s`);
      }
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
    // 实例标识：诊断「多个 daemon 并发」这类问题时靠它区分日志来源
    this.id = Math.random().toString(36).slice(2, 6);
    this.ws = ws;
    this.store = store;
    this.log = (...a) => log(`[d${this.id}]`, ...a);
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
    const oldMap = this.config.mapId;
    if (patch.mapId != null) this.config.mapId = Number(patch.mapId);
    if (patch.monsterId !== undefined) this.config.monsterId = patch.monsterId;
    if (patch.potionThreshold != null) this.config.potionThreshold = Number(patch.potionThreshold);
    this.log(`[combat] 配置 ${JSON.stringify(this.config)}`);

    // 2026-11-16 修：原来改 mapId 后当前这批还要打满 80 只才切图，
    // 实测出现「配置已改成 10030，日志还在 map=10027」的情况。
    // 地图变了就立刻中断当前批，让 loop 用新配置重新开始。
    if (patch.mapId != null && Number(patch.mapId) !== oldMap) {
      this.log(`[combat] 地图切换 ${oldMap} → ${this.config.mapId}，中断当前批`);
      try { this._abort?.('map-changed'); } catch { }
      try { if (!isHalted()) this.ws.send('COMBAT_STOP'); } catch { }
    }
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
      maxDeaths: Number.isFinite(Number(contract.maxDeaths)) ? Number(contract.maxDeaths) : 3,
      createdAt: new Date().toISOString(),
    };
    if (!Number.isFinite(c.mapId)) throw new Error('contract.mapId 无效');
    this.contract = c;
    this._contractStart = Date.now();
    this._contractGold0 = this.store?.st?.role?.money ?? 0;
    this._contractDeaths0 = this.stats.deaths;
    if (Number(c.mapId) !== Number(this.config.mapId)) {
      this.log(`[contract] 地图切换 ${this.config.mapId} → ${c.mapId}，中断当前批`);
      try { this._abort?.('map-changed'); } catch { }
      try { if (!isHalted()) this.ws.send('COMBAT_STOP'); } catch { }
    }
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
    // 防抖：短时间内反复 start 说明上层在空转（看门狗/后勤循环互相触发）。
    // 2026-11-16 实测出现过 start 被调 33 次、心跳日志一分钟刷 54 条的雪崩。
    const nowMs = Date.now();
    if (this._lastStartAt && nowMs - this._lastStartAt < 10_000) {
      this.log(`[combat] start 间隔过短（${nowMs - this._lastStartAt}ms），忽略`);
      return this.status();
    }
    this._lastStartAt = nowMs;
    this._stopped = false;
    this._running = true;
    this._paused = false;
    this.stats.startedAt = new Date().toISOString();
    this.sessionAt = Date.now();
    this._loopPromise = this._loop()
      .catch(e => { this.log('[combat] loop 崩溃', e?.message || String(e)); })
      .finally(() => {
        // 诊断：loop 意外退出是重大事件（会导致 start 被反复调用、心跳堆积）
        this.log(`[combat] ⚠️ loop 退出（stopped=${this._stopped} paused=${this._paused}）`);
        this._loopPromise = null;
      });
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
      let done = false;
      const onIdle = () => { if (done) return; done = true; clearTimeout(t); resolve(true); };
      const t = setTimeout(() => {
        if (done) return; done = true;
        const idx = this._idleWaiters.indexOf(onIdle);
        if (idx >= 0) this._idleWaiters.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
      this._idleWaiters.push(onIdle);
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
      let abortWhy = null;
      this._abort = why => { abortWhy = why || 'aborted'; try { ac.abort(abortWhy); } catch { } };
      let result;
      try {
        result = await fightInMap(this.ws, this.store, mapId, { mode: 'batch', label: 'batch', signal: ac.signal })
          .catch(e => ({ why: '异常', error: e?.message }));
      } finally {
        this._abort = null;
      }
      if (abortWhy && result && result.why !== '死亡') result.why = abortWhy;

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
          if (this._paused || this._stopped || isHalted()) return;
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
