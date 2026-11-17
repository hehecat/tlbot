// src/probe-benchmark.mjs —— 自身完整状态 + 榜一对比 + 差距拆解 + ROI 方向推荐
// 升级自 goal_probe.mjs（原版只落 goal_state.json，无 ROI/无 store 复用）
//
// 用法（阶段 0 只读）：
//   import { createSession } from '../core/lib-ws.mjs';
//   const ws = createSession(); await ws.open();
//   const store = initStore(ws);
//   const report = await probeAll(ws, store);
//
// 设计约束：
//   · 只发读请求（GET_LEADERBOARD / PET_COMMAND{list} / CONSIGNMENT_LIST）
//   · allowWrite=false（默认）时绝不发 COMBAT_STOP 等写包
//   · 采集失败不 throw，把错误写进 report.errors，让 tool 层照常返回

import fs from 'node:fs';
import path from 'node:path';
import { itemValue, analyzeSets, bestLoadout } from '../core/lib-value.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const GOAL_STATE = path.join(ROOT, 'goal_state.json');
const STATUS5 = path.join(ROOT, 'status5.json');

const ME_NAME = '吃西瓜';

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const round = n => (n == null ? null : Math.round(n));

// ── 自身面板 ────────────────────────────────────────────────
function selfPanel(g) {
  const r = g.role || {};
  const all = g.equipments || [];
  const eqs = all.filter(x => x.isEquipped);
  const iv = x => itemValue(x, { gemInfo: g.gemInfo });
  const sets = analyzeSets(eqs, g.equipSets || []);
  const plan = bestLoadout(all, g.equipSets || [], false, { gemInfo: g.gemInfo });
  const bag = g.bagItems || [];

  // 最弱 2 部位：按该槽当前件的 itemValue 升序（只看已穿戴）
  const bySlot = {};
  for (const e of eqs) (bySlot[e.equipTmpl?.slotType] ||= []).push(e);
  const slotRows = Object.entries(bySlot).map(([slot, arr]) => {
    const cur = arr[0];
    const cands = all.filter(x => x.equipTmpl?.slotType === Number(slot) && x.id !== cur.id);
    const bestAlt = cands.slice().sort((a, b) => iv(b) - iv(a))[0];
    return {
      slot: Number(slot),
      name: cur?.equipTmpl?.name || `slot${slot}`,
      req: cur?.equipTmpl?.reqLevel ?? null,
      star: cur?.starLevel ?? 0,
      enhance: cur?.enhanceLevel ?? 0,
      value: round(iv(cur)),
      bestAlternative: bestAlt ? { name: bestAlt.equipTmpl?.name, value: round(iv(bestAlt)) } : null,
    };
  });
  const weakest = slotRows.slice().sort((a, b) => a.value - b.value).slice(0, 2);

  return {
    level: r.level ?? null,
    exp: r.currentExp ?? null,
    gold: r.money ?? null,
    yuanbao: r.yuanbao ?? 0,
    power: r.combatPower ?? null,
    equips: eqs.length,
    equipValue: round(eqs.reduce((a, x) => a + iv(x), 0)),
    bestValue: round(plan.value),
    canImprove: plan.steps.length,
    improveSteps: plan.steps.slice(0, 3),
    sets: sets.filter(x => x.have >= 2).map(x => ({
      name: x.name, have: x.have, total: x.total, allAtk: x.allAtk, score: round(x.score),
    })),
    stars: eqs.reduce((a, x) => a + (x.starLevel || 0), 0),
    enhance: eqs.reduce((a, x) => a + (x.enhanceLevel || 0), 0),
    slots: slotRows.sort((a, b) => a.slot - b.slot),
    weakest,
    bag: {
      count: bag.length,
      enhanceEssence: bag.filter(x => /强化精华/.test(x.itemTmpl?.name || '')).reduce((a, b) => a + (b.count || 0), 0),
      stone: bag.filter(x => /金刚砂/.test(x.itemTmpl?.name || '')).reduce((a, b) => a + (b.count || 0), 0),
      seals: bag.filter(x => /无相印/.test(x.itemTmpl?.name || '')).reduce((a, b) => a + (b.count || 0), 0),
      skillBooks: bag.filter(x => x.itemId >= 980200 && x.itemId <= 980214).length,
    },
    weapons: all.filter(x => x.equipTmpl?.slotType === 1).map(x => {
      let ap = {};
      try { ap = JSON.parse(x.appraisalStats || '[]'); } catch { }
      return {
        name: x.equipTmpl?.name, req: x.equipTmpl?.reqLevel,
        ext: ap.extScore ?? null, int: ap.intScore ?? null,
        qualified: (ap.extScore > 1500 && ap.intScore > 1500),
        equipped: !!x.isEquipped,
      };
    }),
  };
}

