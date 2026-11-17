// 登录/建角探测：node scripts/probe-account.mjs <creds.json> [--create 昵称 门派id]
import fs from 'node:fs';
const [,, credsPath, ...rest] = process.argv;
if (!credsPath) { console.error('用法: node scripts/probe-account.mjs creds.json [--create 昵称 门派id]'); process.exit(1); }
process.env.TL_CREDS = credsPath;
const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
const I = await import('../core/lib-ws.mjs');
I.installDnsFix();
const create = rest[0] === '--create' ? { nickname: rest[1], sectId: Number(rest[2]) } : null;
const ws = new WebSocket('wss://tl.jayczee.top:1212/ws');
let done = false;
const finish = (o, code = 0) => { if (done) return; done = true; console.log(JSON.stringify(o, null, 1)); try { ws.close(); } catch {} setTimeout(() => process.exit(code), 100); };
const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }, 1), 25000);
const send = (type, payload = {}) => ws.send(JSON.stringify({ type, payload }));
ws.onopen = () => send('LOGIN', creds);
ws.onmessage = ev => {
  let d; try { d = JSON.parse(ev.data); } catch { return; }
  if (d.type === 'LOGIN_RESPONSE') {
    if (!d.success) return finish({ ok: false, step: 'login', message: d.message });
    const status = d.data?.status;
    if (status === 'NO_ROLE') {
      if (!create) return finish({ ok: true, step: 'login', status, note: '无角色' });
      send('CREATE_ROLE', { nickname: create.nickname, sectId: create.sectId });
      return;
    }
    if (status === 'HAS_ROLE') { send('ENTER_GAME', {}); return; }
    return finish({ ok: true, step: 'login', status, data: d.data });
  }
  if (d.type === 'CREATE_ROLE_RESPONSE') {
    if (!d.success) return finish({ ok: false, step: 'create', message: d.message }, 2);
    return finish({ ok: true, step: 'create', nickname: create.nickname, sectId: create.sectId });
  }
  if (d.type === 'ENTER_GAME_RESPONSE') {
    clearTimeout(timer);
    if (!d.success) return finish({ ok: false, step: 'enter', message: d.message }, 3);
    const r = d.data?.role || {};
    return finish({ ok: true, step: 'enter', role: { id: r.id, nickname: r.nickname, level: r.level, sect: r.sect, combatPower: r.combatPower } });
  }
  if (d.type === 'ERROR' && !d.success) return finish({ ok: false, step: 'error', message: d.message }, 4);
};
ws.onerror = e => finish({ ok: false, step: 'ws', message: e?.message || 'ws error' }, 5);
