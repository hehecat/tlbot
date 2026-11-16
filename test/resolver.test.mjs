// test/resolver.test.mjs —— 递归目标解析器
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget } from '../src/resolver.mjs';

const data = {
  templates: {
    101: { id: 101, name: '神龙之甲', reqLevel: 50 },
    102: { id: 102, name: '神龙之碧', reqLevel: 50 },
    201: { id: 201, name: '玄铁剑', reqLevel: 50 },
    301: { id: 301, name: '玄铁', reqLevel: 1 },
  },
  sets: [{ id: 1, name: '神龙', equipTmplIds: '[101,102]' }],
  drops: {
    丹霞岭: { name: '丹霞岭', req: 50, drops: [{ cat: 'MONSTER', monsterId: 5, item: '神龙之碧' }] },
    玄武岛: { name: '玄武岛', req: 50, drops: [{ cat: 'LEADER', monsterId: 7, item: '神龙之碧' }] },
    剑阁: { name: '剑阁', req: 30, drops: [{ cat: 'MONSTER', monsterId: 9, item: '玄铁' }] },
  },
  live: { byMap: { 20080: { 神龙之碧: { count: 3 } }, 10027: { 神龙之碧: { count: 1 } } } },
  maps: { 丹霞岭: 10027, 玄武岛: 20080, 剑阁: 20002 },
  recipes: { 201: [{ itemId: 301, count: 5 }] },
};

function game(over = {}) {
  return {
    role: { level: 56 },
    equipments: [{ id: 1, tmplId: 101, isEquipped: true }],
    bagItems: [],
    warehouseItems: [],
    maps: [],
    ...over,
  };
}

test('套装缺件：解析到实测掉落最高的地图与怪物', () => {
  const r = resolveTarget('神龙', game(), { data });
  assert.equal(r.set.name, '神龙');
  assert.equal(r.have.length, 1);
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].item, '神龙之碧');
  assert.equal(r.farm.length >= 1, true);
  assert.equal(r.primaryFarm.mapId, 20080);
  assert.equal(r.primaryFarm.monsterId, 7);
  assert.match(r.primaryFarm.reason, /live_drops/);
});

test('配方递归：玄铁剑缺 1 把 → 差 5 玄铁 → 背包有 2 → 去刷 3 个', () => {
  const g = game({ bagItems: [{ itemId: 301, count: 2 }] });
  const r = resolveTarget({ tmplId: 201, count: 1 }, g, { data });
  assert.equal(r.steps.some(s => s.type === 'craft' && s.item === '玄铁剑'), true);
  const farm = r.farm.find(f => f.item === '玄铁');
  assert.ok(farm, JSON.stringify(r));
  assert.equal(farm.need, 3);
  assert.equal(farm.mapId, 20002);
  assert.equal(farm.monsterId, 9);
});

test('仓库里的材料计入已有数量', () => {
  const g = game({ warehouseItems: [{ itemId: 301, count: 5 }] });
  const r = resolveTarget({ tmplId: 201, count: 1 }, g, { data });
  assert.equal(r.farm.length, 0);
  assert.equal(r.have.some(h => h.item === '玄铁' && h.have >= 5), true);
});

test('未知目标返回 unknown，不抛错', () => {
  const r = resolveTarget('不存在的东西', game(), { data });
  assert.equal(r.ok, false);
  assert.equal(r.unknown.length >= 1, true);
});
