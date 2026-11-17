# tlbot-v2 运行手册（System1 / System2 分离）

更新时间：2026-11-16 · 零氪（元宝零支出）· 目标 Max ΔCP/h

## 0. 一句话架构

```
┌───────────────────────────── System 1（引擎，零 token，毫秒-秒级）─────────────────────────────┐
│ engine/runtime.mjs  (Node, 常驻)                                                             │
│  ├─ 战斗循环  combat-daemon   : 打怪/批次重连/心跳                                           │
│  ├─ 后勤调度  scheduler       : 每 30min maintain / 每天 0:10 daily                           │
│  ├─ 繁殖定时  strategy-auto   : depositAt+55min 自动 claim+hatch（本轮新增）                  │
│  ├─ 自愈      watchdog        : ws 断/daemon 停 自动重连（maintain 期间不误触发）              │
│  └─ HTTP 控制面 127.0.0.1:9527 : /status /plan /pets /auction /tower /strategy/*              │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
                    ▲ 只读状态 + 少量独占写（pause→whenIdle→写→resume）
┌───────────────────┴──────────────── System 2（DSH 本 agent，分钟级，事件驱动）──────────────────┐
│ DSH schedule「天龙八部 System2 巡检与决策」每 30 分钟唤醒一次（2 次/小时，符合 ≤3 次红线）        │
│  读 /status/brief + /plan?live=1 → 只在「到点/够钱/够经验/有证据」时执行一个动作 → 记 decisions  │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

原则：高频、确定、可秒级判断的事全部在 System1；需要拍板、跨系统、异常破局的才进 System2。
System2 每次唤醒 ≤8 次工具调用，无变化只回一行。

## 1. 启停与检查

```bash
cd /Users/hehecat/Documents/Alma/2026-11-11/chat-mwbmk2wc/work/tlbot-v2
./enginectl.sh start 2      # 启动（stage=2 全量；先解析 DNS 覆盖 Clash fake-ip）
./enginectl.sh status       # 进程 + /status/brief
./enginectl.sh logs 80      # 最近日志
./enginectl.sh watch        # 启动服务器恢复守护（每 5min DNS/HTTPS/WS 三探）
./enginectl.sh stop         # 优雅停（写 .halt 等静默）
```

- 引擎 PID：`/tmp/tlbot-engine.pid`；watchdog PID：`/tmp/tlbot-watchdog.pid`
- 状态落盘：`tl_status.json`（30s）；审计：`data/audit/YYYY-MM-DD.jsonl`
- 停止只允许 `touch .halt`（5 秒静默）再 `rm .halt`；禁止 pgrep/pkill/kill/killall/launchctl。

## 2. HTTP 控制面（127.0.0.1:9527，无鉴权，只监听本机）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/status` `/status/brief` | 全量/一行状态 |
| GET | `/plan?live=1` | **Max ΔCP/h 规划器**：预算、经验分配、一次性动作、预测 |
| GET | `/raw` | role/装备/背包/技能/珍兽原始快照（不含凭证） |
| GET | `/pets` | 发 `PET_COMMAND list` 的只读珍兽状态（会等服务端） |
| GET | `/auction?page=1&size=100` | 拍卖行只读列表 |
| GET | `/tower` | 无相浮屠状态（层数/门票/封印） |
| GET | `/wushuang` | 双倍经验/天灵丹状态 |
| GET | `/gear` | 配装 + 官方评分建议（20-30s） |
| GET | `/drops?map=&limit=` | 按地图掉落统计（已修地图归属） |
| GET | `/strategy/state` | 繁殖/喂食计时状态 |
| POST | `/strategy/breed/deposit` | 寄托繁殖（苏州，自动腾栏位） |
| POST | `/strategy/breed/claim` | 领取+孵化（55 分钟后） |
| POST | `/strategy/hatch` | 孵蛋 `{max,release}` |
| POST | `/strategy/feed` | 喂出战珍兽 `{amount,petId}`（记录 power 前后） |
| POST | `/strategy/wushuang` | 用天灵丹 `{use}` |
| POST | `/tower/run` | 跑塔 `{maxFloors}`（门票 3M 金币） |
| POST | `/maintain` `/daily` | 手动后勤/日常 |
| POST | `/config` | `{mapId,potionThreshold}` |
| POST | `/reconnect` `/halt` `/unhalt` | 重连/急停/恢复 |

