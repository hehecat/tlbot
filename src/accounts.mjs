// src/accounts.mjs —— 三账号只读汇总（主号/alt1/alt2）
import fs from 'node:fs';
import path from 'node:path';

const INSTANCES = [
  { id: 'main', data: 'data', status: 'tl_status.json' },
  { id: 'alt1', data: 'data-alt1', status: 'tl_status-alt1.json' },
  { id: 'alt2', data: 'data-alt2', status: 'tl_status-alt2.json' },
];

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function lastLine(p) {
  try {
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]); } catch { }
    }
  } catch { }
  return null;
}

function suggest({ ledger, allocation }) {
  const exp = Number(ledger?.exp || 0);
  const a = allocation;
  if (!a) return '无分配数据';
  if (a.sink === 'role') return '升级角色';
  if (a.sink === 'pet') return '投喂珍兽';
  if (a.sink === 'skill') return '升技能';
  if (a.sink === 'anqi') return '升暗器';
  const cand = (a.candidates || []).filter(c => Number(c.cost) > 0).sort((x, y) => Number(x.cost) - Number(y.cost))[0];
  if (cand) return `攒经验至 ${Number(cand.cost).toLocaleString()}（还差 ${Math.max(0, Number(cand.cost) - exp).toLocaleString()}）后可投 ${cand.label}`;
  return '无可用经验出口';
}

export function summarizeAccounts(root) {
  const accounts = [];
  for (const it of INSTANCES) {
    const status = readJson(path.join(root, it.status));
    const ledger = lastLine(path.join(root, it.data, 'ledger.jsonl'));
    const allocation = readJson(path.join(root, it.data, 'allocation.json'));
    accounts.push({ instance: it.id, status, ledger, allocation, suggestion: suggest({ ledger, allocation }) });
  }
  const known = accounts.filter(a => a.ledger || a.status);
  const totals = known.reduce((acc, a) => {
    const l = a.ledger || {};
    acc.power += Number(l.power || 0);
    acc.gold += Number(l.gold || 0);
    acc.exp += Number(l.exp || 0);
    acc.count += 1;
    return acc;
  }, { count: 0, power: 0, gold: 0, exp: 0 });
  return { at: new Date().toISOString(), accounts, totals };
}
