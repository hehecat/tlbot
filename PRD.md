# PRD：天龙 Bot 重构规范（Pi Extension 常驻架构）

> 本文件是**唯一实现依据**。pi 请严格按此执行。
> 设计层已定稿，实现细节由 pi 自行决定。
> 版本：v1 · 2026-11-14

---

## 0. 一句话目标

把当前「多个独立脚本各自连 WS、靠杀进程抢占单会话」的散装系统，重构成
**一个 pi 进程内的常驻 extension**：它持有唯一 WS 连接、在 Node 内存里跑挂机循环、
对外只暴露少数高层 Tool 给 LLM。

**背景硬事实（决定架构的物理约束）：**

- 游戏**单账号单会话**：第二条 WS 连接会踢掉第一条
- 因此**任何时刻只允许一个进程持有 WS**
- `combat_v5.mjs` + supervisor 现在是持有者 → 新系统上线前必须交权

---

## 1. 四条架构决策（已定，勿改）

### D1. pi 进程就是宿主，extension 持有 WS

```
pi 进程（被 supervisor 守护）
 └── tlbot.ts extension
      ├── 唯一 ws 实例（core/lib-ws.mjs）
      ├── CombatDaemon（Node 内存循环，零 token）
      └── 6 个 Tool → 给 LLM 调用
```

**不再有第二个连 WS 的进程。** `combat_v5.mjs`、`once_tasks.mjs`、`tower.mjs`、
`hunt_pet.mjs` 全部降级为被 extension import 的库，或整体退役。

### D2. 后台挂机零 Token（这是成本红线）

```
高频动作（打怪/吃药/拾取/清仓/配装/喂珍兽）  →  纯 JS，永不调 LLM
LLM 只在三种情况被唤醒：
  ① 定时巡检（默认 30 分钟一次）
  ② Watchdog 检测到异常（纯 JS 判定）
  ③ 用户手动发消息
```

**Token 预算上限（必须实现为硬约束）：**

| 项 | 上限 |
|---|---|
| 每小时 LLM 自动唤醒次数 | ≤ 3 次 |
| 单次巡检工具调用数 | ≤ 8 次 |
| 单次巡检输出 token | ≤ 2000 |
| 连续两轮无实质变化 | 只报一行「无变化」，禁止复述 |

**判据（沿用现有 GOAL.md 定义）：ABC 只看状态有没有变，不看有没有在做事。**
刷经验跑脚本不算进展，除非战力/等级/装备/排名出现可测量变化。

### D3. 红线写进代码，不写在 Markdown 里

现有 `GOAL.md` 里的红线是散文，LLM 可能忘。重构后必须变成 `core/redlines.mjs`
里的**断言函数**，所有写操作（卖/分解/放生/花元宝/穿脱）在发包前强制过一遍：

```js
assertSafe({ action: "SHOP_SELL", itemId, item })
// → 不通过则 throw，工具返回明确错误，动作不发出
```

必须固化的红线（从 GOAL.md 迁移）：

1. 同槽战力前 2 强，**永不卖、永不分解、永不放生**
2. 珍兽最高资质个体，**永不放生**
3. 单次操作消耗元宝 > 0 → 必须先 dry-run 报告，等确认
4. 单次金币消耗 > 当前总额 30% → 拒绝
5. 已穿戴装备的摘除 → 必须先备份物品 ID 快照
6. 不可逆操作（熔炼/鉴定重掷/出售）→ 先 dry-run，后执行

### D4. 一键停机必须始终有效

保留现有 `.halt` 文件约定，并扩展：

```
.halt 存在 →  停止一切主动发包（含巡检），只保留 ws 心跳
AUTOPILOT=off →  只跑挂机循环，不唤醒 LLM
```

**要求：无论系统卡在什么状态，`touch .halt` 必须能在 5 秒内让它安静下来。**
这是 7×24 自治系统的最后一道闸，不允许被任何重构稀释。

---

## 2. 目录结构

