// test/logistics.test.mjs —— 清仓红线 / dry-run / 后勤不越界
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockWs } from './mock-ws.mjs';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbot-logi-'));
process.env.TL_DATA_DIR = DATA;
process.env.TL_HALT_FILE = path.join(DATA, '.halt');
const { createLogistics } = await import('../src/logistics.mjs');
const { initStore } = await import('../src/state-store.mjs');

function buildGame() {
  const eqs = [];
  // slot1 前 2 强：id 1 / 2（高价值），其余都是垃圾
  eqs.push({ id: 1, isEquipped: true, quality: 4, tmplId: 101, isAppraisal: true, isBound: 1, equipTmpl: { slotType: 1, name: '神剑', reqLevel: 50, baseStats: '{"ext_atk":2000}' } });
  eqs.push({ id: 2, quality: 4, tmplId: 102, isAppraisal: true, isBound: 1, equipTmpl: { slotType: 1, name: '好剑', reqLevel: 50, baseStats: '{"ext_atk":1500}' } });
  let id = 3;
  const slots = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  for (let i = 0; i < 58; i++) {
    eqs.push({
      id: id++, isEquipped: false, quality: 1, tmplId: 500 + i, isBound: 1, isAppraisal: true,
      equipTmpl: { slotType: slots[i % slots.length], name: `垃圾${i}`, reqLevel: 40, baseStats: '{"ext_def":1}' },
    });
  }
  return {
    role: {
      level: 56, currentExp: 1_000_000, money: 3_000_000, combatPower: 65_000,
      mapId: 10027, persistenceRevision: 1, settings: '{}', yuanbao: 0,
    },
    equipments: eqs,
    bagItems: [
      { id: 900, itemId: 6, count: 600, itemTmpl: { name: '首乌丹' } },
      { id: 901, itemId: 12, count: 600, itemTmpl: { name: '琼丹' } },
    ],
    equipSets: [],
    skills: [],
  };
}

test('阶段 0：清仓只出 DRY_RUN 计划，不发写包', async () => {
  const game = buildGame();
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  const logi = createLogistics(ws, store, { stage: 0, allowWrite: false, log: () => {} });
  const rep = await logi.maintain();
  assert.equal(rep.dryRun, true);
  assert.ok(rep.actions.some(a => a.dryRun && a.op === 'SHOP_SELL'), '应有 SHOP_SELL dry-run 计划');
  assert.equal(ws.sent.filter(x => x.type === 'SHOP_SELL').length, 0, '阶段 0 不得直卖');
  assert.equal(ws.sent.filter(x => x.type === 'CONSIGNMENT_CREATE').length, 0, '阶段 0 不得挂售');
  store.close();
});

test('阶段 2：清仓直卖垃圾，但同槽前 2 强永不卖', async () => {
  const game = buildGame();
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  ws.setResponse('SHOP_SELL', () => ({ success: true, data: {} }));
  const logi = createLogistics(ws, store, { stage: 2, allowWrite: true, log: () => {} });
  const rep = await logi.maintain();
  const sells = ws.calls.filter(x => x.type === 'SHOP_SELL');
  assert.ok(sells.length > 0, '应卖出垃圾件');
  const soldIds = sells.map(x => x.payload.roleEquipId);
  assert.equal(soldIds.includes(1), false, '同槽第 1 强不得卖');
  assert.equal(soldIds.includes(2), false, '同槽第 2 强不得卖');
  assert.equal(rep.blocked.length, 0, '正常垃圾不应触发红线: ' + JSON.stringify(rep.blocked));
  store.close();
});

test('阶段 2：最高资质珍兽不会被放生（R2）', async () => {
  const game = buildGame();
  game.role.currentExp = 1_000_000;
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  const pets = [
    { pet: { id: 10, level: 20, form: 'MUTANT', sex: 'MALE', appraised: true, status: 'OWNED' }, speciesName: '变异', average: 197, combatPower: 9000 },
    { pet: { id: 11, level: 20, form: 'BABY', sex: 'FEMALE', appraised: true, status: 'OWNED' }, speciesName: '普通', average: 110, combatPower: 1000 },
  ];
  ws.setResponse('PET_COMMAND', () => ({ data: { state: { pets, capacity: 2, reserved: 0, activePetId: 10 } } }));
  const logi = createLogistics(ws, store, { stage: 2, allowWrite: true, log: () => {} });
  await logi.maintain();
  const releases = ws.sent.filter(x => x.type === 'PET_COMMAND' && x.payload.action === 'release');
  assert.equal(releases.some(x => x.payload.petId === 10), false, '最高资质不得放生');
  store.close();
});

