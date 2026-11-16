// test/probe-benchmark.test.mjs —— 面板 / 榜一差距 / ROI 真实数据口径
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockWs } from './mock-ws.mjs';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbot-probe-'));
process.env.TL_DATA_DIR = DATA;
const { initStore } = await import('../src/state-store.mjs');
const { probeAll } = await import('../src/probe-benchmark.mjs');

function game() {
  return {
    role: {
      level: 56, currentExp: 13_000_000, money: 3_300_000, combatPower: 65_763,
      mapId: 10027, persistenceRevision: 1, settings: '{}', yuanbao: 0,
    },
    equipments: [
      { id: 1, isEquipped: true, quality: 4, tmplId: 101, isAppraisal: true, equipTmpl: { slotType: 1, name: '武器', reqLevel: 50, baseStats: '{"ext_atk":1500}' } },
      { id: 2, isEquipped: true, quality: 4, tmplId: 102, isAppraisal: true, equipTmpl: { slotType: 2, name: '衣服', reqLevel: 50, baseStats: '{"ext_def":1200}' } },
      { id: 3, isEquipped: false, quality: 3, tmplId: 103, isAppraisal: true, equipTmpl: { slotType: 2, name: '备用衣服', reqLevel: 50, baseStats: '{"ext_def":1000}' } },
    ],
    bagItems: [
      { id: 1, itemId: 6, count: 400, itemTmpl: { name: '首乌丹' } },
      { id: 2, itemId: 980201, count: 1, itemTmpl: { name: '技能书' } },
    ],
    equipSets: [],
    skills: [],
  };
}

function pets(activeId) {
  return {
    state: {
      activePetId: activeId,
      capacity: 6,
      pets: [
        { pet: { id: 'best', level: 39, form: 'BABY', skills: [] }, speciesName: '乌龟', average: 117.5, quality: 4, combatPower: 11885 },
        { pet: { id: 'other', level: 30, form: 'BABY', skills: [] }, speciesName: '螳螂', average: 114, quality: 3, combatPower: 7870 },
      ],
    },
  };
}

async function run(activeId) {
  const g = game();
  const ws = createMockWs({ game: g });
  const store = initStore(ws);
  store.ingest(g);
  ws.setResponse('PET_COMMAND', () => ({ data: pets(activeId) }));
  ws.setResponse('GET_LEADERBOARD', () => ({
    data: [
      { nickname: 'YourCharName', combatPower: 65763, level: 56 },
      { nickname: '张无忌', combatPower: 120286, level: 56 },
    ],
  }));
  const rep = await probeAll(ws, store, { allowWrite: false, game: g });
  store.close();
  return rep;
}

test('自身面板：最弱 2 部位 / 装备值 / 榜一差距', async () => {
  const rep = await run('best');
  assert.equal(rep.self.level, 56);
  assert.equal(rep.self.power, 65763);
  assert.equal(rep.self.equips, 2);
  assert.equal(rep.self.weakest.length, 2);
  assert.equal(rep.leaderboard.rank, 2);
  assert.equal(rep.leaderboard.top1.name, '张无忌');
  assert.equal(rep.leaderboard.gap, 120286 - 65763);
});

test('ROI：出战就是最强时，不应误报「换出战珍兽」', async () => {
  const rep = await run('best');
  assert.equal(rep.pets.best.id, 'best');
  assert.equal(rep.pets.activePetId, 'best');
  assert.equal(rep.roi.some(r => r.dir === '换出战珍兽'), false, JSON.stringify(rep.roi));
});

test('ROI：出战不是最强时才提示换出战', async () => {
  const rep = await run('other');
  assert.equal(rep.pets.best.id, 'best');
  assert.equal(rep.roi.some(r => r.dir === '换出战珍兽'), true, JSON.stringify(rep.roi));
});

test('ROI：无 MUTANT 提示繁殖；强化精华不足提示塔', async () => {
  const rep = await run('best');
  assert.equal(rep.roi.some(r => r.dir === '珍兽繁殖'), true);
  assert.equal(rep.roi.some(r => r.dir === '强化精华'), true);
});
