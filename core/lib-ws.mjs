// 共用 WebSocket 会话：带 persistenceRevision 乐观锁
// 关键：所有写操作都要在外层带 revision = role.persistenceRevision
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname);

// 凭据来源优先级：环境变量 > creds.json
//   TL_USER / TL_PASS  —— 直接给账号密码（适合 CI / 容器）
//   creds.json         —— { "username": "...", "password": "..." }
// 先找 core/creds.json，找不到再回退到项目根。
function loadCreds() {
  if (process.env.TL_USER && process.env.TL_PASS) {
    return { username: process.env.TL_USER, password: process.env.TL_PASS };
  }
  const p = [path.join(DIR, 'creds.json'), path.join(DIR, '..', 'creds.json')]
    .find(x => fs.existsSync(x));
  if (!p) {
    throw new Error(
      '缺少凭据：请创建 creds.json（见 creds.example.json），或设置环境变量 TL_USER / TL_PASS',
    );
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
export const creds = loadCreds();

// 游戏服务端地址，按需覆盖即可
const WS_URL = process.env.TL_WS_URL || 'wss://tl.jayczee.top:1212/ws';
const OPEN_TIMEOUT = Number(process.env.TL_WS_OPEN_TIMEOUT || 15000);

export function createSession({ trace = false } = {}) {
  const ws = new WebSocket(WS_URL);
  const handlers = new Map();   // type -> resolve
  const state = { pr: null, ready: false, closed: false, lastError: null };
  let waiters = [];

  const send = (type, payload = {}, extra = {}) => {
    const msg = { type, payload, ...extra };
    if (trace) console.log('>>', type, JSON.stringify(payload).slice(0, 120));
    try { ws.send(JSON.stringify(msg)); } catch (e) { state.lastError = e.message; }
  };

  // 写操作：自动带 revision
  const write = (type, payload = {}) => send(type, payload, { revision: state.pr });

  // 通配监听（state-store 用来捕获未知协议；不影响原有按类型监听）
  const anyListeners = new Set();
  const onAny = fn => { anyListeners.add(fn); return () => anyListeners.delete(fn); };

  const listeners = new Map();   // type -> Set<fn>  持续监听（不消费）
  const on = (type, fn) => {
    const set = listeners.get(type) || new Set();
    set.add(fn);
    listeners.set(type, set);
    return () => { set.delete(fn); };
  };
  // off(type) 清空该类型所有监听；off(type, fn) 只移除指定函数
  const off = (type, fn) => {
    if (!fn) { listeners.delete(type); return; }
    const set = listeners.get(type);
    if (set) set.delete(fn);
  };

  ws.onmessage = ev => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    const t = d.type;
    if (trace) console.log('<<', t, d.success === false ? 'FAIL:' + d.message : 'ok');
    state.lastError = null;

    // 通配监听者（先跑，保证 state-store 能看到原始包）
    for (const fn of [...anyListeners]) { try { fn(d); } catch { } }

    // 持续监听者
    const set = listeners.get(t);
    if (set) for (const fn of [...set]) { try { fn(d); } catch { } }

    if (t === 'ERROR') {
      state.lastError = d.message;
    }
    // 每次响应都可能刷新 revision
    if (d.data && d.data.role && d.data.role.persistenceRevision != null) {
      state.pr = d.data.role.persistenceRevision;
    }
    if (d.data && d.data.persistenceRevision != null) {
      state.pr = d.data.persistenceRevision;
    }
    if (d.data && d.data.roleInfo && d.data.roleInfo.role && d.data.roleInfo.role.persistenceRevision != null) {
      state.pr = d.data.roleInfo.role.persistenceRevision;
    }
    // ENTER_MAP 也是写操作，会推进 revision —— 用 ENTER_MAP_RESPONSE 里的数据（如果有）
    if (t === 'ENTER_MAP_RESPONSE' && d.data && d.data.role && d.data.role.persistenceRevision != null) {
      state.pr = d.data.role.persistenceRevision;
    }

    const list = handlers.get(t);
    if (list && list.length) {
      const fn = list.shift();
      fn(d);
    }
  };

  ws.onclose = ev => {
    state.closed = true;
    state.closeCode = ev?.code ?? null;
    state.closeReason = ev?.reason || '';
    for (const w of waiters) w(null);
    waiters = [];
  };
  ws.onerror = ev => { state.lastError = ev?.message || 'ws error'; };

  const open = () => new Promise((res, rej) => {
    let settled = false;
    // ★ 外层超时：即使 ws 一直停在 CONNECTING（不触发 onopen/onclose），也必须结束
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      state.closed = true;
      try { ws.close(); } catch { }
      rej(new Error('open timeout'));
    }, OPEN_TIMEOUT);
    const ok = data => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res(data);
    };
    const bad = msg => {
      if (settled) return;
      settled = true;
      state.closed = true;   // 打开失败 → 会话不可用
      clearTimeout(timer);
      try { ws.close(); } catch { }
      rej(new Error(msg));
    };
    ws.onopen = () => {
      send('LOGIN', creds);
      wait('LOGIN_RESPONSE').then(lr => {
        if (!lr) return bad('login fail');
        send('ENTER_GAME');
        wait('ENTER_GAME_RESPONSE').then(g => {
          if (!g || !g.data) return bad('enter fail');
          state.pr = g.data.role.persistenceRevision;
          state.ready = true;
          ok(g.data);
        });
      });
    };
  });

  const wait = (type, ms = 12000) => {
    if (state.closed) return Promise.resolve(null);
    return new Promise(resolve => {
      const arr = handlers.get(type) || [];
      let done = false;
      const fn = d => { if (done) return; done = true; resolve(d); };
      arr.push(fn);
      handlers.set(type, arr);
      const timer = setTimeout(() => { if (!done) { done = true; const a = handlers.get(type) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); resolve(null); } }, ms);
      // 清理：成功时也移除 timer
      const orig = fn;
      fn.cleanup = () => clearTimeout(timer);
    });
  };

  // 命令 → 响应类型映射
  const RESP = {
    TRIAL_COMMAND: 'TRIAL_RESPONSE',
    ARENA_COMMAND: 'ARENA_RESPONSE',
    PET_COMMAND: 'PET_RESPONSE',
    WUSHUANG_STATUS: 'WUSHUANG_STATUS_RESPONSE',
    WUSHUANG_CLAIM: 'WUSHUANG_CLAIM_RESPONSE',
  };
  const respType = t => RESP[t] || t + '_RESPONSE';

  // 带重试的请求（错误只归本次请求）
  const req = async (type, payload = {}, { ms = 12000, revision = true } = {}) => {
    const myErr = { msg: null };
    const offErr = on('ERROR', d => { if (myErr.msg == null) myErr.msg = d.message; });
    const p = wait(respType(type), ms);
    if (revision) write(type, payload); else send(type, payload);
    const r = await p;
    await new Promise(x => setTimeout(x, 30));   // 给 ERROR 一点时间落到 myErr
    offErr();
    if (r) return r;
    // 没有正式响应：回传本次的错误
    return myErr.msg ? { success: false, message: myErr.msg, _fromError: true } : null;
  };

  const close = () => { try { ws.close(); } catch { } };

  return { open, wait, on, onAny, off, send, write, req, close, state, get pr() { return state.pr; } };
}

// 洛阳
export const LUOYANG = 4;
