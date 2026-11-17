# GOAL.md · tlbot-v2 战略看板

> 只保留最新状态 + 最近 10 条决策。历史归档到 `_archive/`。
> 数据源：`goal_state.json`（采集）/ `status5.json`（v5 旧状态）/ `data/calibration.json`。

---

## 目标

真实战力冲到排行榜第一。判据（ABC）：**只看状态有没有可测量变化**（战力 / 等级 / 装备 / 排名），
刷经验跑脚本不算进展。

---

## 最新状态（2026-11-15 11:17，host 已 24/7 接管）

| 项 | 值 |
|---|---|
| 等级 | 56 |
| 战力 | 63,902（host 稳定运行） |
| 金币 | host 挂机中持续增长 |
| 经验 | host 持续挂机 + 契约刷怪 |
| 排名 | #11 / 20 |
| 榜一 | 张无忌 152,761 |
| 差距 | 约 89,000 |
| 装备值 | 82,126（最优 82,597；slot9 同槽多件，自动换装已跳过） |
| 珍兽 | 6 只，最好 乌龟 Lv.40 117.5%，无 MUTANT |
| 告警 | 未知协议 0；校准公式已升级到 v2（旧坏样本不再触发告警） |

### 榜一差距拆解（2026-11-15 06:14 实测）

榜一 张无忌 152,761 / 我 63,227，差 **89,534**；等级同为 56。

| 维度 | 我 | 榜一 | 差 |
|---|---|---|---|
| 装备价值 | 83,313 | 121,445 | -38,132 |
| 星级合计 | 15 | 29 | -14 |
| 强化合计 | 3 | 19 | -16 |
| 宝石数 | 1 | 7 | -6 |
| 出战珍兽 | 乌龟 BABY Lv42 117.5% cp12,714 | 乌龟 MUTANT Lv46 185.75% cp24,187 | 资质 -68.25% |

最大单件缺口：暗器 slot12（飞蝗石 q1 +0 值11,817 vs q4 +6 双宝石 值31,447，差 -19,630），
其次护腕 -4,132、鞋 -4,096、护肩 -4,055、腰带 -3,288、项链 -2,931。
双方均无 2 件以上套装，套装不是当前差距来源。
报告：`logs/gap-2026-11-14T22-14-13-161Z.json`

### 最弱部位 / 卡点

- 强化精华 1 个（塔内商店 100 币/个，或玄武岛）
- 金刚砂 0（重鉴定武器用）
- 无 MUTANT 珍兽；最好资质为 BABY
- 套装 0 套 4 件（all_atk% 未吃到）
- 双资质 >1500 武器：无（最近 1915/948、970/1640，各差一侧）

### 迁移状态

