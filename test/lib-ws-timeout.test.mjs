// test/lib-ws-timeout.test.mjs —— WS 一直连不上时 open() 必须超时失败，不能永久挂起
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TL_WS_URL = 'ws://127.0.0.1:1';
process.env.TL_WS_OPEN_TIMEOUT = '600';
const { createSession } = await import('../core/lib-ws.mjs');

test('open() 对不可达 WS 在超时后 reject（不永久挂起）', async () => {
  const s = createSession();
  const t0 = Date.now();
  await assert.rejects(() => s.open(), /open timeout|login fail|enter fail|ECONNREFUSED|closed/i);
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `应快速失败，实际 ${ms}ms`);
  assert.equal(s.state.closed, true);
  try { s.close(); } catch { }
});
