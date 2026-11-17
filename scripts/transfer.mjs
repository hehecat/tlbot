#!/usr/bin/env node
// 半自动跨号调拨：源号指定交易上架 → 目标号按 id 购买 → 双端核对。
// 默认 dry-run；加 --confirm 才真正上架/购买。禁止用于元宝交易。
//
// 用法：
//   node scripts/transfer.mjs --from 9528 --to 9527 --id 794906239873329 --price 100
//   node scripts/transfer.mjs --from 9528 --to 9527 --id 794906239873329 --price 100 --confirm
import { argv, exit } from 'node:process';

const args = Object.fromEntries(argv.slice(2).reduce((a, x, i, arr) => {
  if (x.startsWith('--')) a.push([x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return a;
}, []));

const from = String(args.from || '9527');
const to = String(args.to || '9528');
const id = String(args.id || '');
const price = Math.max(100, Math.floor(Number(args.price || 100)));
const confirm = args.confirm === true || args.confirm === 'true';
const base = (p) => `http://127.0.0.1:${p}`;

const jget = async (p, path) => {
  const r = await fetch(base(p) + path);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}${path} HTTP ${r.status}`);
  return j;
};
const jpost = async (p, path, body) => {
  const r = await fetch(base(p) + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
};

const srcRaw = await jget(from, '/raw');
const dstRaw = await jget(to, '/raw');
const srcRole = srcRaw.role || {};
const dstRole = dstRaw.role || {};
// /raw 不含昵称，从 GET_PLAYER_INFO 取
const srcPlayer = await jget(from, `/player?roleId=${srcRole.id}`);
const dstPlayer = await jget(to, `/player?roleId=${dstRole.id}`);
const srcName = srcPlayer?.data?.role?.nickname || '';
const target = dstPlayer?.data?.role?.nickname || '';
if (!target) { console.error('目标角色名为空，无法指定交易'); exit(2); }
const item = (srcRaw.equipments || []).find(e => String(e.id) === id);
if (!item) { console.error(`源号背包找不到装备 ${id}`); exit(2); }

console.log(JSON.stringify({
  dryRun: !confirm, from, to, target, item: { id, name: item.equipTmpl?.name, q: item.quality, bound: item.isBound, equipped: item.isEquipped }, price,
}, null, 1));

const pv = await jpost(from, '/trade/designated/preview', { roleEquipId: id, targetNickname: target, price });
console.log('preview', JSON.stringify(pv));
if (!pv?.ok) { console.error('预览未通过，停止'); exit(3); }
if (!confirm) { console.log('dry-run：加 --confirm 才会真正上架与购买'); exit(0); }

const created = await jpost(from, '/trade/designated/create', { roleEquipId: id, targetNickname: target, price, dryRun: false, confirm: true });
console.log('create', JSON.stringify(created));
if (!created?.ok) { console.error('上架失败'); exit(4); }

// 逐页找自己的挂单（每页实际 6 件）
let listing = null;
for (let p = 1; p <= 60; p++) {
  const j = await jget(from, `/auction?page=${p}&size=100`);
  const arr = j.items || [];
  listing = arr.find(x => String(x.sellerRoleId) === String(srcRole.id) && Number(x.price) === price && String(x.tmplId) === String(item.tmplId));
  if (listing || arr.length < 6) break;
}
if (!listing) { console.error('上架后未在拍卖列表找到挂单（可能被定向隐藏）'); exit(5); }
console.log('listing', JSON.stringify({ id: listing.id, name: listing.itemName, price: listing.price }));

const bought = await jpost(to, '/trade/designated/buy', { consignmentId: listing.id, dryRun: false });
console.log('buy', JSON.stringify(bought).slice(0, 400));

// 双端核对：目标背包出现同 tmplId，源号挂单消失
try { await jget(to, '/settings'); } catch { } // 强制 ENTER_GAME 刷新本地状态
const dstAfter = await jget(to, '/raw');
const got = (dstAfter.equipments || []).find(e => String(e.tmplId) === String(item.tmplId) && !e.isEquipped);
const sales = await jget(from, '/consignment/sales');
const rec = (sales.sales || []).find(x => String(x.buyerRoleId) === String(dstRole.id) && String(x.itemId) === String(item.tmplId) && Number(x.price) === price);
console.log('verify', JSON.stringify({ targetHasItem: !!got, saleRecord: rec ? { id: rec.id, buyer: rec.buyerName, price: rec.price, income: rec.income } : null }));
if (!got) { console.error('核对未通过：目标背包没有新装备'); exit(6); }
if (!rec) console.warn('注意：目标背包已到账，但成交记录暂未查到（服务端记录可能延迟/日切）');
console.log('OK 调拨完成');