```
.
├── _archive/                  # v3/v4/orchestrator/bot/test_*/过期 json 全部移入
├── core/
│   ├── lib-ws.mjs             # 通信层（禁止改动 persistenceRevision 锁逻辑）
│   ├── lib-value.mjs          # 价值模型（保留现有导出，补充品质权重）
│   ├── redlines.mjs           # 新增：红线断言（D3）
│   └── sets.json
├── src/
│   ├── state-store.mjs        # 内存状态树 + 协议白名单 + 未知包捕获
│   ├── combat-daemon.mjs      # 战斗循环（可 pause/resume）
│   ├── logistics.mjs          # 鉴定/清仓/配装/商城/喂珍兽
│   ├── activities.mjs         # 日常/塔/刷蛋（自动 pause→执行→resume）
│   ├── probe-benchmark.mjs    # 自身 + 榜一对比 + ROI 方向推荐
│   └── verifier.mjs           # 预测 vs 实测偏差记录
├── data/
│   ├── live_drops.json        # 实时掉落累积（替代过期 drops.json）
│   ├── calibration.json       # 属性权重实测修正
│   └── unknown_packets.jsonl  # 未识别协议样本（同 cmd 最多 5 条）
├── .pi/
│   ├── extensions/tlbot.ts    # 唯一入口
│   └── skills/
│       ├── gear-expert/SKILL.md
│       ├── pet-master/SKILL.md
│       └── reverse-explore/SKILL.md
├── AGENTS.md                  # 环境 + 禁忌（合并 PITFALLS.md）
└── GOAL.md                    # 战略看板（只留最新状态 + 最近 10 条决策）
```

---

## 3. Extension 实现要点（API 已核实，照抄）

**入口形状**（pi 1.5.2 实测）：

```ts
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function tlbot(pi: ExtensionAPI) {
  const store = initStore(ws);
  const daemon = new CombatDaemon(ws, store, logistics);

  const statusTool = defineTool({
    name: "bot_status_and_benchmark",
    label: "Bot Status",
    description: "...",
    parameters: Type.Object({ includeTop1: Type.Optional(Type.Boolean()) }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return { content: [{ type: "text", text: JSON.stringify(snapshot) }] };
    },
  });

  pi.registerTool(statusTool);
}
```

**关键 API（均已确认存在）：**

| 用途 | API |
|---|---|
| 注册工具 | `pi.registerTool(defineTool({...}))` |
| 主动唤醒 LLM | `pi.sendUserMessage(content, { deliverAs: "followUp" })` |
| 注入状态摘要 | `pi.on("context", handler)` |
| 压缩前保留关键信息 | `pi.on("session_before_compact", handler)` |
| 自定义持久化 | `pi.appendEntry(customType, data)` |
| 生命周期 | `pi.on("session_start" \| "session_shutdown", ...)` |

**扩展加载路径（已核实 `loader.js`）：**
项目级 `cwd/.pi/extensions/` **会被自动发现**，无需额外声明。

---

## 4. 六个 Tool 规范

### T1 `bot_status_and_benchmark`
无参或 `{ includeTop1?: boolean }`
返回：自身面板 / 挂机速率（XP·h、Gold·h）/ 最弱 2 部位 / 榜一差距拆解 /
告警位（未知协议数、公式偏差、卡死标记）。

### T2 `bot_configure_combat`
`{ action: "start"|"pause"|"resume"|"update", mapId?, monsterId?, potionThreshold? }`

### T3 `bot_run_activity`
`{ activity: "daily_tasks"|"tower"|"hunt_pet", options? }`
内部自动 `pause → 执行 → resume`，返回战报。

### T4 `bot_manage_gear_and_pet`
`{ action: "auto_maintain"|"craft_slot"|"upgrade_pet"|"list_auction", params? }`
所有写操作强制过 `redlines.mjs`。

### T5 `bot_safe_ws_probe` ⭐
`{ cmd: string, payload: object, expectWrite: boolean }`

**这是整个 PRD 里最有价值的工具，必须完整实现。**
发送前快照 `{ 元宝, 金币, 已穿戴 ID 集合 }` → 发 `ws.req()` → 发送后再快照对比。
若元宝减少或核心装备消失且非预期 → **立即锁定该 cmd 永久禁调**，返回错误。

