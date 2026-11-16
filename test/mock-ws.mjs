// test/mock-ws.mjs —— 假 WS 会话（不联网），用于集成测试
//
// 实现 core/lib-ws.mjs createSession() 的最小表面：
//   open() / req() / send() / wait() / on() / onAny() / close() / state
//
// 测试可以：
//   ws.emit({type,data})        注入下行包
//   ws.onSend(fn)               监听上行包（断言协议）
//   ws.setResponse(cmd, fn)     自定义 req 响应
//   ws.sent                     所有上行包记录

export function createMockWs({ game, responses = {} } = {}) {
  const listeners = new Map();     // type -> Set
  const waiters = new Map();       // type -> [resolve]
  const anyListeners = new Set();
  const sendHooks = new Set();
  const sent = [];
  const calls = [];
  const state = { pr: 1, ready: true, closed: false, lastError: null };

  const defaultGame = game || {
    role: {
      level: 56, currentExp: 10_000_000, money: 3_000_000, combatPower: 65_000,
      mapId: 10027, persistenceRevision: 1, settings: '{}', yuanbao: 0,
    },
    equipments: [],
    bagItems: [],
    equipSets: [],
    skills: [],
  };

  function emit(packet) {
    const t = packet?.type;
    if (!t) return;
    for (const fn of [...anyListeners]) { try { fn(packet); } catch { } }
    const set = listeners.get(t);
    if (set) for (const fn of [...set]) { try { fn(packet); } catch { } }
    const q = waiters.get(t);
    if (q?.length) {
      const resolve = q.shift();
      resolve(packet);
    }
  }

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type)?.delete(fn);
  }
  function onAny(fn) { anyListeners.add(fn); return () => anyListeners.delete(fn); }
  function off(type, fn) {
    if (!fn) listeners.delete(type);
    else listeners.get(type)?.delete(fn);
  }
  function wait(type, ms = 5000) {
    if (state.closed) return Promise.resolve(null);
    return new Promise(resolve => {
      const arr = waiters.get(type) || [];
      let done = false;
      let timer = null;
      const fn = p => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(p);
      };
      arr.push(fn);
      waiters.set(type, arr);
      timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
    });
  }
  function send(type, payload = {}, extra = {}) {
    const msg = { type, payload, ...extra };
    sent.push(msg);
    for (const fn of [...sendHooks]) { try { fn(msg); } catch { } }
    return true;
  }

  const RESP = {
    TRIAL_COMMAND: 'TRIAL_RESPONSE',
    ARENA_COMMAND: 'ARENA_RESPONSE',
    PET_COMMAND: 'PET_RESPONSE',
  };
  const respType = t => RESP[t] || t + '_RESPONSE';

  async function req(type, payload = {}, opts = {}) {
    calls.push({ type, payload, opts });
    if (type === 'ENTER_GAME') {
      const r = { type: 'ENTER_GAME_RESPONSE', success: true, data: defaultGame };
      emit(r);
      return r;
    }
    if (responses[type]) {
      const r = await responses[type](payload, opts);
      const packet = r && r.type ? r : { type: respType(type), success: true, data: r?.data ?? r ?? {} };
      emit(packet);
      return packet;
    }
    const packet = { type: respType(type), success: true, data: {} };
    emit(packet);
    return packet;
  }

  return {
    state, sent, calls, emit, on, onAny, off, wait, send, req,
    async open() { return defaultGame; },
    close() { state.closed = true; },
    onSend(fn) { sendHooks.add(fn); return () => sendHooks.delete(fn); },
    setResponse(cmd, fn) { responses[cmd] = fn; },
    get pr() { return state.pr; },
    game: defaultGame,
  };
}

// 构造一个会推进战斗的 mock：收到 COMBAT_START 后按帧推 COMBAT_STATE
export function attachCombatSim(ws, {
  total = 80, step = 10, intervalMs = 5, stage = 'running', hp = 1000, once = false,
} = {}) {
  let timer = null;
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  ws.onSend(msg => {
    if (msg.type === 'COMBAT_START') {
      stop();
      let defeated = 0;
      // 首帧故意推一个 total/total（模拟上一批残留），测试必须靠 seenLow 才能判定
      ws.emit({ type: 'COMBAT_STATE', data: { stage: 'preparing', combatProgress: { defeated: 0, total }, player: { currentHp: hp } } });
      ws.emit({ type: 'COMBAT_STATE', data: { stage, combatProgress: { defeated: 0, total }, player: { currentHp: hp } } });
      timer = setInterval(() => {
        defeated = Math.min(total, defeated + step);
        ws.emit({ type: 'COMBAT_STATE', data: { stage, combatProgress: { defeated, total }, player: { currentHp: hp } } });
        if (defeated >= total) {
          stop();
          if (!once) return;
          ws.emit({ type: 'COMBAT_STATE', data: { stage: 'idle', combatProgress: { defeated, total }, player: { currentHp: hp } } });
        }
      }, intervalMs);
      timer.unref?.();
    }
    if (msg.type === 'COMBAT_STOP') stop();
  });
  return { stop };
}
