// scripts/resolve-ip.mjs —— 给出游戏服务器的真实 IP（用于 TL_DNS_FIX）
//
// 难点：Clash 的 TUN 模式会劫持所有 53 端口查询（包括显式指定的公共 DNS），
// 所以「查 DNS 绕过 fake-ip」这条路通常走不通 —— 拿回来还是 198.18.x.x。
//
// 因此这里采用三层策略：
//   1. 已知 IP 缓存（data/ws-ip.txt），命中即用
//   2. 直接 TCP 探测已知 IP 的 1212 端口，可用才算数
//   3. 全部失败则不输出，调用方按默认方式连接
//
// 缓存会在连接成功后由引擎写入，形成一个自维护的闭环。

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, 'data', 'ws-ip.txt');
const HOST = process.env.TL_HOST || 'tl.jayczee.top';
const PORT = Number(process.env.TL_PORT_REMOTE || 1212);

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n')
      .map(l => l.trim())
      .filter(l => /^\d+\.\d+\.\d+\.\d+$/.test(l))
      .filter(ip => !ip.startsWith('198.18.') && !ip.startsWith('198.19.'));
  } catch { return []; }
}

function probe(ip, timeoutMs = 3000) {
  return new Promise(resolve => {
    const t = Date.now();
    const s = net.connect({ host: ip, port: PORT, timeout: timeoutMs }, () => {
      s.destroy();
      resolve({ ok: true, ms: Date.now() - t });
    });
    s.on('error', () => resolve({ ok: false }));
    s.on('timeout', () => { s.destroy(); resolve({ ok: false }); });
  });
}

const candidates = readCache();
for (const ip of candidates) {
  const r = await probe(ip);
  if (r.ok) {
    process.stdout.write(`${HOST}=${ip}`);
    process.exit(0);
  }
}
process.exit(0);
