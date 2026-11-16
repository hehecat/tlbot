---
name: reverse-explore
description: 天龙八部挂机版的未知协议逆向 SOP 与公式校准 SOP：如何安全探测未识别命令、如何用 data/unknown_packets.jsonl 找线索、如何做快照闸门、如何记录预测 vs 实测偏差。当出现未知协议、公式对不上、需要试探新接口时使用。
---

# 逆向探索 SOP（reverse-explore）

适用：① 发现未知下行协议 ② 需要试探新命令 ③ 战力/伤害公式与实际对不上。

## 0. 铁律（违反一次就可能丢装备/掉线）

```
1. 单账号单会话 —— 任何时刻只允许一条 WS 连接。
   探测前必须确认持有者（v5 / extension）是谁；不要让两条连接同时存在。
2. 探测用 bot_safe_ws_probe（T5），不要手写脚本裸发。
   阶段 0（TL_STAGE<1）它只返回 DRY_RUN —— 这是设计，不是 bug。
3. 不可逆命令（SELL / SMELT / REAPPRAISE / RELEASE）永远先 dry-run。
4. 元宝消耗 > 0 一律先报告（余额为 0，任何消耗都不可能成功）。
5. 禁 pgrep / pkill / kill / launchctl。停进程 = touch .halt。
```

## 1. 发现未知协议

`src/state-store.mjs` 会把所有非白名单下行包写进 `data/unknown_packets.jsonl`，
同一 cmd 最多 5 条（防刷爆）。

```bash
# 有哪些未知协议
jq -r '.type' data/unknown_packets.jsonl | sort | uniq -c | sort -rn

# 看某个包的完整样本
jq -c 'select(.type=="XXX")' data/unknown_packets.jsonl | head -1
```

判读顺序：
1. 包名像不像某个已知命令的响应？`FOO_RESPONSE` → 说明存在 `FOO` 命令
2. `payloadKeys` 里有没有 `role` / `equipments` / `state` / `drops` / `rewards`
3. 有没有 `revision` / `persistenceRevision` → 说明是写操作响应
4. `sample` 里的字段名 → 反推服务端数据结构

## 2. 探测一个新命令（标准流程）

```
① 先读：用已知的读命令拉同类数据（如 GET_LEADERBOARD），确认基线
② 白名单里加它（src/state-store.mjs 的 KNOWN），否则它会被当未知包重复记录
③ T5 探测：
   bot_safe_ws_probe({ cmd:"FOO", payload:{...}, expectWrite:false, dryRun:false })
   → 阶段 0 只会 DRY_RUN；阶段 1+ 才会真发
④ 看返回：
   · 正常数据 → 写进 state-store 的解析分支
   · 报错「未知xxx」→ 参数名错（历史：petId 不是 id）
   · 报错「请到XX处办理」→ 地图前置条件（历史：claim 必须在苏州 map5）
   · 报错「请先结束战斗」→ 需要 COMBAT_STOP
⑤ 成功一次 → 立刻在 AGENTS.md / 对应 SKILL.md 记下接口 + 参数 + 前置条件
```

**参数名猜测优先级**（实测命中率）：
`petId` > `id`；`mapId` > `map`；`bagItemId` > `itemId`；`requestId` 常要 UUID。

**动作名猜测**：`action` 字段是惯例。`PET_COMMAND` 的合法动作集是
list/appraise/feed/deposit/summon/lock/release/claim/hatch/book/rename，
错一个就报「未知珍兽操作」—— 所以报这个错说明**动作名**错，不是参数错。

## 3. 快照闸门（T5 内置，必须理解）

```
before = safeSnapshot()   // { yuanbao, gold, equippedIds, topGearIds, bestPetId }
→ 发包
after  = safeSnapshot()
```

拦截条件：
- `after.yuanbao < before.yuanbao` → 元宝被扣 → 立刻 `lockCmd(cmd)` **永久禁调**
- `expectWrite=false` 且 `equippedIds` 少了 → 装备消失 → 同样永久禁调

被禁调的命令再调用会直接返回 `blockedByRedline`，需要人工确认后才从
`core/redlines.mjs` 的 LOCKED 表里移除（进程重启即清空）。

## 4. 公式校准 SOP（预测 vs 实测）

目标：让 `data/calibration.json` 有真实偏差样本，而不是拍脑袋权重。

```
① 基线：记录当前面板（战力、hp、extAtk、extDef）+ 60 秒固定图击杀数
② 单变量：只换一件装备（或只改一个属性来源）
③ 再测：同样 60 秒同图，记录击杀数 / 死亡 / 承受伤害
④ 算偏差：
   预测击杀 = 基线击杀 × (新攻/旧攻)^α     α 未知，先用 1 做基准
   实测/预测 = 偏差系数 → 写进 calibration.json
⑤ 一次只改一个变量。同时改两件 → 数据作废
```

`data/calibration.json` 建议结构：
```json
{
  "samples": [
    { "at": "2026-11-14T12:00:00Z", "mapId": 10027, "seconds": 60,
      "changed": "武器 燕侯·护 → 北冥刃环",
      "before": { "power": 43285, "extAtk": 1307, "kills": 28 },
      "after":  { "power": 48559, "extAtk": 1945, "kills": 30 },
      "verdict": "外攻 +49% 只换来击杀 +7% → 攻击收益强递减" }
  ]
}
```

已知校准结论（可直接引用，不必重测）：
- 外攻 1307 → 3026（+131%），击杀 28 → 44（+57%）：攻击**明显递减**
- hp 6197 → 4579（−26%），击杀 28 → 32：当前难度**血量不是瓶颈**
- 防御减伤 ≈ 防御/(防御+5000)
- 洛神图：火/毒 +20%，冰/玄 −35%

## 5. 卡死自愈与告警（纯 JS 判定，不烧 token）

Watchdog 三条件（任一触发才唤醒 LLM）：
```
① rates.xpPerHour == 0 持续 30 分钟
② 背包使用率 ≥ 95%
③ calibration 偏差超阈值（|实测/预测 − 1| > 0.3）
```
`store.getSnapshot().health.stalled` 已实现条件 ①的静默判定
（`COMBAT_STATE` 静默 > 30 分钟）。

## 6. 一页速查

```bash
# 未知包统计
jq -r '.type' data/unknown_packets.jsonl | sort | uniq -c | sort -rn

# 掉落累积：某物品哪张图最多
jq '.byMap' data/live_drops.json

# 红线自测（12 例）
node -e 'import("./core/redlines.mjs").then(m=>console.log(m.selfTest()))'

# 阶段 0 只读探测（不连 WS）
TL_DISABLE_WS=1 node -e 'import("./src/state-store.mjs").then(()=>console.log("ok"))'
```
