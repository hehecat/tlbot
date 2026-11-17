// src/planner.mjs —— Max ΔCP/h 规划器（纯计算，不发包）
//
// 输入是一份「当前状态快照」，输出是：
//   · 资源预算（经验/金币/元宝/时间/栏位/封印）
//   · 每个候选动作的 ΔCP、成本、效率、可用性、置信度
//   · 按小时战力增量排序的执行建议
// 设计原则：任何没有实测数据的系数都标注 confidence=low，并由 System2 用
// audit / live_drops 回填（见 data/roi-calibration.json）。

const M = 1_000_000;

// 经验去向的边际系数（CP / 1M exp）。实测回填后覆盖。
const DEFAULT_ROI = {
  petCpPerLevel: 250,        // v5 实测约 +270/级；当前 Lv51 用 250 保守
  roleCpPerLevel: 180,       // 等级 56→57 估计（基础属性 +1~2%）
  skillCpPerLevel: 200,      // 主动技能等级对战力影响很小，低置信
  smeltCpPerStar: 250,       // 升星对战力影响小，低置信
  mutantGain: 9000,          // MUTANT 珍兽相对 BABY 的战力增量（榜上 164-197%）
  mutantChanceEgg: 0.03,     // 孵蛋出 MUTANT 的概率（未实测）
  mutantChanceBreed: 0.15,   // 繁殖出 MUTANT 的概率（未实测）
  essenceCp: 629,            // 高级强化精华对 q4 武器 787/787 的 +1 级战力
  eggCp: 300,                // 非 MUTANT 蛋宠相对当前出战的期望增量
  goldToCp: 0.002,           // 1 金币 ≈ 多少战力（拍卖行成交价经验值）
};

function num(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }

function petOf(pets) {
  const list = pets?.list || pets?.pets || [];
  const active = list.find(p => p.active || p.pet?.id === pets?.activePetId) || list[0] || null;
  // 更高成长的二代/变异宠：非出战、资质明显高于出战宠。
  // 2026-11-16 实测：SECOND 松鼠 Lv11→33 投入 137.7M 经验涨 7,320 CP（53 CP/M），
  // 而喂 Lv51 乌龟一整级 160.8M 只约 +250（1.55 CP/M）。
  const growth = list
    .filter(p => p !== active && p.pet?.status === 'OWNED' &&
      (p.pet.form === 'SECOND' || p.pet.form === 'MUTANT') &&
      num(p.average) > num(active?.average) + 1)
    .sort((a, b) => num(b.average) - num(a.average))[0] || null;
  return { list, active, growth };
}

function expNeedToLevel(p) {
  const exp = num(p?.pet?.exp ?? p?.exp);
  const next = num(p?.nextExp);
  return next > exp ? next - exp : null;
}