// ── 珍兽 ────────────────────────────────────────────────────
function petPanel(store) {
  const p = store?.st?.pets;
  if (!p) return null;
  const list = (p.list || []).slice().sort((a, b) => (b.average || 0) - (a.average || 0));
  return {
    count: p.count, capacity: p.capacity, activePetId: p.activePetId,
    best: list[0] ? { id: list[0].id, name: list[0].name, form: list[0].form, level: list[0].level, average: list[0].average, cp: list[0].cp } : null,
    hasMutant: list.some(x => x.form === 'MUTANT'),
    list: list.map(x => ({ name: x.name, form: x.form, lv: x.level, avg: x.average, cp: x.cp, active: x.active })),
  };
}

// ── 排行榜 ──────────────────────────────────────────────────
async function leaderboard(ws, errors) {
  const r = await ws.req('GET_LEADERBOARD', {}, { ms: 8000 });
  const L = r?.data;
  const arr = Array.isArray(L) ? L : (L?.list || L?.items || []);
  if (!arr.length) { errors.push('GET_LEADERBOARD 无数据: ' + JSON.stringify(r).slice(0, 200)); return null; }
  const sorted = arr.slice().sort((a, b) => (b.combatPower || 0) - (a.combatPower || 0));
  const idx = sorted.findIndex(x => x.nickname === ME_NAME);
  return {
    me: idx >= 0 ? { rank: idx + 1, name: ME_NAME, power: sorted[idx].combatPower } : null,
    rank: idx >= 0 ? idx + 1 : null,
    total: sorted.length,
    top1: sorted[0] ? { name: sorted[0].nickname, power: sorted[0].combatPower, level: sorted[0].level } : null,
    top5: sorted.slice(0, 5).map((x, i) => ({ rank: i + 1, name: x.nickname, power: x.combatPower, level: x.level })),
    gap: idx > 0 ? sorted[0].combatPower - sorted[idx].combatPower : 0,
    raw: sorted,
  };
}

// ── 差距拆解 ────────────────────────────────────────────────
// 只对「我们能量到的维度」做拆解；榜一的装备/珍兽明细 GET_LEADERBOARD 不给，
// 拿不到就明确标 unknown（不瞎猜，PRD 要求真实）
function gapBreakdown(self, lb) {
  if (!lb?.top1 || !self) return null;
  return {
    power: { me: self.power, top1: lb.top1.power, diff: (lb.top1.power || 0) - (self.power || 0) },
    level: { me: self.level, top1: lb.top1.level, diff: lb.top1.level != null && self.level != null ? lb.top1.level - self.level : null },
    equipValue: { me: self.equipValue, top1: null, note: 'GET_LEADERBOARD 不含装备明细' },
    stars: { me: self.stars, top1: null, note: '需榜一 inspect 接口，未确认' },
    enhance: { me: self.enhance, top1: null, note: '同上' },
    pets: { me: null, top1: null, note: '同上' },
    unknown: ['top1 装备/珍兽/星级/强化明细 —— 需 reverse-explore 找 inspect 接口'],
  };
}

// ── ROI 推荐 ────────────────────────────────────────────────
// 每条都带「依据」和「预估」，没有实测依据的不进榜
function roi(self, pets, lb) {
  const out = [];
  const push = (dir, why, est, action) => out.push({ dir, why, est, action });

  if (self.canImprove > 0) {
    push('配装优化', `${self.canImprove} 处可换装，装备值 ${self.equipValue} → ${self.bestValue}`,
      `+${self.bestValue - self.equipValue} 装备值`, 'bot_manage_gear_and_pet{action:"auto_maintain"}');
  }
  if (pets && !pets.hasMutant) {
    push('珍兽繁殖', `最好资质 ${pets.best?.average ?? 0}%（${pets.best?.form || '-'}），无 MUTANT`,
      'MUTANT 164~197% → 战力 +数千', 'bot_run_activity{activity:"hunt_pet"}');
  }
  if (pets?.activePetId && pets.best?.id && pets.best.id !== pets.activePetId) {
    push('换出战珍兽', `出战不是最强资质个体（最强 ${pets.best.name} ${pets.best.average}%）`,
      '战力 = 自身 + 出战珍兽 cp，直接差值', 'bot_manage_gear_and_pet{action:"upgrade_pet"}');
  }
  if (self.bag.enhanceEssence < 10) {
    push('强化精华', `背包只有 ${self.bag.enhanceEssence} 个（强化 12 件 req50+ 需高级精华）`,
      '每件强化 +战力，具体倍率见 lib-power ENH', 'bot_run_activity{activity:"tower"}');
  }
  const best4 = self.sets.slice().sort((a, b) => (b.allAtk || 0) - (a.allAtk || 0))[0];
  if (!best4 || best4.have < 4) {
    push('套装凑件', best4 ? `${best4.name} ${best4.have}/${best4.total}` : '无 2 件以上套装',
      'all_atk 4 件套 +20%（战力公式不计，实战最值钱）', 'bot_configure_combat{action:"update"} 切掉套装件的图');
  }
  const closeW = (self.weapons || []).filter(w => w.ext && w.int)
    .sort((a, b) => Math.min(b.ext, b.int) - Math.min(a.ext, a.int))[0];
  if (!(self.weapons || []).some(w => w.qualified)) {
    push('双资质武器', closeW ? `最近 ${closeW.name} ${closeW.ext}/${closeW.int}（差 ${Math.max(0, 1500 - Math.min(closeW.ext, closeW.int))}）` : '无已鉴定武器',
      '熔炼（升星）门槛：双资质 > 1500', '刷武器图 / 金刚砂重鉴定');
  }
  if (lb?.gap) push('总差距', `距榜一 ${lb.gap}（${lb.top1?.name} ${lb.top1?.power}）`, '—', '先做上面收益最高的 1 条');
  return out;
}

