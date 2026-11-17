#!/usr/bin/env node
// 从客户端 bundle 提取 NPC 点击路由（纯前端面板映射）并做变更留痕。
// 客户端没有 NPC 交互协议：点击 NPC 只是设置本地面板布尔值，服务端无感知。
// 因此“NPC 功能是否变化”只能从 bundle 的路由逻辑判断。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = process.env.TL_DATA_DIR ? path.resolve(process.env.TL_DATA_DIR) : path.join(ROOT, 'data');
const BUNDLE = path.join(ROOT, 'data', 'frontend-app.js');
const OUT = path.join(DATA, 'npc-routes.json');
const LOG = path.join(DATA, 'npc-route-changes.jsonl');

export function extractNpcRoutes(src) {
  // 找形如 xxx=se=>{if(se.id==="npc_... 的点击路由
  const m = /\{if\(([A-Za-z_$][\w$]*)\.id==="npc_/.exec(src);
  if (!m) return null;
  const start = m.index;
  const snippet = src.slice(start, start + 5000);
  const ids = [...new Set([...snippet.matchAll(/npc_[a-z_]+/g)].map(x => x[0]))];
  const gates = [...snippet.matchAll(/level\|\|0\)<(\d+)/g)].map(x => Number(x[1]));
  return {
    hash: crypto.createHash('sha256').update(snippet).digest('hex'),
    ids,
    gates,
    snippet: snippet.slice(0, 1800),
  };
}

export function checkNpcRoutes(logger = console.log) {
  try {
    if (!fs.existsSync(BUNDLE)) return null;
    const src = fs.readFileSync(BUNDLE, 'utf8');
    const cur = extractNpcRoutes(src);
    if (!cur) return null;
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { }
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), ...cur }, null, 1));
    if (prev && prev.hash !== cur.hash) {
      const added = cur.ids.filter(x => !(prev.ids || []).includes(x));
      const removed = (prev.ids || []).filter(x => !cur.ids.includes(x));
      fs.appendFileSync(LOG, JSON.stringify({
        at: new Date().toISOString(), kind: 'npc_routes_changed',
        from: prev.hash, to: cur.hash, added, removed,
        ids: cur.ids,
      }) + '\n');
      logger(`[update] NPC 路由逻辑变化：新增 ${added.length} / 移除 ${removed.length} / 现有 ${cur.ids.length}`);
    }
    return cur;
  } catch (e) { logger('[update] NPC 路由检测失败:', e?.message || e); return null; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const r = checkNpcRoutes();
  if (!r) { console.log('未找到 NPC 路由'); process.exit(1); }
  console.log(JSON.stringify({ ids: r.ids, gates: r.gates, hash: r.hash.slice(0, 12) }, null, 2));
  console.log('snippet:', r.snippet.slice(0, 400));
}
