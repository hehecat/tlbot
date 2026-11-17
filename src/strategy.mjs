// src/strategy.mjs —— System 2 的动作执行器（珍兽繁殖/孵蛋/喂食/无双）
//
// 定位：不决定「做什么」（那由 planner / DSH agent 决定），只把已授权的
// 高价值动作安全地执行掉：暂停战斗 → 切图 → 发包 → 回图 → 恢复战斗。
// 所有函数都可重复调用（幂等/有前置检查），并通过 data/strategy.json 记录计时。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { goMap, isHalted } from './combat-daemon.mjs';
import { itemValue, suggestPrice } from '../core/lib-value.mjs';
import { topGearIds } from '../core/redlines.mjs';

const SUZHOU = 5;
const EGG_RE = /珍兽蛋/;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function createStrategy(ws, store, { log = () => { }, stage = 0, allowWrite = false, defaultMapId = 10027 } = {}) {
  const canWrite = () => allowWrite && stage >= 2 && !isHalted();
  const DATA_DIR = process.env.TL_DATA_DIR ? path.resolve(process.env.TL_DATA_DIR) : path.resolve(process.cwd(), 'data');
  const STATE_F = path.join(DATA_DIR, 'strategy.json');
  const note = (m) => { try { log(`[strategy] ${m}`); } catch { } };

  let st = { depositAt: 0, depositPetId: null, lastClaimAt: 0, lastHatchAt: 0, lastFeedAt: 0, feeds: 0 };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(STATE_F, 'utf8')) }; } catch { }
  const save = () => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATE_F, JSON.stringify(st, null, 1)); } catch { } };

  const refresh = async () => {
    const r = await ws.req('ENTER_GAME', {}, { ms: 9000, revision: false });
    if (r?.data) store?.ingest?.(r.data);
    return r?.data || null;
  };
  const petState = async () => {
    const r = await ws.req('PET_COMMAND', { action: 'list', requestId: crypto.randomUUID() }, { ms: 8000 });
    if (r?.data?.state) {
      // PET_RESPONSE 也会走 ingest；这里保证立即拿到
      return r.data.state;
    }
    return null;
  };
  const go = async (mapId) => { const r = await goMap(ws, store, mapId); await sleep(400); return r; };
  const eggs = (g) => (g?.bagItems || []).filter(b => EGG_RE.test(b.itemTmpl?.name || ''));
  const appraise = async (petId) => {
    try {
      const r = await ws.req('PET_COMMAND', { action: 'appraise', petId, requestId: crypto.randomUUID() }, { ms: 8000 });
      return { ok: !!r?.success, msg: r?.message };
    } catch (e) { return { ok: false, msg: e?.message || String(e) }; }
  };
  const backToDefault = async () => {
    try { await go(defaultMapId); } catch (e) { note(`回图失败 ${e?.message || e}`); }
  };

  // ── 繁殖寄托：选一只 Lv>=30、未繁殖、非出战的异性 ─────────────
  async function breedDeposit({ petId } = {}) {
    if (!canWrite()) return { skipped: true, reason: 'stage/halt' };
    const before = await refresh();
    const map0 = before?.role?.mapId;
    ws.send('COMBAT_STOP'); await sleep(700);
    await go(SUZHOU);
    let ps = await petState();
    if (!ps) { await backToDefault(); return { error: 'PET_COMMAND list 无响应' }; }
    // 指定 petId 且该宠正在出战：先换下（服务端不允许寄托出战宠），再寄托
    let summoned = null;
    const wantId = petId ? String(petId) : null;
    if (wantId) {
      const target = (ps.pets || []).find(p => String(p.pet.id) === wantId);
      if (target && ps.activePetId === target.pet.id) {
        const other = (ps.pets || [])
          .filter(p => String(p.pet.id) !== wantId && p.pet.status === 'OWNED')
          .sort((a, b) => (b.combatPower || 0) - (a.combatPower || 0))[0];
        if (!other) { await backToDefault(); return { error: '无可替换的出战宠' }; }
        const sr = await ws.req('PET_COMMAND', { action: 'summon', petId: other.pet.id, requestId: crypto.randomUUID() }, { ms: 8000 });
        if (!sr?.success) { await backToDefault(); return { error: '换下出战宠失败: ' + (sr?.message || '无响应') }; }
        summoned = { name: other.speciesName, level: other.pet.level, combatPower: other.combatPower };
        note(`先换出战 ${other.speciesName} Lv${other.pet.level} 战力${other.combatPower}`);
        await sleep(500);
        ps = (await petState()) || ps;
      }
    }
    if (ps.reserved > 0 || (ps.pets || []).some(p => p.pet.status === 'WAITING' || p.pet.status === 'BREEDING')) {
      await backToDefault();
      return { skipped: true, reason: '已有寄托', reserved: ps.reserved };
    }
    // 栏位满（含繁殖预留位）：先放生最差的一只非出战珍兽腾位
    let released = null;
    if ((ps.pets || []).length >= (ps.capacity || 6)) {
      const best = Math.max(...(ps.pets || []).map(p => p.average || 0));
      const worst = (ps.pets || [])
        .filter(p => ps.activePetId !== p.pet.id && p.pet.form !== 'MUTANT' && p.pet.status === 'OWNED'
          && !(p.pet.level >= 30 && !p.pet.breedingUsed)   // 保留可繁殖的
          && (p.average || 0) < best - 1)
        .sort((a, b) => (a.average || 0) - (b.average || 0))[0];
      if (!worst) { await backToDefault(); return { skipped: true, reason: '栏位满且无安全可放生珍兽' }; }
      const rel = await ws.req('PET_COMMAND', { action: 'release', confirm: true, petId: worst.pet.id, requestId: crypto.randomUUID() }, { ms: 8000 });
      if (!rel?.success) { await backToDefault(); return { error: '放生失败: ' + (rel?.message || '无响应') }; }
      released = { name: worst.speciesName, average: worst.average, level: worst.pet.level };
      note(`放生 ${worst.speciesName} Lv${worst.pet.level} ${worst.average}% 腾栏位`);
      await sleep(600);
      ps = (await petState()) || ps;
    }

    // 出战宠不能寄托；优先找最高资质的合格异性
    const cands = (ps.pets || [])
      .filter(p => p.pet.status === 'OWNED' && p.pet.form === 'BABY' && !p.pet.breedingUsed && p.pet.level >= 30 && ps.activePetId !== p.pet.id
        && (!wantId || String(p.pet.id) === wantId))
      .sort((a, b) => b.average - a.average);
    if (!cands.length) { await backToDefault(); return { skipped: true, reason: '无 Lv30+ 未繁殖非出战珍兽' }; }
    const pick = cands[0];
    const r = await ws.req('PET_COMMAND', { action: 'deposit', petId: pick.pet.id, requestId: crypto.randomUUID() }, { ms: 10000 });
    const ok = !!r?.success;
    if (ok) { st.depositAt = Date.now(); st.depositPetId = pick.pet.id; save(); }
    note(`寄托 ${pick.speciesName} ${pick.pet.sex} Lv${pick.pet.level} avg${pick.average}% → ${ok ? '成功' : (r?.message || '失败')}`);
    const after = await petState();
    await backToDefault(map0);
    return { ok, message: r?.message, released, summoned, pet: { id: pick.pet.id, name: pick.speciesName, sex: pick.pet.sex, level: pick.pet.level, average: pick.average }, reserved: after?.reserved ?? null, map0 };
  }

  // ── 繁殖领取：满 1 小时后 claim → hatch → appraise ─────────────
  async function breedClaim({ force = false } = {}) {
    if (!canWrite()) return { skipped: true, reason: 'stage/halt' };
    if (!force && st.depositAt && Date.now() - st.depositAt < 55 * 60 * 1000) {
      return { skipped: true, reason: '未满 55 分钟', waitSec: Math.round((55 * 60 * 1000 - (Date.now() - st.depositAt)) / 1000) };
    }
    const before = await refresh();
    const idsBefore = new Set(((await petState())?.pets || []).map(p => p.pet.id));
    ws.send('COMBAT_STOP'); await sleep(700);
    await go(SUZHOU);
    let ps = await petState();
    if (!ps) { await backToDefault(); return { error: 'pet list 无响应' }; }
    // 寄托中的珍兽状态是 BREEDING（不是 WAITING）；兼容两种。
    const waiting = (ps.pets || []).filter(p => p.pet.status === 'WAITING' || p.pet.status === 'BREEDING');
    if (!waiting.length) {
      st.depositAt = 0; st.depositPetId = null; save();
      await backToDefault();
      return { skipped: true, reason: '没有 BREEDING/WAITING 珍兽，已清 depositAt（停止重试）' };
    }
    const out = { claimed: false, hatched: false, messages: [], newPets: [] };
    for (const w of waiting) {
      const c = await ws.req('PET_COMMAND', { action: 'claim', petId: w.pet.id, requestId: crypto.randomUUID() }, { ms: 10000 });
      out.messages.push(`claim ${w.speciesName}: ${c?.success ? '成功' : (c?.message || '失败')}`);
      if (c?.success) out.claimed = true;
      await sleep(400);
    }
    const h = await ws.req('PET_COMMAND', { action: 'hatch', requestId: crypto.randomUUID() }, { ms: 10000 });
    out.messages.push(`hatch: ${h?.success ? '成功' : (h?.message || '失败')}`);
    out.hatched = !!h?.success;
    await sleep(600);
    ps = (h?.data?.state) || (await petState()) || ps;
    for (const p of ps.pets || []) {
      if (!idsBefore.has(p.pet.id)) {
        const ap = await appraise(p.pet.id);
        out.newPets.push({ id: p.pet.id, name: p.speciesName, sex: p.pet.sex, form: p.pet.form, level: p.pet.level, average: p.average, cp: p.combatPower, appraised: ap.ok, msg: ap.msg });
        await sleep(300);
      }
    }
    if (out.claimed || out.hatched) { st.depositAt = 0; st.depositPetId = null; st.lastClaimAt = Date.now(); save(); }
    await backToDefault();
    return out;
  }

  // ── 孵蛋：释放最差（非出战/非MUTANT/低资质）腾位 → hatch ─────
  async function hatchEggs({ max = 3, release = true } = {}) {
    if (!canWrite()) return { skipped: true, reason: 'stage/halt' };
    const g0 = await refresh();
    const eggs0 = eggs(g0);
    if (!eggs0.length) return { skipped: true, reason: '背包无珍兽蛋' };
    ws.send('COMBAT_STOP'); await sleep(700);
    await go(SUZHOU);
    const out = { hatched: 0, released: 0, newPets: [], messages: [] };
    let ps = await petState();
    if (!ps) { await backToDefault(); return { error: 'pet list 无响应' }; }
    for (let i = 0; i < max; i++) {
      ps = (await petState()) || ps;
      if ((ps.pets || []).length >= (ps.capacity || 6)) {
        if (!release) { out.messages.push('栏位满，停止'); break; }
        const best = Math.max(...(ps.pets || []).map(p => p.average || 0));
        const worst = (ps.pets || [])
          .filter(p => ps.activePetId !== p.pet.id && p.pet.form !== 'MUTANT' && p.pet.form !== 'SECOND' && p.pet.status === 'OWNED' && (p.average || 0) < best - 2)
          .sort((a, b) => (a.average || 0) - (b.average || 0))[0];
        if (!worst) { out.messages.push('无安全可放生珍兽，停止'); break; }
        const rel = await ws.req('PET_COMMAND', { action: 'release', confirm: true, petId: worst.pet.id, requestId: crypto.randomUUID() }, { ms: 8000 });
        out.messages.push(`放生 ${worst.speciesName} ${worst.average}%: ${rel?.success ? '成功' : (rel?.message || '失败')}`);
        if (!rel?.success) break;
        out.released++;
        await sleep(500);
        i--; // 放生不算一次孵化配额
        continue;
      }
      const idsBefore = new Set(((await petState())?.pets || []).map(p => p.pet.id));
      // 孵化背包里的蛋走 USE_ITEM（PET_COMMAND hatch 只用于繁殖产物，会报「道具不存在」）
      const gNow = await refresh();
      const eggNow = eggs(gNow)[0];
      if (!eggNow) { out.messages.push('蛋已用尽'); break; }
      const h = await ws.req('USE_ITEM', { bagItemId: eggNow.id, count: 1, requestId: crypto.randomUUID() }, { ms: 10000 });
      out.messages.push(`孵 ${eggNow.itemTmpl?.name || eggNow.id}: ${h?.success ? '成功' : (h?.message || '失败')}`);
      if (!h?.success) break;
      out.hatched++;
      await sleep(600);
      const ps2 = (h?.data?.state) || (await petState());
      for (const p of ps2?.pets || []) {
        if (!idsBefore.has(p.pet.id) && ps2.activePetId !== p.pet.id) {
          const ap = await appraise(p.pet.id);
          out.newPets.push({ id: p.pet.id, name: p.speciesName, sex: p.pet.sex, form: p.pet.form, average: p.average, cp: p.combatPower, appraised: ap.ok, msg: ap.msg });
        }
      }
    }
    st.lastHatchAt = Date.now(); save();
    await backToDefault();
    return out;
  }

  // ── 出售「用不上但好」的装备：参考拍卖行同模板/同槽在售价 ──────────
  // 安全边界：已穿戴不卖、武器不卖、套装件不卖、同槽 itemValue 前 2 不卖、绑定不卖。
  async function sellUnusedGear({ max = 5, dryRun = true, minValue = 2000, factor = 0.95 } = {}) {
    const g0 = await refresh();
    if (!g0) return { error: 'refresh 无响应' };
    const all = (g0.equipments || []).filter(x => x?.equipTmpl);
    const iv = x => itemValue(x, { gemInfo: g0.gemInfo });
    const equipped = all.filter(x => x.isEquipped);
    // 同槽保护（统一策略：第1名+已穿必保；第2名仅高价值必保）
    const topIds = topGearIds(all);
    // 套装模板保护（equipSets.equipTmplIds 是 JSON 字符串）
    const setTmpl = new Set();
    for (const st0 of (g0.equipSets || [])) {
      try { for (const id of JSON.parse(st0.equipTmplIds || '[]')) setTmpl.add(Number(id)); } catch { }
    }
    const cand = all.filter(x => {
      if (x.isEquipped) return false;
      if (x.isBound === 1 || x.isBound === true) return false;
      const t = x.equipTmpl;
      if (t.slotType === 1) return false;            // 武器：鉴定/熔炼胚子，不卖
      if (setTmpl.has(Number(t.id))) return false;   // 套装件不卖
      if (topIds.has(x.id)) return false;            // 同槽前 2 强不卖
      if (Number(x.quality ?? 1) < 2) return false;  // 白装只走存仓/垃圾清理
      if (iv(x) < minValue) return false;
      return true;
    }).sort((a, b) => iv(b) - iv(a)).slice(0, Math.max(1, max));

    if (!cand.length) return { dryRun, candidates: [], message: '没有符合条件的好装备' };

    // 行情参考：拉一页在售（100 件），同模板优先，其次同槽位
    let goods = [];
    try {
      const list = await ws.req('CONSIGNMENT_LIST', { page: 1, size: 100 }, { ms: 10000 });
      goods = (list?.data?.items || []).filter(x => x.itemType === 1 && x.equipTmpl);
    } catch { }
    const out = cand.map(x => {
      const tmplId = Number(x.equipTmpl.id);
      const sameTmpl = goods.filter(y => Number(y.tmplId) === tmplId);
      const slot = x.equipTmpl.slotType;
      const sameSlot = goods.filter(y => y.equipTmpl?.slotType === slot &&
        Math.abs(Number(y.equipTmpl?.qualityBase ?? 0) - Number(x.equipTmpl?.qualityBase ?? 0)) <= 1);
      const refs = (sameTmpl.length ? sameTmpl : sameSlot).map(y => Number(y.price)).filter(p => p > 0).sort((a, b) => a - b);
      const refPrice = refs.length ? refs[0] : null;
      const price = refPrice ? Math.max(100, Math.floor(refPrice * factor)) : Math.max(100, Math.floor(suggestPrice(x, { gemInfo: g0.gemInfo }) * factor));
      return {
        id: x.id, name: x.equipTmpl?.name, slot, q: Number(x.quality ?? 1), enh: x.enhanceLevel, star: x.starLevel,
        iv: Math.round(iv(x)), refPrice, price,
        refKind: tmplId && sameTmpl.length ? 'sameTmpl' : (sameSlot.length ? 'sameSlot' : 'formula'),
      };
    });

    if (dryRun) return { dryRun: true, candidates: out };
    if (!canWrite()) return { skipped: true, reason: 'stage/halt' };

    // 在售位检查（账号上限 25；CONSIGNMENT_RECORD_LIST 是历史成交，不能当在售列表，直接用 25 上限）
    let slotsLeft = Math.max(0, 25);
    try { slotsLeft = Math.max(0, 25 - (await myListings()).length); } catch { }
    const results = [];
    for (const x of out) {
      if (slotsLeft <= 0) { results.push({ ...x, listed: false, why: '挂售位满' }); continue; }
      const item = cand.find(c => c.id === x.id);
      const r = await ws.req('CONSIGNMENT_CREATE', { roleEquipId: x.id, count: 1, price: x.price, currency: 1, targetNickname: null }, { ms: 8000 });
      const ok = !!r?.success;
      results.push({ ...x, listed: ok, why: ok ? null : (r?.message || '失败') });
      if (ok) {
        slotsLeft--;
        note(`挂售 ${x.name} ${x.price}金（参考${x.refKind === 'formula' ? '公式' : '行情'}${x.refPrice ? ' ' + x.refPrice : ''}）`);
      }
      await sleep(300);
    }
    return { dryRun: false, results };
  }

  // ── 我自己的在售挂单：/auction 每页只回 6 件，逐页翻 ──────
  async function myListings() {
    const g = await refresh();
    const me = g?.role?.id;
    if (me == null) return [];
    const out = [];
    for (let page = 1; page <= 60; page++) {
      let raw = [];
      try {
        const r = await ws.req('CONSIGNMENT_LIST', { page, size: 100 }, { ms: 9000 });
        raw = r?.data?.items || [];
      } catch { break; }
      if (!raw.length) break;
      out.push(...raw.filter(x => x.itemType === 1 && x.equipTmpl));
      if (raw.length < 6) break;
      await sleep(80);
    }
    return out.filter(x => me == null || String(x.sellerRoleId) === String(me));
  }

  // ── 下架全部挂单，按 factor 折价重挂（用户要求低价甩卖）──────
  async function clearanceListings({ factor = 0.5, dryRun = true, max = 25 } = {}) {
    if (!canWrite()) return { skipped: true, reason: 'stage/halt' };
    const mine = await myListings();
    if (!mine.length) return { found: 0, message: '没有自己的在售挂单' };
    const plan = mine.slice(0, max).map(x => ({
      id: x.id, tmplId: Number(x.tmplId), name: x.equipTmpl?.name || x.itemName, price: Number(x.price) || 0,
      newPrice: Math.max(100, Math.floor((Number(x.price) || 0) * factor)),
      q: Number(x.quality || 0), slot: x.equipTmpl?.slotType,
    }));
    if (dryRun) return { dryRun: true, found: plan.length, plan };
    const cancelled = [];
    for (const x of mine.slice(0, max)) {
      const r = await ws.req('CONSIGNMENT_CANCEL', { consignmentId: x.id }, { ms: 7000 });
      cancelled.push({ id: x.id, ok: !!r?.success, message: r?.message });
      await sleep(250);
    }
    const g2 = await refresh();
    const relistResults = [];
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      if (!cancelled[i]?.ok) { relistResults.push({ id: p.id, name: p.name, listed: false, why: '下架失败跳过' }); continue; }
      const item = (g2?.equipments || []).find(it => Number(it.equipTmpl?.id) === Number(p.tmplId) && !it.isEquipped);
      if (!item) { relistResults.push({ id: p.id, name: p.name, newPrice: p.newPrice, listed: false, why: '背包找不到' }); continue; }
      const r2 = await ws.req('CONSIGNMENT_CREATE', { roleEquipId: item.id, count: 1, price: p.newPrice, currency: 1, targetNickname: null }, { ms: 8000 });
      relistResults.push({ id: p.id, name: p.name, newPrice: p.newPrice, listed: !!r2?.success, why: r2?.success ? null : (r2?.message || '失败') });
      await sleep(300);
    }
    st.clearance = { at: Date.now(), factor, repricedAt: 0, listed: relistResults.filter(x => x.listed).length };
    save();
    return { dryRun: false, found: plan.length, cancelled, relisted: relistResults };
  }

  // ── P3：商城指定交易（默认 dry-run；targetNickname 定向，未实测）──
  async function designatedPreview({ roleEquipId, targetNickname, price } = {}) {
    const g = await refresh();
    const it = (g?.equipments || []).find(e => String(e.id) === String(roleEquipId));
    if (!it) return { ok: false, error: '找不到装备' };
    if (it.isEquipped) return { ok: false, error: '已穿戴装备不能上架' };
    if (it.isBound === 1 || it.isBound === true) return { ok: false, error: '绑定装备不能交易' };
    const p = Math.max(100, Math.floor(Number(price || suggestPrice(it, { gemInfo: g.gemInfo }) || 100)));
    return {
      ok: true, roleEquipId: it.id, name: it.equipTmpl?.name, tmplId: it.equipTmpl?.id,
      q: Number(it.quality ?? 1), iv: Math.round(itemValue(it, { gemInfo: g.gemInfo })),
      targetNickname: String(targetNickname || '').trim() || null, price: p,
      note: 'targetNickname 定向支持未实测；create 需 confirm:true',
    };
  }

  async function designatedCreate({ roleEquipId, targetNickname, price, dryRun = true, confirm = false } = {}) {
    if (!canWrite()) return { skipped: true, reason: 'stage/halt' };
    const pv = await designatedPreview({ roleEquipId, targetNickname, price });
    if (!pv.ok || dryRun) return { dryRun: true, preview: pv };
    if (!pv.targetNickname) return { ok: false, error: '缺少 targetNickname' };
    if (!confirm) return { ok: false, error: '需要 confirm:true 才执行指定交易上架' };
    const r = await ws.req('CONSIGNMENT_CREATE', {
      roleEquipId: pv.roleEquipId, count: 1, price: pv.price, currency: 1, targetNickname: pv.targetNickname,
    }, { ms: 8000 });
    note(`P3 指定交易上架 ${pv.name} ${pv.price}金 -> ${pv.targetNickname}`);
    return { ok: !!r?.success, message: r?.message, preview: pv };
  }

  // 通用上架（公开挂单，targetNickname=null）；用于受控测试与人工指定
  async function listItem({ roleEquipId, price, currency = 1, targetNickname = null } = {}) {
    if (!canWrite()) return { skipped: true, reason: 'stage/halt' };
    const g = await refresh();
    const it = (g?.equipments || []).find(e => String(e.id) === String(roleEquipId));
    if (!it) return { ok: false, error: '找不到装备' };
    if (it.isEquipped) return { ok: false, error: '已穿戴装备不能上架' };
    if (it.isBound === 1 || it.isBound === true) return { ok: false, error: '绑定装备不能交易' };
    const p = Math.max(100, Math.floor(Number(price || suggestPrice(it, { gemInfo: g.gemInfo }) || 100)));
    const target = String(targetNickname || '').trim() || null;
    const r = await ws.req('CONSIGNMENT_CREATE', {
      roleEquipId: it.id, count: 1, price: p, currency: Number(currency) || 1, targetNickname: target,
    }, { ms: 8000 });
    note(`上架 ${it.equipTmpl?.name} ${p}金${target ? ` -> ${target}` : '（公开）'}`);
    return { ok: !!r?.success, message: r?.message, roleEquipId: it.id, name: it.equipTmpl?.name, price: p, targetNickname: target };
  }

  async function countBuyRecords() {
    try {
      const rr = await ws.req('CONSIGNMENT_RECORD_LIST', { page: 1, size: 50, type: 'BUY' }, { ms: 8000 });
      const arr = rr?.data?.records || rr?.data?.items || (Array.isArray(rr?.data) ? rr.data : []);
      return arr.length;
    } catch { return null; }
  }

  async function designatedBuy({ consignmentId, dryRun = true } = {}) {
    if (!canWrite()) return { skipped: true, reason: 'stage/halt' };
    if (!consignmentId) return { ok: false, error: '缺少 consignmentId' };
    if (dryRun) return { dryRun: true, consignmentId };
    const before = await countBuyRecords();
    let r = null, err = null;
    try { r = await ws.req('CONSIGNMENT_BUY', { consignmentId }, { ms: 8000 }); }
    catch (e) { err = e; }
    if (r?.success) {
      try { await refresh(); } catch { }
      return { ok: true, message: r?.message, data: r?.data };
    }
    // 回包丢失/连接断开时，服务端可能已经成交：查 BUY 记录做幂等确认
    await sleep(1500);
    try { await refresh(); } catch { }
    const after = await countBuyRecords();
    if (before != null && after != null && after > before) {
      return { ok: true, verified: true, message: '成交记录已增加，确认购买成功（原回包丢失）', data: r?.data, error: err?.message };
    }
    return { ok: false, message: r?.message || err?.message || '结果未知，未查到成交记录', data: r?.data };
  }

  // ── P1：手动降价过期挂单（默认 dry-run；不自动定时执行）──
  async function repriceListings({ factor = 0.85, dryRun = true, max = 10 } = {}) {
    if (!canWrite()) return { skipped: true, reason: 'stage/halt' };
    const mine = await myListings();
    if (!mine.length) return { found: 0, message: '没有自己的在售挂单' };
    const plan = mine.slice(0, max).map(x => ({
      id: x.id, tmplId: Number(x.equipTmpl?.id ?? x.tmplId ?? x.itemId ?? 0) || null, name: x.equipTmpl?.name || x.itemName,
      price: Number(x.price) || 0, newPrice: Math.max(100, Math.floor((Number(x.price) || 0) * factor)),
    }));
    if (dryRun) return { dryRun: true, found: plan.length, plan };
    const results = [];
    for (const x of plan) {
      const c = await ws.req('CONSIGNMENT_CANCEL', { consignmentId: x.id }, { ms: 7000 });
      if (!c?.success) { results.push({ ...x, cancelled: false, message: c?.message }); continue; }
      await sleep(400);
      const g = await refresh();
      const it = (g?.equipments || []).find(e => !e.isEquipped && ((x.tmplId && Number(e?.equipTmpl?.id) === x.tmplId) || (!x.tmplId && (e?.equipTmpl?.name || '') === x.name)));
      if (!it) { results.push({ ...x, cancelled: true, relisted: false, message: '背包找不到该装备' }); continue; }
      const r = await ws.req('CONSIGNMENT_CREATE', { roleEquipId: it.id, count: 1, price: x.newPrice, currency: 1, targetNickname: null }, { ms: 8000 });
      results.push({ ...x, cancelled: true, relisted: !!r?.success, newEquipId: it.id, message: r?.message });
      await sleep(300);
    }
    note(`P1 降价重挂 ${results.filter(r => r.relisted).length}/${results.length}`);
    return { dryRun: false, results };
  }

  // ── 喂出战珍兽：记录喂前/喂后真实战力，用于标定边际 ΔCP ──────
  // ── 5 折挂 3 小时仍无成交 → 自动 3 折重挂（只执行一次）──
  async function clearanceFollowup({ afterMs = 3 * 60 * 60_000, factor = 0.3 } = {}) {
    const c = st.clearance;
    if (!c || c.repricedAt) return { skipped: true, reason: '无待降价的挂单' };
    const age = Date.now() - Number(c.at || 0);
    if (age < afterMs) return { skipped: true, waitMs: afterMs - age };
    if (!canWrite()) return { skipped: true, reason: 'stage/halt' };
    const r = await clearanceListings({ factor, dryRun: false, max: 25 });
    st.clearance = { ...c, repricedAt: Date.now(), followupFactor: factor, followupFound: r?.found ?? 0 };
    save();
    note(`挂单 3 小时未售 → ${Math.round(factor * 100)} 折重挂（${r?.found ?? 0} 件）`);
    return { ok: true, factor, ...r };
  }

  async function feedPet({ amount = 5_000_000, petId = null } = {}) {
    if (!canWrite()) return { skipped: true, reason: 'stage/halt' };
    ws.send('COMBAT_STOP'); await sleep(700);
    const g0 = await refresh();
    const powerBefore = g0?.role?.combatPower ?? null;
    const ps = await petState();
    if (!ps) { await backToDefault(); return { error: 'pet list 无响应' }; }
    const target = petId ? (ps.pets || []).find(p => p.pet.id === petId) : (ps.pets || []).find(p => p.pet.id === ps.activePetId) || (ps.pets || [])[0];
    if (!target) { await backToDefault(); return { error: '无珍兽' }; }
    const exp = g0?.role?.currentExp ?? 0;
    const n = Math.max(0, Math.min(Number(amount), exp - 1_000_000));
    if (n <= 0) { await backToDefault(); return { skipped: true, reason: '经验不足' }; }
    const f = await ws.req('PET_COMMAND', { action: 'feed', petId: target.pet.id, amount: n, requestId: crypto.randomUUID() }, { ms: 9000 });
    await sleep(800);
    const g1 = await refresh();
    const powerAfter = g1?.role?.combatPower ?? null;
    const ps1 = (f?.data?.state) || (await petState());
    const after = (ps1?.pets || []).find(p => p.pet.id === target.pet.id);
    st.lastFeedAt = Date.now(); st.feeds = (st.feeds || 0) + 1; save();
    const out = {
      ok: !!f?.success, message: f?.message, amount: n,
      pet: { id: target.pet.id, name: target.speciesName, levelBefore: target.pet.level, levelAfter: after?.pet?.level, expAfter: after?.pet?.exp, nextExp: after?.nextExp },
      powerBefore, powerAfter, delta: (powerBefore != null && powerAfter != null) ? powerAfter - powerBefore : null,
    };
    note(`喂 ${target.speciesName} ${n} 经验 → Lv${out.pet.levelBefore}→${out.pet.levelAfter} 战力 ${powerBefore}→${powerAfter} (Δ${out.delta})`);
    await backToDefault();
    return out;
  }

  // ── 无双双倍：查状态 → 领取 → 背包有天灵丹就吃 ─────────────────
  async function wushuang({ use = true } = {}) {
    if (!canWrite()) return { skipped: true, reason: 'stage/halt' };
    const st0 = await ws.req('WUSHUANG_STATUS', {}, { ms: 6000 });
    const d0 = st0?.data || {};
    let claimed = false, used = false;
    if (use && (d0.remainingSeconds || 0) <= 0) {
      const c = await ws.req('WUSHUANG_CLAIM', {}, { ms: 6000 });
      claimed = !!c?.success;
      const g = await refresh();
      const tl = (g?.bagItems || []).find(b => b.itemId === 51003 || /天灵丹/.test(b.itemTmpl?.name || ''));
      if (tl) {
        const u = await ws.req('USE_ITEM', { itemId: tl.id, count: 1 }, { ms: 6000 });
        used = !!u?.success;
      }
    }
    return { before: d0, claimed, used };
  }

  async function summonPet({ petId } = {}) {
    if (!canWrite()) return { skipped: true, reason: 'stage/halt' };
    if (!petId) return { skipped: true, reason: 'no petId' };
    ws.send('COMBAT_STOP'); await sleep(700);
    await go(SUZHOU);
    const r = await ws.req('PET_COMMAND', { action: 'summon', petId, requestId: crypto.randomUUID() }, { ms: 8000 });
    const after = await petState();
    await backToDefault();
    note(`换出战 petId=${petId} → ${r?.success ? '成功' : (r?.message || '失败')}`);
    return { ok: !!r?.success, message: r?.message, activePetId: after?.activePetId ?? null };
  }

  return { breedDeposit, breedClaim, hatchEggs, feedPet, sellUnusedGear, clearanceListings, clearanceFollowup, myListings, repriceListings, listItem, designatedPreview, designatedCreate, designatedBuy, wushuang, summonPet, refresh, petState, get state() { return st; } };
}
