#!/usr/bin/env node
// scripts/scan-features.mjs —— 全量扫描游戏功能
//
// 逻辑：
//   1. 从 gamedata.json 拿所有 NPC
//   2. 从前端包里提取所有 .send("XXX") 协议
//   3. 对比我们已实现的协议，得出缺口
//   4. 对每个未实现协议提取上下文（参数、前置条件）
//
// 用法：
//   node scripts/scan-features.mjs                 # 用缓存的前端包
//   node scripts/scan-features.mjs --refresh       # 重新下载前端包
//   node scripts/scan-features.mjs --json          # 输出 JSON

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const CACHE = path.join(DATA, 'frontend-app.js');
const CACHE_META = path.join(DATA, 'frontend-meta.json');
const GAMEDATA = path.join(DATA, 'gamedata.json');

const args = process.argv.slice(2);
const REFRESH = args.includes('--refresh');
const JSON_OUT = args.includes('--json');

// ── 1. 拉前端包 ────────────────────────────────────────
async function fetchBundle() {
  if (!REFRESH && fs.existsSync(CACHE)) {
    const meta = JSON.parse(fs.readFileSync(CACHE_META, 'utf8'));
    return { path: CACHE, bundle: meta.bundle, cached: true };
  }

  const html = await new Promise((res, rej) => {
    https.get('https://tl.jayczee.top:1212/', { rejectUnauthorized: false, timeout: 15000 }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
    }).on('error', rej);
  });

  const m = html.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
  if (!m) throw new Error('首页里找不到 bundle 名');
  const bundle = m[1];

  const buf = await new Promise((res, rej) => {
    https.get(`https://tl.jayczee.top:1212/assets/${bundle}`, { rejectUnauthorized: false, timeout: 60000 }, r => {
      const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => res(Buffer.concat(chunks)));
    }).on('error', rej);
  });

  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CACHE, buf);
  fs.writeFileSync(CACHE_META, JSON.stringify({ bundle, at: new Date().toISOString(), size: buf.length }, null, 1));
  return { path: CACHE, bundle, cached: false, size: buf.length };
}

// ── 2. 提取协议 ────────────────────────────────────────
function extractProtocols(src) {
  const sends = new Set();
  for (const m of src.matchAll(/\.send\("([A-Z][A-Z0-9_]+)"/g)) sends.add(m[1]);
  return sends;
}

// ── 3. 提取每个协议的上下文 ────────────────────────────
function contextOf(src, proto, span = 300) {
  const out = [];
  for (const m of src.matchAll(new RegExp(`"${proto}"`, 'g'))) {
    const i = m.index;
    out.push(src.slice(Math.max(0, i - span), i + span).replace(/\s+/g, ' '));
    if (out.length >= 2) break;
  }
  return out;
}

// ── 4. 我们已实现的 ────────────────────────────────────
function implementedProtocols() {
  const dirs = ['src', 'core', 'engine', 'scripts'].map(d => path.join(ROOT, d));
  const ours = new Set();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.mjs')) continue;
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of src.matchAll(/\.(?:req|send)\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g)) ours.add(m[1]);
    }
  }
  return ours;
}

// ── 5. NPC 清单 ────────────────────────────────────────
function npcList() {
  try {
    const g = JSON.parse(fs.readFileSync(GAMEDATA, 'utf8'));
    const out = [];
    for (const m of g.maps || []) {
      for (const n of m.npcs || []) {
        out.push({ map: m.name, mapId: m.id, id: n.id, name: n.name });
      }
    }
    return out;
  } catch { return []; }
}

// ── 主流程 ─────────────────────────────────────────────
const { bundle, cached } = await fetchBundle();
const src = fs.readFileSync(CACHE, 'utf8');
const all = extractProtocols(src);
const ours = implementedProtocols();
const missing = [...all].filter(p => !ours.has(p)).sort();
const npcs = npcList();

// 分类：系统级不算功能缺口
const SYS = new Set(['LOGIN','RECONNECT','CREATE_ROLE','CHAT_SEND','CHAT_HISTORY','CREDIT_CONFIG','CREDIT_HISTORY','CREDIT_QUERY_ORDER','CREDIT_RECHARGE','CREDIT_WITHDRAW']);
const functional = missing.filter(p => !SYS.has(p));

const report = {
  at: new Date().toISOString(),
  bundle,
  cached,
  counts: { total: all.size, implemented: ours.size, missing: missing.length, functional: functional.length },
  npcs,
  missing: functional.map(p => ({ protocol: p, context: contextOf(src, p) })),
  system: missing.filter(p => SYS.has(p)),
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 1));
  process.exit(0);
}

console.log(`前端包: ${bundle}${cached ? '（缓存）' : '（新下载）'}`);
console.log(`协议总数 ${all.size} ｜ 已实现 ${ours.size} ｜ 未实现 ${missing.length}（其中功能类 ${functional.length}）\n`);

console.log('═══ 所有 NPC ═══');
for (const n of npcs) console.log(`  [${n.map}] ${n.name.padEnd(20)} ${n.id}`);

console.log('\n═══ 未实现的功能协议 ═══');
for (const p of functional) {
  console.log(`\n▸ ${p}`);
  const ctx = contextOf(src, p, 200);
  for (const c of ctx) console.log(`    ${c.slice(0, 320)}`);
}
