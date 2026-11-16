# 天龙八部挂机 · tlbot-v2 说明书（Pi Extension 常驻架构）

> 本项目是 `PRD.md` 的实现。唯一入口是 `.pi/extensions/tlbot.ts`。
> 旧目录 `../tlbot/` 是正在跑的 v5 系统，**在新系统验收前不要动它**。

---

## 🚨 绝对禁止（会卡死整个系统 / 踢掉游戏会话）

```
❌ 禁 pgrep / pkill / kill / killall / launchctl   → Bash 通道弹权限确认，卡 5 分钟
❌ 禁 curl / npm / ifconfig / ping                 → 只有 node 的 fetch 稳定
❌ 不得自行新建第二条 WS 连接                        → 单账号单会话，会踢掉主会话
❌ 不得修改 core/lib-ws.mjs 的 persistenceRevision 乐观锁
```

**停进程只用 `touch .halt`**（本项目根目录）。extension 会在 5 秒内停止一切主动发包，
只保留 ws 原生心跳。`.halt` 不会自动删除；确认安全后手动 `rm .halt`。

---

## 环境

```
项目根     $(pwd)
旧系统     ../tlbot（v5 + supervise_v5.sh，仍在跑）
Node       /Applications/Alma.app/Contents/Resources/alma-server/runtime/node
游戏 WS    wss://tl.jayczee.top:1212/ws
账号       creds.json（项目根，core/lib-ws.mjs 自动读取）
```

所有脚本都用上面的 node 绝对路径跑。

---

## 目录

```
core/
  lib-ws.mjs       通信层（persistenceRevision 锁，禁止改逻辑）
  lib-value.mjs    装备价值 / 套装 / 最优配装
  lib-power.mjs    真实战力公式
  redlines.mjs     六条红线断言 + T5 永久禁调表
  sets.json        套装模板
src/
  state-store.mjs      内存状态树 + 协议白名单 + 未知包捕获 + live_drops
  combat-daemon.mjs    战斗循环（pause/resume，零 token）
  logistics.mjs        补药/清仓/配装/商城/镶嵌/鉴定/珍兽/技能
  activities.mjs       日常/塔/刷蛋
  probe-benchmark.mjs  自身 + 榜一对比 + ROI
  verifier.mjs         预测 vs 实测偏差 → data/calibration.json
.pi/
  extensions/tlbot.ts  唯一入口（5 个 Tool）
  skills/              gear-expert / pet-master / reverse-explore
data/
  live_drops.json      实时掉落累积
  calibration.json     属性权重实测修正
  unknown_packets.jsonl 未识别协议（同 cmd 最多 5 条）
  equip-snapshots/     摘/换装备前的 ID 快照
```

---

## 自动巡检（Extension 内部常驻，不依赖外部 shell）

```
/autobot start            # 开启自动巡检（默认 interval 60min）
/autobot stop             # 停止自动唤醒 LLM，挂机循环继续
/autobot interval 30      # 改成 30 分钟
/autobot status
```

- 定时器 + Watchdog（XP 停滞 / 满包 / 校准偏差）通过 `pi.sendUserMessage(..., {deliverAs:"followUp"})` 自唤醒
- 每 8 轮自动巡检且 `GOAL.md` 已更新 → `ctx.compact()` 压缩上下文
- `scripts/pi-host.mjs` 只负责让 pi 进程常驻；巡检/契约调度都在 extension 内部

## 阶段开关（PRD §7）

```bash
TL_STAGE=0   # 只读影子：不写、不挂机（默认）
TL_STAGE=1   # 只接管挂机：daemon 可 start，后勤/日常仍 DRY_RUN
TL_STAGE=2   # 全量接管：后勤/日常/塔/刷蛋可写
```

**WS 三重闸门**（防踢）：

```bash
TL_ENABLE_WS=1    # 必须显式开启
TL_DISABLE_WS=1   # 永远优先，强制关闭
TL_FORCE_WS=1     # 仅当 v5 已确认停掉时，人工绕过 supervisor PID 检测
```

检测到 `/tmp/tlbot-v5-supervisor.pid` 时默认拒绝连接。

---

## 六个 Tool

| Tool | 作用 | 阶段 |
|---|---|---|
| `bot_status_and_benchmark` | 面板 / 速率 / 榜一差距 / ROI / 告警 | 0+ |
| `bot_configure_combat` | start / pause / resume / update | start 需 1+ |
| `bot_run_activity` | daily_tasks / tower / hunt_pet | 2+ |
| `bot_manage_gear_and_pet` | auto_maintain / craft_slot / upgrade_pet / list_auction / **resolve** | 写操作 2+，否则 dry-run |
| `bot_safe_ws_probe` | 未知协议探测 + 元宝/装备快照闸门 | 写操作 2+ |
| `bot_run_contract` | 任务契约：目标/地图/停止条件/金币预算/时限 | 1+ |

### 任务契约（Mission Contract）

```json
{
  "target": "刷满 50 个玄铁",
  "mapId": 10027,
  "monsterId": 117,
  "stopWhen": { "itemId": 501, "count": 50 },
  "maxGoldSpend": 100000,
  "maxMinutes": 30,
  "maxDeaths": 3
}
```