// 把「每 1M 经验换多少战力」统一成可比较的指标
function expActions(ctx) {
  const { pets, role, levelTmpl, skills, smelt, tower } = ctx;
  const out = [];
  if (tower?.weapon && num(tower.level) > 0) {
    const need = Math.max(0, num(tower.nextLevelExp) - num(tower.weapon.experience));
    if (need > 0 && need < 1e9) {
      out.push({
        id: 'anqi_feed',
        name: `喂飞蝗石（Lv${tower.level}→${tower.level + 1}）`,
        deltaCP: 184, cost: { exp: need, timeMin: 1 },
        cpPerExp: 184 / (need / M),
        confidence: 'low', available: true,
        note: '实测每级约16M经验，收益0~650 CP波动（Lv59单级+650），期望约11 CP/M，远高于宠/角色',
      });
    }
  }
  const { active, growth } = petOf(pets);
  if (growth) {
    const lv = num(growth.pet?.level, 1);
    // 粗估到 Lv51 的累计经验（Lv33 时实测剩余约 110M；曲线随等级加速）
    const expTo51 = Math.max(30 * M, 244_500_000 * (1 - Math.pow(Math.max(0, lv - 1) / 50, 1.7)));
    out.push({
      id: 'level_growth_pet',
      name: `培养二代宠（${growth.speciesName || '珍兽'} ${growth.pet?.form || ''} Lv${lv}→51）`,
      deltaCP: 3000,
      cost: { exp: expTo51, timeMin: 1 },
      cpPerExp: 3000 / (expTo51 / M),
      confidence: 'medium',
      available: true,
      note: `低等级边际远高于满级宠：14:02 实测 137.7M 经验 → +7,320 CP（53 CP/M）。预计还需 ${(expTo51 / M).toFixed(0)}M 到 Lv51，届时 auto-summon 出战（目标反超乌龟 ${active?.combatPower || '?'} CP）`,
    });
  }
  if (active) {
    const need = expNeedToLevel(active);
    const cpLevel = DEFAULT_ROI.petCpPerLevel;
    out.push({
      id: 'feed_pet', name: `喂出战珍兽（${active.speciesName || active.pet?.name || '珍兽'} Lv${active.pet?.level}）`,
      deltaCP: need ? cpLevel : null,
      cost: { exp: need, timeMin: 1 }, need,
      cpPerExp: need ? cpLevel / (need / M) : null,
      confidence: need ? 'medium' : 'low',
      available: !!need,
      note: need ? `下一级需 ${(need / M).toFixed(1)}M 经验，约 +${cpLevel} 战力` : '经验已够升级/无可喂珍兽',
    });
  }
  if (role?.level && levelTmpl?.upgradeExp) {
    out.push({
      id: 'level_role', name: `角色升 ${role.level + 1} 级`,
      deltaCP: DEFAULT_ROI.roleCpPerLevel,
      // 经验是累计的：只算「距离下一级还差多少」，已攒的部分不重复计价
      cost: { exp: Math.max(1, levelTmpl.upgradeExp - num(role.exp)), timeMin: 0 },
      cpPerExp: DEFAULT_ROI.roleCpPerLevel / (Math.max(1, levelTmpl.upgradeExp - num(role.exp)) / M),
      confidence: 'low',
      // 用户判定：56 已是最高装备需求等级，升 57 不再带来装备收益，不优先
      available: false,
      note: `还差 ${((levelTmpl.upgradeExp - num(role.exp)) / M).toFixed(1)}M 经验（升级后自动结算）；等级基础属性增量未实测`,
    });
  }
  for (const s of skills || []) {
    const cost = s.nextExp ?? s.nextLevelExp;
    if (!cost) continue;
    out.push({
      id: `skill_${s.id ?? s.skillId}`, name: `技能 ${s.name} 升级`,
      deltaCP: DEFAULT_ROI.skillCpPerLevel,
      cost: { exp: cost, timeMin: 1 },
      cpPerExp: DEFAULT_ROI.skillCpPerLevel / (cost / M),
      confidence: 'low',
      available: num(role?.exp) >= cost,
      note: `需 ${(cost / M).toFixed(0)}M 经验；主动技能对战力的贡献很小`,
    });
  }
  if (smelt?.itemId) {
    out.push({
      id: 'smelt_star', name: `武器升星（${smelt.progressPct?.toFixed?.(1) ?? '?'}%）`,
      deltaCP: DEFAULT_ROI.smeltCpPerStar,
      cost: { exp: 880 * M, timeMin: 1 },
      cpPerExp: DEFAULT_ROI.smeltCpPerStar / 880,
      confidence: 'low',
      // 只有经验严重溢出（≥880M）才考虑；TL_SMELT_BUDGET=0 时也不会执行
      available: num(role?.exp) >= 880 * M,
      note: '880M 经验/星；除非经验严重溢出，否则不投',
    });
  }
  return out.sort((a, b) => (b.cpPerExp || 0) - (a.cpPerExp || 0));
}

