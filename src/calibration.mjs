// 实测 ROI 校准：把每次写操作的 (消耗, ΔCP) 以 EMA 形式沉淀，供 planner/System2 读取。
import fs from 'node:fs';
import path from 'node:path';

const DATA = process.env.TL_DATA_DIR || path.resolve(import.meta.dirname, '..', 'data');
const F = path.join(DATA, 'roi-calibration.json');
const HIST = path.join(DATA, 'allocation-history.jsonl');

export function load() { try { return JSON.parse(fs.readFileSync(F, 'utf8')) || {}; } catch { return {}; } }
export function record({ kind, exp = 0, cost = 0, cpBefore = null, cpAfter = null, note = '' } = {}) {
  const dcp = (cpBefore != null && cpAfter != null) ? Number(cpAfter) - Number(cpBefore) : null;
  const denom = Number(exp) || Number(cost) || 0;
  const cpPerUnit = dcp != null && denom > 0 ? dcp / (denom / 1e6) : null;
  const all = load();
  const prev = all[kind] || { n: 0, emaCpPerMexp: null, emaDeltaCP: null, last: null };
  const n = prev.n + 1;
  const ema = (old, v) => (old == null ? v : old * 0.7 + v * 0.3);
  all[kind] = {
    n,
    emaCpPerMexp: cpPerUnit == null ? prev.emaCpPerMexp : +ema(prev.emaCpPerMexp, cpPerUnit).toFixed(3),
    emaDeltaCP: dcp == null ? prev.emaDeltaCP : +ema(prev.emaDeltaCP, dcp).toFixed(1),
    last: { at: new Date().toISOString(), exp, cost, cpBefore, cpAfter, deltaCP: dcp, cpPerMexp: cpPerUnit == null ? null : +cpPerUnit.toFixed(3), note },
  };
  try { fs.writeFileSync(F, JSON.stringify(all, null, 1)); } catch { }
  return all[kind];
}

export function summary() {
  const all = load();
  const out = { at: new Date().toISOString(), kinds: all };
  try {
    const lines = fs.readFileSync(HIST, 'utf8').trim().split('\n').filter(Boolean).slice(-20).map(JSON.parse);
    out.recentAnqi = lines.map(x => ({ at: x.at, exp: x.exp ?? x.cost, deltaCP: x.deltaCP, cpPerMexp: x.cpPerM }));
  } catch { out.recentAnqi = []; }
  return out;
}
