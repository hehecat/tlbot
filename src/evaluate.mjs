// src/evaluate.mjs —— 官方装备评分（EQUIPMENT_EVALUATE）
//
// 为什么用它：服务端自己有一套 combat-power-v2 算法，能直接回答
// 「把这件装上去，伤害/命中/闪避/会心各变化多少百分比」。
// 我们自建的 lib-value 权重是猜的，实测 3 个换装样本里错了 2 个
// （预测 +439 实测 -55、预测 +165 实测 -408），不能再拿它做最终决定。
//
// 协议（2026-11-16 从 index-4q5inR0O.js 逆向确认）：
//   → EQUIPMENT_EVALUATE  { requestId, tokens: [evaluationToken], mode: "basic" }
//   ← EQUIPMENT_EVALUATE_RESPONSE { requestId, status: "queued"|"complete", results: [ ... ] }
//   result = {
//     eligible: boolean,      // 等级是否够
//     reason: string|null,
//     damagePct, hitPct, dodgePct, criticalPct,   // 相对当前配装的百分比数字（-3.98 = -3.98%）
//     equipmentPower: number,                     // 官方单件战力
//     powerVersion: "combat-power-v2"
//   }
//
// 语义要点（实测确认）：
//   · 已穿戴装备一律返回 0.00% —— 它们是「当前配装」的基准
//   · 未穿戴装备返回「装上去之后相对当前的变化」
//   · 因此必须一次性评估同槽所有候选，拿到同一基准下的可比数值
//   · 评估结果依赖当前配装快照，换装后要重新评

import crypto from 'node:crypto';

// 服务端限流：同时最多 12 个评估在跑，超了返回 "评估队列繁忙"
const MAX_CONCURRENT = 6;      // 保守一点，别把服务端的 12 个额度占满
const EVAL_TIMEOUT_MS = 90_000;
const CACHE_TTL_MS = 5 * 60_000;

let inflight = 0;
const queue = [];
const cache = new Map();       // key = `${snapshotSig}:${token}` -> result

function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      inflight++;
      // 必须把 fn 的结果透传出去，否则外层 Promise 永远不 settle
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          inflight--;
          const next = queue.shift();
          if (next) next();
        });
    };
    if (inflight < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

// 配装快照签名：任何影响评估基准的字段变了，缓存就得作废
export function snapshotSignature(game) {
  if (!game?.role) return 'none';
  const parts = [
    game.role.id, game.role.level, game.role.sect,
    (game.equipments || [])
      .filter(e => e.isEquipped)
      .map(e => [e.id, e.tmplId, e.evaluationToken, e.enhanceLevel, e.gemSlots, e.extraStats, e.isAppraisal, e.appraisalStats])
      .sort(),
    // 技能与套装会影响输出/防御基准
    (game.skills || []).map(s => [s.id, s.currentLevel]).sort(),
    (game.equipSets || []).map(s => [s.id, s.equipTmplIds]),
  ];
  const h = crypto.createHash('sha1');
  h.update(JSON.stringify(parts));
  return h.digest('hex').slice(0, 16);
}

/**
 * 评估单件装备。
 * @param {object} ws       lib-ws session
 * @param {object} game     ENTER_GAME 返回的 data（用来算快照签名）
 * @param {string} token    item.evaluationToken
 * @returns {Promise<object>} { eligible, damagePct, hitPct, dodgePct, criticalPct, equipmentPower, ... }
 */
export function evaluateOne(ws, game, token) {
  if (!token) return Promise.reject(new Error('缺少 evaluationToken'));
  const sig = snapshotSignature(game);
  const key = `${sig}:${token}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.result);

  return withSlot(() => new Promise((resolve, reject) => {
    const requestId = `power-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    let settled = false;
    let unsub = null;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ws.on 返回的是取消订阅函数，直接调用
      try { unsub?.(); } catch { }
      fn(v);
    };
    const timer = setTimeout(() => done(reject, new Error('评估超时')), EVAL_TIMEOUT_MS);
    unsub = ws.on('EQUIPMENT_EVALUATE_RESPONSE', msg => {
      const b = msg?.data;
      if (!b || b.requestId !== requestId) return;
      if (b.status === 'queued') return;         // 服务端排队，继续等
      if (b.status !== 'complete' || !b.results?.[0]) {
        return done(reject, new Error(b.message || `评估失败 status=${b.status}`));
      }
      const r = b.results[0];
      cache.set(key, { at: Date.now(), result: r });
      if (cache.size > 512) cache.delete(cache.keys().next().value);
      done(resolve, r);
    });
    try {
      ws.send('EQUIPMENT_EVALUATE', { requestId, tokens: [token], mode: 'basic' });
    } catch (e) {
      done(reject, e);
    }
  }));
}

/**
 * 批量评估（内部串行化到 MAX_CONCURRENT）。
 * @returns {Promise<Array<{item, result|null, error}>>}
 */
export async function evaluateMany(ws, game, items) {
  const out = [];
  for (const item of items) {
    try {
      const result = await evaluateOne(ws, game, item.evaluationToken);
      out.push({ item, result, error: null });
    } catch (e) {
      out.push({ item, result: null, error: e?.message || String(e) });
    }
  }
  return out;
}

/**
 * 一个槽位的最优选择。
 *
 * 关键：同槽所有候选必须一次性评完，才能在同一基准下比较。
 * 已穿戴的那件会是 0.00%，未穿的给出相对增量，直接取增量最大的。
 */
