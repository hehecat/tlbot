// test/verifier.test.mjs —— 预测 Δ 战力 / 校准样本
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbot-verifier-'));
process.env.TL_DATA_DIR = DATA;
const { predictEquipDelta, recordSample, readCalibration, calibrationHealth } = await import('../src/verifier.mjs');

function game() {
  return {
    role: { level: 50 },
    levelTmpls: [{ level: 50 }],
    equipments: [
      { id: 1, isEquipped: true, equipTmpl: { slotType: 1, name: '旧武器', baseStats: '{"ext_atk":100}' } },
      { id: 2, isEquipped: false, equipTmpl: { slotType: 1, name: '新武器', baseStats: '{"ext_atk":300}' } },
    ],
    equipSets: [], skills: [],
  };
}

test('predictEquipDelta 返回真实增量，而不是裸装→满装绝对值', async () => {
  const g = game();
  const r = await predictEquipDelta(g, g.equipments[1]);
  // 当前 ext_atk 100 → 400 战力；换新 300 → 1200；Δ=800
  assert.equal(r.beforePower, 400);
  assert.equal(r.afterPower, 1200);
  assert.equal(r.predicted, 800);
});

test('recordSample 写入 calibration.json 并计算偏差', () => {
  const { sample, bias } = recordSample({
    action: 'EQUIP_ITEM', predicted: 800, measured: 600, beforePower: 400, afterPower: 1000,
    detail: { slot: 1 },
  });
  assert.equal(sample.error, -200);
  assert.equal(bias.n, 1);
  assert.equal(bias.absMean, 200);
  const c = readCalibration();
  assert.equal(c.samples.length, 1);
  assert.equal(c.samples[0].action, 'EQUIP_ITEM');
  const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'calibration.json'), 'utf8'));
  assert.equal(raw.samples.length, 1);
});

test('calibrationHealth 在偏差 >5% 时提示需要校准', () => {
  // 再加一条大偏差样本
  recordSample({ action: 'EQUIP_ITEM', predicted: 1000, measured: -500 });
  const h = calibrationHealth(1000);
  assert.equal(h.needsCalibration, true);
  assert.ok(h.relAbsBias > 0.05);
});
