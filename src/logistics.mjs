// src/logistics.mjs —— 鉴定 / 清仓 / 配装 / 商城 / 喂珍兽（PRD §2）
//
// 铁律：
//   · 所有写操作先过 core/redlines.mjs 的 assertSafe()，不通过直接拒绝
//   · dryRun=true 时只出报告，不发任何写包
//   · .halt 存在时立即停止主动发包
//   · 只使用宿主的唯一 ws，不新建连接

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { itemValue, analyzeSets, bestLoadout, suggestPrice } from '../core/lib-value.mjs';
import { computePower } from '../core/lib-power.mjs';
import { assertSafe, safeSnapshot, RedlineError } from '../core/redlines.mjs';
import { goMap, isHalted, sleep } from './combat-daemon.mjs';
import { recordSample, predictEquipDelta } from './verifier.mjs';
import { resolveTarget as resolveTargetImpl } from './resolver.mjs';
import { bestInSlot, clearCache as clearEvalCache } from './evaluate.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SNAP_DIR = path.join(process.env.TL_DATA_DIR ? path.resolve(process.env.TL_DATA_DIR) : path.join(ROOT, 'data'), 'equip-snapshots');
const LUOYANG = 4;
const SUZHOU = 5;
const MAP_XUANWU = 20080;

const eqFlag = x => !!(x?.isEquipped);
const qty = (bag, id) => (bag || []).filter(b => b.itemId === id).reduce((a, b) => a + (b.count || 0), 0);
const byName = (bag, re) => (bag || []).filter(b => re.test(b.itemTmpl?.name || ''));

// 递归目标解析：Pi 说「凑齐某套 / 某件 / 某材料」→ 直接给背包/仓库差多少、去哪张图刷哪个怪
export function resolveTarget(target, game, opts = {}) {
  return resolveTargetImpl(target, game, opts);
}

