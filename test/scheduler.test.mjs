// test/scheduler.test.mjs —— 后勤 / 日常调度决策
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tlbot-sched-'));
process.env.TL_DATA_DIR = DATA;
const { decideActions, dateKey, loadState, saveState } = await import('../src/scheduler.mjs');

const MIN = 60_000;

test('后勤：超过 30 分钟才触发 maintain', () => {
  const now = Date.now();
  assert.deepEqual(decideActions({ lastMaintainAt: now - 31 * MIN, lastDailyKey: dateKey(now) }, now, { maintenanceMs: 30 * MIN }), ['maintain']);
  assert.deepEqual(decideActions({ lastMaintainAt: now - 10 * MIN, lastDailyKey: dateKey(now) }, now, { maintenanceMs: 30 * MIN }), []);
});

test('日常：跨天且过了 00:05 才触发，每天只触发一次', () => {
  const before = new Date(2026, 10, 15, 0, 2).getTime();
  const after = new Date(2026, 10, 15, 0, 10).getTime();
  const st = { lastMaintainAt: before, lastDailyKey: '2026-11-14' };
  assert.deepEqual(decideActions(st, before, { maintenanceMs: 30 * MIN, dailyHour: 0, dailyMinute: 5 }), []);
  assert.deepEqual(decideActions(st, after, { maintenanceMs: 30 * MIN, dailyHour: 0, dailyMinute: 5 }), ['daily']);
  assert.deepEqual(decideActions({ lastMaintainAt: after, lastDailyKey: '2026-11-15' }, after, { maintenanceMs: 30 * MIN }), []);
});

test('状态持久化：重启后不重复跑日常', () => {
  const st = { lastMaintainAt: 123, lastDailyKey: '2026-11-15' };
  assert.equal(saveState(st), true);
  const loaded = loadState();
  assert.equal(loaded.lastMaintainAt, 123);
  assert.equal(loaded.lastDailyKey, '2026-11-15');
  const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'scheduler.json'), 'utf8'));
  assert.ok(raw.updatedAt);
});

test('dateKey 使用本地日期', () => {
  assert.equal(dateKey(new Date(2026, 0, 2, 23, 59).getTime()), '2026-1-2');
});