export async function bestInSlot(ws, game, slotType) {
  const all = (game.equipments || []).filter(
    e => e.equipTmpl?.slotType === Number(slotType) && e.evaluationToken,
  );
  if (!all.length) return { slot: slotType, candidates: [], best: null, reason: '该槽无带 token 的装备' };

  const evaled = await evaluateMany(ws, game, all);
  // 基准战力 = 当前穿戴那件的官方 equipmentPower。
  // 它是"当前强度"的锚点，用来判断候选是综合变强还是只变强了输出。
  const basePower = (() => {
    const cur = evaled.find(x => x.item.isEquipped && x.result?.eligible);
    if (cur?.result?.equipmentPower) return cur.result.equipmentPower;
    // 同槽多件（戒指/饰品）时没有唯一基准，用候选里 power 最高的当锚
    const pws = evaled.map(x => x.result?.equipmentPower).filter(Boolean);
    return pws.length ? Math.max(...pws) : 0;
  })();

  const scored = evaled
    .filter(x => x.result?.eligible)
    .map(x => ({
      item: x.item,
      isEquipped: !!x.item.isEquipped,
      // 综合收益权重。
      //
      // 2026-11-16 两次踩坑后的定稿：
      //
      // 坑 1：给会心 0.5 权重，把镶玉扇（伤害 -10.54% / 会心 +26.50%）
      //       算成 +2.71 判定该换。会心是概率项，+26.5% 会心率对期望 DPS
      //       的贡献远小于 -10.54% 伤害的损失。不能同量纲相加。
      //
      // 坑 2：只看 damagePct，把织网战甲（power 3607）换成儒玄铠（power 2875），
      //       输出确实 +3.16%，但总战力掉 732 —— 防御被砍了。挂机能不能打满
      //       一批全靠不死，牺牲生存换输出是亏的。
      //
      // 定稿口径：
      //   · servicePowerRatio 用官方 equipmentPower 衡量综合强度（含生存）
      //   · damagePct 衡量输出
      //   · 两者都要为正才推荐，任一为负都否决
      //   · 命中/会心/闪避只是微调项
      score: (() => {
        const dmg = x.result.damagePct || 0;
        const hit = x.result.hitPct || 0;
        const crit = x.result.criticalPct || 0;
        const dodge = x.result.dodgePct || 0;
        const pw = x.result.equipmentPower || 0;
        // 官方战力相对基准的百分比变化
        const basePw = basePower || pw || 1;
        const pwPct = ((pw - basePw) / basePw) * 100;
        const secondary = hit * 0.15 + crit * 0.15 + dodge * 0.10;
        // 输出与综合强度各占一半；任一为负则高强度惩罚
        const core = dmg * 0.5 + pwPct * 0.5;
        if (dmg < 0 || pwPct < -2) return Math.min(core, -0.5) + secondary * 0.2;
        return core + secondary;
      })(),
      raw: x.result,
    }))
    .sort((a, b) => b.score - a.score);

  const failed = evaled.filter(x => !x.result || !x.result.eligible);
  const equippedNow = all.find(e => e.isEquipped) || null;
  // 排除当前穿戴的那件，只在「候选」里选最优
  const alternatives = scored.filter(s => !s.isEquipped);
  const top = alternatives[0] || null;
  const currentScore = scored.find(s => s.isEquipped)?.score ?? 0;

  // 换装闸门（四条全满足才建议换）：
  //   ① 有非穿戴候选
  //   ② 候选伤害不为负 —— 输出亏了就不换
  //   ③ 候选官方战力不明显低于基准 —— 生存亏了也不换（这一条是第二次踩坑的教训）
  //   ④ 综合分明显高于当前（留 0.5 缓冲，避免临界抖动）
  const topRaw = top?.raw || {};
  const damageOk = (topRaw.damagePct ?? -1) >= 0;
  const topPw = topRaw.equipmentPower || 0;
  const powerOk = !basePower || topPw >= basePower * 0.98;   // 战力掉超 2% 就不换
  const clearlyBetter = top ? top.score > currentScore + 0.5 : false;
  const shouldSwap = !!(top && damageOk && powerOk && clearlyBetter);

  return {
    slot: Number(slotType),
    candidates: scored,
    equippedNow,
    best: top,
    currentScore,
    shouldSwap,
    why: shouldSwap ? 'ok'
      : !top ? '无候选'
      : !damageOk ? `候选伤害为负(${(topRaw.damagePct ?? 0).toFixed(2)}%)`
      : !powerOk ? `候选战力偏低(${topPw} < ${basePower}×0.98)`
      : `综合提升不足(${(top.score - currentScore).toFixed(2)})`,
    failed: failed.map(x => ({ name: x.item.equipTmpl?.name, error: x.error || x.result?.reason || '不合格' })),
  };
}

/**
 * 全槽位扫描 —— 返回每个槽位的建议（仅供人工/LLM 决策，不自动执行）。
 */
export async function scanAllSlots(ws, game) {
  const slots = [...new Set((game.equipments || []).map(e => e.equipTmpl?.slotType).filter(x => x != null))];
  const reports = [];
  for (const sl of slots.sort((a, b) => a - b)) {
    try {
      reports.push(await bestInSlot(ws, game, sl));
    } catch (e) {
      reports.push({ slot: sl, error: e?.message || String(e) });
    }
  }
  return reports;
}

export function clearCache() { cache.clear(); }
