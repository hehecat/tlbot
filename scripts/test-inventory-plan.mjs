import assert from 'node:assert/strict';
import { buildInventoryPlan } from '../src/inventory-plan.mjs';

const gear = (id, slot, hp, q = 2, extra = {}) => ({
  id, tmplId: 90000 + id, quality: q, isEquipped: false, starLevel: 0, enhanceLevel: 0,
  equipTmpl: { id: 90000 + id, name: `item${id}`, slotType: slot, reqLevel: 50, qualityBase: q, baseStats: JSON.stringify({ hp }) },
  extraStats: JSON.stringify(extra),
});

const worn = { ...gear(1, 1, 5000), isEquipped: true };
const bag = [gear(2, 1, 4000), gear(3, 1, 3000), gear(4, 1, 2000), gear(5, 1, 1000)];
const wh = [gear(6, 1, 4500), gear(7, 1, 800)];
const plan = buildInventoryPlan({
  equipments: [worn, ...bag],
  warehouse: wh,
  equipSets: [{ equipTmplIds: [90007] }],
});

assert.equal(plan.slots.length, 1);
const s = plan.slots[0];
assert.equal(s.worn.id, 1);
assert.equal(s.total, 7);
// 7 件、50% => 4 件保留；已穿 + 前三
assert.equal(s.keepN, 4);
assert.equal(s.keep.length, 5); // 4 常规保留 + 1 套装保护
assert.ok(s.keep.some(k => k.id === 1 && k.reason === 'worn'));
// 套装 7 受保护，不进入卖列表
assert.ok(plan.protectedSet.some(p => p.id === '7'));
assert.ok(!plan.sellBag.some(x => x.id === 7));
assert.ok(!plan.sellWarehouse.some(x => x.id === 7));
// 仓库 4500 比已穿 5000 低，不应升级
assert.equal(plan.upgrade.length, 0);
// 卖列表合计 = 总数 - 保留 - 套装
assert.equal(plan.sellBag.length + plan.sellWarehouse.length, s.total - s.keep.length);

// 仓库更好的应进入 upgrade
const wh2 = [gear(8, 1, 9000)];
const p2 = buildInventoryPlan({ equipments: [worn], warehouse: wh2, equipSets: [] });
assert.equal(p2.upgrade.length, 1);
assert.equal(p2.upgrade[0].id, 8);
console.log('inventory-plan tests OK', JSON.stringify(plan.summary));
