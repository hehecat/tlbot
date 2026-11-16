// test/redlines.test.mjs —— 六条红线逐条单测
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafe, RedlineError, selfTest, lockCmd, isLocked, lockedCmds, assertNotLocked,
} from '../core/redlines.mjs';

const owned = [
  { id: 1, isEquipped: true, quality: 4, equipTmpl: { slotType: 1, name: 'W1' }, extraStats: '{"ext_atk":900}' },
  { id: 2, quality: 4, equipTmpl: { slotType: 1, name: 'W2' }, extraStats: '{"ext_atk":800}' },
  { id: 3, quality: 1, equipTmpl: { slotType: 1, name: 'W3' }, extraStats: '{"ext_atk":10}' },
  { id: 4, isEquipped: true, quality: 4, equipTmpl: { slotType: 2, name: 'A1' }, extraStats: '{"ext_def":900}' },
  { id: 5, quality: 2, equipTmpl: { slotType: 2, name: 'A2' }, extraStats: '{"ext_def":100}' },
  { id: 6, quality: 1, equipTmpl: { slotType: 2, name: 'A3' }, extraStats: '{"ext_def":10}' },
];
const pets = [
  { pet: { id: 10 }, average: 197, speciesName: 'MUTANT' },
  { pet: { id: 11 }, average: 120, speciesName: 'BABY' },
];

test('R1 同槽前 2 强：卖/分解/放生都拒绝', () => {
  for (const id of [1, 2, 4, 5]) {
    const item = owned.find(x => x.id === id);
    assert.throws(
      () => assertSafe({ action: 'SHOP_SELL', op: 'SHOP_SELL', itemId: id, item, owned, dryRun: true }),
      e => e instanceof RedlineError && e.code === 'R1',
      `item ${id} 应被 R1 拒绝`,
    );
  }
});

test('R1 允许卖非前 2 强', () => {
  for (const id of [3, 6]) {
    const item = owned.find(x => x.id === id);
    assert.doesNotThrow(() => assertSafe({ action: 'SHOP_SELL', op: 'SHOP_SELL', itemId: id, item, owned, dryRun: true }));
  }
});

test('R1 装备但缺 owned 列表 → 宁可拒绝', () => {
  assert.throws(
    () => assertSafe({ action: 'SHOP_SELL', op: 'SHOP_SELL', itemId: 99, item: { id: 99, equipTmpl: { slotType: 1 } } }),
    e => e instanceof RedlineError && e.code === 'R1',
  );
});

test('作用域：存仓 / 换装 / 出战最强装备与珍兽不被误拦', () => {
  const top = owned.find(x => x.id === 1);
  assert.doesNotThrow(() => assertSafe({ action: 'WAREHOUSE_DEPOSIT', op: 'WAREHOUSE_DEPOSIT', itemId: 1, item: top, owned }));
  assert.doesNotThrow(() => assertSafe({ action: 'EQUIP_ITEM', op: 'EQUIP_ITEM', itemId: 1, item: top, owned }));
  assert.doesNotThrow(() => assertSafe({ action: 'PET_COMMAND', op: 'PET_SUMMON', petId: 10, pets }));
  assert.doesNotThrow(() => assertSafe({ action: 'PET_COMMAND', op: 'PET_FEED', petId: 10, pets }));
  // 但真正的破坏性动作仍拦
  assert.throws(() => assertSafe({ action: 'ITEM_DECOMPOSE', op: 'ITEM_DECOMPOSE', itemId: 1, item: top, owned, dryRun: true }), e => e.code === 'R1');
});

test('R2 最高资质珍兽永不放生', () => {
  assert.throws(
    () => assertSafe({ action: 'PET_COMMAND', op: 'PET_RELEASE', petId: 10, pets, dryRun: true }),
    e => e instanceof RedlineError && e.code === 'R2',
  );
  assert.doesNotThrow(() => assertSafe({ action: 'PET_COMMAND', op: 'PET_RELEASE', petId: 11, pets, dryRun: true }));
});

test('R3 消耗元宝 >0 必须先 dry-run + 确认', () => {
  assert.throws(
    () => assertSafe({ action: 'BUY', cost: 300, yuanbao: 500 }),
    e => e instanceof RedlineError && e.code === 'R3',
  );
  assert.doesNotThrow(() => assertSafe({ action: 'BUY', cost: 300, yuanbao: 500, dryRun: true }));
  assert.throws(
    () => assertSafe({ action: 'BUY', cost: 600, yuanbao: 500, confirmed: true }),
    e => e instanceof RedlineError && e.code === 'R3',
  );
  assert.doesNotThrow(() => assertSafe({ action: 'BUY', cost: 300, yuanbao: 500, confirmed: true }));
});

test('R4 单次金币 > 30% 拒绝', () => {
  assert.throws(
    () => assertSafe({ action: 'BUY', goldCost: 4000, money: 10000 }),
    e => e instanceof RedlineError && e.code === 'R4',
  );
  assert.doesNotThrow(() => assertSafe({ action: 'BUY', goldCost: 2000, money: 10000 }));
});

test('R5 摘除已穿戴装备必须先有 ID 快照', () => {
  assert.throws(
    () => assertSafe({ action: 'EQUIP', unequip: true, snapshot: { equippedIds: [] } }),
    e => e instanceof RedlineError && e.code === 'R5',
  );
  assert.doesNotThrow(() => assertSafe({ action: 'EQUIP', unequip: true, snapshot: { equippedIds: [1, 4] } }));
});

test('R6 不可逆操作必须先 dry-run', () => {
  for (const op of ['SHOP_SELL', 'SMELT_START', 'PET_RELEASE', 'ITEM_DECOMPOSE']) {
    assert.throws(
      () => assertSafe({ action: op, op }),
      e => e instanceof RedlineError && e.code === 'R6',
      `${op} 应被 R6 拒绝`,
    );
    assert.doesNotThrow(() => assertSafe({ action: op, op, dryRun: true }));
  }
});

test('T5 永久禁调表', () => {
  assert.equal(isLocked('EVIL_CMD'), false);
  lockCmd('EVIL_CMD', 'test');
  assert.equal(isLocked('EVIL_CMD'), true);
  assert.ok(lockedCmds().includes('EVIL_CMD'));
  assert.throws(() => assertNotLocked('EVIL_CMD'), e => e instanceof RedlineError && e.code === 'LOCK');
  assert.doesNotThrow(() => assertNotLocked('SAFE_CMD'));
});

test('selfTest 全量通过', () => {
  const r = selfTest();
  assert.equal(r.failed, 0, JSON.stringify(r.cases.filter(c => !c.pass), null, 1));
  assert.ok(r.total >= 12);
});