export function createLogistics(ws, store, { log = () => { }, stage = 0, allowWrite = false } = {}) {
  const canWrite = () => allowWrite && stage >= 2 && !isHalted();
  // 珍兽投喂熔断：投喂被证明不涨级后，不再每轮烧 5M 经验（经验优先给技能升级）
  let petFeedNoGain = 0;
  let petFeedDisabled = false;
  // 官方评分本轮判过的槽位（供 equipBest 跳过，避免两套模型互相推翻）
  let evalHandledSlots = new Set();
  const report = { at: new Date().toISOString(), stage, dryRun: !canWrite(), actions: [], blocked: [], errors: [], before: null, after: null };

  const note = (msg, extra = {}) => { report.actions.push({ at: new Date().toISOString().slice(11, 19), msg, ...extra }); log(msg); };
  const block = (msg, e) => {
    const row = { msg, code: e?.code || null, reason: e?.message || String(e) };
    report.blocked.push(row);
    log('⛔', msg, row.reason);
  };

  // 发包前统一入口：红线 + halt + stage 闸门
  async function guarded(req, fn) {
    if (isHalted()) throw new Error('halt：已停止主动发包');
    if (!canWrite()) {
      report.actions.push({
        at: new Date().toISOString().slice(11, 19),
        msg: `DRY_RUN ${req.action}`, dryRun: true,
        op: req.op || req.action, itemId: req.itemId ?? null,
      });
      return { skipped: true, reason: 'DRY_RUN/阶段未到' };
    }
    try {
      assertSafe(req);
    } catch (e) {
      if (e instanceof RedlineError) { block(req.action, e); return { blocked: true, code: e.code }; }
      throw e;
    }
    return fn();
  }

  // 2026-11-16 修：ENTER_GAME 偶发扑空（会话刚重建 / 战斗刚停仍有残留包在途），
  // 单次失败就让整个 maintain 空转（actions=0, power=?）。改成重试 + 退避。
  const refresh = async () => {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await new Promise(r => setTimeout(r, 800 * attempt));
        const g = await ws.req('ENTER_GAME', {}, { ms: attempt === 0 ? 9000 : 14000, revision: false });
        const data = g?.data;
        if (data?.role) { store?.ingest?.(data); return data; }
        // 有 data 但无 role：可能是会话还在注册，稍后重试
        if (data) store?.ingest?.(data);
        lastErr = new Error(data ? 'ENTER_GAME 无 role' : 'ENTER_GAME 无响应');
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('ENTER_GAME 失败');
  };

  const snapshotEquipped = (g, tag) => {
    const snap = safeSnapshot({ ...g, role: g?.role, equipments: g?.equipments || [] });
    try {
      fs.mkdirSync(SNAP_DIR, { recursive: true });
      fs.writeFileSync(path.join(SNAP_DIR, `${tag}-${Date.now()}.json`), JSON.stringify(snap, null, 1));
    } catch { }
    return snap;
  };

  // ── 1. 补药 + 喝药设置 ─────────────────────────────────────
  async function potions(g) {
    const bag = g.bagItems || [];
    const hpN = qty(bag, 6), mpN = qty(bag, 12);
    const money = g.role?.money || 0;
    if (hpN < 300) {
      const r = await guarded(
        { action: 'SHOP_BUY', op: 'SHOP_BUY', goldCost: 0, money, currency: 'gold' },
        () => ws.req('SHOP_BUY', { shopItemId: 6, count: 600 }, { ms: 6000 }),
      );
      if (r?.success) note(`补红药 首乌丹 600（原 ${hpN}）`);
      else if (!r?.skipped && !r?.blocked) report.errors.push('SHOP_BUY 红药失败: ' + (r?.message || ''));
    }
    if (mpN < 200) {
      const r = await guarded(
        { action: 'SHOP_BUY', op: 'SHOP_BUY', goldCost: 0, money, currency: 'gold' },
        () => ws.req('SHOP_BUY', { shopItemId: 5, count: 600 }, { ms: 6000 }),
      );
      if (r?.success) note(`补蓝药 参心丹 600（原 ${mpN}）`);
      else if (!r?.skipped && !r?.blocked) report.errors.push('SHOP_BUY 蓝药失败: ' + (r?.message || ''));
    }

    // 自动喝药（priority 必须是 6 元素数组）
    try {
      const cur = JSON.parse(g.role?.settings || '{}');
      const want = {
        ...cur,
        hp: { enabled: true, threshold: 70, priority: [0, 0, 0, 0, 0, 6] },
        mp: { enabled: true, threshold: 60, priority: [0, 0, 0, 0, 0, 12] },
      };
      if (JSON.stringify(want) !== JSON.stringify(cur)) {
        const r = await guarded(
          { action: 'UPDATE_SETTINGS', op: 'UPDATE_SETTINGS' },
          () => ws.req('UPDATE_SETTINGS', { settings: JSON.stringify(want) }, { ms: 6000 }),
        );
        if (r?.success) note('喝药设置已更新（首乌丹/琼丹）');
      }
    } catch { }
  }

  // ── 2. 清仓：存仓 → 挂售 → 直卖（每槽前 2 强永不卖）─────────
  async function cleanup(g) {
    const eqs = g.equipments || [];
    const iv = x => itemValue(x, { gemInfo: g.gemInfo });
    if (eqs.length <= 50) return;

    const setIds = new Set();
    for (const s of g.equipSets || []) {
      try { JSON.parse(s.equipTmplIds || '[]').forEach(id => setIds.add(id)); } catch { }
    }
    const bestBySlot = {};
    for (const e of eqs) {
      const sl = e.equipTmpl?.slotType;
      if (!sl) continue;
      bestBySlot[sl] = Math.max(bestBySlot[sl] || 0, iv(e));
    }

    // ★ 双模型保护：itemValue 前 2 强 + 真实战力前 2 强，都不卖
    //   itemValue 与战力公式权重不同，曾把「战力更高但价值分更低」的腰带/护符卖掉。
    let powerTopIds = new Set();
    try {
      const base = { ...g, equipments: eqs.map(x => ({ ...x, isEquipped: false })) };
      const p0 = computePower(base).power ?? 0;
      const powerOf = new Map();
      for (const e of eqs) {
        const d = { ...base, equipments: eqs.map(x => ({ ...x, isEquipped: x.id === e.id })) };
        powerOf.set(e.id, (computePower(d).power ?? 0) - p0);
      }
      const bySlotPower = {};
      for (const e of eqs) { const sl = e.equipTmpl?.slotType; if (sl) (bySlotPower[sl] ||= []).push(e); }
      for (const arr of Object.values(bySlotPower)) {
        arr.slice().sort((a, b) => (powerOf.get(b.id) || 0) - (powerOf.get(a.id) || 0))
          .slice(0, 2).forEach(e => powerTopIds.add(e.id));
      }
    } catch { }

    // 紫以上套装件 / 高分件 / 战力前 2 强 → 存仓（白蓝普通件不存）
    const keepStrong = eqs.filter(x => {
      if (eqFlag(x)) return false;
      if (powerTopIds.has(x.id)) return true;
      if (Number(x.quality ?? 1) <= 2) return false;
      if (setIds.has(x.tmplId)) return true;
      const sl = x.equipTmpl?.slotType;
      return sl && bestBySlot[sl] && iv(x) >= bestBySlot[sl] * 0.7;
    }).sort((a, b) => iv(b) - iv(a)).slice(0, 6);

    for (const x of keepStrong) {
      const r = await guarded(
        { action: 'WAREHOUSE_DEPOSIT', op: 'WAREHOUSE_DEPOSIT', itemId: x.id, item: x, owned: eqs },
        () => ws.req('WAREHOUSE_DEPOSIT', { roleEquipId: x.id, count: 1 }, { ms: 5000 }),
      );
      if (r?.success) note(`存仓 ${x.equipTmpl?.name}（价值 ${Math.round(iv(x))}）`);
      await sleep(200);
    }

    // 同槽前 2 强（保险，redlines 里还会再判一次）
    const topIds = new Set();
    const grouped = {};
    for (const e of eqs) {
      const sl = e.equipTmpl?.slotType;
      if (!sl) continue;
      (grouped[sl] ||= []).push(e);
    }
    for (const arr of Object.values(grouped)) {
      arr.slice().sort((a, b) => iv(b) - iv(a)).slice(0, 2).forEach(e => topIds.add(e.id));
    }

    const bestOfTmpl = new Map();
    for (const e of eqs) {
      if (eqFlag(e)) continue;
      const cur = bestOfTmpl.get(e.tmplId);
      const v = iv(e);
      if (!cur || v > cur.value) bestOfTmpl.set(e.tmplId, { id: e.id, value: v });
    }

    const junk = eqs.filter(x => {
      if (eqFlag(x)) return false;
      if (topIds.has(x.id)) return false;
      if (powerTopIds.has(x.id)) return false;   // 真实战力前 2 强也不卖
      const q = Number(x.quality ?? 1);
      if (q <= 2) return true;
      const bestSame = bestOfTmpl.get(x.tmplId);
      if (bestSame && bestSame.id !== x.id) return true;
      if (setIds.has(x.tmplId)) return false;
      const sl = x.equipTmpl?.slotType;
      if (sl && bestBySlot[sl] && iv(x) >= bestBySlot[sl] * 0.7) return false;
      return true;
    }).sort((a, b) => {
      const qa = Number(a.quality ?? 1), qb = Number(b.quality ?? 1);
      return qa !== qb ? qa - qb : iv(a) - iv(b);
    });

    const mine = await ws.req('CONSIGNMENT_RECORD_LIST', { page: 1, size: 50, type: 'SELL' }, { ms: 5000 });
    const onSale = (mine?.data?.items || mine?.data?.records || []).length;
    const need = Math.max(0, eqs.length - 50);
    const toSell = junk.slice(0, Math.min(need + 5, 20));
    const isBound = x => x.isBound === 1 || x.isBound === true;
    const slotsLeft = Math.max(0, 10 - onSale);
    const free = toSell.filter(x => !isBound(x)).sort((a, b) => iv(b) - iv(a));
    const toConsign = free.slice(0, slotsLeft);
    const toDirect = [...toSell.filter(isBound), ...free.slice(slotsLeft)];

    note(`装备库 ${eqs.length} | 在售 ${onSale}/10 | 存仓 ${keepStrong.length} | 待卖 ${toSell.length}`);

    for (const x of toDirect) {
      const r = await guarded(
        { action: 'SHOP_SELL', op: 'SHOP_SELL', itemId: x.id, item: x, owned: eqs, dryRun: false, confirmed: true },
        () => ws.req('SHOP_SELL', { roleEquipId: x.id, count: 1 }, { ms: 5000 }),
      );
      if (r?.success) note(`直卖 ${x.equipTmpl?.name}`);
      await sleep(150);
    }
    for (const x of toConsign) {
      const price = suggestPrice(x, { gemInfo: g.gemInfo });
      const r = await guarded(
        {
          action: 'CONSIGNMENT_CREATE', op: 'CONSIGNMENT_CREATE', itemId: x.id, item: x, owned: eqs,
          goldCost: 0, money: g.role?.money || 0, currency: 'gold',
        },
        () => ws.req('CONSIGNMENT_CREATE', { roleEquipId: x.id, count: 1, price, currency: 1, targetNickname: null }, { ms: 6000 }),
      );
      if (r?.success) note(`挂售 ${x.equipTmpl?.name} ${price}金`);
      else if (/最多同时上架/.test(r?.message || '')) {
        const r2 = await guarded(
          { action: 'SHOP_SELL', op: 'SHOP_SELL', itemId: x.id, item: x, owned: eqs, dryRun: false, confirmed: true },
          () => ws.req('SHOP_SELL', { roleEquipId: x.id, count: 1 }, { ms: 5000 }),
        );
        if (r2?.success) note(`直卖 ${x.equipTmpl?.name}（挂售位满）`);
      }
      await sleep(200);
    }
  }

  // ── 2.5 官方评分换装（EQUIPMENT_EVALUATE，权威）──────────────
  //
  // 2026-11-16 起，换装决策以服务端评分为准，不再用自建的 lib-value 权重。
  // 原因：verifier 里 3 个换装样本错了 2 个
  //   （预测 +439 实测 -55、预测 +165 实测 -408），absMean 误差 338 战力。
  // lib-value 降级为预筛选 / 定价 / 降级方案。
  //
  // 官方评分的额外好处：能处理「同槽多件」的槽位（戒指/饰品）。
  // 老逻辑遇到同槽多件直接跳过，现在可以在同一基准下比出哪件最优。
  async function equipByEvaluation(game) {
    let changed = 0;
    // 官方评分处理过的槽位：交给 equipBest 跳过，避免两套模型互相推翻
    const handledSlots = new Set();
    let g = game;

    const slotsOf = gg => [...new Set((gg.equipments || []).map(e => e.equipTmpl?.slotType).filter(x => x != null))]
      .sort((a, b) => a - b);

    // 2026-11-16 修：原实现把 slots / eqs 在循环外算死，换完第一件后
    // g 已经换成新快照，但循环还在用旧的 eqs → 同一个槽位被重复评估、
    // 甚至把刚换上去的又换下来。现在每个槽位都从当前 g 重新取数据。
    for (const slot of slotsOf(g)) {
      if (isHalted()) break;
      const eqs = g.equipments || [];
      const cands = eqs.filter(e => e.equipTmpl?.slotType === slot && e.evaluationToken);
      if (cands.length < 2) continue;

      let r;
      try {
        r = await bestInSlot(ws, g, slot);
      } catch (e) {
        report.errors.push(`evaluate slot${slot}: ${e?.message || e}`);
        continue;
      }
      // 官方已经对这个槽位给出结论（不管换不换），lib-value 都不该再插手
      handledSlots.add(slot);
      if (!r.shouldSwap) continue;

      const target = r.best.item;
      const before = g.role?.combatPower ?? 0;
      const snap = snapshotEquipped(g, `eval-slot${slot}`);

      const res = await guarded(
        { action: 'EQUIP_ITEM', op: 'EQUIP_ITEM', unequip: true, snapshot: snap, itemId: target.id, item: target, owned: eqs },
        () => ws.req('EQUIP_ITEM', { roleEquipId: target.id }, { ms: 8000 }),
      );

      if (!res?.success) continue;
      changed++;
      note(`官方评分换装 slot${slot} ${r.equippedNow?.equipTmpl?.name || '空'} → ${target.equipTmpl?.name}（伤害${(r.best.raw.damagePct || 0).toFixed(2)}% 综合+${r.best.score.toFixed(2)}）`);

      // 复核真实战力；战力明显下降就回滚
      try {
        const g2 = await refresh();
        const after = g2?.role?.combatPower ?? before;
        recordSample({
          action: 'EQUIP_ITEM_EVAL', predicted: Math.round(r.best.score * 100), measured: after - before,
          beforePower: before, afterPower: after,
          detail: { slot, from: r.equippedNow?.equipTmpl?.name, to: target.equipTmpl?.name, evalScore: r.best.score, damagePct: r.best.raw.damagePct },
        });
        if (after < before - 200) {
          note(`⚠️ 换装后战力下降 ${before} → ${after}，尝试回滚`);
          if (r.equippedNow) {
            const rb = await guarded(
              { action: 'EQUIP_ITEM', op: 'EQUIP_ITEM_ROLLBACK', unequip: true, itemId: r.equippedNow.id, item: r.equippedNow, owned: g2?.equipments || eqs },
              () => ws.req('EQUIP_ITEM', { roleEquipId: r.equippedNow.id }, { ms: 8000 }),
            ).catch(() => null);
            if (rb?.success) {
              changed--;
              note(`↩️ 已回滚 slot${slot} 到 ${r.equippedNow.equipTmpl?.name}`);
              const g3 = await refresh().catch(() => null);
              if (g3) g = g3;
            } else {
              note(`❌ slot${slot} 回滚失败，需人工处理`);
            }
          }
        } else if (g2) {
          g = g2;
        }
      } catch { }
      // 换装后基准变了，评分缓存必须作废
      clearEvalCache();
    }
    return { changed, handledSlots, game: g };
  }

  // ── 3. 配装：装备价值 + 真实战力双模型（实际战力只增不减）────
  async function equipBest(g, skipSlots = new Set()) {
    const plan = bestLoadout(g.equipments || [], g.equipSets || [], false, { minGain: 400, maxSteps: 4, gemInfo: g.gemInfo });
    let changed = 0;
    const rejected = new Set();   // 本次维护内已证明「换上去战力反而降」的候选

    // 同一 slotType 可能有多件同时穿戴（戒指/饰品）→ 自动换装无法确定替换哪一件，
    // 强行换会丢装备。这类槽位一律跳过，交给人工/工具显式处理。
    const equippedBySlot = {};
    for (const e of (g.equipments || []).filter(x => x.isEquipped)) {
      const sl = e.equipTmpl?.slotType;
      if (sl != null) equippedBySlot[sl] = (equippedBySlot[sl] || 0) + 1;
    }
    const unsafeSlots = new Set(Object.entries(equippedBySlot).filter(([, n]) => n > 1).map(([sl]) => Number(sl)));
    if (unsafeSlots.size) note(`跳过自动换装槽位 ${[...unsafeSlots].join(',')}（同槽多件，避免丢装备）`);

    // 换一件 → 立刻刷新真实战力 + 核对已穿戴 ID 集合；异常则完整回滚。
    const safeEquip = async (hit, why, { minPredicted = 150 } = {}) => {
      if (rejected.has(hit.id)) return false;
      const slot = hit.equipTmpl?.slotType;
      // 官方评分已经判过的槽位，不再用自建模型推翻
      if (skipSlots.has(slot)) return false;
      if (unsafeSlots.has(slot)) { note(`跳过 slot${slot} 自动换装（同槽多件）`); return false; }
      const old = (g.equipments || []).find(x => x.isEquipped && x.equipTmpl?.slotType === slot);
      if (old?.id === hit.id) return true;
      if (!old) { note(`跳过 slot${slot} 空槽自动换装（无回滚路径）`); return false; }
      const beforeIds = new Set((g.equipments || []).filter(x => x.isEquipped).map(x => x.id));
      const beforePower = g.role?.combatPower ?? 0;
      const pred = await predictEquipDelta(g, hit).catch(() => ({ predicted: 0 }));
      // 只做「战力模型明确有收益」的换装；小幅 itemValue 提升不值得冒掉战力的风险
      if ((pred.predicted ?? 0) < minPredicted) {
        rejected.add(hit.id);
        note(`跳过 ${hit.equipTmpl?.name}（战力模型预测 ${pred.predicted == null ? '未知' : (pred.predicted >= 0 ? '+' : '') + Math.round(pred.predicted)}，收益不足）`);
        return false;
      }
      const snap = snapshotEquipped(g, 'pre-equip');
      const r = await guarded(
        { action: 'EQUIP_ITEM', op: 'EQUIP_ITEM', unequip: true, snapshot: snap, itemId: hit.id, item: hit, owned: g.equipments || [] },
        () => ws.req('EQUIP_ITEM', { roleEquipId: hit.id }, { ms: 6000 }),
      );
      if (!r?.success) return false;
      await sleep(800);
      let g2 = await refresh();
      await sleep(300);
      g2 = await refresh();   // 二次读取，避免服务器 combatPower 尚未刷新导致误判
      if (!g2?.role) return true;
      const afterPower = g2.role.combatPower ?? 0;
      try {
        recordSample({
          action: 'EQUIP_ITEM', predicted: pred.predicted, measured: afterPower - beforePower,
          beforePower, afterPower, detail: { slot, from: old?.equipTmpl?.name || null, to: hit.equipTmpl?.name, why },
        });
      } catch { }

      const afterIds = new Set((g2.equipments || []).filter(x => x.isEquipped).map(x => x.id));
      const lost = [...beforeIds].filter(id => !afterIds.has(id) && id !== old.id);
      if (afterPower < beforePower || lost.length) {
        // 回滚：先把原装备换回去，再补回任何意外消失的已穿戴件
        const snap2 = snapshotEquipped(g2, 'rollback');
        let rr = null;
        if (!afterIds.has(old.id)) {
          rr = await guarded(
            { action: 'EQUIP_ITEM', op: 'EQUIP_ITEM', unequip: true, snapshot: snap2, itemId: old.id, item: old, owned: g2.equipments || [] },
            () => ws.req('EQUIP_ITEM', { roleEquipId: old.id }, { ms: 6000 }),
          );
        }
        for (const id of lost) {
          const item = (g2.equipments || []).find(x => x.id === id);
          if (item && !item.isEquipped) {
            await guarded(
              { action: 'EQUIP_ITEM', op: 'EQUIP_ITEM', unequip: true, snapshot: snap2, itemId: id, item, owned: g2.equipments || [] },
              () => ws.req('EQUIP_ITEM', { roleEquipId: id }, { ms: 6000 }),
            );
          }
        }
        await sleep(500);
        let g3 = await refresh();
        await sleep(300);
        g3 = await refresh();
        g = g3?.role ? g3 : g2;
        rejected.add(hit.id);
        const finalIds = new Set((g.equipments || []).filter(x => x.isEquipped).map(x => x.id));
        const stillLost = [...beforeIds].filter(id => !finalIds.has(id));
        const whyTxt = [
          afterPower < beforePower ? `战力 ${beforePower}→${afterPower}` : '',
          lost.length ? `丢失已穿戴 ${lost.join(',')}` : '',
        ].filter(Boolean).join('；');
        note(`↩ 回滚 ${hit.equipTmpl?.name}：${whyTxt}（${rr?.success ? '已换回 ' + (old.equipTmpl?.name || '') : '无需换回'}）`);
        if (stillLost.length) note(`⚠️ 回滚后仍缺失装备 ${stillLost.join(',')}，请人工检查`);
        return false;
      }

      g = g2;
      changed++;
      note(`换装 slot${slot} ${hit.equipTmpl?.name}（${why}，战力 ${beforePower}→${afterPower}）`);
      return true;
    };

    if (plan.steps.length) {
      note(`配装方案：${plan.steps.length} 处，总价值 ${Math.round(plan.value)}`);
      for (const step of plan.steps.slice(0, 3)) {
        const hit = (g.equipments || []).find(x => x.equipTmpl?.name === step.name && x.equipTmpl?.slotType === step.slot);
        if (hit) await safeEquip(hit, `价值 +${Math.round(step.gain)}`);
      }
    } else note(`配装已最优（总价值 ${Math.round(plan.value)}）`);

    // 真实战力模型校正（itemValue 权重 != 战力公式）；同样只保留实测提升的换装
    try {
      const eqs = g.equipments || [];
      const base = { ...g, equipments: eqs.map(x => ({ ...x, isEquipped: false })) };
      const p0 = computePower(base).power;
      const bySlot = {};
      for (const e of eqs) { const sl = e.equipTmpl?.slotType; if (sl) (bySlot[sl] ||= []).push(e); }
      for (const [sl, arr] of Object.entries(bySlot)) {
        if (unsafeSlots.has(Number(sl))) continue;
        const scored = arr.map(e => {
          const d = { ...base, equipments: eqs.map(x => ({ ...x, isEquipped: x.id === e.id })) };
          return { e, p: computePower(d).power - p0 };
        }).sort((a, b) => b.p - a.p);
        const best = scored[0];
        const cur = scored.find(x => x.e.isEquipped);
        if (best && !best.e.isEquipped && best.p > (cur?.p || 0) + 50) {
          await safeEquip(best.e, `战力模型 +${Math.round(best.p)}`, { minPredicted: 1 });
        }
      }
    } catch (e) { report.errors.push('战力配装: ' + (e?.message || e)); }

    return changed;
  }

  // ── 4. 商城：套装缺件优先，其次同槽高收益 ──────────────────
  async function shop(g) {
    const eqs = (g.equipments || []).filter(eqFlag);
    const iv = x => itemValue(x, { gemInfo: g.gemInfo });
    const sets = analyzeSets(eqs, g.equipSets || []);
    const owned = new Set(eqs.map(x => x.tmplId));
    const want = new Map();
    for (const s of sets) {
      if (s.have < 2 || s.allAtk <= 0 || s.have >= 4) continue;
      const missing = s.ids.filter(id => !owned.has(id));
      if (missing.length) want.set(s.name, { missing, pct: s.allAtk, have: s.have });
    }

    const list = await ws.req('CONSIGNMENT_LIST', { page: 1, size: 100 }, { ms: 8000 });
    const goods = (list?.data?.items || []).filter(x => x.itemType === 1 && x.equipTmpl);
    if (!goods.length) { note('商城无货'); return; }

    let picked = null;
    for (const [name, v] of want) {
      const hit = goods.find(x => v.missing.includes(x.tmplId));
      if (hit) { picked = { item: hit, why: `套装${name}缺件(+${v.pct}%)` }; break; }
    }
    if (!picked) {
      const curBySlot = {};
      for (const e of eqs) {
        const sl = e.equipTmpl?.slotType;
        if (sl) curBySlot[sl] = Math.max(curBySlot[sl] || 0, iv(e));
      }
      const cands = goods.map(x => {
        const sl = x.equipTmpl?.slotType;
        return { item: x, gain: iv(x) - (curBySlot[sl] || 0) };
      }).filter(x => x.gain > 200)
        .sort((a, b) => b.gain / Math.max(1, b.item.price) - a.gain / Math.max(1, a.item.price));
      if (cands.length) picked = { item: cands[0].item, why: `同槽 +${Math.round(cands[0].gain)}` };
    }
    if (!picked) { note('商城无可买目标'); return; }

    const price = picked.item.price;
    const money = g.role?.money || 0;
    if (money < price * 3) { note(`金币不足（${money} < ${price * 3}），放弃 ${picked.item.itemName}`); return; }
    const r = await guarded(
      { action: 'CONSIGNMENT_BUY', op: 'CONSIGNMENT_BUY', goldCost: price, money, currency: 'gold', itemId: picked.item.id, item: picked.item, owned: g.equipments || [] },
      () => ws.req('CONSIGNMENT_BUY', { consignmentId: picked.item.id }, { ms: 8000 }),
    );
    if (r?.success) note(`🛒 买入 ${picked.item.itemName || picked.item.equipTmpl?.name} ${picked.why} ${price}金`);
  }

  // ── 5. 鉴定（只对 req>=50 武器；不可逆 → dry-run 语义）───────
  async function appraise(g) {
    const iv = x => itemValue(x, { gemInfo: g.gemInfo });
    const pending = (g.equipments || []).filter(x =>
      !x.isAppraisal && x.equipTmpl?.slotType === 1 && (x.equipTmpl?.reqLevel || 0) >= 50);
    const worn = pending.filter(eqFlag).sort((a, b) => iv(b) - iv(a));
    const spare = pending.filter(x => !eqFlag(x)).sort((a, b) => iv(b) - iv(a));
    for (const x of [...worn, ...spare].slice(0, 2)) {
      const r = await guarded(
        { action: 'SMITHY_APPRAISAL', op: 'SMITHY_APPRAISAL', itemId: x.id, item: x, owned: g.equipments || [] },
        () => ws.req('SMITHY_APPRAISAL', { roleEquipId: x.id }, { ms: 6000 }),
      );
      if (r?.success) {
        let ap = {};
        try { ap = JSON.parse(r.data?.equipments?.find(e => e.id === x.id)?.appraisalStats || '[]'); } catch { }
        note(`鉴定 ${eqFlag(x) ? '[穿]' : ''}${x.equipTmpl?.name}${ap.extScore != null ? ` 双资质 ${ap.extScore}/${ap.intScore}` : ''}`);
      }
      await sleep(400);
    }
  }

  // ── 6. 镶嵌（有镶嵌符才做）─────────────────────────────────
  async function gems(g) {
    const charms = (g.bagItems || []).filter(b => b.itemId === 5053 || b.itemId === 5052);
    if (!charms.length) return;
    const ATK_SLOTS = [1, 6, 8, 7, 11, 12];
    const ATK_TYPES = ['希望宝石', '智慧宝石', '玄微宝石', '幻冥宝石'];
    const DEF_TYPES = ['生命宝石', '魅力宝石', '命运宝石', '天机宝石'];
    const W = { hp: .3, extAtk: 4, intAtk: 4, extDef: 3, intDef: 3, precision: 5, critRate: 5, critDef: 3, avoidance: 3, iceAtk: 2, fireAtk: 2, poisonAtk: 2, holyAtk: 2, iceDef: 1.5, fireDef: 1.5, poisonDef: 1.5, holyDef: 1.5 };
    const SUB = { 1: 'hp', 3: 'extAtk', 4: 'intAtk', 5: 'extDef', 6: 'intDef', 7: 'precision', 8: 'avoidance', 9: 'critRate', 11: 'iceAtk', 12: 'fireAtk', 13: 'poisonAtk', 14: 'holyAtk', 15: 'iceDef', 16: 'fireDef', 17: 'poisonDef', 18: 'holyDef' };
    const gemGain = b => { const t = b.itemTmpl || {}; const attr = SUB[t.subType]; return attr ? (W[attr] || 0) * (t.value || 0) : 0; };
    const stock = (g.bagItems || []).filter(b => b.itemId >= 4000 && b.itemId <= 4099 && gemGain(b) > 0)
      .sort((a, b) => gemGain(b) - gemGain(a)).map(b => ({ ...b, left: b.count || 1 }));
    const take = pool => {
      for (const s of stock) if (s.left > 0 && pool.includes(s.itemTmpl.gemType)) { s.left--; return s; }
      return null;
    };
    let bag = g.bagItems || [];
    let eqs = g.equipments || [];
    let used = 0;
    for (const eq of eqs.filter(eqFlag)) {
      let slots = [];
      try { slots = JSON.parse(eq.gemSlots || '[]'); } catch { }
      if (!Array.isArray(slots) || !slots.length) continue;
      const pool = ATK_SLOTS.includes(eq.equipTmpl?.slotType) ? ATK_TYPES : DEF_TYPES;
      for (let i = 0; i < slots.length; i++) {
        if (slots[i] !== 0) continue;
        const charm = bag.find(b => b.itemId === 5053) || bag.find(b => b.itemId === 5052);
        if (!charm) break;
        const gem = take(pool);
        if (!gem) break;
        const gemNow = bag.find(b => b.itemId === gem.itemId);
        if (!gemNow) break;
        const r = await guarded(
          { action: 'GEM_INLAY', op: 'GEM_INLAY', itemId: eq.id, item: eq, owned: eqs },
          () => ws.req('GEM_INLAY', { roleEquipId: eq.id, gemBagItemId: gemNow.id, charmBagItemId: charm.id }, { ms: 8000 }),
        );
        if (r?.success) { used++; note(`镶嵌 ${eq.equipTmpl?.name} ${gem.itemTmpl?.name}（+${Math.round(gemGain(gem))}）`); }
        else if (r?.message) note(`镶嵌失败 ${eq.equipTmpl?.name} ${r.message}`);
        if (r?.data?.bagItems) bag = r.data.bagItems;
        if (r?.data?.equipments) {
          eqs = r.data.equipments;
          const fresh = eqs.find(x => x.id === eq.id);
          if (fresh) { try { slots = JSON.parse(fresh.gemSlots || '[]'); } catch { } }
        }
        await sleep(200);
      }
    }
    if (used) note(`本轮镶嵌 ${used} 颗宝石`);
  }

  // ── 7. 珍兽：孵蛋 / 鉴定 / 出战 / 喂食 / 放生 / 繁殖 ─────────
  async function pets(g) {
    if (canWrite()) { ws.send('COMBAT_STOP'); await sleep(700); }

    // 双倍经验
    try {
      const st0 = await ws.req('WUSHUANG_STATUS', {}, { ms: 6000 });
      if ((st0?.data?.remainingSeconds || 0) <= 0) {
        const tl = byName(g.bagItems, /天灵丹/);
        if (tl.length) {
          const r = await guarded(
            { action: 'USE_ITEM', op: 'USE_ITEM', itemId: tl[0].id, item: tl[0], owned: g.equipments || [] },
            () => ws.req('USE_ITEM', { bagItemId: tl[0].id, count: 1 }, { ms: 6000 }),
          );
          if (r?.success) note('双倍已过期 → 吃天灵丹 ✓ 2 小时双倍');
        }
      }
    } catch { }

    // 孵蛋（USE_ITEM，不是 PET_COMMAND hatch）
    for (const egg of byName(g.bagItems, /珍兽蛋/)) {
      for (let i = 0; i < (egg.count || 1); i++) {
        const r = await guarded(
          { action: 'USE_ITEM', op: 'USE_ITEM', itemId: egg.id, item: egg, owned: g.equipments || [] },
          () => ws.req('USE_ITEM', { bagItemId: egg.id, count: 1, requestId: crypto.randomUUID() }, { ms: 8000 }),
        );
        if (!r?.success) break;
        note(`孵化 ${egg.itemTmpl?.name}`);
      }
    }

    const pr = await ws.req('PET_COMMAND', { action: 'list', requestId: crypto.randomUUID() }, { ms: 8000 });
    const ps = pr?.data?.state || {};
    const petsArr = ps.pets || [];
    const activeId = ps.activePetId;
    const topPet = [...petsArr].sort((a, b) => (b.combatPower || 0) - (a.combatPower || 0))[0];
    const mutant = petsArr.filter(p => p.pet.form === 'MUTANT').sort((a, b) => (b.combatPower || 0) - (a.combatPower || 0))[0];

    // 鉴定未鉴定
    for (const p of petsArr.filter(x => !x.pet.appraised).slice(0, 3)) {
      const r = await guarded(
        { action: 'PET_COMMAND', op: 'PET_APPRAISE', petId: p.pet.id, pet: p, pets: petsArr },
        () => ws.req('PET_COMMAND', { action: 'appraise', petId: p.pet.id, requestId: crypto.randomUUID() }, { ms: 8000 }),
      );
      if (r?.success) note(`鉴定珍兽 ${p.speciesName}`);
      await sleep(400);
    }

    // 栏位满 → 放生低资质（红线 R2 保护最高资质）
    const cap = ps.capacity || 6, reserved = ps.reserved || 0;
    if (petsArr.length >= cap - reserved) {
      const bestAvg = Math.max(...petsArr.map(p => p.average || 0));
      const junk = petsArr.filter(p =>
        p.pet.form !== 'MUTANT' && p.pet.status === 'OWNED' && p.pet.id !== activeId &&
        (p.average || 0) < Math.max(100, bestAvg - 2))
        .sort((a, b) => (a.average || 0) - (b.average || 0));
      if (junk.length) {
        const w = junk[0];
        if (w.pet.locked) {
          await guarded(
            { action: 'PET_COMMAND', op: 'PET_UNLOCK', petId: w.pet.id, pet: w, pets: petsArr },
            () => ws.req('PET_COMMAND', { action: 'lock', locked: false, petId: w.pet.id, requestId: crypto.randomUUID() }, { ms: 6000 }),
          );
        }
        const r = await guarded(
          { action: 'PET_COMMAND', op: 'PET_RELEASE', petId: w.pet.id, pet: w, pets: petsArr, dryRun: false, confirmed: true },
          () => ws.req('PET_COMMAND', { action: 'release', confirm: true, petId: w.pet.id, requestId: crypto.randomUUID() }, { ms: 8000 }),
        );
        if (r?.success) note(`放生低资质珍兽 ${w.speciesName} ${w.average}%`);
      }
    }

    // 出战战力最高的
    if (topPet && topPet.pet.id !== activeId) {
      const r = await guarded(
        { action: 'PET_COMMAND', op: 'PET_SUMMON', petId: topPet.pet.id, pet: topPet, pets: petsArr },
        () => ws.req('PET_COMMAND', { action: 'summon', petId: topPet.pet.id, requestId: crypto.randomUUID() }, { ms: 8000 }),
      );
      if (r?.success) note(`换出战珍兽 ${topPet.speciesName} Lv.${topPet.pet.level} 战力${topPet.combatPower}`);
    }

    // 喂经验：只喂「出战」珍兽（战力只认出战那只）
    // 繁殖用的非出战珍兽不自动喂 —— 想练繁殖对请用 upgrade_pet({petId}) 显式指定。
    const expNow = g.role?.currentExp || 0;
    if (expNow > 3_000_000) {
      const activePet = petsArr.find(p => p.pet.id === activeId) || null;
      const cand = activePet || topPet || null;

      // 只做提示，不消耗经验去练非出战珍兽
      const ready30 = petsArr.filter(p => p.pet.level >= 30 && !p.pet.breedingUsed);
      const hasPair = ready30.some(p => p.pet.sex === 'MALE') && ready30.some(p => p.pet.sex === 'FEMALE');
      if (hasPair) note('繁殖条件已满足（一公一母均 30 级）→ 可去苏州云飘飘 deposit；经验仍喂出战珍兽');

      if (cand && !petFeedDisabled) {
        // 实测 2026-11-15：一次性喂 40.77M 经验给 Lv.45 出战乌龟，
        // 角色经验清零但珍兽等级/战力(cp 13552)完全没变 → 大额一次性投喂无效或溢出丢失。
        // 改为单轮最多 5M，喂完立刻复核等级/战力，没涨就不再自动喂。
        //
        // 2026-11-16：投喂一旦被证明无效就熔断，别每轮继续烧 5M 经验。
        // 经验对技能升级是实打实的战斗力，喂给不涨级的珍兽等于白扔。
        const amount = Math.min(expNow - 500_000, 5_000_000);
        const r = await guarded(
          { action: 'PET_COMMAND', op: 'PET_FEED', petId: cand.pet.id, pet: cand, pets: petsArr },
          () => ws.req('PET_COMMAND', { action: 'feed', petId: cand.pet.id, amount, requestId: crypto.randomUUID() }, { ms: 9000 }),
        );
        if (r?.success) {
          const after = (g.pets || []).find(p => p.id === cand.pet.id) || null;
          const gained = after ? (after.level - cand.pet.level) : 0;
          note(`喂出战珍兽 ${cand.speciesName} ${amount.toLocaleString()} 经验（原 Lv.${cand.pet.level} 资质${cand.average}%）→ Lv.${after ? after.level : '?'}（+${gained}）`);
          if (after && gained <= 0) {
            // 连续两次喂食都不涨级 → 熔断，后面的轮次不再烧经验
            petFeedNoGain++;
            note(`⚠️ 喂食后珍兽等级未变（第 ${petFeedNoGain} 次）`);
            if (petFeedNoGain >= 2) {
              petFeedDisabled = true;
              note('🛑 珍兽投喂已熔断：连续两次不涨级，经验改用于升技能');
            }
          } else if (after && gained > 0) {
            petFeedNoGain = 0;
          }
        }
      }
    }
  }

  // ── 8. 技能（只在经验溢出时升；ROI 远低于珍兽）───────────────
  async function skills(g) {
    let best = null;
    for (const sk of g.skills || []) {
      if (sk.currentLevel >= (sk.skillDetail?.maxLevel ?? 99)) continue;
      let arr = [];
      try { arr = JSON.parse(sk.skillDetail?.expCost || '[]'); } catch { }
      const nx = arr.find(x => x.skill_level === sk.currentLevel + 1);
      if (!nx || nx.exp > (g.role?.currentExp || 0)) continue;
      // 2026-11-16 修：原来 `if (nx.exp < 30_000_000) continue;  // 经验留给珍兽`
      // 把所有便宜技能都挡死了（普通技能升级只要几百到几千万），实战里从没升过一次，
      // 而珍兽每轮吃掉 500 万经验。技能直接决定伤害 → 打怪慢一倍（277s vs 136s 一批）。
      // 改为：留一笔经验做珍兽口粮后，剩下的优先升最便宜的那一级，先吃到即时收益。
      const feedReserve = Number(process.env.TL_FEED_RESERVE || 6_000_000); // 珍兽口粮预留
      if (nx.exp > (g.role?.currentExp || 0) - feedReserve) continue;
      if (!best || nx.exp < best.cost) best = { id: sk.id, cost: nx.exp, name: sk.skillDetail?.name, lv: `${sk.currentLevel}→${sk.currentLevel + 1}` };
    }
    if (!best) return;
    const r = await guarded(
      { action: 'UPGRADE_SKILL', op: 'UPGRADE_SKILL' },
      () => ws.req('UPGRADE_SKILL', { roleSkillId: best.id }, { ms: 6000 }),
    );
    if (r?.success) note(`技能 +1 ${best.name} ${best.lv}（耗经验 ${best.cost}）`);
  }

  // ── 主入口 ─────────────────────────────────────────────────
  async function maintain() {
    report.at = new Date().toISOString();
    report.actions = []; report.blocked = []; report.errors = []; report.halted = false;
    if (isHalted()) { report.halted = true; return report; }
    let g;
    try { g = await refresh(); } catch (e) { report.errors.push('ENTER_GAME: ' + (e?.message || e)); return report; }
    if (!g?.role) { report.errors.push('ENTER_GAME 无 role'); return report; }

    report.before = {
      level: g.role.level, power: g.role.combatPower, money: g.role.money,
      exp: g.role.currentExp, equips: (g.equipments || []).length,
    };

    // 所有后勤动作串行，任何一步失败不影响后续
    for (const [name, fn] of [
      ['potions', () => potions(g)],
      ['cleanup', () => cleanup(g)],
      // 先官方评分换装（权威），再走 lib-value 兜底。
      // 关键：官方判过的槽位要传给 equipBest 跳过，否则两套模型会互相推翻
      // （实测出现过：官方换上去，lib-value 立刻换回来）。
      ['equipEval', async () => {
        const r = await equipByEvaluation(g);
        evalHandledSlots = r.handledSlots;
        // 函数内部已经把最新的 game 拿回来了，直接用，别再额外刷新
        if (r.game) g = r.game;
      }],
      ['equip', () => equipBest(g, evalHandledSlots)],
      ['shop', () => shop(g)],
      ['gems', () => gems(g)],
      ['appraise', () => appraise(g)],
      ['pets', () => pets(g)],
      ['skills', () => skills(g)],
    ]) {
      if (isHalted()) { report.halted = true; break; }
      try { await fn(); } catch (e) { report.errors.push(`${name}: ${e?.message || e}`); }
    }

    try {
      const g2 = await refresh();
      if (g2?.role) {
        report.after = {
          level: g2.role.level, power: g2.role.combatPower, money: g2.role.money,
          exp: g2.role.currentExp, equips: (g2.equipments || []).length,
        };
        const delta = (report.after.power || 0) - (report.before.power || 0);
        if (delta) note(`战力 ${report.before.power} → ${report.after.power}（${delta > 0 ? '+' : ''}${delta}）`);
        // verifier：记录一次真实换装偏差（预测值先用 itemValue 估算）
        if (delta !== 0) {
          try {
            recordSample({
              action: 'maintain',
              predicted: 0,
              measured: delta,
              beforePower: report.before.power,
              afterPower: report.after.power,
            });
          } catch { }
        }
      }
    } catch { }

    report.dryRun = !canWrite();
    return report;
  }

  // 单槽位优化（craft_slot）：从已有装备里选该槽最优并换上
  async function craftSlot(slot) {
    const g = await refresh();
    if (!g) return { ok: false, error: '无状态' };
    const eqs = g.equipments || [];
    const cands = eqs.filter(x => x.equipTmpl?.slotType === Number(slot));
    const iv = x => itemValue(x, { gemInfo: g.gemInfo });
    if (!cands.length) return { ok: false, error: `slot${slot} 无候选装备` };
    const best = cands.slice().sort((a, b) => iv(b) - iv(a))[0];
    if (best.isEquipped) return { ok: true, alreadyBest: true, item: best.equipTmpl?.name };
    const snap = snapshotEquipped(g, `craft-slot${slot}`);
    const r = await guarded(
      { action: 'EQUIP_ITEM', op: 'EQUIP_ITEM', unequip: true, snapshot: snap, itemId: best.id, item: best, owned: eqs },
      () => ws.req('EQUIP_ITEM', { roleEquipId: best.id }, { ms: 6000 }),
    );
    if (r?.success) note(`craft_slot${slot} → ${best.equipTmpl?.name}`);
    return { ok: !!r?.success, dryRun: !!r?.skipped, blocked: !!r?.blocked, item: best.equipTmpl?.name, report };
  }

  async function upgradePet(petId) {
    const g = await refresh();
    const pr = await ws.req('PET_COMMAND', { action: 'list', requestId: crypto.randomUUID() }, { ms: 8000 });
    const ps = pr?.data?.state || {};
    const petsArr = ps.pets || [];
    const target = petId
      ? petsArr.find(p => String(p.pet.id) === String(petId))
      : [...petsArr].sort((a, b) => (b.combatPower || 0) - (a.combatPower || 0))[0];
    if (!target) return { ok: false, error: '没有可升级的珍兽' };
    if (ps.activePetId !== target.pet.id) {
      await guarded(
        { action: 'PET_COMMAND', op: 'PET_SUMMON', petId: target.pet.id, pet: target, pets: petsArr },
        () => ws.req('PET_COMMAND', { action: 'summon', petId: target.pet.id, requestId: crypto.randomUUID() }, { ms: 8000 }),
      );
    }
    const amount = Math.max(0, (g?.role?.currentExp || 0) - 500_000);
    if (amount <= 0) return { ok: true, note: '经验不足，未喂食' };
    const r = await guarded(
      { action: 'PET_COMMAND', op: 'PET_FEED', petId: target.pet.id, pet: target, pets: petsArr },
      () => ws.req('PET_COMMAND', { action: 'feed', petId: target.pet.id, amount, requestId: crypto.randomUUID() }, { ms: 9000 }),
    );
    return { ok: !!r?.success, pet: target.speciesName, amount, dryRun: !!r?.skipped, blocked: !!r?.blocked, report };
  }

  async function listAuction() {
    const g = await refresh();
    if (!g) return { ok: false, error: '无状态' };
    await cleanup(g);
    return { ok: true, report };
  }

  async function resolve(target, opts = {}) {
    const g = await refresh();
    if (!g) return { ok: false, error: '无状态' };
    return resolveTargetImpl(target, g, opts);
  }

  return { maintain, autoMaintain: maintain, craftSlot, upgradePet, listAuction, resolve, refresh, report, equipByEvaluation };
}

export { LUOYANG, SUZHOU, MAP_XUANWU };
