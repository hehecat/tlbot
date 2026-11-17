#!/usr/bin/env node
// 30 分钟巡检增量报告：本次巡检期间 experience/gold/主要材料，及与上一周期的对比。
// 快照落 data/inspection-snapshots.jsonl；首次运行只建基线。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'data', 'inspection-snapshots.jsonl');
const PORTS = [[9527, 'main'], [9528, 'alt1'], [9529, 'alt2']];
const MAT = [
  ['高级强化精华', /高级强化精华/], ['低级强化精华', /低级强化精华/],
  ['金刚砂', /金刚砂/], ['天罡强化露', /天罡强化露/],
  ['无相印', /无相印/], ['玉犀角', /玉犀角/], ['百淬神玉', /百淬神玉/],
  ['天灵丹', /天灵丹/], ['珍兽蛋', /珍兽蛋|宝宝蛋|蛋$/],
  ['宝石', /宝石|晶石|玉$|石$/], ['棉布', /棉布/], ['秘银', /秘银/], ['万灵石', /万灵石/],
];
const num = (v) => Number(v) || 0;

async function get(port, p) {
  try { const r = await fetch(`http://127.0.0.1:${port}${p}`); return r.ok ? await r.json() : null; } catch { return null; }
}
async function snapshot() {
  const out = { at: new Date().toISOString(), accounts: {} };
  for (const [port, name] of PORTS) {
    const b = await get(port, '/status/brief');
    if (!b) { out.accounts[name] = { port, offline: true }; continue; }
    const raw = await get(port, '/raw');
    const bag = raw?.bagItems || [];
    const mats = {};
    for (const [label, re] of MAT) {
      const n = bag.filter(x => re.test(x.itemTmpl?.name || '') || re.test(x.name || '')).reduce((a, x) => a + num(x.count || 1), 0);
      if (n) mats[label] = n;
    }
    out.accounts[name] = { port, level: b.level, power: b.power, exp: num(b.exp), gold: num(b.gold), mapId: b.mapId, combat: b.combat, mats };
  }
  return out;
}
function load() {
  try { return fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; }
}
function diff(cur, prev) {
  if (!cur || !prev) return null;
  const d = { exp: num(cur.exp) - num(prev.exp), gold: num(cur.gold) - num(prev.gold), mats: null, matsNote: null };
  if (cur.mats && prev.mats) {
    d.mats = {};
    const keys = new Set([...Object.keys(cur.mats), ...Object.keys(prev.mats)]);
    for (const k of keys) { const v = num(cur.mats[k]) - num(prev.mats[k]); if (v) d.mats[k] = v; }
  } else d.matsNote = '材料首期基线，下期开始出增减';
  return d;
}
const cur = await snapshot();
const hist = load();
const prev = hist.at(-1) || null;
const prev2 = hist.at(-2) || null;
const report = { at: cur.at, since: prev?.at || null, accounts: {}, totals: {} };
for (const [name, a] of Object.entries(cur.accounts)) {
  const p = prev?.accounts?.[name], p2 = prev2?.accounts?.[name];
  const nowD = diff(a, p), prevD = diff(p, p2);
  report.accounts[name] = {
    level: a.level, power: a.power, exp: a.exp, gold: a.gold, combat: a.combat, offline: !!a.offline,
    sinceLast: nowD, previous: prevD,
    vsPrevious: nowD && prevD ? { exp: nowD.exp - prevD.exp, gold: nowD.gold - prevD.gold } : null,
  };
}
const sum = (k, f) => Object.values(report.accounts).reduce((a, x) => a + (f(x?.[k]) || 0), 0);
report.totals = {
  exp: sum('sinceLast', d => d?.exp), gold: sum('sinceLast', d => d?.gold),
  prevExp: sum('previous', d => d?.exp), prevGold: sum('previous', d => d?.gold),
};
if (!process.argv.includes('--no-save')) fs.appendFileSync(FILE, JSON.stringify(cur) + '\n');
console.log(JSON.stringify(report, null, 1));