test('阶段 2：换装导致实际战力下降时自动回滚', async () => {
  const game = {
    role: {
      level: 56, currentExp: 1_000_000, money: 3_000_000, combatPower: 1000,
      mapId: 10027, persistenceRevision: 1, settings: '{}', yuanbao: 0,
    },
    levelTmpls: [{ level: 56 }],
    equipments: [
      { id: 1, isEquipped: true, quality: 4, tmplId: 201, isAppraisal: true, equipTmpl: { slotType: 8, name: '旧护符', reqLevel: 50, baseStats: '{"ext_def":100}' } },
      { id: 2, isEquipped: false, quality: 4, tmplId: 202, isAppraisal: true, equipTmpl: { slotType: 8, name: '新护符', reqLevel: 50, baseStats: '{"ext_def":1000}' } },
    ],
    bagItems: [
      { id: 900, itemId: 6, count: 600, itemTmpl: { name: '首乌丹' } },
      { id: 901, itemId: 12, count: 600, itemTmpl: { name: '琼丹' } },
    ],
    equipSets: [], skills: [],
  };
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  ws.setResponse('EQUIP_ITEM', (payload) => {
    const id = payload.roleEquipId;
    game.equipments.forEach(x => { x.isEquipped = x.id === id; });
    // 模拟真实服务器：新护符反而降战力
    game.role.combatPower = id === 2 ? 900 : 1000;
    return { success: true, data: {} };
  });
  const logi = createLogistics(ws, store, { stage: 2, allowWrite: true, log: () => {} });
  const rep = await logi.maintain();
  const equips = ws.calls.filter(x => x.type === 'EQUIP_ITEM').map(x => x.payload.roleEquipId);
  assert.ok(equips.includes(2), '应尝试换上新护符: ' + JSON.stringify(equips));
  assert.ok(equips.includes(1), '应在战力下降后换回旧护符: ' + JSON.stringify(equips));
  assert.equal(rep.after.power, 1000, '最终战力应回到原值');
  assert.ok(rep.actions.some(a => /回滚/.test(a.msg)), '战报应记录回滚');
  const cal = JSON.parse(fs.readFileSync(path.join(DATA, 'calibration.json'), 'utf8'));
  const s = cal.samples.find(x => x.action === 'EQUIP_ITEM' && x.measured === -100);
  assert.ok(s, '应记录实测 -100 的校准样本: ' + JSON.stringify(cal.samples.slice(-3)));
  store.close();
});

test('喂经验只喂出战珍兽，不拿经验练非出战繁殖对', async () => {
  const game = buildGame();
  game.role.currentExp = 10_000_000;
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  const pets = [
    { pet: { id: 10, level: 20, form: 'BABY', sex: 'MALE', appraised: true, status: 'OWNED' }, speciesName: '出战龟', average: 117, combatPower: 9000 },
    { pet: { id: 11, level: 1, form: 'BABY', sex: 'FEMALE', appraised: true, status: 'OWNED' }, speciesName: '松鼠', average: 112, combatPower: 1000 },
  ];
  ws.setResponse('PET_COMMAND', () => ({ data: { state: { pets, capacity: 6, reserved: 0, activePetId: 10 } } }));
  const logi = createLogistics(ws, store, { stage: 2, allowWrite: true, log: () => {} });
  await logi.maintain();
  const feeds = ws.calls.filter(x => x.type === 'PET_COMMAND' && x.payload.action === 'feed');
  assert.ok(feeds.length > 0, '应喂食');
  assert.equal(feeds.every(x => x.payload.petId === 10), true, '只能喂出战珍兽: ' + JSON.stringify(feeds));
  store.close();
});

