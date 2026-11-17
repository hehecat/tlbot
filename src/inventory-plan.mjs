// 背包 / 仓库 / 已穿装备的纯计算整理计划（不发包，不依赖 WS）
// 规则（用户 2026-11-17 要求）：
//   1) 每个槽位把「已穿 + 背包 + 仓库」合并，按 itemValue 排序，保留前 50%（至少保留已穿 + 同槽前二）
//   2) 套装件、已穿、绑定件不卖（绑定件只标记，由调用方决定）
//   3) 仓库里比已穿明显更好的，列入 upgrade（取出 → 官方评分 → 换装）
//   4) 其余列入 sellBag / sellWarehouse；堆叠物不动
import { itemValue } from '../core/lib-value.mjs';
import { topGearPerSlot, protectSecondGear } from '../core/redlines.mjs';

const isGear = x => x && x.equipTmpl && Number(x.equipTmpl.slotType) >= 1;

export function buildInventoryPlan({
  equipments = [],
  warehouse = [],
  bagItems = [],
  equipSets = [],
  gemInfo = null,
  keepRatio = 0.5,
  minKeepPerSlot = 2,
  upgradeMargin = 0.02,
} = {}) {
  const setTmplIds = new Set();
  for (const s of equipSets || []) {
    let ids = s?.equipTmplIds ?? [];
    if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch { ids = []; } }
    for (const id of ids || []) setTmplIds.add(String(id));
  }

  const ivOf = x => {
    try { return Number(itemValue(x, { gemInfo })) || 0; } catch { return 0; }
  };

  const worn = equipments.filter(x => isGear(x) && x.isEquipped);
  const bagGear = equipments.filter(x => isGear(x) && !x.isEquipped);
  const whGear = (warehouse || []).filter(isGear);
  const whStack = (warehouse || []).filter(x => x && !isGear(x));
  const bagStack = (bagItems || []).filter(x => x && !isGear(x));

  const slots = [];
  const upgrade = [];
  const sellBag = [];
  const sellWarehouse = [];
  const protectedSet = [];

  for (let slot = 1; slot <= 12; slot++) {
    const w = worn.find(x => Number(x.equipTmpl?.slotType) === slot) || null;
    const bc = bagGear.filter(x => Number(x.equipTmpl?.slotType) === slot);
    const wc = whGear.filter(x => Number(x.equipTmpl?.slotType) === slot);
    const all = [
      ...(w ? [{ x: w, source: 'worn' }] : []),
      ...bc.map(x => ({ x, source: 'bag' })),
      ...wc.map(x => ({ x, source: 'warehouse' })),
    ].map(e => ({ ...e, iv: ivOf(e.x) }));

    if (!all.length) continue;

    const sorted = all.slice().sort((a, b) => b.iv - a.iv);
    const keepN = Math.max(
      minKeepPerSlot,
      w ? 1 : 0,
      Math.ceil(all.length * keepRatio),
    );
    const keep = new Set();
    if (w) keep.add(String(w.id));
    for (const e of sorted) {
      if (keep.size >= keepN) break;
      keep.add(String(e.x.id));
    }
    // 同槽保护：第 1 永远保留；第 2 仅高价值（q>=3/套装/绑定）强制保留
    const perSlot = topGearPerSlot();
    if (perSlot >= 1 && sorted[0]) keep.add(String(sorted[0].x.id));
    if (perSlot >= 2 && sorted[1] && protectSecondGear(sorted[1].x)) keep.add(String(sorted[1].x.id));

    const keepItems = [];
    const dropItems = [];
    for (const e of sorted) {
      const id = String(e.x.id);
      const isSet = setTmplIds.has(String(e.x.tmplId ?? e.x.equipTmpl?.id ?? ''));
      if (isSet) {
        keepItems.push({ ...e, reason: 'set' });
        protectedSet.push({ slot, id, source: e.source, name: e.x.equipTmpl?.name, iv: e.iv });
      } else if (keep.has(id)) {
        keepItems.push({ ...e, reason: e.source === 'worn' ? 'worn' : 'keep' });
      } else {
        dropItems.push(e);
      }
    }

    const wIv = w ? ivOf(w) : 0;
    const better = wc
      .map(x => ({ x, iv: ivOf(x) }))
      .filter(e => e.iv > Math.max(wIv * (1 + upgradeMargin), wIv + 200))
      .sort((a, b) => b.iv - a.iv)[0];
    if (better) {
      upgrade.push({
        slot,
        id: better.x.id,
        name: better.x.equipTmpl?.name,
        iv: better.iv,
        wornIv: wIv,
        delta: better.iv - wIv,
      });
    }

    for (const e of dropItems) {
      const row = {
        slot, id: e.x.id, name: e.x.equipTmpl?.name,
        q: e.x.quality, iv: e.iv, bound: !!e.x.isBound, source: e.source,
        tmplId: e.x.tmplId ?? e.x.equipTmpl?.id,
      };
      if (e.source === 'bag') sellBag.push(row);
      else if (e.source === 'warehouse') sellWarehouse.push(row);
    }

    slots.push({
      slot,
      worn: w ? { id: w.id, name: w.equipTmpl?.name, iv: wIv, q: w.quality, star: w.starLevel, enh: w.enhanceLevel } : null,
      keep: keepItems.map(e => ({ id: e.x.id, source: e.source, reason: e.reason, name: e.x.equipTmpl?.name, iv: e.iv, q: e.x.quality })),
      drop: dropItems.map(e => ({ id: e.x.id, source: e.source, name: e.x.equipTmpl?.name, iv: e.iv, q: e.x.quality })),
      total: all.length,
      keepN,
    });
  }

  // 堆叠物只做统计，不卖；仓库堆叠物留给 apply 阶段按需取回
  const stackSummary = {
    bagKinds: bagStack.length,
    warehouseKinds: whStack.length,
    warehouseCount: whStack.reduce((n, x) => n + Number(x.count || 1), 0),
  };

  return {
    slots,
    upgrade,
    sellBag,
    sellWarehouse,
    protectedSet,
    stackSummary,
    summary: {
      gearWorn: worn.length,
      gearBag: bagGear.length,
      gearWarehouse: whGear.length,
      keepSlots: slots.length,
      keepGear: slots.reduce((n, s) => n + s.keep.length, 0),
      sellBag: sellBag.length,
      sellWarehouse: sellWarehouse.length,
      upgrade: upgrade.length,
      protectedSet: protectedSet.length,
    },
  };
}
