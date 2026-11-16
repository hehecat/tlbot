# test/

## 离线测试（安全，不连游戏 WS）

```bash
sh test/run-all.sh
# 或分开跑
node --test test/*.test.mjs
node --experimental-strip-types test/extension-smoke.mjs
```

| 文件 | 覆盖 |
|---|---|
| `redlines.test.mjs` | 六条红线逐条 + 作用域（存仓/换装/出战不误拦）+ T5 禁调表 |
| `state-store.test.mjs` | 状态树、XP/Gold 速率、live_drops、未知包同 cmd≤5 |
| `combat-daemon.test.mjs` | 连续跑批、pause 中断、.halt 静默、换图刷新 revision |
| `logistics.test.mjs` | 阶段 0 dry-run 不发写包、阶段 2 清仓不卖前 2 强、最高资质珍兽不放生 |
| `activities.test.mjs` | 阶段 0 只读、阶段 2 领双倍、塔 enter→打一层→surrender |
| `probe-benchmark.test.mjs` | 面板 / 榜一差距 / ROI（出战珍兽不误报） |
| `extension-smoke.mjs` | 真实加载 `.pi/extensions/tlbot.ts`，5 个 Tool、阶段 0 全部 DRY_RUN |

## 实机测试（会连接真实游戏 WS！）

**前提：旧 v5 必须已停，任何时刻只允许一个 WS。**

```bash
# 阶段 0：只读对账（约 1 秒）
TL_ENABLE_WS=1 node test/phase0-live.mjs

# 阶段 1：接管挂机打满 1 批（默认最多 220 秒）
TL_ENABLE_WS=1 TL_PHASE1_SECONDS=180 node test/phase1-live.mjs
```

输出写到 `logs/phase0-*.json` / `logs/phase1-*.json`。

### 安全停 v5 / 恢复 v5

v5 的 supervisor 会自动拉起，必须按顺序操作：

1. `node -e "process.kill($(cat /tmp/tlbot-v5-supervisor.pid),'SIGTERM')"` 停 supervisor
2. `touch ../tlbot/.halt` 让 v5 在当前战斗批次结束后退出（最多约 200 秒）
3. 确认无 v5 进程：`ps -eo pid,args | awk '$2 ~ /runtime\/node$/ && $3 ~ /combat_v5\.mjs/ {print $1}'`
4. 删除 `/tmp/tlbot-v5-supervisor.pid`（否则 extension 防踢闸门拒绝连接）
5. 测试
6. 恢复：`cd ../tlbot && nohup ./supervise_v5.sh >/dev/null 2>&1 &`

> 注意：`ps` 的 `comm` 在 macOS 上是完整 node 路径，判断 v5 要用 `ps -eo pid,args` 的 `$2/$3`，不要用 `comm=="node"`。