function oneOffActions(ctx) {
  const out = [];
  const { pets, bagItems, breed, tower, auction, role } = ctx;
  const { list, active } = petOf(pets);
  const activeId = pets?.activePetId || active?.pet?.id;
  const eggs = (bagItems || []).filter(b => /珍兽蛋/.test(b.itemTmpl?.name || ''));
  const eggCount = eggs.reduce((a, b) => a + num(b.count, 1), 0);
  const freeSlots = Math.max(0, num(pets?.capacity, 6) - num(pets?.reserved) - list.length);
  const waiting = list.filter(p => p.pet?.status === 'WAITING');

  // 繁殖领取
  const due = breed?.depositAt ? Math.max(0, 55 * 60 * 1000 - (Date.now() - breed.depositAt)) : null;
  if (waiting.length || breed?.depositAt) {
    out.push({
      id: 'breed_claim', name: '珍兽繁殖领取 + 孵化（未来资产）',
      deltaCP: 0,
      futureCP: +(DEFAULT_ROI.mutantGain * DEFAULT_ROI.mutantChanceBreed).toFixed(0),
      levelingExp: 244_500_000,
      cost: { timeMin: 6, slots: 1 }, confidence: 'low',
      available: !due,
      waitSec: due ? Math.round(due / 1000) : 0,
      cpPerHour: 0,
      note: `1h/次；新宠 Lv1，须再投约 244.5M 经验练到 Lv51 才兑现约 +${DEFAULT_ROI.mutantGain}（MUTANT 概率未实测）。免费选项，照领但不计入即时 CP/h`,
    });
  }

  // 孵蛋
  if (eggCount > 0) {
    const eggFuture = DEFAULT_ROI.eggCp * (1 - DEFAULT_ROI.mutantChanceEgg) + DEFAULT_ROI.mutantGain * DEFAULT_ROI.mutantChanceEgg;
    out.push({
      id: 'hatch_egg', name: `孵珍兽蛋 ×${Math.min(eggCount, Math.max(1, freeSlots))}（未来资产）`,
      deltaCP: 0,
      futureCP: +eggFuture.toFixed(0),
      levelingExp: 244_500_000,
      cost: { timeMin: 1, slots: 1 }, confidence: 'low',
      available: eggCount > 0,
      stock: eggCount, freeSlots,
      stockEV: +(eggFuture * eggCount).toFixed(0),
      note: `库存 ${eggCount} 个；新宠 Lv1，须练级才兑现。用于赌 MUTANT 长期资产，不计入即时 CP/h`,
    });
  }

  // 强化（有多少精华就能强化几次；无精华则不可用）
  const essences = (bagItems || []).filter(b => b.itemId === 5051 || /高级强化精华/.test(b.itemTmpl?.name || ''));
  const essenceCount = essences.reduce((a, b) => a + num(b.count, 1), 0);
  if (essenceCount > 0) {
    out.push({
      id: 'enhance_weapon', name: `强化武器 ×${Math.min(essenceCount, 3)}`,
      deltaCP: DEFAULT_ROI.essenceCp * Math.min(essenceCount, 3),
      cost: { essence: Math.min(essenceCount, 3), gold: 0, timeMin: 1 },
      confidence: 'high', available: true,
      note: `高级强化精华 ${essenceCount} 个；只乘基础属性，q4 武器每级约 +629~944`,
    });
  }

  // 塔（金币门槛 + 新层封印）
  if (tower) {
    const fee = num(tower.entryFee);
    const canEnter = num(role?.gold) >= fee;
    const sealsPerRun = num(tower.lastSettlement?.firstSeals, 6) || 6;
    const nextSeals = sealsPerRun * DEFAULT_ROI.essenceCp / 100;
    out.push({
      id: 'tower_run', name: `无相浮屠（最高 ${tower.highestFloor} 层）`,
      deltaCP: nextSeals,
      cost: { gold: fee, timeMin: 8 }, confidence: 'low',
      available: canEnter,
      waitGold: canEnter ? 0 : fee - num(role?.gold),
      cpPerGold: fee > 0 ? nextSeals / fee : null,
      cpPerHour: canEnter ? +(nextSeals / (8 / 60)).toFixed(1) : null,
      note: `门票 ${(fee / M).toFixed(1)}M 金币；封印 ${tower.balances?.seals ?? '?'}/100（每趟约 +${sealsPerRun}），10 层解锁精华`,
    });
  }

  // 拍卖行（只在有候选时给出）
  if (auction?.items?.length) {
    out.push({
      id: 'auction_scan', name: `拍卖行扫货（${auction.items.length} 件）`,
      deltaCP: 0, cost: { timeMin: 1, gold: 0 }, confidence: 'low',
      available: true,
      note: '需逐件官方评分后才能定价；planner 不猜',
    });
  }

  // 免费换装（官方评分）
  out.push({
    id: 'gear_swap', name: '官方评分换装（免费）',
    deltaCP: 0, cost: { timeMin: 3 }, confidence: 'high', available: true,
    cpPerHour: 0,
    note: '库存里若有更高分同槽装备，maintain/gear 会自动换；这是零成本动作',
  });

  return out;
}