test('同槽多件（戒指/饰品）不做自动换装，避免丢装备', async () => {
  const game = {
    role: { level: 56, currentExp: 1_000_000, money: 3_000_000, combatPower: 1000, mapId: 10027, persistenceRevision: 1, settings: '{}', yuanbao: 0 },
    equipments: [
      { id: 1, isEquipped: true, quality: 4, tmplId: 301, isAppraisal: true, equipTmpl: { slotType: 7, name: '戒指A', reqLevel: 50, baseStats: '{"ext_atk":100}' } },
      { id: 2, isEquipped: true, quality: 4, tmplId: 302, isAppraisal: true, equipTmpl: { slotType: 7, name: '戒指B', reqLevel: 50, baseStats: '{"ext_atk":100}' } },
      { id: 3, isEquipped: false, quality: 4, tmplId: 303, isAppraisal: true, equipTmpl: { slotType: 7, name: '戒指C', reqLevel: 50, baseStats: '{"ext_atk":5000}' } },
    ],
    bagItems: [
      { id: 900, itemId: 6, count: 600, itemTmpl: { name: '首乌丹' } },
      { id: 901, itemId: 12, count: 600, itemTmpl: { name: '琼丹' } },
    ],
    equipSets: [], skills: [],
  };
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  ws.setResponse('EQUIP_ITEM', () => ({ success: true, data: {} }));
  const logi = createLogistics(ws, store, { stage: 2, allowWrite: true, log: () => {} });
  const rep = await logi.maintain();
  const ringEquips = ws.calls.filter(x => x.type === 'EQUIP_ITEM' && x.payload.roleEquipId === 3);
  assert.equal(ringEquips.length, 0, '同槽多件时不得自动换戒指');
  assert.ok(rep.actions.some(a => /跳过自动换装槽位 7/.test(a.msg)), '战报应说明跳过 slot7');
  store.close();
});

test('换装意外挤掉其它已穿戴件时，回滚并补回', async () => {
  const game = {
    role: { level: 56, currentExp: 1_000_000, money: 3_000_000, combatPower: 1000, mapId: 10027, persistenceRevision: 1, settings: '{}', yuanbao: 0 },
    levelTmpls: [{ level: 56 }],
    equipments: [
      { id: 1, isEquipped: true, quality: 4, tmplId: 401, isAppraisal: true, equipTmpl: { slotType: 8, name: '旧护符', reqLevel: 50, baseStats: '{"ext_def":100}' } },
      { id: 2, isEquipped: false, quality: 4, tmplId: 402, isAppraisal: true, equipTmpl: { slotType: 8, name: '新护符', reqLevel: 50, baseStats: '{"ext_def":1000}' } },
      { id: 3, isEquipped: true, quality: 4, tmplId: 403, isAppraisal: true, equipTmpl: { slotType: 5, name: '鞋子', reqLevel: 50, baseStats: '{"ext_def":100}' } },
    ],
    bagItems: [
      { id: 900, itemId: 6, count: 600, itemTmpl: { name: '首乌丹' } },
      { id: 901, itemId: 12, count: 600, itemTmpl: { name: '琼丹' } },
    ],
    equipSets: [], skills: [],
  };
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  ws.setResponse('EQUIP_ITEM', (payload) => {
    const id = payload.roleEquipId;
    if (id === 2) {
      // 模拟服务器异常：换新护符时把鞋子也挤掉
      game.equipments.forEach(x => { x.isEquipped = x.id === 2; });
      game.role.combatPower = 900;
    } else if (id === 1) {
      game.equipments.forEach(x => { x.isEquipped = x.id === 1; });
      game.role.combatPower = 1000;
    } else if (id === 3) {
      game.equipments.find(x => x.id === 3).isEquipped = true;
    }
    return { success: true, data: {} };
  });
  const logi = createLogistics(ws, store, { stage: 2, allowWrite: true, log: () => {} });
  const rep = await logi.maintain();
  const ids = ws.calls.filter(x => x.type === 'EQUIP_ITEM').map(x => x.payload.roleEquipId);
  assert.ok(ids.includes(2), '应尝试新护符');
  assert.ok(ids.includes(1), '应换回旧护符');
  assert.ok(ids.includes(3), '应补回被挤掉的鞋子: ' + JSON.stringify(ids));
  const equipped = game.equipments.filter(x => x.isEquipped).map(x => x.id).sort();
  assert.deepEqual(equipped, [1, 3], '最终应恢复原穿戴集合: ' + JSON.stringify(equipped));
  store.close();
});

