# tlbot-v2 TODO（System2 待办与实验队列）

> 更新：2026-11-17 09:0x（Asia/Shanghai）｜维护者：DSH System2
> 硬约束：元宝零支出；禁止 curl/pgrep/pkill/kill/launchctl、第二条 WS；停引擎只 touch .halt。

## P0 正在进行
- [x] SECOND 松鼠已练到 Lv42（160.75%，cp15,269）并自动出战，power 67,459→69,037（+1,578）；Lv42→43 需 2.75 亿经验，已停止投喂。
- [ ] 用户 2026-11-17 报告：自动喝药设置、背包/仓库全满、仓库更好装备未换、25 个挂单太贵。引擎当前按用户指令暂停，等手动结束执行 `scripts/inventory-cleanup.mjs --apply`。
- [ ] 背包/仓库各留最好一半：`GET /inventory/plan` 已实现（按槽 itemValue 排序，保留 50%，保护已穿/前二/套装）；maintain 新增 tidy 自动卖 q<=2 多余件。
- [ ] 25 个挂单下架 + 5 折重挂：`POST /consignment/clearance {factor:0.5}` 已实现，dry-run 默认。
- [ ] 世界聊天情报：`GET /chat?limit=50` 已记录 CHAT_BROADCAST；System2 每次唤醒扫最近 50 条。

## P1 繁殖与珍兽
- [x] 服务端规则确认：**仅 BABY 可繁殖**（原文「仅30级及以上、从未繁殖的宝宝可以寄托」）；SECOND/MUTANT 不能做父母，没有逐代叠加。
- [ ] 下一轮繁殖：把最高资质 BABY（乌龟 119.5% 或 119.25%）练到 30 再寄托；单次开奖目标 SECOND/MUTANT。
- [ ] 2026-11-17 00:36 已领：乌龟 SECOND 160% Lv1 cp2,737（上一轮 118.5% BABY → SECOND）。
- [ ] 蛋策略修正：蛋只出 BABY（25 样本，最高 119.25），不再批量孵化；只留资质最高的 1-2 只练到 30 当繁殖素材。
- [ ] MUTANT 目标：164-197%；繁殖出 SECOND 已确认，MUTANT 概率待样本。

## P1 装备/资源
- [ ] 挂售位管理（25 上限）：滞销旧挂单下架→按行情重挂；每卖出一件释放一个位。
- [x] 仓库抓取已修（`state-store` 读 ENTER_GAME.warehouse）；`WAREHOUSE_WITHDRAW` 协议已从 bundle 找到。
- [ ] 仓库扩容/清理：紫装与套装优先存仓，仓库满时先清 q1/q2 弱件。
- [ ] 拍卖行扫描：每次唤醒查 /auction，只买「同槽 itemValue 明显高于已穿且 官方评分确认提升」的件。
- [ ] 塔（3M 金币入场）：金币攒够后跑塔拿无相印（58→100 换高级强化精华）；当前金币约 75 万。
- [ ] 玄武岛 20080 掉率对比 10027（高级强化精华/珍兽蛋），需 2h 样本，由 System2 定时切图采集。

## P2 系统/工程
- [ ] `docs/TODO.md` 并入 System2 唤醒流程（每次读本文件，更新勾选）。
- [ ] 回填 DEFAULT_ROI 实测值：宠物升级 8.6~53 CP/M（随等级下降）、金币 253k/h、经验 60M/h。
- [ ] 安全自动出售规则：只卖同模板重复低价值件 + 官方评分确认无用；默认 dry-run，用户批准后启用。
- [ ] 修 `state-store` 蛋计数不刷新（孵化后 /raw count 未更新）。
- [ ] 看门狗/引擎 24/7：确认 watchdog 常驻与重启自愈；DSH schedule 每 30 分钟巡检。
- [x] 文档：RUNBOOK 已补 /inventory/plan、/inventory/withdraw、/inventory/equip、/inventory/sell、/consignment/clearance。

## 实验记录（data/roi-calibration.jsonl）
- 2026-11-16：SECOND Lv1→11 用 2M exp，cp+2,489（1,244 CP/M，低等级段）。
- 2026-11-16：SECOND Lv11→33 用 137.7M exp，cp+7,320（53 CP/M）。
- 2026-11-16：SECOND Lv33→34 用 36.6M exp，cp+316（8.6 CP/M，边际递减）。
- 2026-11-16：25 个蛋全部 BABY，无 SECOND/MUTANT。
