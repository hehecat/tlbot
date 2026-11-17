// test/extension-smoke.mjs —— 真实加载 .pi/extensions/tlbot.ts（mock pi）
//
// 目的：验证 pi 的 defineTool / typebox 能加载 extension，5 个工具 schema 正确，
// 阶段 0 下所有工具都不发包、不越权。
//
// 用法：node test/extension-smoke.mjs
// 说明：为了解析 pi 的裸包名，会在项目根临时创建 node_modules 软链，结束后删除。

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');
const PI_ROOT = process.env.PI_PACKAGE_ROOT ||
  '/Users/hehecat/.pi/agent/install/releases/1.5.2/node_modules';

const links = [
  ['@earendil-works/pi-coding-agent', path.join(PI_ROOT, '@earendil-works/pi-coding-agent')],
  ['typebox', path.join(PI_ROOT, 'typebox')],
];

function setupLinks() {
  const nm = path.join(ROOT, 'node_modules');
  fs.mkdirSync(path.join(nm, '@earendil-works'), { recursive: true });
  for (const [name, target] of links) {
    const p = path.join(nm, name);
    if (fs.existsSync(p)) continue;
    fs.symlinkSync(target, p);
  }
}
function cleanupLinks() {
  const nm = path.join(ROOT, 'node_modules');
  try { fs.rmSync(nm, { recursive: true, force: true }); } catch { }
}

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log('✔', msg); else { failed++; console.log('✖', msg); } };

try {
  setupLinks();
  const mod = await import(path.join(ROOT, '.pi/extensions/tlbot.ts'));
  const tools = new Map();
  const commands = new Map();
  const events = [];
  const sent = [];
  const pi = {
    registerTool: (t) => tools.set(t.name, t),
    registerCommand: (name, def) => commands.set(name, def),
    on: (name) => events.push(name),
    sendUserMessage: (m) => sent.push(m),
    appendEntry: () => {},
  };
  mod.default(pi);

  const expected = [
    'bot_status_and_benchmark', 'bot_configure_combat', 'bot_run_activity',
    'bot_manage_gear_and_pet', 'bot_safe_ws_probe', 'bot_run_contract',
  ];
  ok(expected.every(n => tools.has(n)) && tools.size === 6, '注册 6 个工具（含任务契约）');
  ok(events.includes('session_start') && events.includes('context') &&
     events.includes('session_before_compact') && events.includes('session_shutdown') &&
     events.includes('agent_end'), '注册生命周期/上下文/agent_end 事件');
  ok(commands.has('autobot'), '注册 /autobot 命令');

  const call = async (name, args = {}) => {
    const r = await tools.get(name).execute('t', args, null, null, {});
    return { raw: r, json: JSON.parse(r.content[0].text) };
  };

  const st = await call('bot_status_and_benchmark', {});
  ok(st.json.mode === 'OFFLINE', '阶段 0 无 WS → OFFLINE');
  ok(st.json.wsDisabled === true, 'WS 防踢闸门默认关闭');
  ok(st.raw.content[0].text.length < 8000, '离线快照体积受控 (<8KB)');

  const start = await call('bot_configure_combat', { action: 'start', mapId: 20080 });
  ok(start.json.mode === 'DRY_RUN', '阶段 0 start → DRY_RUN');
  const pause = await call('bot_configure_combat', { action: 'pause' });
  ok(pause.json.mode === 'DRY_RUN', '阶段 0 pause → DRY_RUN');

  const act = await call('bot_run_activity', { activity: 'tower' });
  ok(act.json.mode === 'DRY_RUN', '阶段 0 activity → DRY_RUN');

  const gear = await call('bot_manage_gear_and_pet', { action: 'auto_maintain' });
  ok(gear.json.mode === 'OFFLINE', '阶段 0 无 WS 的后勤 → OFFLINE（不发包）');

  const contract = await call('bot_run_contract', { target: '刷玄铁', mapId: 10027, stopWhen: { itemId: 501, count: 50 } });
  ok(contract.json.mode === 'DRY_RUN', '阶段 0 contract → DRY_RUN');

  const probe = await call('bot_safe_ws_probe', { cmd: 'FOO_BAR', payload: { a: 1 } });
  ok(probe.json.mode === 'DRY_RUN' && probe.json.sent === false, 'T5 阶段 0 只 DRY_RUN');
  ok(probe.json.precheck?.redline?.ok === true, 'T5 红线预检执行');

  const sell = await call('bot_safe_ws_probe', { cmd: 'SHOP_SELL', payload: { itemId: 1 } });
  ok(sell.json.mode === 'DRY_RUN' && sell.json.sent === false, 'T5 写操作阶段 0 不发包');

  // /autobot 命令
  const autobot = commands.get('autobot');
  const ctx = { ui: { notify: () => {} } };
  await autobot.handler('status', ctx);
  await autobot.handler('interval 30', ctx);
  await autobot.handler('start', ctx);
  ok(sent.length === 1 && String(sent[0]).includes('autobot'), '/autobot start 会发巡检消息');
  await autobot.handler('stop', ctx);
} catch (e) {
  failed++;
  console.error('✖ extension smoke 异常:', e?.stack || e);
} finally {
  cleanupLinks();
}

if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过');