test('真实战力前 2 强即使 itemValue 低也不卖（双模型保护）', async () => {
  const eqs = [];
  eqs.push({ id: 1, isEquipped: true, quality: 4, tmplId: 601, isAppraisal: true, equipTmpl: { slotType: 1, name: '普通剑', reqLevel: 50, baseStats: '{"ext_atk":100}' } });
  // 冰攻：itemValue 是负分，但战力公式算 +2/点 → 低价值、高战力
  eqs.push({ id: 2, isEquipped: false, quality: 3, tmplId: 602, isAppraisal: true, equipTmpl: { slotType: 1, name: '冰攻剑', reqLevel: 50, baseStats: '{"ice_atk":500}' } });
  eqs.push({ id: 3, isEquipped: false, quality: 1, tmplId: 603, isAppraisal: true, equipTmpl: { slotType: 1, name: '弱剑', reqLevel: 40, baseStats: '{"ext_atk":50}' } });
  let id = 4;
  const slots = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  for (let i = 0; i < 58; i++) {
    eqs.push({ id: id++, isEquipped: false, quality: 1, tmplId: 700 + i, isBound: 1, isAppraisal: true, equipTmpl: { slotType: slots[i % slots.length], name: `垃圾${i}`, reqLevel: 40, baseStats: '{"ext_def":1}' } });
  }
  const game = {
    role: { level: 50, currentExp: 1_000_000, money: 3_000_000, combatPower: 1000, mapId: 10027, persistenceRevision: 1, settings: '{}', yuanbao: 0 },
    levelTmpls: [{ level: 50 }],
    equipments: eqs,
    bagItems: [
      { id: 900, itemId: 6, count: 600, itemTmpl: { name: '首乌丹' } },
      { id: 901, itemId: 12, count: 600, itemTmpl: { name: '琼丹' } },
    ],
    equipSets: [], skills: [],
  };
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  ws.setResponse('SHOP_SELL', () => ({ success: true, data: {} }));
  ws.setResponse('WAREHOUSE_DEPOSIT', () => ({ success: true, data: {} }));
  const logi = createLogistics(ws, store, { stage: 2, allowWrite: true, log: () => {} });
  await logi.maintain();
  const sells = ws.calls.filter(x => x.type === 'SHOP_SELL').map(x => x.payload.roleEquipId);
  assert.equal(sells.includes(2), false, '冰攻剑是战力前 2 强，不得卖: ' + JSON.stringify(sells));
  store.close();
});

test('upgradePet 支持 UUID petId（不能被 Number() 转成 NaN）', async () => {
  const game = buildGame();
  game.role.currentExp = 10_000_000;
  const ws = createMockWs({ game });
  const store = initStore(ws);
  store.ingest(game);
  const pets = [
    { pet: { id: '0fac5a42-079f-4ae6-bd3c-1449dc7c3b12', level: 43, form: 'BABY', sex: 'MALE', appraised: true, status: 'OWNED' }, speciesName: '乌龟', average: 117.5, combatPower: 13000 },
  ];
  ws.setResponse('PET_COMMAND', () => ({ data: { state: { pets, capacity: 6, reserved: 0, activePetId: pets[0].pet.id } } }));
  const logi = createLogistics(ws, store, { stage: 2, allowWrite: true, log: () => {} });
  const r = await logi.upgradePet('0fac5a42-079f-4ae6-bd3c-1449dc7c3b12');
  assert.equal(r.ok, true, JSON.stringify(r));
  const feeds = ws.calls.filter(x => x.type === 'PET_COMMAND' && x.payload.action === 'feed');
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].payload.petId, '0fac5a42-079f-4ae6-bd3c-1449dc7c3b12');
  store.close();
});
