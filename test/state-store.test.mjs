// test/state-store.test.mjs —— 状态树 / 速率 / 掉落 / 未知包
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockWs } from './mock-ws.mjs';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbot-store-'));
process.env.TL_DATA_DIR = DATA;
const { initStore, bestMapForItem, topDrops } = await import('../src/state-store.mjs');

const game = {
  role: {
    level: 56, currentExp: 1_000_000, money: 3_000_000, combatPower: 65_000,
    mapId: 10027, persistenceRevision: 7, settings: '{}', yuanbao: 0,
  },
  equipments: [
    { id: 1, isEquipped: true, equipTmpl: { slotType: 1, name: 'W1', baseStats: '{"ext_atk":100}' } },
    { id: 2, isEquipped: true, equipTmpl: { slotType: 2, name: 'A1', baseStats: '{"ext_def":100}' } },
  ],
  bagItems: [{ id: 1, itemId: 6, count: 10, itemTmpl: { name: '首乌丹' } }],
  equipSets: [{ name: '神龙', equipTmplIds: '[101,102]' }],
  skills: [],
};

test('状态树：ENTER_GAME 后快照正确', () => {
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  const s = store.getSnapshot();
  assert.equal(s.me.level, 56);
  assert.equal(s.me.power, 65000);
  assert.equal(s.me.gold, 3000000);
  assert.equal(s.me.equips, 2);
  assert.equal(s.me.bagCount, 1);
  assert.equal(s.health.packets > 0, true);
  store.close();
});

test('速率：跨 2 分钟样本计算 XP/h 与 Gold/h', () => {
  const ws = createMockWs({ game });
  const store = initStore(ws);
  const now = Date.now();
  store.st.samples.push({ t: now - 120_000, exp: 1_000_000, money: 1_000_000, level: 56, power: 65000 });
  store.st.samples.push({ t: now, exp: 1_200_000, money: 1_060_000, level: 56, power: 65000 });
  const r = store.rates();
  assert.equal(r.spanMs, 120_000);
  assert.equal(r.xpPerHour, 6_000_000);   // 200k / 2min * 60
  assert.equal(r.goldPerHour, 1_800_000); // 60k / 2min * 60
  store.close();
});

test('掉落：COMBAT_REWARD 累积到 live_drops.json，并能查最佳地图', () => {
  const ws = createMockWs({ game });
  const store = initStore(ws);
  ws.emit({ type: 'COMBAT_REWARD', data: { mapId: 20080, drops: [{ name: '珍兽蛋', count: 2 }, { name: '强化精华', count: 1 }] } });
  ws.emit({ type: 'COMBAT_REWARD', data: { mapId: 20080, drops: [{ name: '珍兽蛋', count: 3 }] } });
  ws.emit({ type: 'COMBAT_REWARD', data: { mapId: 10027, drops: [{ name: '珍兽蛋', count: 1 }] } });
  const f = path.join(DATA, 'live_drops.json');
  assert.equal(fs.existsSync(f), true);
  const disk = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(disk.byMap['20080']['珍兽蛋'].count, 5);
  assert.deepEqual(bestMapForItem(disk, '珍兽蛋'), { mapId: '20080', count: 5 });
  assert.equal(topDrops(disk, 1)[0].name, '珍兽蛋');
  store.close();
});

test('未知协议：同 cmd 最多落 5 条', () => {
  const ws = createMockWs({ game });
  const store = initStore(ws);
  for (let i = 0; i < 8; i++) ws.emit({ type: 'MYSTERY_CMD', data: { i } });
  assert.equal(store.st.unknownByType.MYSTERY_CMD, 8);
  const lines = fs.readFileSync(path.join(DATA, 'unknown_packets.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  const mine = lines.filter(l => l.includes('MYSTERY_CMD'));
  assert.equal(mine.length, 5);
  store.close();
});

test('已知协议不落未知包', () => {
  const ws = createMockWs({ game });
  const store = initStore(ws);
  ws.emit({ type: 'COMBAT_STATE', data: { stage: 'running', combatProgress: { defeated: 3, total: 80 } } });
  assert.equal(store.st.unknownByType.COMBAT_STATE, undefined);
  assert.equal(store.st.combat.stage, 'running');
  assert.equal(store.st.combat.progress, '3/80');
  store.close();
});