写操作统一走 `exclusive()`：`schedBusy` 防重入 → `daemon.pause()` → 等空闲 → 执行 → 回默认图 → `daemon.resume()`。

## 3. 自动循环（已生效）

### System1（引擎内，零 token）
1. **战斗**：map 10027 丹霞岭，80 只/批，批次间重连（`TL_SESSION_MS` 默认 120s）。
2. **后勤**：每 30 分钟 `maintain`（药/清理/官方评分换装/商店/宝石/珍兽/技能；鉴定 `TL_APPRAISE_BUDGET=0`、熔炼 `TL_SMELT_BUDGET=0` 默认关闭；蓝药按参心丹 id5 判断，不再每轮误买 600 瓶）。
3. **日常**：每天 0:10（`TL_DAILY_HOUR/MINUTE`）。
4. **繁殖**：`strategy.json` 的 `depositAt` 到 55 分钟，自动 `breedClaim()` + 孵化 + 鉴定；每 60s 检查。
5. **自愈**：daemon 停 >180s 或 ws 断 >90s 才拉起；`schedBusy/strategyBusy/paused` 期间不误触发。
6. **看门狗**：引擎进程死且服务器可达 → 自动 `enginectl start 2`。

### System2（DSH schedule，每 30 分钟）
任务名：**天龙八部 System2 巡检与决策**（`this_session`，每 30 分钟）。
每次只做「有证据能拍板」的一件事：领繁殖 / 够 160.8M 经验喂宠 / 空栏孵蛋 / 2h 对比 20080 掉率 / 记录决策。
无变化回一行「无动作：原因」，不消耗额外 token。

唤醒第一步先跑 `node scripts/system2-brief.mjs`：一次拿齐 brief/plan/strategy/pets/tower/drops10027 的紧凑 JSON（≤3KB），再决定动作。

## 4. 当前 ROI 表（planner DEFAULT_ROI，可实测回填）

| 经验去向 | 需求 | ΔCP | CP/M exp | 结论 |
|---|---|---|---|---|
| 喂出战珍兽 Lv51→52 | 160.8M | ~250 | **1.55** | 最优稳定经验去向 |
| 角色 56→57 | 162.8M | ~180 | 1.11 | 次优，暂不投 |
| 技能升级 | 236-255M | ~200 | 0.78-0.85 | 不投 |
| 武器升星 | 880M/星 | ~250 | 0.28 | 默认关闭（`TL_SMELT_BUDGET=0`） |

| 一次性动作 | 成本 | 期望 ΔCP | 说明 |
|---|---|---|---|
| 繁殖 claim（1h） | 5 分钟 | 9000×15% ≈ 1,350 | 高方差；MUTANT 概率待实测 |
| 孵蛋（45 乌龟蛋+39 松鼠蛋+12 螳螂蛋） | 1 分钟/个 | 561/个（3% MUTANT） | 库存 EV 约 53,856；需栏位 |
| 强化武器（有高级精华时） | 1 精华/次 | 629~944/级 | 无精华；元宝禁买 |
| 塔（最高 4 层） | 3M 金币 | ~38/趟 | 金币不够；10 层才解锁 100 印/精华 |
| 官方评分换装 | 免费 | 逐件评分 | 最高置信度，maintain 自动跑 |
| 拍卖行 | 金币 | 逐件评分 | 当前 6 件全 q1 垃圾，无买入 |

## 5. 红线

