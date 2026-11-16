// core/audit.mjs —— 全操作审计日志
//
// 目标：任何改动游戏状态的操作，事后都能回答三个问题：
//   ① 做了什么（action）
//   ② 为什么做（reason）—— 判定依据
//   ③ 代价与产出（cost / gain）—— 消耗了什么、得到了什么
//
// 存储：data/audit/YYYY-MM-DD.jsonl，每行一条 JSON，便于 grep/jq 分析。
//
// 用法：
//   import { audit } from '../core/audit.mjs';
//
//   // 简单记录
//   audit.log('sell', { item: '白装护腕', price: 1200, reason: '非前2强且品质1' });
//
//   // 带前后快照的一对（推荐用于有消耗/产出的操作）
//   audit.begin('craft', { slot: 2, target: '御赐混沌护胸' });
//   ...执行...
//   audit.end('craft', { ok: true, cost: [{ item: '2级棉布', n: 3 }], gain: [{ item: '御赐混沌护胸', n: 1 }] });
//
// 字段约定：
//   ts        ISO 时间
//   cat       分类（combat/daily/craft/gear/pet/shop/combat/lottery/dungeon/system）
//   action    动作名（snake_case）
//   ok        成功与否
//   reason    判定依据（为什么要这么做）
//   cost      消耗清单 [{item, n, id?}]
//   gain      产出清单 [{item, n, id?}]
//   before/after  关键状态快照（战力/金币/经验…）
//   extra     其它上下文

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = process.env.TL_DATA_DIR ? path.resolve(process.env.TL_DATA_DIR) : path.join(ROOT, 'data');
const DIR = path.join(DATA, 'audit');
const KEEP_DAYS = Number(process.env.TL_AUDIT_KEEP_DAYS || 30);

const enabled = String(process.env.TL_AUDIT ?? 'on').toLowerCase() !== 'off';

function todayFile(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(DIR, `${y}-${m}-${dd}.jsonl`);
}

function write(rec) {
  if (!enabled) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(todayFile(), JSON.stringify(rec) + '\n');
  } catch { }
}

// 内存里的"进行中"操作（begin/end 配对）
const pending = new Map();

function normalizeList(list) {
  if (!list) return undefined;
  if (!Array.isArray(list)) list = [list];
  return list.map(x => {
    if (x == null) return null;
    if (typeof x === 'string') return { item: x };
    if (typeof x === 'number') return { n: x };
    return x;
  }).filter(Boolean);
}

export const audit = {
  /**
   * 记录一条完整操作
   * @param {string} action 动作名
   * @param {object} o { cat, ok, reason, cost, gain, before, after, extra }
   */
  log(action, o = {}) {
    const rec = {
      ts: new Date().toISOString(),
      cat: o.cat || 'misc',
      action,
      ok: o.ok !== false,
      ...(o.reason != null ? { reason: String(o.reason) } : {}),
      ...(o.cost ? { cost: normalizeList(o.cost) } : {}),
      ...(o.gain ? { gain: normalizeList(o.gain) } : {}),
      ...(o.before ? { before: o.before } : {}),
      ...(o.after ? { after: o.after } : {}),
      ...(o.extra ? { extra: o.extra } : {}),
    };
    write(rec);
    return rec;
  },

  /** 开始一个需要前后对比的操作 */
  begin(action, ctx = {}) {
    const key = `${action}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;
    pending.set(key, { action, ctx, startedAt: Date.now() });
    if (pending.size > 200) {
      // 防止泄漏：丢掉最老的
      const oldest = [...pending.keys()][0];
      pending.delete(oldest);
    }
    return key;
  },

  /** 结束并落盘 */
  end(key, o = {}) {
    const p = pending.get(key);
    pending.delete(key);
    if (!p) return this.log(o.action || 'unknown', o);
    const rec = {
      ts: new Date().toISOString(),
      cat: o.cat || p.ctx.cat || 'misc',
      action: p.action,
      ok: o.ok !== false,
      ms: Date.now() - p.startedAt,
      ...(o.reason != null ? { reason: String(o.reason) } : {}),
      ...(Object.keys(p.ctx).length ? { ctx: p.ctx } : {}),
      ...(o.cost ? { cost: normalizeList(o.cost) } : {}),
      ...(o.gain ? { gain: normalizeList(o.gain) } : {}),
      ...(o.before ? { before: o.before } : {}),
      ...(o.after ? { after: o.after } : {}),
      ...(o.extra ? { extra: o.extra } : {}),
    };
    write(rec);
    return rec;
  },

  /** 从背包快照算差异（省去手写 cost/gain） */
  diffBag(before, after, { ignore = [], threshold = 0 } = {}) {
    const toMap = (bag) => {
      const m = new Map();
      for (const b of bag || []) {
        const name = b.itemTmpl?.name || String(b.itemId);
        if (ignore.some(re => (re instanceof RegExp ? re.test(name) : name === re))) continue;
        m.set(name, (m.get(name) || 0) + (b.count || 0));
      }
      return m;
    };
    const A = toMap(before), B = toMap(after);
    const cost = [], gain = [];
    for (const [name, n] of A) {
      const after2 = B.get(name) || 0;
      const d = n - after2;
      if (d > threshold) cost.push({ item: name, n: d });
    }
    for (const [name, n] of B) {
      const before2 = A.get(name) || 0;
      const d = n - before2;
      if (d > threshold) gain.push({ item: name, n: d });
    }
    return { cost, gain };
  },

  /** 关键状态快照（用于 before/after） */
  snap(game) {
    if (!game?.role) return null;
    return {
      power: game.role.combatPower,
      level: game.role.level,
      gold: game.role.money,
      exp: game.role.currentExp,
      yuanbao: game.role.yuanbao,
      bag: (game.bagItems || []).length,
      equips: (game.equipments || []).filter(e => e.isEquipped).length,
    };
  },

  /** 清理过期日志 */
  prune() {
    try {
      if (!fs.existsSync(DIR)) return 0;
      const cutoff = Date.now() - KEEP_DAYS * 86400_000;
      let n = 0;
      for (const f of fs.readdirSync(DIR)) {
        const m = f.match(/^(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
        if (!m) continue;
        const t = new Date(`${m[1]}-${m[2]}-${m[3]}`).getTime();
        if (t < cutoff) { fs.unlinkSync(path.join(DIR, f)); n++; }
      }
      return n;
    } catch { return 0; }
  },

  /** 读取某天的记录 */
  read(dateStr, filter = null) {
    try {
      const p = path.join(DIR, `${dateStr}.jsonl`);
      if (!fs.existsSync(p)) return [];
      const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
      const rows = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return filter ? rows.filter(filter) : rows;
    } catch { return []; }
  },

  /** 汇总某天：按 action 聚合消耗/产出 */
  summary(dateStr) {
    const rows = this.read(dateStr);
    const byAction = {};
    const costTotals = {}, gainTotals = {};
    for (const r of rows) {
      const k = r.action;
      (byAction[k] ||= { n: 0, ok: 0 });
      byAction[k].n++;
      if (r.ok) byAction[k].ok++;
      for (const c of r.cost || []) costTotals[c.item] = (costTotals[c.item] || 0) + (c.n || 1);
      for (const g of r.gain || []) gainTotals[g.item] = (gainTotals[g.item] || 0) + (g.n || 1);
    }
    return { date: dateStr, count: rows.length, byAction, costTotals, gainTotals };
  },

  paths: { DIR, todayFile },
};

export default audit;