### T6（已删除）
原 PRD 的 `bot_query_knowledge_data` **不注册为工具**。
理由：pi 有 bash + `rg` + `jq`，读 JSON 不需要额外工具。
每多一个工具，每轮上下文都多一份 schema 税 —— 与 D2 成本红线冲突。

---

## 5. Skills（3 个）

| Skill | 来源 | 作用 |
|---|---|---|
| `gear-expert` | GEAR_RESEARCH.md | 属性权重、元素惩罚、套装凑件优先级、判断树 |
| `pet-master` | PET_SYSTEM.md | 繁殖代数、资质阈值、何时该刷蛋 |
| `reverse-explore` | 新写 | 未知协议 SOP + 公式校准 SOP |

---

## 6. 标准巡检循环（每次 LLM 唤醒执行）

```
1. bot_status_and_benchmark
2. 跨天重置？→ bot_run_activity("daily_tasks") → bot_run_activity("tower")
3. 对照榜一差距 + 最弱 2 部位：
   - 材料够 → bot_manage_gear_and_pet
   - 缺套装件 → 查 live_drops → bot_configure_combat("update") 切图
   - 等级落后过多 → 切最高 XP/h 图
4. 有未知协议/公式偏差，且挂机稳定 → 加载 reverse-explore 探测
5. 写回 GOAL.md（只留最新状态 + 最近 10 条决策）
```

---

## 7. 分阶段上线（**这一节是最重要的，不许跳过**）

现有系统正在跑，战力 6.4 万，不能赌。

### 阶段 0：只读影子模式（必做）

新 extension **只读不写**：
- 连 WS 读状态（此时 v5 必须已停）
- 跑 `probe-benchmark` 出报告
- **不执行任何写操作**，所有 action 返回 `DRY_RUN`

验收：连续 2 小时，`bot_status_and_benchmark` 输出与 `status5.json` 一致，无断连。

### 阶段 1：只接管挂机

- extension 接管战斗循环，后勤仍由旧脚本处理
- 验收：连续 6 小时不掉线、XP/h ≥ 现有水平、无卡死

### 阶段 2：全量接管

- 后勤、日常、塔、刷蛋全部搬入
- 红线断言全部就位
- 验收：跑满 24 小时无人工干预，且发生至少一次自动处置（卡死自愈/异常告警）

### 阶段 3：清理

- `_archive/` 已归档
- 删除 launchd 里 v5 相关 plist
- `.halt` 单手可停验证通过

**任何阶段验收不过 → 回滚到上一阶段，不硬推。**

---

## 8. 验收标准

**功能**
- [ ] 六个工具（T1–T5）全部可调，参数校验正确
- [ ] `bot_safe_ws_probe` 的元宝/装备快照闸门真实生效（造一次非预期消耗，必须被拦）
- [ ] `.halt` 5 秒内静默

**稳定**
- [ ] 断线自动重连（指数退避 3s/6s/12s），重连后恢复到原挂机状态
- [ ] 连续 24 小时无人工干预
- [ ] Watchdog 三条件任一触发能主动唤醒（XP/h=0 超 30 分 / 背包 95% / 校准偏差）

**成本**
- [ ] 单小时 LLM 唤醒 ≤ 3 次
- [ ] 单次巡检工具调用 ≤ 8 次
- [ ] 连续两轮无变化时输出 ≤ 50 字

**安全**
- [ ] `redlines.mjs` 六条红线各有单元测试
- [ ] 同槽前 2 强 / 最高资质珍兽 在测试中被尝试卖出时被拒绝

**数据**
- [ ] `live_drops.json` 能回答「某物品在哪张图掉率最高」
- [ ] `calibration.json` 记录至少 1 条真实换装偏差样本

---

## 9. 禁忌（从 AGENTS.md 继承，必须写进代码注释）

- **禁** `pgrep` / `pkill` / `kill` / `launchctl` —— 在 Bash 通道里会卡死
- 停进程用 `touch .halt`，不用信号
- 改 cron 任务必须走 HTTP API，改 `jobs.json` 无效
- 不得自行新建第二个 WS 连接（会踢掉主会话）
- 不得修改 `lib-ws.mjs` 的 `persistenceRevision` 乐观锁逻辑
