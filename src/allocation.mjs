// 统一经验分配器（P0）：所有经验去向在同一张表里按保守边际（P10）排序。
// 纯计算，无 ws 依赖；runtime 每 60s 写 data/allocation.json，各执行器只读它决定是否动手。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_ALLOC = {
  expReserve: null,
  minP10: 0.6,
  roleCpPerM: 1.11,
  roleP10: 0.9,
  petCpPerM: 1.1,
  petP10: 0.6,
  growthPetCpPerM: 20,
  growthPetP10: 0.5,
  skillCpPerM: 0.85,
  skillP10: 0.5,
  anqiCap: 50,
};

export function allocPath(dataDir = process.env.TL_DATA_DIR || 'data') {
  return path.join(dataDir, 'allocation.json');
}

export function readAllocation(p = allocPath()) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function writeAllocation(obj, p = allocPath()) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, p);
  } catch { }
}

function pct10(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const i = Math.floor((s.length - 1) * 0.1);
  return s[i];
}

export function readAnqiHistory(p = path.join(process.env.TL_DATA_DIR || 'data', 'allocation-history.jsonl'), n = 8) {
  try {
    const rows = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(x => x && x.kind === 'anqi' && Number.isFinite(x.cpPerM));
    return rows.slice(-n);
  } catch { return []; }
}

export function computeAllocation({ role, pets = [], skills = [], anqi = null, activePetId = null, cfg = {}, now = Date.now() } = {}) {
  const c = { ...DEFAULT_ALLOC, ...cfg };
  const exp = Number(role?.exp || 0);
  const level = Number(role?.level || 0);
  const reserve = Number(c.expReserve ?? (level < 30 ? 50_000 : 2_000_000));
  const cand = [];
  const push = (o) => { if (o && Number.isFinite(o.cost) && o.cost > 0) cand.push(o); };

  // 角色：56 级后用户明确“不生 57”，默认关闭；小号升级解锁地图，保留。
  const nextExp = Number(role?.nextExp || role?.upgradeExp || 0);
  if (nextExp > 0 && (level < 56 || c.allowRoleLevel)) {
    push({ sink: 'role', label: `角色 Lv${level + 1}`, cost: nextExp - exp, cpPerM: c.roleCpPerM, p10: c.roleP10, confidence: 'medium' });
  }

  // 珍兽：优先非出战高资质 SECOND/MUTANT（早期边际高）；否则出战宠按保守 1.1。
  const activeId = activePetId || role?.activePetId || null;
  const list = (pets || []).map(p => p?.pet ? { ...p.pet, average: p.average ?? p.pet.average, _avg: p.average, _active: p.pet.id === activeId } : p);
  const active = list.find(p => p.id === activeId) || list.find(p => p.active) || list.find(p => p._active);
  const growth = list.filter(p => p.id !== active?.id && (p.form === 'SECOND' || p.form === 'MUTANT') && Number(p.average || p._avg || 0) > Number(active?.average || active?._avg || 0) + 1)
    .sort((a, b) => Number(b.average || b._avg || 0) - Number(a.average || a._avg || 0))[0];
  for (const p of [growth, active]) {
    if (!p) continue;
    const need = Number(p.nextExp || 0) - Number(p.exp || 0);
    if (!(need > 0)) continue;
    const isGrowth = p === growth;
    push({ sink: 'pet', petId: p.id, label: `${p.name || '珍兽'} Lv${p.level}${isGrowth ? '(成长)' : ''}`,
      cost: need, cpPerM: isGrowth ? c.growthPetCpPerM : c.petCpPerM, p10: isGrowth ? c.growthPetP10 : c.petP10,
      confidence: 'low' });
  }

  // 技能：只把“下一级”作为一个段，按保守 0.85 CP/M，置信低。
  for (const s of skills || []) {
    if (s.unlockLevel && level < Number(s.unlockLevel)) continue;
    const cost = Number(s.nextExp || s.cost || 0);
    if (cost > 0) push({ sink: 'skill', skillId: s.id, label: `${s.name || '技能'} ${s.level ? 'Lv' + s.level : ''}`, cost, cpPerM: c.skillCpPerM, p10: c.skillP10, confidence: 'low' });
  }

  // 暗器：只有历史实测 P10>0 才可用，防止“单次 +650 外推”。
  if (anqi && Number(anqi.cost) > 0) {
    const hist = readAnqiHistory();
    const p10 = Math.min(c.anqiCap, pct10(hist.map(x => Math.min(c.anqiCap, Math.max(0, x.cpPerM)))));
    push({ sink: 'anqi', label: `飞蝗石 Lv${anqi.level}`, cost: Number(anqi.cost), cpPerM: p10 || 0, p10: p10 || 0,
      confidence: hist.length >= 3 ? 'measured' : 'none', samples: hist.length });
  }

  const usable = cand.filter(x => x.p10 > 0 && x.cost <= Math.max(0, exp - reserve));
  usable.sort((a, b) => (b.p10 * b.cpPerM) - (a.p10 * a.cpPerM));
  const best = usable[0] || null;
  if (best) best.score = +(best.p10 * best.cpPerM).toFixed(3);
  return {
    at: new Date(now).toISOString(), exp, level, reserve,
    sink: best?.sink || null,
    score: best ? +(best.p10 * best.cpPerM).toFixed(3) : 0,
    best, candidates: cand.map(x => ({ ...x, score: +(x.p10 * x.cpPerM).toFixed(3) })),
    allow: { role: best?.sink === 'role', pets: best?.sink === 'pet', skills: best?.sink === 'skill', anqi: best?.sink === 'anqi' },
  };
}

export function appendAnqiHistory(row, p = path.join(process.env.TL_DATA_DIR || 'data', 'allocation-history.jsonl')) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), kind: 'anqi', ...row }) + '\n');
  } catch { }
}
