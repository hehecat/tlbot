#!/usr/bin/env node
// 背包 / 仓库 / 挂单整理执行器（先 dry-run，确认后 --apply）
// 前提：引擎正在运行（HTTP 127.0.0.1:9527），且用户已结束手动客户端。
// 用法：
//   node scripts/inventory-cleanup.mjs                # 只读计划
//   node scripts/inventory-cleanup.mjs --apply        # 换装 + 卖 + 下架重挂
//   node scripts/inventory-cleanup.mjs --apply --clearance-factor=0.5
const BASE = process.env.TL_HTTP || 'http://127.0.0.1:9527';
const APPLY = process.argv.includes('--apply');
const argOf = (name, dflt) => {
  const p = process.argv.find(x => x.startsWith(`--${name}=`));
  return p ? p.split('=')[1] : dflt;
};
const factor = Number(argOf('clearance-factor', 0.5));
const maxSell = Number(argOf('max-sell', 12));

async function call(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return data;
}

const brief = await call('GET', '/status/brief');
if (brief?.daemon === 'stopped' || brief?.wsClosed) {
  console.error('引擎未就绪，先启动引擎：', JSON.stringify(brief).slice(0, 300));
  process.exit(2);
}

const plan = await call('GET', '/inventory/plan');
console.log('计划摘要', JSON.stringify(plan.summary));
for (const u of plan.upgrade || []) {
  console.log(`升级 slot${u.slot}: ${u.name} iv ${u.iv} > 已穿 ${u.wornIv} (Δ${u.delta})`);
}
for (const x of plan.sellBag || []) console.log(`卖背包 slot${x.slot} ${x.name} iv ${x.iv} q${x.q}`);
for (const x of plan.sellWarehouse || []) console.log(`卖仓库 slot${x.slot} ${x.name} iv ${x.iv} q${x.q}`);

if (!APPLY) {
  console.log('\n只读模式。确认后加 --apply 执行（会写包）。');
  process.exit(0);
}

// 1) 仓库更好的：取出 → 换上
for (const u of plan.upgrade || []) {
  const w = await call('POST', '/inventory/withdraw', { roleEquipId: u.id });
  console.log('取出', u.name, JSON.stringify(w));
  if (w?.ok) {
    const e = await call('POST', '/inventory/equip', { roleEquipId: u.id });
    console.log('换装', u.name, JSON.stringify(e));
  }
}

// 2) 背包/仓库多余的：NPC 直卖（绑定件跳过）
let sold = 0;
for (const x of plan.sellBag || []) {
  if (x.bound) continue;
  if (sold >= maxSell) break;
  const r = await call('POST', '/inventory/sell', { roleEquipId: x.id, confirmed: true });
  console.log('卖背包', x.name, JSON.stringify(r));
  sold++;
}
for (const x of plan.sellWarehouse || []) {
  if (x.bound) continue;
  if (sold >= maxSell) break;
  const w = await call('POST', '/inventory/withdraw', { roleEquipId: x.id });
  if (!w?.ok) { console.log('取出失败', x.name, JSON.stringify(w)); continue; }
  const r = await call('POST', '/inventory/sell', { roleEquipId: x.id, confirmed: true });
  console.log('卖仓库', x.name, JSON.stringify(r));
  sold++;
}

// 3) 25 个挂单：下架 + factor 折价重挂
const c = await call('POST', '/consignment/clearance', { factor, dryRun: false });
console.log('挂单整理', JSON.stringify(c).slice(0, 2000));

console.log('\n完成。建议再跑一次 GET /inventory/plan 复核，并 POST /gear 看官方评分。');
