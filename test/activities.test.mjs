// test/activities.test.mjs —— 日常 / 塔：阶段闸门、自动 pause 语义、战报
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockWs, attachCombatSim } from './mock-ws.mjs';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbot-act-'));
process.env.TL_DATA_DIR = DATA;
process.env.TL_HALT_FILE = path.join(DATA, '.halt');
const { createActivities } = await import('../src/activities.mjs');
const { initStore } = await import('../src/state-store.mjs');

const game = {
  role: {
    level: 56, currentExp: 1_000_000, money: 3_000_000, combatPower: 65_000,
    mapId: 4, persistenceRevision: 1, settings: '{}', yuanbao: 0,
  },
  equipments: [], bagItems: [], equipSets: [], skills: [],
};

test('阶段 0：daily_tasks 只读，不发写包', async () => {
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  const acts = createActivities(ws, store, { stage: 0, allowWrite: false, log: () => {} });
  const rep = await acts.dailyTasks({ skip: ['pet', 'dungeon'] });
  assert.equal(rep.dryRun, true);
  const writes = ws.calls.filter(x =>
    (x.type === 'TRIAL_COMMAND' && x.payload?.action !== 'status') ||
    x.type === 'WUSHUANG_CLAIM' || x.type === 'ARENA_COMMAND' && x.payload?.action !== 'list' ||
    x.type === 'USE_ITEM' || x.type === 'EQUIP_ITEM');
  assert.deepEqual(writes, [], '阶段 0 不应有写请求: ' + JSON.stringify(writes));
  store.close();
});

test('阶段 2：daily_tasks 领双倍会真正发包', async () => {
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  ws.setResponse('WUSHUANG_STATUS', () => ({ data: { claimedToday: false, remainingSeconds: 100, tianlingCount: 1 } }));
  ws.setResponse('WUSHUANG_CLAIM', () => ({ success: true, data: {} }));
  const acts = createActivities(ws, store, { stage: 2, allowWrite: true, log: () => {} });
  const rep = await acts.dailyTasks({ skip: ['anqi', 'arena', 'pet', 'dungeon'] });
  assert.equal(rep.dryRun, false);
  assert.ok(ws.calls.some(x => x.type === 'WUSHUANG_CLAIM'), '应领双倍');
  assert.equal(rep.errors.length, 0, JSON.stringify(rep.errors));
  store.close();
});

test('阶段 2：塔 enter → 打一层 → surrender，返回战报', async () => {
  const g = structuredClone(game);
  g.role.mapId = 4;
  const ws = createMockWs({ game: g });
  const store = initStore(ws);
  store.ingest(g);
  attachCombatSim(ws, { total: 30, step: 15, intervalMs: 5 });

  let floor = 1;
  ws.setResponse('TRIAL_COMMAND', (payload) => {
    const action = payload?.action;
    if (action === 'status') {
      return {
        data: {
          trial: {
            highestFloor: 1, startFloor: 1, entryFee: 1000, historyRemaining: 1, revision: 5,
            floor: { number: floor, kind: 'normal', enemies: [{}, {}] },
            balances: { sand: 10, jade: 2, seals: 3 },
          },
        },
      };
    }
    if (action === 'enter') {
      g.role.mapId = 20070;
      floor = 1;
      return { success: true, data: {} };
    }
    if (action === 'surrender') {
      g.role.mapId = 4;
      return { success: true, data: {} };
    }
    return { success: true, data: {} };
  });
  // goMap 回主图需要 ENTER_MAP_RESPONSE
  ws.onSend(msg => {
    if (msg.type === 'ENTER_MAP') {
      setTimeout(() => ws.emit({ type: 'ENTER_MAP_RESPONSE', success: true, data: { mapId: msg.payload.mapId } }), 0);
    }
  });

  const acts = createActivities(ws, store, { stage: 2, allowWrite: true, log: () => {} });
  const rep = await acts.tower({ maxFloors: 1 });
  assert.ok(ws.calls.some(x => x.type === 'TRIAL_COMMAND' && x.payload?.action === 'enter'), '应入塔');
  assert.ok(ws.calls.some(x => x.type === 'TRIAL_COMMAND' && x.payload?.action === 'surrender'), '应认负结算');
  assert.ok(rep.activities.some(a => /第 1 层/.test(a.msg)), '应有第 1 层战报');
  assert.equal(rep.errors.length, 0, JSON.stringify(rep.errors));
  store.close();
});
