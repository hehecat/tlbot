// test/combat-daemon.test.mjs —— 战斗循环 / pause / resume / .halt / goMap
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockWs, attachCombatSim } from './mock-ws.mjs';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbot-combat-'));
process.env.TL_DATA_DIR = DATA;
const HALT = path.join(DATA, '.halt');
process.env.TL_HALT_FILE = HALT;
const { CombatDaemon, goMap, isHalted } = await import('../src/combat-daemon.mjs');
const { initStore } = await import('../src/state-store.mjs');

const game = {
  role: {
    level: 56, currentExp: 1_000_000, money: 3_000_000, combatPower: 65_000,
    mapId: 10027, persistenceRevision: 1, settings: '{}',
  },
  equipments: [], bagItems: [], equipSets: [], skills: [],
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
}

test('daemon 连续跑批 + pause/resume', async () => {
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  attachCombatSim(ws, { total: 40, step: 20, intervalMs: 5 });
  const d = new CombatDaemon(ws, store, { log: () => {} });
  d.configure({ mapId: 10027 });
  d.start();
  assert.equal(await waitFor(() => d.stats.batches >= 2), true, '应至少完成 2 批');
  assert.ok(ws.sent.filter(x => x.type === 'COMBAT_START').length >= 2);
  assert.ok(ws.sent.filter(x => x.type === 'COMBAT_SYNC').length >= 1);

  d.pause('test');
  assert.equal(d.paused, true);
  assert.equal(d.running, false);
  assert.ok(ws.sent.some(x => x.type === 'COMBAT_STOP'));
  assert.equal(await d.whenIdle(3000), true);

  d.resume();
  assert.equal(d.running, true);
  await sleep(100);
  await d.stop();
  assert.equal(d.running, false);
  store.close();
});

test('pause 能中断进行中的一批（whenIdle 快速返回）', async () => {
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  // 很慢的模拟：每 200ms 只推 1 只，pause 必须立刻中断
  attachCombatSim(ws, { total: 80, step: 1, intervalMs: 200 });
  const d = new CombatDaemon(ws, store, { log: () => {} });
  d.start();
  assert.equal(await waitFor(() => d.busy), true);
  const t0 = Date.now();
  d.pause('interrupt');
  const idle = await d.whenIdle(3000);
  assert.equal(idle, true);
  assert.ok(Date.now() - t0 < 1500, 'pause 后应快速空闲，实际 ' + (Date.now() - t0) + 'ms');
  await d.stop();
  store.close();
});

test('.halt 存在时 daemon 不主动发包', async () => {
  fs.writeFileSync(HALT, 'halt');
  assert.equal(isHalted(), true);
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  attachCombatSim(ws, { total: 10, step: 10 });
  const d = new CombatDaemon(ws, store, { log: () => {} });
  d.start();
  await sleep(400);
  assert.equal(ws.sent.filter(x => x.type === 'COMBAT_START').length, 0, '.halt 下不得 COMBAT_START');
  assert.equal(ws.sent.filter(x => x.type === 'COMBAT_SYNC').length, 0, '.halt 下不得 COMBAT_SYNC');
  await d.stop();
  store.close();
  fs.unlinkSync(HALT);
  assert.equal(isHalted(), false);
});

test('goMap 发 ENTER_MAP 后刷新 ENTER_GAME', async () => {
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  ws.onSend(msg => {
    if (msg.type === 'ENTER_MAP') {
      setTimeout(() => ws.emit({ type: 'ENTER_MAP_RESPONSE', success: true, data: { name: '玄武岛', mapId: msg.payload.mapId } }), 0);
    }
  });
  const r = await goMap(ws, store, 20080);
  assert.equal(r.success, true);
  assert.equal(ws.sent.filter(x => x.type === 'ENTER_MAP')[0].payload.mapId, 20080);
  assert.ok(ws.calls.some(x => x.type === 'ENTER_GAME'), '换图后应 ENTER_GAME 刷新 revision');
  store.close();
});

test('批次间按 maxSessionMs 主动重连', async () => {
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  attachCombatSim(ws, { total: 20, step: 10, intervalMs: 5 });
  let reconnects = 0;
  const d = new CombatDaemon(ws, store, {
    log: () => {}, maxSessionMs: 0,
    reconnect: async () => { reconnects++; await sleep(10); },
  });
  d.start();
  assert.equal(await waitFor(() => reconnects >= 1), true, '应触发批次间重连');
  assert.equal(await waitFor(() => d.stats.batches >= 1), true, '重连后应继续跑批');
  await d.stop();
  store.close();
});

test('ws 已关闭时 daemon 先重连再开打', async () => {
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  attachCombatSim(ws, { total: 20, step: 10, intervalMs: 5 });
  ws.state.closed = true;
  let reconnects = 0;
  const d = new CombatDaemon(ws, store, {
    log: () => {}, maxSessionMs: 60_000,
    reconnect: async () => { reconnects++; ws.state.closed = false; await sleep(10); },
  });
  d.start();
  assert.equal(await waitFor(() => reconnects >= 1), true, 'closed 时应重连');
  assert.equal(await waitFor(() => d.stats.batches >= 1), true, '重连后应继续跑批');
  await d.stop();
  store.close();
});

test('任务契约：达到 itemId/count 即结束并回调', async () => {
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  store.st.bagItems = [{ itemId: 501, count: 10, itemTmpl: { name: '玄铁' } }];
  let ended = null;
  const d = new CombatDaemon(ws, store, {
    log: () => {}, onContractEnd: (c, r) => { ended = { c, r }; },
  });
  d.startContract({ target: '刷满 10 玄铁', mapId: 10027, stopWhen: { itemId: 501, count: 10 }, maxMinutes: 30 });
  assert.equal(await waitFor(() => ended !== null), true, '应触发 onContractEnd');
  assert.match(ended.r.reason, /目标达成/);
  assert.equal(d.contract, null);
  await d.stop();
  store.close();
});

test('任务契约：超时 / 金币预算 / 死亡 都能判定', async () => {
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  store.st.role.money = 1000;
  const d = new CombatDaemon(ws, store, { log: () => {} });
  d.startContract({ target: 'x', mapId: 10027, maxMinutes: 30, maxGoldSpend: 100 });
  d._contractStart = Date.now() - 31 * 60_000;
  assert.match(d._checkContract().reason, /超时/);

  d.contract.maxMinutes = 30;
  d._contractStart = Date.now();
  d._contractGold0 = 1000;
  store.st.role.money = 800;
  assert.match(d._checkContract().reason, /金币消耗超预算/);

  store.st.role.money = 1000;
  d._contractDeaths0 = d.stats.deaths;
  d.stats.deaths = d._contractDeaths0 + 3;
  assert.match(d._checkContract().reason, /死亡/);
  await d.stop();
  store.close();
});
