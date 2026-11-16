// src/scheduler.mjs —— 纯 JS 定时调度（PRD D2：高频动作零 token）
//
// 只做决策，不执行：
//   · maintain：每 N 分钟一次后勤
//   · daily：跨天后第一次运行日常 + 塔
//
// 状态持久化到 data/scheduler.json，进程重启不会重复跑日常。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = process.env.TL_DATA_DIR ? path.resolve(process.env.TL_DATA_DIR) : path.join(ROOT, 'data');
const FILE = path.join(DATA, 'scheduler.json');

export const DEFAULT_MAINTENANCE_MS = 30 * 60_000;
export const DEFAULT_DAILY_HOUR = 0;
export const DEFAULT_DAILY_MINUTE = 5;

export function dateKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function loadState() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { lastMaintainAt: Number(d.lastMaintainAt) || 0, lastDailyKey: String(d.lastDailyKey || '') };
  } catch {
    return { lastMaintainAt: 0, lastDailyKey: '' };
  }
}

export function saveState(s) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({
      lastMaintainAt: s.lastMaintainAt || 0,
      lastDailyKey: s.lastDailyKey || '',
      updatedAt: new Date().toISOString(),
    }, null, 1));
    return true;
  } catch { return false; }
}

// 返回本次 tick 要执行的动作（按优先级）
export function decideActions(state, now = Date.now(), opts = {}) {
  const maintenanceMs = Number(opts.maintenanceMs ?? DEFAULT_MAINTENANCE_MS);
  const dailyHour = Number(opts.dailyHour ?? DEFAULT_DAILY_HOUR);
  const dailyMinute = Number(opts.dailyMinute ?? DEFAULT_DAILY_MINUTE);
  const actions = [];

  if (now - (Number(state.lastMaintainAt) || 0) >= maintenanceMs) actions.push('maintain');

  const d = new Date(now);
  const afterDaily = d.getHours() > dailyHour || (d.getHours() === dailyHour && d.getMinutes() >= dailyMinute);
  if (String(state.lastDailyKey || '') !== dateKey(now) && afterDaily) actions.push('daily');

  return actions;
}

export const SCHEDULER_FILE = FILE;