function resourceBudget(ctx) {
  const expRate = num(ctx.rates?.xpPerHour, 60 * M);
  const goldRate = num(ctx.rates?.goldPerHour, 253_000);
  return {
    expNow: num(ctx.role?.exp),
    expPerHour: expRate,
    goldNow: num(ctx.role?.gold),
    goldPerHour: goldRate,
    yuanbao: num(ctx.role?.yuanbao),
    yuanbaoPolicy: 'zero-spend（用户 2026-11-16 明确：不花元宝）',
    seals: num(ctx.tower?.balances?.seals),
    slots: Math.max(0, num(ctx.pets?.capacity, 6) - num(ctx.pets?.reserved) - (petOf(ctx.pets).list.length)),
    horizonHours: 1,
  };
}

// 多资源背包启发式：一个动作的「约束份额」= 它在各项预算里占的最大比例；
// 优先级 = ΔCP / 份额。份额>1 表示一小时内做不完，需要跨小时累积。
function priorityOf(a, budget) {
  const c = a.cost || {};
  if (num(c.yuanbao) > 0) return { priority: 0, share: Infinity, binding: 'yuanbao(禁用)' };
  const shares = [];
  if (num(c.exp) > 0) shares.push([num(c.exp) / Math.max(1, budget.expPerHour), 'exp']);
  if (num(c.gold) > 0) shares.push([num(c.gold) / Math.max(1, budget.goldPerHour), 'gold']);
  if (num(c.timeMin) > 0) shares.push([num(c.timeMin) / 60, 'time']);
  if (num(c.slots) > 0) shares.push([num(c.slots) / Math.max(1, budget.slots), 'slots']);
  if (!shares.length) return { priority: 0, share: 0, binding: 'free' };
  shares.sort((x, y) => y[0] - x[0]);
  const [share, binding] = shares[0];
  if (!Number.isFinite(share) || share <= 0) return { priority: 0, share: Infinity, binding };
  return { priority: +((a.deltaCP || 0) / share).toFixed(1), share: +share.toFixed(2), binding };
}

