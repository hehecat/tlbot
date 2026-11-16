# tlbot

一个《天龙八部》网页版的自动化挂机引擎。基于 WebSocket 协议逆向，模块化设计，支持 7×24 无人值守。

不依赖任何浏览器自动化 —— 直接跟游戏服务端对话。

```
WebSocket ──> state-store ──> combat-daemon ──> 打怪循环
                    │
                    ├──> logistics ──> 补药/清仓/配装/鉴定/喂珍兽
                    ├──> activities ──> 日常/副本/爬塔/刷蛋
                    └──> probe-benchmark ──> 状态采集 + 排行榜对比
```

## 特点

- **零 LLM 挂机** —— 战斗和后勤是纯 JavaScript 内存循环，不烧 token。LLM 只在需要做战略决策时介入
- **模块化** —— 6.6k 行拆成 8 个业务模块 + 5 个核心库，不是一个大脚本
- **红线保护** —— 卖装备、放生珍兽、花元宝等不可逆操作前强制过断言，防止自动化误伤
- **实测校准** —— 每次换装记录「预测收益 vs 实际战力变化」，偏差超阈值会告警
- **断线自愈** —— 指数退避重连，会话被服务端撤销也能恢复

## 快速开始

```bash
# 1. 装依赖
npm install

# 2. 配账号
cp creds.example.json creds.json
# 编辑 creds.json 填入你的账号密码

# 3. 跑起来
scripts/hostctl.sh start

# 看状态
scripts/hostctl.sh status
scripts/hostctl.sh logs
```

如果不用 `creds.json`，也可以走环境变量：

```bash
TL_USER=your_account TL_PASS=your_password scripts/hostctl.sh start
```

## 目录结构

```
core/
  lib-ws.mjs         WebSocket 会话封装（persistenceRevision 乐观锁）
  lib-value.mjs      装备价值模型（属性权重 / 套装加成 / 配装最优解）
  lib-power.mjs      战力公式
  redlines.mjs       红线断言（不可逆操作前强制检查）
  sets.json          52 个套装定义

src/
  state-store.mjs    内存状态树 + 协议白名单 + 未知包捕获
  combat-daemon.mjs  战斗循环（可 pause/resume）
  logistics.mjs      后勤：补药 → 清仓 → 配装 → 商城 → 宝石 → 鉴定 → 珍兽 → 技能
  activities.mjs     日常任务 / 副本 / 爬塔 / 刷珍兽蛋
  probe-benchmark.mjs 状态采集 + 排行榜差距分析
  verifier.mjs       预测 vs 实测偏差记录
  resolver.mjs       目标解析
  scheduler.mjs      纯 JS 定时调度

scripts/
  pi-host.mjs        常驻宿主（可选，整合 Pi coding agent）
  hostctl.sh         启动/停止/状态/日志
  stability-watch.mjs 稳定性看门狗

.pi/
  extensions/tlbot.ts  把引擎暴露成 LLM 可调用的工具
  skills/              领域知识（配装 / 珍兽 / 逆向探测）
```

## 核心概念

### 单账号单会话

游戏服务端只允许一个 WebSocket 连接。第二条连接会把第一条踢掉（`4001 Session replaced`）。

**这是整套设计的根本约束。** 所以：

- 同一时刻只允许一个进程持有 WS
- 切换系统前必须先停旧的，否则两边互相踢
- 启动脚本会检查是否有旧进程的 pidfile

### 战斗循环的完成判定

游戏地图分两种：

- **普通地图** —— 无尽刷怪，`total` 是一批上限（通常 80）
- **副本** —— 固定波次

判断一批打完不能只看 `defeated >= total`，因为连接后首帧可能带上一批的残留进度。正确的判定是：

1. 必须先观察到 `defeated < total`（证明这批真的在打）
2. 然后 `defeated >= total` 才算打完
3. `stage === 'idle'` 连续出现 3 次也算结束
4. `preparing` 超过 25 秒要重发 `COMBAT_START`（服务器偶尔会漏）

### 战力公式

服务端返回的 `combatPower` 有水分，真实强度要自己算：

```
hp*0.3 + mp*0.2 + (extAtk+intAtk)*4 + (extDef+intDef)*3
+ (critRate+precision)*5 + (critDef+avoidance)*3 + 元素攻*2 + 元素防*1.5
```

这个公式漏掉了套装 `all_atk%` 和防御减伤曲线 `def/(def+5000)`，所以 `lib-value.mjs` 里做了补充。

### 珍兽系统

- `form` 分 `BABY`（资质 91–119%）和 `MUTANT`（164–197%）
- 繁殖需要双方 ≥30 级、从未繁殖过、在苏州 `deposit`
- 1 小时后双方各得一只二代

### 强化与熔炼

- 强化只乘 `baseStats`，倍率 = `{1:10, 2:20, 3:30, 4:45, 5:65, 6:90, 7:120, 8:155, 9:195}%`
- 鉴定只对 `req ≥ 50` 的武器开放
- 熔炼要求武器双资质（`extScore` 和 `intScore`）都 > 1500
- **已鉴定的武器可以重掷资质**，代价 1 个金刚砂

## 配置

全部走环境变量：

| 变量 | 说明 | 默认 |
|---|---|---|
| `TL_USER` / `TL_PASS` | 账号密码 | — |
| `TL_WS_URL` | 游戏服务端地址 | 见 `core/lib-ws.mjs` |
| `TL_MAP` | 挂机地图 ID | 10027 |
| `TL_STAGE` | 运行阶段（0 只读 / 1 接管战斗 / 2 全量） | 0 |
| `AUTOPILOT` | `off` 时只跑循环不唤醒 LLM | `on` |

## 安全红线

`core/redlines.mjs` 里固化了六条，所有写操作发包前强制检查：

1. 同槽战力前 2 强 —— 永不卖、永不分解、永不放生
2. 珍兽最高资质个体 —— 永不放生
3. 单次消耗元宝 > 0 —— 必须先 dry-run
4. 单次金币消耗 > 总额 30% —— 拒绝
5. 摘除已穿戴装备 —— 必须先快照物品 ID
6. 不可逆操作（熔炼 / 重掷 / 出售）—— 先 dry-run

**这些是断言函数，不是文档说明。** 触发就 `throw`，动作不会发出。

## 紧急停止

```bash
touch .halt
```

5 秒内停止一切主动发包。这是最后一道闸，不管系统卡在什么状态都有效。

## 已知限制

- 免费路线的收益天花板很低：强化精华野外不掉、打孔材料只在元宝商城
- 套装很难凑齐（商城刷不到缺失的槽位）
- 熔炼要求双资质 >1500，实测最好只有 1469，差 31
- 炉石（金刚砂）来源有限

## 免责声明

仅供学习 WebSocket 协议和自动化技术使用。请自行承担使用风险，遵守游戏的服务条款。

## License

MIT