- **元宝零支出**（用户明确选择）：任何自动动作不得花元宝；planner `yuanbaoPolicy=zero-spend`。元宝余额来自账号日常/活动奖励与拍卖行出售（currency=2 的成交按元宝结算）；当前 985 的构成见成交记录：2026-11-16 03:32 售出「珍兽技能书·凝神」500 元宝（税 5，到账 495，买家张无忌）；历史买入 14 件花 2,788,700 金 + 10 元宝。引擎代码不含元宝购买路径；出售记录用 `GET /consignment/records?type=SELL|BUY` 核对。
- **自动出售/挂售默认关闭**（`TL_AUTOSELL=0`）：cleanup 只做「强件存仓」，不直卖、不挂售；即使开启也排除武器、套装、白蓝以外品质、同槽前 2 强。
- 单条 WS 会话；不得修改 `core/lib-ws.mjs` 的 `persistenceRevision`。
- 禁止 `curl/pgrep/pkill/kill/killall/launchctl`；HTTP 用 node fetch。
- 写操作必须 `exclusive`（先停战、等空闲、回图、恢复战斗）。
- 单次金币 >30% 总额、单次元宝 >0、不可逆操作（卖/熔/放生/鉴定重随）必须人工或 System2 明确拍板。
- 装备评分只信服务端 `EQUIPMENT_EVALUATE`；`computePower` 不含星级/鉴定，别用它估价。

## 6. 数据与校准

- `data/roi-calibration.jsonl`：每次实测（喂宠/升级/换装/孵蛋）追加一行，System2 回填 `DEFAULT_ROI`。
- `data/decisions.jsonl`：System2 每轮决策一行（ts, action, why, result）。
- `data/strategy.json`：繁殖/孵化/喂食计时。
- `data/audit/*.jsonl`：所有写操作审计（costTotals）。
- `data/live_drops.json`：按地图掉落累计（已修 `state-store.mjs` 归属）。
- `data/calibration.json`：换装预测 vs 实测偏差（v2 n=15，absMean 422 ≈0.6%）。

## 7. 故障处理

| 现象 | 处理 |
|---|---|
| `/status/brief` 无响应 | `./enginectl.sh start 2`；仍失败看 `logs/engine.log` |
| daemon running 但 combat 不动 | 等 60s 自愈；仍不动 `POST /reconnect` |
| maintain 后长期停战 | 看日志是否卡在 gems/appraise/pets；`POST /combat/resume` |
| wsClosed=true | 自动重连中；看 5 分钟内是否恢复 |
| 繁殖 claim 失败 | `POST /strategy/breed/claim {force:true}`；栏位满先放生 |
| 想改地图 | `POST /config {"mapId":20080}`；2h 后对比 `/drops` |

## 8. 背包/仓库整理（2026-11-17 新增）

用户要求：背包与仓库各留最好的一半；仓库里更好的装备要取出换上；25 个挂单下架、低价重挂。

- 计划（只读）：`GET /inventory/plan` → `src/inventory-plan.mjs` 纯计算，按槽位合并「已穿+背包+仓库」按 `itemValue` 排序，保留前 50%（至少同槽前二；已穿/套装保护），输出 `upgrade/sellBag/sellWarehouse/protectedSet`。
- 仓库取出：`POST /inventory/withdraw {roleEquipId}` → `WAREHOUSE_WITHDRAW`（协议来自 `data/frontend-app.js`；装备用 `roleEquipId`，堆叠物用 `warehouseItemId+count`）。
- 单件换装：`POST /inventory/equip {roleEquipId}` → `EQUIP_ITEM` + 快照 + 掉战力>200 自动回滚。
- 单件 NPC 卖：`POST /inventory/sell {roleEquipId, confirmed:true}`（绑定件跳过；R6 红线仍校验）。
- 挂单整理：`POST /consignment/clearance {factor:0.5, dryRun:true|false}` → 逐页翻 `/auction` 找 `sellerRoleId=自己` 的在售，全部 `CONSIGNMENT_CANCEL`，再按 `factor` 折价重挂（`sellUnusedGear` 已支持 factor，挂售上限按 25 计）。
- 挂单降价规则（用户 2026-11-17 定）：先 5 折；满 3 小时无成交 → 自动 3 折重挂一次（runtime 每 10 分钟检查 `data/strategy.json` 的 `clearance`，也可 `POST /consignment/clearance/followup {factor:0.3}` 手动触发）。
- **自动整理 + 单次入口**：`POST /inventory/tidy {dryRun:true}` 出计划；`{dryRun:false}` 执行一次（仓库更好件取出换上、背包/仓库按每槽保留一半、多余 q1/q2 NPC 直卖）。maintain 每轮也会自动卖 q1/q2 多余件（不做仓库升级，保持 30 分钟内完成）。
- 一键执行：`node scripts/inventory-cleanup.mjs`（只读）/ `--apply`（换装+卖+下架重挂）。
- 喝药设置：`src/logistics.mjs applyPotionSettings()` 在引擎启动时执行一次，蓝药选 `id5 参心丹`、放 priority 第 1 槽（原 `id12 甘露丹` + 第 6 槽是无效根因）；`potions()` 每轮 maintain 也会校正。