- [x] 新项目目录 `tlbot-v2/`（PRD §2 结构）
- [x] core：lib-ws / lib-value / lib-power / redlines / sets.json
- [x] src：state-store / combat-daemon / logistics / activities / probe-benchmark / verifier
- [x] `.pi/extensions/tlbot.ts`（T1–T5，T6 不注册）
- [x] 3 个 Skill
- [x] data：live_drops / calibration / unknown_packets / equip-snapshots
- [x] 阶段 0 实机抽检（2026-11-14 22:40）：单 WS 只读 815ms，power/level 与 status5 一致，rank #9，gap 54,523
- [x] 阶段 1 实机抽检（2026-11-14 22:47）：接管 10027 打满 1 批 80 只，155s，XP +12,830,864，Gold +40,630，无断连
- [ ] 阶段 0 连续 2 小时验收
- [ ] 阶段 1 连续 6 小时验收
- [x] 阶段 2 实机抽检（2026-11-14 22:59）：后勤 +272 战力，坏换装自动回滚，无丢装备
- [x] 常驻 host 抽检（2026-11-14 23:19）：pi RPC + scheduler，3.7 分钟 2 次自动后勤，LLM watchdog 自动修复 calibration bug
- [x] 2026-11-14 23:29 正式切换到常驻 host（stage 2）；v5 supervisor 已停，保留脚本作回退
- [x] host 首次日常：暗器/双倍/比武/珍兽 OK；珍珑材料不足、伪宋军次数用完；塔因门票 3M > 30% 金币被 R4 拒绝（红线生效）
- [x] host stage 2 连续运行约 1 小时：18+ 批、800+ 杀、跨天日常（珍珑超时/5 场伪宋军清完/塔 R4 拦截）
- [x] host 自动后勤 + watchdog：喂出战珍兽、清仓、双模型回滚、LLM 自动修 calibration bug
- [x] **2026-11-15 06:05 回滚到 v5**：WS 多次 code=4001/1006 断连 + 后勤期间半开连接，power 从 66,996 掉到 62,812；按 PRD「验收不过回滚」原则恢复 v5
- [ ] 阶段 2 连续 24 小时验收（host 已开始 24/7，持续观察）
- [x] 阶段 3 清理（旧 launchd 已 bootout + plist 改名 `.disabled`；旧目录保留作回退）
- [x] `scripts/pi-host.mjs` + `scripts/hostctl.sh`（pi RPC 常驻宿主）
- [x] `src/scheduler.mjs`（后勤 30 分钟 / 跨天日常，纯 JS 零 token）
- [x] `lib-value` 计入强化倍率（lib-power.ENH）、星级（4%/星，待校准）、宝石（gemInfo）；50 项测试全过
- [x] 榜一差距拆解采集（`test/gap-live.mjs`）
- [x] 递归目标解析器（`src/resolver.mjs`，T4 `resolve`）：套装/装备/材料 → 背包/仓库差多少 → 配方递归 → drops/live_drops → mapId+monsterId
- [x] 任务契约（`bot_run_contract` + `CombatDaemon.startContract`）：目标/地图/stopWhen/金币预算/时限，结束自动唤醒 Pi
- [x] `/autobot start|stop|interval|status` + `agent_end` 8 轮压缩；巡检/契约调度在 extension 内部
- [x] 稳定性：批次间主动重连（默认 120s）、后勤前换新会话、半开连接 60s watchdog、open 超时
- [x] 实机验证（2026-11-15 06:50）：maps 42 张、神龙解析到 10027/怪物117、2.5 分钟契约打满 80 只、1 次批次间重连、无断连
- [x] 2026-11-15 11:16 **60 分钟稳定复测 PASS**（host 独占 WS）：基线 63,902 → 63,902，30 批，24 次重连，63 次断连全部自动恢复
- [x] 旧 launchd（ai.alma.tlbot / tlbot-once / goalprobe / tlrank / pigoal）已 bootout 并改名 `.disabled`，v5 不再自动拉起
- [x] host 为唯一 WS 持有者，继续 24/7；auto-loop 5 轮、契约（丹霞岭 bagCount=90）正常运行
- [x] 59 项测试全过

---

## 最近 10 条决策

1. 高频动作全部纯 JS（战斗/吃药/拾取/清仓/配装/喂珍兽），LLM 只在巡检/Watchdog/用户消息时唤醒。
2. 红线从 GOAL.md 散文迁进 `core/redlines.mjs` 断言；所有写操作发包前 `assertSafe()`。
3. 保留 `.halt` 约定，扩展为 5 秒内停止一切主动发包；`AUTOPILOT=off` 只挂机不唤醒 LLM。
4. 删除 T6 `bot_query_knowledge_data`：bash + rg + jq 足够，少一个工具少一份 schema 税。
5. 阶段 0 默认 `TL_STAGE=0` + 三重 WS 闸门，v5 的 supervisor PID 存在时拒绝连接。
6. 换图后立刻 `ENTER_GAME` 刷新 `persistenceRevision`，不新建第二条 WS（单会话约束）。
7. 清仓保留「同槽前 2 强永不卖」硬保险，redlines 再判一次（双保险）。
8. 经验优先喂「出战」珍兽（战力只认出战那只），技能仅在经验 >3000 万时升。
9. 2026-11-14 阶段 0/1/2 实机通过；修 redlines 作用域、ROI 珍兽 id、换装回滚、同槽多件跳过、只喂出战珍兽。
10. 2026-11-15 11:16 host 60 分钟 PASS，旧 launchd 全部停用，v5 不再自动拉起；host 独占 WS 进入 24/7，59 项测试全过。

---

## 巡检循环（每次 LLM 唤醒）

```
1. bot_status_and_benchmark
2. 跨天重置？→ bot_run_activity("daily_tasks") → bot_run_activity("tower")
3. 对照榜一差距 + 最弱 2 部位：
   - 材料够 → bot_manage_gear_and_pet
   - 缺套装件 → 查 data/live_drops.json → bot_configure_combat("update") 切图
   - 等级落后过多 → 切最高 XP/h 图
4. 有未知协议/公式偏差，且挂机稳定 → 加载 reverse-explore 探测
5. 写回本文件（只留最新状态 + 最近 10 条决策）
```

**成本红线**：每小时 LLM 自动唤醒 ≤3 次；单次巡检 ≤8 次工具调用、≤2000 output token；
连续两轮无实质变化只回一行「无变化」。