后台纯 JS 执行；完成 / 超时 / 金币超预算 / 死亡超限 / 满包后，`onContractEnd`
通过 `pi.sendUserMessage(..., {deliverAs:"followUp"})` 叫醒 Pi 签发下一张。

### 递归目标解析（T4 action=resolve）

```json
{ "action": "resolve", "params": { "target": "神龙", "count": 1 } }
```

解析顺序：已穿戴 / 背包 / 仓库 → 配方递归 → `data/drops.json` + `data/live_drops.json`
→ 返回 `mapId / monsterId / cat / need / reason`。数据文件：
`templates.json`（_tpl）、`setdata.json`（套装）、`drops.json`、`maps.json`（ENTER_GAME 自动写）。

T5 发送前后对比 `{元宝, 金币, 已穿戴 ID}`：元宝减少或核心装备消失 → 该 cmd 永久禁调。

---

## 红线（core/redlines.mjs，写进代码）

1. 同槽战力前 2 强 → 永不卖 / 永不分解 / 永不放生
2. 珍兽最高资质个体 → 永不放生
3. 单次消耗元宝 > 0 → 先 dry-run 报告，等确认
4. 单次金币消耗 > 当前总额 30% → 拒绝
5. 摘除已穿戴装备 → 必须先写 `data/equip-snapshots/` ID 快照
6. 不可逆操作（熔炼 / 鉴定重掷 / 出售 / 放生）→ 先 dry-run，后执行

自测：`node -e 'import("./core/redlines.mjs").then(m=>console.log(m.selfTest()))'`

---

## 游戏关键机制（已实测）

### 战力公式

```
floor(hp*.3 + mp*.2 + (extAtk+intAtk)*4 + (extDef+intDef)*3
      + (critRate+precision)*5 + (critDef+avoidance)*3
      + 元素攻*2 + 元素防*1.5)
```

### 公式漏掉的（实战更值钱）

```
① 套装 all_atk%（+15~20%，战力完全不计）
② 洛神图被动：火/毒伤 +20%，冰/玄伤 -35%
③ 防御减伤曲线：防御/(防御+5000)
```

### 星级 / 强化 / 熔炼

```
强化只乘 baseStats，不乘 extraStats → 挑装备看基材
强化倍率 {1:10,2:20,3:30,4:45,5:65,6:90,7:120,8:155,9:195}%
熔炼（升星）要求：武器双资质 > 1500
  资质 = appraisalStats.extScore / intScore
  鉴定只对 req>=50 的武器开放
```

### 珍兽（ROI 最高）

```
喂经验给「出战」珍兽，消耗角色经验
实测：4000 万经验 → 战力 +7329（是升技能的 100 倍）
技能升级门槛 2.46 亿/级，完全不值
繁殖：30 级 + 未繁殖过 → deposit 寄托 → 等 1 小时拿二代
MUTANT 变异资质 164-197%，BABY 只有 91-119%
```

### 协议

```
LOGIN {username,password} → ENTER_GAME → ENTER_GAME_RESPONSE（含 role/maps/equipments/bagItems）
写操作外层带 revision = role.persistenceRevision（lib-ws.req 自动带）
ENTER_MAP 会推进 revision 但响应可能不带新值 → 换图后立刻 ENTER_GAME 刷新
战斗结束信号：COMBAT_STATE.stage === 'idle'（preparing/running/idle）
COMBAT_SYNC 每 300ms
```

### 地图

```
10027  丹霞岭         req50  无尽刷怪，80 只/批，最稳
20080  玄武岛·外滩    req1   刷珍兽蛋 + 强化精华 + 技能书
20051  伪宋军领地     req30  50 小怪 + 10 精英 + 1 BOSS
20050  珍珑棋局       req15  需令牌 + 材料
20070  无相浮屠（塔）
5      苏州           req1   云飘飘（珍兽）/ 裁缝
4      洛阳           req1   薛飞（暗器）/ 比武校尉
```

---

## 开发 / 验证

```bash
# 红线单测
node -e 'import("./core/redlines.mjs").then(m=>console.log(m.selfTest()))'

# 模块冒烟（不连 WS）
node -e 'await import("./src/state-store.mjs");await import("./src/combat-daemon.mjs");await import("./src/logistics.mjs");await import("./src/activities.mjs");console.log("ok")'

# 阶段 0（必须先停 v5：touch ../tlbot/.halt）
TL_STAGE=0 TL_ENABLE_WS=1 pi
```

**任何阶段验收不过 → 回滚到上一阶段，不硬推。**

---

## 上线顺序（PRD §7）

1. 阶段 0：停 v5（`touch ../tlbot/.halt`）→ `TL_STAGE=0 TL_ENABLE_WS=1` → 连续 2 小时与 `status5.json` 对账
2. 阶段 1：`TL_STAGE=1` 接管战斗 6 小时，XP/h ≥ 现有水平
3. 阶段 2：`TL_STAGE=2` 全量，跑满 24 小时 + 至少一次自动处置
4. 阶段 3：归档旧目录、删 v5 launchd、验证 `.halt` 5 秒静默