## P0–P3 改造（2026-11-17）
- **P0 统一经验分配器**：`src/allocation.mjs` 每 60s 由 runtime 计算写 `data/allocation.json`；`GET /allocation` 查看 sink/候选/P10。autoLevelUp、暗器自动喂养、maintain 的 pet/skill 投喂都以 `state.alloc` 为准；暗器历史 P10<0.6 时停喂。
- **观测**：`GET /performance?minutes=5..240`（按 loadout 分组，含 deaths/mapId/goldNet/xpPerHour/goldPerHour/killsPerMin）；`/performance` 文件按实例落 `TL_DATA_DIR`。
- **P1**：自动 3 折默认关闭（`TL_CLEARANCE_AUTO=1` 才开）；手动降价 `POST /consignment/reprice {factor,dryRun}`（默认 dry-run）；maintain 事件化：背包装备≥60 或红药<2000 才 30min，否则 2h；红线 R6 已按 op 判定（PET_RELEASE 受控）。
- **P2**：每实例每 5min 写 `ledger.jsonl`；`GET /ledger`；主号 `GET /accounts` 汇总三实例（status+ledger+allocation+totals），只读。
- **P3**：指定交易 `POST /trade/designated/{preview,create,buy}`；`preview` 默认安全；`create` 需 `dryRun:false,confirm:true` 且目标昵称非空；`targetNickname` 定向是否被服务端强约束未实测，先 dry-run。
- 验证：main /accounts 三号 ledger 正常；/allocation 在 exp<203.8M 时 sink=null（攒整级）；/performance 行含 deaths/mapIds。
- 追加：分配器 reserve 按等级缩放（<30 级 5 万，其余 200 万），技能按 unlockLevel 过滤；`/accounts` 带每号下一步建议；成交后 5 分钟内自动补挂 1 件（`CONSIGNMENT_RECORD_LIST` 计数驱动，不降价）。
- 追加：`POST /trade/designated/create` 指定 targetNickname 后，挂单对非目标不可见；实单已验证主号→alt1 成交（sales 记录含 buyer）。`buy` 回包丢失时按 BUY 记录增量做幂等确认。
- 追加：重连会保留断线前地图；alt 启动默认 TL_MAP=10000，autoMap 再按等级上换。
- P2 半自动跨号调拨：`node scripts/transfer.mjs --from 9528 --to 9527 --id <roleEquipId> --price 100`（默认 dry-run），加 `--confirm` 执行；目标号购买后自动 `/settings` 刷新再核对背包与 sales。
- P1 成交基线在启动时读取（`[listing] 成交基线 N`），之后每 5 分钟只对新增成交补挂 1 件；若启动后 5 分钟内成交且进程重启，会丢一次事件（已知限制）。
- 通用公开上架：`POST /consignment/list {roleEquipId,price,currency,targetNickname}`。

- 同槽保护：R1 默认保护已穿 + 每槽第 1；第 2 名仅 q>=3/套装/绑定受保护。`TL_TOP_GEAR_PER_SLOT=1` 只保第 1，`=0` 只保已穿。q1/q2 的第 2 名现在可被清理/挂售。
- P2 自动跨号装备交换：`node scripts/gear-exchange.mjs [--apply --max 1] [--min-q 3]`。流程=三号 /raw 建表→本地职业加权粗筛→指定交易 100 金投递→接收号 /gear 官方评分→`/inventory/equip` 或原路退回；结果写 `data/gear-exchange.jsonl`。已加入 30 分钟巡检第 8 步，每轮最多 1 件，默认目标背包接近上限时跳过。
