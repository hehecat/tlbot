# tlbot v2 — 天龙八部全自动托管引擎

独立 Node 引擎（System 1，零 LLM）+ DSH Agent 决策层（System 2）。引擎独占一条 WebSocket，通过 HTTP `127.0.0.1:9527` 暴露状态与控制面；战斗、喝药、拾取、维护、繁殖、升级、换装、挂售全部由确定性代码完成，Agent 只在关键节点做规划与破局。

## 架构

```
engine/runtime.mjs      唯一 WS 持有者：手机登录/战斗守护/维护/日常/自动升级/自动换图/繁殖领取
  ├─ src/state-store.mjs  协议白名单 → 内存状态树（role/bag/warehouse/combat/rates/chat/stats）
  ├─ src/combat-daemon.mjs批次战斗（回血/死亡统计/契约停止条件）
  ├─ src/logistics.mjs    喝药/换装/整理/出售/商店/珍兽/技能
  ├─ src/activities.mjs   日常/塔/伪宋军/合成/强化/熔炼
  ├─ src/strategy.mjs     繁殖/孵化/喂宠/挂售/清仓/召唤
  ├─ src/planner.mjs      Max ΔCP/h 规划器（多资源背包贪心）
  ├─ src/evaluate.mjs     官方 EQUIPMENT_EVALUATE 换装评分
  └─ src/performance.mjs  按 loadout 采样 XP/h、金币/h、击杀/min
engine/http.mjs         控制面（status/plan/gear/pets/auction/tower/chat/inventory/consignment…）
engine/watchdog.mjs     DNS→HTTPS→WS 三探，引擎死了自动拉起
enginectl.sh            main/alt1/alt2 多实例启停（9527/9528/9529，独立 data/log/pid/.halt）
```

## 多实例

```bash
./enginectl.sh start 2                 # 主号 9527, data/
TL_INSTANCE=alt1 ./enginectl.sh start 2  # 小号 9528, data-alt1/, creds.hehecat2.json
TL_INSTANCE=alt2 ./enginectl.sh start 2  # 小号 9529, data-alt2/, creds.hehecat3.json
./enginectl.sh status|logs|stop
```

凭据放 `creds.json` / `creds.<name>.json`（`{"username","password"}`，权限 600），**已被 .gitignore 排除**。

## 安全红线

- 默认零元宝支出；单次金币支出超过总额 30% 会被红线拦截。
- 同进程只允许一条 WS；停进程先 `touch .halt`。
- 换装以服务端官方评分（伤害% + 综合战力%）为准，`itemValue` 只做候选排序。
- 所有写操作落 `data/audit/*.jsonl`，决策落 `data/decisions.jsonl`。

## 运行

```bash
./enginectl.sh start 2
node -e 'fetch("http://127.0.0.1:9527/status/brief").then(r=>r.json()).then(console.log)'
```

详见 `docs/RUNBOOK.md`、`docs/PLAN-MAX-CP.md`。