export function buildPlan(ctx) {
  const exp = expActions(ctx);
  const once = oneOffActions(ctx);
  const budget = resourceBudget(ctx);
  const expRate = budget.expPerHour;

  // 经验的最优去向：按 cpPerExp 排序后，把每小时经验分配给第一项
  const bestExp = exp.find(a => a.available && a.cpPerExp > 0) || exp[0] || null;
  const expCpPerHour = bestExp?.cpPerExp ? bestExp.cpPerExp * (expRate / M) : 0;

  // 一次性动作：按资源份额优先级排序（ΔCP / max(各资源占预算比例)）
  for (const a of once) {
    const p = priorityOf(a, { ...budget, slots: Math.max(1, budget.slots) });
    a.priority = a.available ? p.priority : 0;
    a.binding = p.binding;
  }
  once.sort((a, b) => (b.priority || 0) - (a.priority || 0) || (b.deltaCP || 0) - (a.deltaCP || 0));

  const breed = once.find(a => a.id === 'breed_claim');
  const breedCpPerHour = breed && breed.available ? +(breed.cpPerHour || 0) : 0;
  const stableCpPerHour = expCpPerHour + breedCpPerHour;
  const stockEV = once.filter(a => a.id === 'hatch_egg').reduce((s, a) => s + (a.stockEV || 0), 0);

  return {
    at: new Date().toISOString(),
    budget,
    expAllocation: bestExp ? { action: bestExp.id, name: bestExp.name, cpPerHour: +expCpPerHour.toFixed(2), cpPerMexp: +(bestExp.cpPerExp || 0).toFixed(3), expPerHour: +(expRate / M).toFixed(1) } : null,
    expActions: exp.map(a => {
      const p = priorityOf(a, budget);
      return { ...a, cpPerHour: a.cpPerExp ? +(a.cpPerExp * (expRate / M)).toFixed(2) : null, priority: a.available ? p.priority : 0, binding: p.binding };
    }),
    oneOffActions: once.map(a => ({ ...a, deltaCP: +(a.deltaCP || 0).toFixed(0) })),
    plan: [...once.filter(a => a.available), ...exp.map(a => ({ ...a, priority: priorityOf(a, budget).priority })).filter(a => a.available)]
      .sort((a, b) => (b.priority || 0) - (a.priority || 0)).slice(0, 5)
      .map(a => ({ id: a.id, name: a.name, deltaCP: a.deltaCP, priority: a.priority, binding: a.binding })),
    summary: {
      stableCpPerHour: +stableCpPerHour.toFixed(1),
      expCpPerHour: +expCpPerHour.toFixed(1),
      breedCpPerHour,
      oneOffStockEV: stockEV,
      forecastCpPerHour: +stableCpPerHour.toFixed(1),
      note: 'stable = 经验稳定转化 + 到点的繁殖 EV；孵蛋/换装/塔是大额一次性（看 stockEV/deltaCP），不要当稳定速率；繁殖概率未实测',
    },
    dataGaps: [
      'role 57 级真实 ΔCP（需 levelTmpl 57 / 实测）',
      'pet 每级真实 ΔCP（当前 Lv51，喂满一级约 5.3h 后可实测）',
      '孵蛋/繁殖 MUTANT 概率（建议各做 5-10 次统计）',
      '玄武岛高级强化精华掉率（live_drops 按地图归属已修）',
      '拍卖行成交价→ΔCP 的换算（需官方评分批量扫描）',
    ],
    roi: DEFAULT_ROI,
  };
}

// 从引擎状态组装 ctx（只读；tower/pets 需要 WS 查询，调用方决定是否 live）
export async function collectCtx(engine, { live = false } = {}) {
  const { state } = engine;
  const g = state.game || {};
  const st = state.store?.st || {};
  const petsCached = st.pets || null;
  let pets = state.petCache || petsCached;
  let tower = state.towerCache || null;
  if (live) {
    try { pets = (await state.strategy?.petState?.()) || pets; state.petCache = pets; } catch { }
    try {
      const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const r = await state.ws.req('TRIAL_COMMAND', { action: 'status', requestId }, { ms: 9000 });
      tower = r?.data?.trial || tower;
      state.towerCache = tower;
    } catch { }
  }
  const lts = Array.isArray(g.levelTmpls) ? g.levelTmpls : [];
  const levelTmpl = lts.find(x => x.level === (g.role?.level ?? 0) + 1) || lts.find(x => x.level === g.role?.level) || { upgradeExp: 162_829_440 };
  const r = g.role || {};
  const role = {
    id: r.id, name: r.name, level: r.level, exp: r.currentExp ?? r.exp,
    gold: r.money ?? r.gold, yuanbao: r.yuanbao ?? r.goldIngot,
    power: r.combatPower, mapId: r.mapId,
    smeltingItemId: r.smeltingItemId, smeltingExp: r.smeltingExp,
    smeltingTargetExp: r.smeltingTargetExp,
  };
  const skills = (g.skillDetail || g.skills || []).map(s => ({
    id: s.skillId ?? s.skillDetail?.id, name: s.skillDetail?.name || s.name,
    nextExp: (() => {
      try {
        const arr = JSON.parse(s.skillDetail?.expCost || s.expCost || '[]');
        return arr.find(x => x.skill_level === (s.currentLevel ?? s.level) + 1)?.exp ?? null;
      } catch { return null; }
    })(),
  }));
  return {
    role, pets, bagItems: g.bagItems || [], levelTmpl, skills,
    tower, rates: st.rates,
    smelt: role.smeltingItemId ? {
      itemId: role.smeltingItemId, progressPct: 100 * num(role.smeltingExp) / Math.max(1, num(role.smeltingTargetExp)),
    } : null,
    breed: state.strategy?.state || null,
    auction: state.auctionCache || null,
  };
}
