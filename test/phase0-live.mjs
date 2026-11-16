// test/phase0-live.mjs —— 阶段 0 实机只读对账（会连接真实游戏 WS！）
//
// 前置条件（缺一不可）：
//   1. 旧 v5 已停（supervisor 不再拉起 v5）
//   2. 环境变量 TL_ENABLE_WS=1
//   3. 没有 .halt
//
// 用法：
//   cd tlbot-v2
//   TL_ENABLE_WS=1 node test/phase0-live.mjs
//
// 输出：logs/phase0-<timestamp>.json + 终端摘要
// 退出码：0 = 连接成功且状态可用；1 = 失败

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SUP_PID = '/tmp/tlbot-v5-supervisor.pid';
const OUT_DIR = path.join(ROOT, 'logs');

const fail = msg => { console.error('✖', msg); process.exit(1); };

if (process.env.TL_ENABLE_WS !== '1') fail('必须显式 TL_ENABLE_WS=1（防止误连踢掉 v5）');
if (fs.existsSync(path.join(ROOT, '.halt'))) fail('存在 .halt，先删除再跑');
if (fs.existsSync(SUP_PID) && process.env.TL_FORCE_WS !== '1') {
  const pid = fs.readFileSync(SUP_PID, 'utf8').trim();
  fail(`检测到 v5 supervisor PID 文件 (${pid})。确认 v5 已停后：rm ${SUP_PID} 或 TL_FORCE_WS=1`);
}

const { createSession } = await import('../core/lib-ws.mjs');
const { initStore } = await import('../src/state-store.mjs');
const { probeAll } = await import('../src/probe-benchmark.mjs');
const { calibrationHealth } = await import('../src/verifier.mjs');

const readJson = f => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch { return null; } };
const status5 = readJson('status5.json');

const t0 = Date.now();
const ws = createSession();
let store = null;
let report = null;
let err = null;
try {
  const g = await ws.open();
  store = initStore(ws);
  store.ingest(g);
  report = await probeAll(ws, store, { allowWrite: false, includeShop: false, game: g });
} catch (e) {
  err = e?.message || String(e);
} finally {
  try { store?.close?.(); } catch { }
  try { ws.close(); } catch { }
}

const self = report?.self || null;
const cmp = {
  level: self && status5 ? self.level === status5.level : null,
  money: self && status5 ? self.money === status5.money : null,
  power: self && status5 ? self.power === status5.power : null,
  powerDrift: self && status5 ? (self.power ?? 0) - (status5.power ?? 0) : null,
};

const out = {
  at: new Date().toISOString(),
  elapsedMs: Date.now() - t0,
  ok: !err && !!self,
  error: err,
  self,
  leaderboard: report?.leaderboard ? {
    rank: report.leaderboard.rank, total: report.leaderboard.total,
    top1: report.leaderboard.top1, gap: report.leaderboard.gap,
  } : null,
  pets: report?.pets,
  roi: report?.roi,
  health: report?.health,
  rates: report?.rates,
  crossCheck: report?.crossCheck,
  compareStatus5: { status5: status5 ? { level: status5.level, power: status5.power, money: status5.money } : null, cmp },
  calibration: calibrationHealth(self?.power ?? null),
  errors: report?.errors || [],
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, `phase0-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));

console.log(JSON.stringify({
  ok: out.ok, elapsedMs: out.elapsedMs, error: out.error,
  self: self ? { level: self.level, power: self.power, money: self.money, equipValue: self.equipValue } : null,
  rank: out.leaderboard?.rank, top1: out.leaderboard?.top1?.power, gap: out.leaderboard?.gap,
  compareStatus5: out.compareStatus5,
  errors: out.errors,
  report: file,
}, null, 1));

process.exit(out.ok ? 0 : 1);
