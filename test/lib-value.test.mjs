// test/lib-value.test.mjs —— 强化 / 星级 / 宝石计入装备价值
import test from 'node:test';
import assert from 'node:assert/strict';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
import { itemValue, currentValue, bestLoadout, suggestPrice, STAR_BASE_MULT } from '../core/lib-value.mjs';

const base = {
  id: 1, isEquipped: true, quality: 4, tmplId: 1,
  equipTmpl: { slotType: 1, name: '剑', reqLevel: 50, baseStats: '{"ext_atk":100}' },
  extraStats: '{}', appraisalStats: '[]', gemSlots: '[]', enhanceLevel: 0, starLevel: 0,
};

test('强化倍率乘基材（+4 = 45%）', () => {
  const v0 = itemValue({ ...base });
  const v4 = itemValue({ ...base, enhanceLevel: 4 });
  close(v0, 640);           // 100 * 4 * 1.6
  close(v4, 928);           // 640 * 1.45
});

test('星级乘基材（4%/星）', () => {
  assert.equal(STAR_BASE_MULT, 0.04);
  const v = itemValue({ ...base, starLevel: 5 });
  close(v, 768);            // 640 * 1.2
});

test('强化 + 星级叠加', () => {
  const v = itemValue({ ...base, enhanceLevel: 4, starLevel: 5 });
  close(v, 640 * 1.45 * 1.2);
});

test('宝石按 gemInfo 计入价值', () => {
  const gemInfo = [{ id: 11, subType: 0, value: 50 }];   // subType 0 = extAtk
  const withGem = { ...base, gemSlots: '[11]' };
  close(itemValue(withGem), 640);                 // 没有 gemInfo 时不计
  close(itemValue(withGem, { gemInfo }), 640 + 50 * 4);
});

test('currentValue 同样计入强化/星级/宝石', () => {
  const gemInfo = [{ id: 11, subType: 0, value: 50 }];
  const e = { ...base, enhanceLevel: 4, starLevel: 5, gemSlots: '[11]' };
  close(currentValue(e, { gemInfo }), 100 * 1.45 * 1.2 * 4 + 50 * 4);
});

test('bestLoadout 在 gemInfo 下选择带宝石的候选', () => {
  const a = { ...base, id: 1, isEquipped: true, equipTmpl: { ...base.equipTmpl, name: '无宝石' } };
  const b = { ...base, id: 2, isEquipped: false, gemSlots: '[11]', equipTmpl: { ...base.equipTmpl, name: '带宝石' } };
  const gemInfo = [{ id: 11, subType: 0, value: 50 }];
  const plan = bestLoadout([a, b], [], false, { gemInfo, minGain: 1 });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].name, '带宝石');
  close(plan.steps[0].gain, 200);
});

test('suggestPrice 对高星/高强/宝石件给更高价', () => {
  const plain = suggestPrice({ ...base });
  const rich = suggestPrice({ ...base, enhanceLevel: 6, starLevel: 5, gemSlots: '[11]' }, { gemInfo: [{ id: 11, subType: 0, value: 50 }] });
  assert.ok(rich > plain, `${rich} 应大于 ${plain}`);
});
