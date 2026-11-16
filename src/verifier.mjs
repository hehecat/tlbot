// src/verifier.mjs —— 预测 vs 实测偏差记录（PRD §2 / §8 数据验收）
//
// 目的：
//   · 每次「预测会提升 X 战力」的改动，都记录实测 Δpower
//   · 偏差累积后给出权重修正建议（不自动改 lib-value，避免自我强化偏差）
//
// data/calibration.json 结构：
//   { version, note, weights: { ... }, bias: { mean, n }, samples: [ ... ] }

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = process.env.TL_DATA_DIR ? path.resolve(process.env.TL_DATA_DIR) : path.join(ROOT, 'data');
const FILE = path.join(DATA, 'calibration.json');
const MAX_SAMPLES = 200;
// 预测公式版本：公式变更后旧样本不再参与偏差统计（保留历史，不删除）
export const PREDICTOR_VERSION = 2;

const DEFAULT = {
  version: 1,
  note: '预测 vs 实测偏差记录（reverse-explore SKILL 的 SOP）。weights 为实测修正系数，1 = 不修正。',
  weights: {
    itemValue: 1,
    allAtk: 1,
    elementAtk: 1,
    star: 1,
    enhance: 1,
    pet: 1,
  },
  bias: { mean: null, n: 0, absMean: null },
  samples: [],
};

export function readCalibration() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { ...DEFAULT, ...d, weights: { ...DEFAULT.weights, ...(d.weights || {}) }, samples: d.samples || [] };
  } catch { return structuredClone(DEFAULT); }
}

export function writeCalibration(d) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(d, null, 1));
    return true;
  } catch { return false; }
}

// 记录一条：predicted 是预测 Δpower，measured 是实测 Δpower
export function recordSample({
  action = 'unknown', predicted = 0, measured = 0,
  beforePower = null, afterPower = null, detail = null,
  predictorVersion = PREDICTOR_VERSION,
} = {}) {
  const c = readCalibration();
  const p = Number(predicted) || 0;
  const m = Number(measured) || 0;
  const err = m - p;
  const sample = {
    at: new Date().toISOString(),
    action,
    predicted: p,
    measured: m,
    error: err,
    ratio: p !== 0 ? Number((m / p).toFixed(4)) : null,
    beforePower,
    afterPower,
    detail,
    predictorVersion,
  };
  c.samples.push(sample);
  if (c.samples.length > MAX_SAMPLES) c.samples = c.samples.slice(-MAX_SAMPLES);

  const withPred = c.samples.filter(s => s.predicted !== 0 && (s.predictorVersion ?? 0) === PREDICTOR_VERSION);
  const n = withPred.length;
  const mean = n ? withPred.reduce((a, s) => a + s.error, 0) / n : null;
  const absMean = n ? withPred.reduce((a, s) => a + Math.abs(s.error), 0) / n : null;
  c.bias = { mean: mean == null ? null : Number(mean.toFixed(2)), absMean: absMean == null ? null : Number(absMean.toFixed(2)), n };
  c.updatedAt = new Date().toISOString();
  writeCalibration(c);
  return { sample, bias: c.bias };
}

// 对一次「换装」给出预测（复用战力公式：把候选设为 isEquipped，其它同槽卸下）
export function predictEquipDelta(gameData, candidate) {
  // 动态 import 避免循环依赖
  return import('../core/lib-power.mjs').then(({ computePower }) => {
    const eqs = gameData.equipments || [];
    const slot = candidate.equipTmpl?.slotType;
    // p0 必须保持「当前已穿戴」不变，否则算出的是全裸 → 满装（绝对值，不是 Δ）
    const base = { ...gameData, equipments: eqs };
    const p0 = computePower(base).power;
    const after = {
      ...gameData,
      equipments: eqs.map(x => ({
        ...x,
        isEquipped: x.id === candidate.id ? true : (x.isEquipped && x.equipTmpl?.slotType !== slot ? true : false),
      })),
    };
    const p1 = computePower(after).power;
    return { predicted: (p1 || 0) - (p0 || 0), beforePower: p0, afterPower: p1 };
  });
}

// 偏差健康度：absMean / 典型战力 > 5% 视为需要校准
export function calibrationHealth(power = null) {
  const c = readCalibration();
  // 只用当前公式版本的样本算偏差；旧公式样本保留但不影响告警
  const cur = c.samples.filter(s => (s.predictorVersion ?? 0) === PREDICTOR_VERSION);
  const withPred = cur.filter(s => s.predicted !== 0);
  const n = withPred.length;
  const mean = n ? withPred.reduce((a, s) => a + s.error, 0) / n : null;
  const absMean = n ? withPred.reduce((a, s) => a + Math.abs(s.error), 0) / n : null;
  const bias = { mean: mean == null ? null : Number(mean.toFixed(2)), absMean: absMean == null ? null : Number(absMean.toFixed(2)), n };
  const rel = absMean != null && power ? absMean / power : null;
  return {
    samples: c.samples.length,
    currentSamples: cur.length,
    predictorVersion: PREDICTOR_VERSION,
    bias,
    weights: c.weights,
    relAbsBias: rel == null ? null : Number(rel.toFixed(4)),
    needsCalibration: rel != null ? rel > 0.05 : false,
    recent: cur.slice(-3),
  };
}

export const CALIBRATION_FILE = FILE;