// ── 主入口 ──────────────────────────────────────────────────
export async function probeAll(ws, store, opts = {}) {
  const { allowWrite = false, includeShop = false } = opts;
  const errors = [];
  const report = { at: new Date().toISOString(), errors };

  // 1) 自身面板：优先用 ws 打开时的 ENTER_GAME_RESPONSE（由调用方传入 g）
  let g = opts.game;
  if (!g) {
    // 没有现成快照就发一个只读请求
    const r = await ws.req('ENTER_GAME', {}, { ms: 10000, revision: false });
    g = r?.data;
    if (!g?.role) errors.push('ENTER_GAME 无 role: ' + JSON.stringify(r).slice(0, 200));
  }

  if (g?.role) {
    report.self = selfPanel(g);
    // 2) 珍兽：store 里有就用 store（零发包），否则尝试 list
    if (!store?.st?.pets) {
      const pr = await ws.req('PET_COMMAND', { action: 'list', requestId: crypto.randomUUID() }, { ms: 7000 });
      if (pr?.data?.state) {
        const s = pr.data.state;
        if (store) {
          store.st.pets = {
            count: s.pets?.length ?? 0, capacity: s.capacity ?? null, activePetId: s.activePetId ?? null,
            list: (s.pets || []).map(p => ({
              id: p.pet?.id, name: p.speciesName || p.pet?.name, form: p.pet?.form, level: p.pet?.level,
              average: p.average, quality: p.quality, cp: p.combatPower, active: s.activePetId === p.pet?.id,
            })),
          };
        }
      } else if (!pr) errors.push('PET_COMMAND list 无响应（可能在战斗中，需先 COMBAT_STOP）');
      else errors.push('PET_COMMAND list: ' + (pr.message || 'failed'));
    }
    report.pets = petPanel(store);

    // 3) 排行榜 + 差距 + ROI
    report.leaderboard = await leaderboard(ws, errors);
    if (report.leaderboard) {
      report.gap = gapBreakdown(report.self, report.leaderboard);
      report.roi = roi(report.self, report.pets, report.leaderboard);
    }

    // 4) 商城（可选，慢）
    if (includeShop) {
      const cl = await ws.req('CONSIGNMENT_LIST', { page: 1, size: 100 }, { ms: 8000 });
      const goods = (cl?.data?.items || []).filter(x => x.equipTmpl);
      const setIds = new Set();
      for (const s of g.equipSets || []) {
        try { JSON.parse(s.equipTmplIds || '[]').forEach(id => setIds.add(id)); } catch { }
      }
      report.shop = {
        count: goods.length,
        setPieces: goods.filter(x => setIds.has(x.tmplId)).map(x => ({ name: x.itemName, price: x.price, req: x.equipTmpl?.reqLevel })),
        highReq: goods.filter(x => (x.equipTmpl?.reqLevel || 0) >= 50).length,
      };
    }
  }

  // 5) store 健康度 + 速率
  report.health = store?.getSnapshot?.().health || null;
  report.rates = store?.getSnapshot?.().rates || null;
  report.combat = store?.getSnapshot?.().combat || null;
  report.drops = store?.getSnapshot?.().drops || null;

  // 6) 阶段 0 验收：与 status5.json / goal_state.json 对账
  const s5 = readJson(STATUS5);
  const gs = readJson(GOAL_STATE);
  report.crossCheck = {
    status5: s5 ? { level: s5.level, power: s5.power, money: s5.money } : null,
    goalState: gs ? { at: gs.at, power: gs.me?.power, rank: gs.rank } : null,
    drift: {
      levelVsStatus5: s5 && report.self ? (report.self.level ?? 0) - (s5.level ?? 0) : null,
      powerVsStatus5: s5 && report.self ? (report.self.power ?? 0) - (s5.power ?? 0) : null,
      powerVsGoalState: gs && report.self ? (report.self.power ?? 0) - (gs.me?.power ?? 0) : null,
    },
    note: 'stage0 验收口径：bot_status_and_benchmark 与 status5.json 应一致（同一角色）',
  };

  return report;
}

export const __paths = { GOAL_STATE, STATUS5 };
