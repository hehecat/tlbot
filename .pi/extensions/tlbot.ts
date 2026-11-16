/**
 * .pi/extensions/tlbot.ts —— 天龙挂机唯一入口（PRD §1/§3/§4）
 *
 * 架构（D1）：
 *   pi 进程
 *    └── tlbot.ts
 *         ├── 唯一 ws（core/lib-ws.mjs，persistenceRevision 乐观锁禁止改动）
 *         ├── CombatDaemon（src/combat-daemon.mjs，Node 内存循环，零 token）
 *         ├── logistics / activities / probe-benchmark / verifier
 *         └── 5 个 Tool（T6 已按 PRD 删除，不注册）
 *
 * 阶段（PRD §7，TL_STAGE）：
 *   0  只读影子：不写、不挂机；T1/T5 可读，写操作一律 DRY_RUN
 *   1  只接管挂机：daemon 可 start；后勤/日常仍 DRY_RUN
 *   2  全量接管：后勤/日常/塔/刷蛋全部可写
 *
 * WS 开关（单账号单会话，防踢）：
 *   必须显式 TL_ENABLE_WS=1；TL_DISABLE_WS=1 永远优先；
 *   检测到 /tmp/tlbot-v5-supervisor.pid 时默认拒绝连接（TL_FORCE_WS=1 可人工绕过）。
 *
 * 禁忌（PRD §9 / AGENTS.md，写进代码）：
 *   · 禁 pgrep / pkill / kill / launchctl（Bash 通道会卡死）
 *   · 停进程用 touch .halt，不用信号
 *   · 不得自建第二条 WS 连接
 *   · 不得修改 core/lib-ws.mjs 的 persistenceRevision 乐观锁
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";

// @ts-ignore - .mjs 无类型声明（pi 用 node strip-types 直接跑）
import { createSession } from "../../core/lib-ws.mjs";
// @ts-ignore
import { initStore } from "../../src/state-store.mjs";
// @ts-ignore
import { probeAll } from "../../src/probe-benchmark.mjs";
// @ts-ignore
import { CombatDaemon, isHalted, HALT_FILE } from "../../src/combat-daemon.mjs";
// @ts-ignore
import { createLogistics } from "../../src/logistics.mjs";
// @ts-ignore
import { createActivities } from "../../src/activities.mjs";
// @ts-ignore
import { calibrationHealth, readCalibration } from "../../src/verifier.mjs";
// @ts-ignore
import { decideActions, loadState as loadSched, saveState as saveSched, dateKey } from "../../src/scheduler.mjs";
// @ts-ignore
import {
  assertSafe, safeSnapshot, assertNotLocked, lockCmd, isLocked, lockedCmds, RedlineError,
} from "../../core/redlines.mjs";

// ── 阶段 / 开关 ────────────────────────────────────────────
const STAGE = Number(process.env.TL_STAGE ?? 0);
const AUTOPILOT = (process.env.AUTOPILOT ?? "on").toLowerCase() !== "off";
const MAINT_MS = Number(process.env.TL_MAINTENANCE_MS || 30 * 60_000);
const DAILY_HOUR = Number(process.env.TL_DAILY_HOUR ?? 0);
const DAILY_MINUTE = Number(process.env.TL_DAILY_MINUTE ?? 5);
const SUP_PID = "/tmp/tlbot-v5-supervisor.pid";
const v5HoldsSession = () => { try { return fs.existsSync(SUP_PID); } catch { return false; } };
const WS_DISABLED =
  process.env.TL_DISABLE_WS === "1" ||
  process.env.TL_ENABLE_WS !== "1" ||
  (v5HoldsSession() && process.env.TL_FORCE_WS !== "1");

const ROOT = process.env.TL_ROOT || path.resolve(import.meta.dirname, "../..");
const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch { return null; } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// ⚠️ RPC 模式下 stdout 是 JSONL 协议流，日志绝不能写 stdout。
const EXT_LOG = path.join(ROOT, "logs", "extension.log");
const log = (...a: any[]) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] [tlbot] ` + a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ");
  try { fs.mkdirSync(path.dirname(EXT_LOG), { recursive: true }); fs.appendFileSync(EXT_LOG, line + "\n"); } catch { }
  try { console.error(line); } catch { }
};

// ── 自动巡检状态（持久化，防重启丢轮次）─────────────────────
const AUTO_STATE_FILE = path.join(ROOT, "data", "autoloop.json");
function loadAutoState(): any {
  try { return JSON.parse(fs.readFileSync(AUTO_STATE_FILE, "utf8")); } catch { return {}; }
}
const _auto0 = loadAutoState();
let patrolRounds = Number(_auto0.patrolRounds || 0);
let lastCompactionAt = Number(_auto0.lastCompactionAt || 0);
let autoRunPending = false;
let compacting = false;
function saveAutoState() {
  try {
    fs.mkdirSync(path.dirname(AUTO_STATE_FILE), { recursive: true });
    fs.writeFileSync(AUTO_STATE_FILE, JSON.stringify({
      autobotEnabled, patrolMs, patrolRounds, lastCompactionAt,
      updatedAt: new Date().toISOString(),
    }, null, 1));
  } catch { }
}

// ── 运行时（唯一 ws + 依赖它的模块）─────────────────────────
type Runtime = {
  ws: any; store: any; daemon: any; logistics: any; activities: any;
  reconnect: () => Promise<void>;
  connectedAt: number;
  _reconnectPromise?: Promise<void> | null;
};

let rt: Runtime | null = null;
let opening: Promise<Runtime | null> | null = null;
let lastError: string | null = null;
let wantDaemon = false;
let daemonConfig: any = {};
let reconnectAt = 0;
let reconnectAttempt = 0;
let schedState = loadSched();
let schedBusy = false;
let lastPatrolAt = Date.now();
let autobotEnabled = process.env.TL_AUTOBOT != null
  ? String(process.env.TL_AUTOBOT).toLowerCase() !== "off"
  : (_auto0.autobotEnabled ?? true);
let patrolMs = Number(process.env.TL_PATROL_MS || _auto0.patrolMs || 60 * 60_000);
const RECONNECT_DELAYS = [3000, 6000, 12000];

function buildRuntime(ws: any, initialGame: any = null): Runtime {
  // 每次（重）连接后尽快跑一次后勤：断线可能丢失出战珍兽/临时状态，需重新召唤/校正
  if (STAGE >= 2) schedState.lastMaintainAt = 0;

  const r: Runtime = {
    ws, store: null, daemon: null, logistics: null, activities: null,
    connectedAt: Date.now(), _reconnectPromise: null,
    reconnect: async () => { },
  };

  const makeStore = (w: any, g: any) => {
    const st = initStore(w);
    if (g) { try { st.ingest(g); } catch { } }
    return st;
  };
  const makeServices = () => {
    r.logistics = createLogistics(r.ws, r.store, { log, stage: STAGE, allowWrite: STAGE >= 2 });
    r.activities = createActivities(r.ws, r.store, { log, stage: STAGE, allowWrite: STAGE >= 2 });
  };

  r.store = makeStore(ws, initialGame);

  // ★ 批次间重连：关闭旧会话 → 新会话 → 同步更新 daemon/logistics/activities
  r.reconnect = async () => {
    if (r._reconnectPromise) return r._reconnectPromise;
    r._reconnectPromise = (async () => {
      const oldWs = r.ws, oldStore = r.store;
      try { oldStore?.close?.(); } catch { }
      try { oldWs?.close(); } catch { }
      // 给服务器时间释放旧会话，避免新连接被 1006 连续踢
      await sleep(2000);
      const nws = createSession() as any;
      const g = await nws.open();
      const nstore = makeStore(nws, g);
      r.ws = nws; r.store = nstore;
      r.connectedAt = Date.now();
      if (r.daemon) {
        r.daemon.ws = nws;
        r.daemon.store = nstore;
        r.daemon.sessionAt = Date.now();
      }
      makeServices();
      log('WS 已重连（新会话）');
    })().finally(() => { r._reconnectPromise = null; });
    return r._reconnectPromise;
  };

  r.daemon = new CombatDaemon(r.ws, r.store, {
    log,
    reconnect: () => r.reconnect(),
    onContractEnd: (contract: any, result: any) => {
      const msg = `[tlbot contract] ${contract.id} 结束：${result?.reason || '完成'}。` +
        `target=${contract.target} map=${contract.mapId} 进度=${JSON.stringify(result?.progress || {})}。` +
        `请调用 bot_status_and_benchmark 检查，然后签发下一张 bot_run_contract；若该停止就说明原因。`;
      log(`[contract] 结束回调：${result?.reason || '完成'}`);
      if (autobotEnabled && AUTOPILOT && !isHalted()) {
        autoRunPending = true;
        try { piRef?.sendUserMessage(msg, { deliverAs: "followUp" }); } catch (e: any) { autoRunPending = false; log('contract 唤醒失败', e?.message || String(e)); }
      }
    },
  });
  if (daemonConfig && Object.keys(daemonConfig).length) r.daemon.configure(daemonConfig);
  makeServices();
  if (wantDaemon && STAGE >= 1 && AUTOPILOT && !isHalted()) r.daemon.start();
  return r;
}

function destroyRuntime() {
  if (!rt) return;
  // 先停旧 daemon，否则重连后旧循环还在跑（发到已关闭的 ws，白耗 CPU）
  try { rt.daemon?.stop?.(); } catch { }
  try { rt.store?.close?.(); } catch { }
  try { rt.ws?.close?.(); } catch { }
  rt = null;
}

async function getRuntime(): Promise<Runtime | null> {
  if (WS_DISABLED) return null;
  if (rt) {
    if (!rt.ws?.state?.closed) return rt;
    // daemon 在跑时让它自己在批次间重连；否则这里直接换会话
    if (rt.daemon?.running) return rt;
    try {
      await rt.reconnect();
      return rt;
    } catch (e: any) {
      lastError = `WS 重连失败: ${e?.message || e}`;
      log(lastError);
      return null;
    }
  }
  if (opening) return opening;
  opening = (async () => {
    try {
      destroyRuntime();
      const ws = createSession() as any;
      const initialGame = await ws.open();
      rt = buildRuntime(ws, initialGame);
      reconnectAttempt = 0;
      lastError = null;
      log(`WS 已连接 stage=${STAGE}`);
      return rt;
    } catch (e: any) {
      lastError = `WS 连接失败: ${e?.message || e}`;
      log(lastError);
      rt = null;
      return null;
    } finally { opening = null; }
  })();
  return opening;
}

// 断线自动重连：3s / 6s / 12s 指数退避；重连后恢复挂机状态
setInterval(async () => {
  if (WS_DISABLED || isHalted()) return;
  if (opening) return;

  if (rt && !rt.ws?.state?.closed) {
    // 半开连接：daemon 在跑但 60s 没有任何下行包 → 主动关闭，让 daemon 批次间重连
    if (STAGE >= 1 && rt.daemon?.running && !schedBusy) {
      const last = rt.store?.st?.lastPacketAt ? Date.parse(rt.store.st.lastPacketAt) : null;
      if (last && Date.now() - last > 60_000) {
        log(`60s 无下行包（半开连接）→ 强制关闭 ws`);
        try { rt.ws.close(); } catch { }
      }
    }
    return;
  }

  if (rt?.ws?.state?.closed) {
    log(`WS 已断开 code=${rt.ws.state.closeCode ?? '?'} reason=${rt.ws.state.closeReason || ''}`);
    // daemon 在跑：交给它批次间重连，避免这里 stop 掉它
    if (rt.daemon?.running) return;
  }

  if (Date.now() < reconnectAt) return;
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  reconnectAt = Date.now() + delay;
  reconnectAttempt++;
  log(`重连尝试 #${reconnectAttempt}`);
  if (rt?.ws?.state?.closed) {
    try { await rt.reconnect(); reconnectAttempt = 0; } catch (e: any) { log('重连失败', e?.message || String(e)); }
  } else {
    await getRuntime();
  }
}, 5000).unref?.();

// ── .halt：5 秒内安静（D4）────────────────────────────────
let haltLatched = false;
setInterval(() => {
  const h = isHalted();
  if (h && !haltLatched) {
    haltLatched = true;
    log('.halt 检测到 → 暂停一切主动发包');
    try { rt?.daemon?.pause?.('halt'); } catch { }
    try { rt?.ws?.send?.('COMBAT_STOP'); } catch { }
  } else if (!h && haltLatched) {
    haltLatched = false;
    log('.halt 已移除');
  }
}, 1000).unref?.();

// ── withPaused：后勤/活动执行前必须暂停战斗 ─────────────────
async function withPaused<T>(fn: (r: Runtime | null) => Promise<T>): Promise<T> {
  const r = await getRuntime();
  if (!r) return fn(null);
  const wasRunning = r.daemon.running;
  if (wasRunning) {
    r.daemon.pause('activity');
    await r.daemon.whenIdle(20_000);
  }
  try {
    // 只在连接真的断了才重连。
    // 2026-11-16 修：原逻辑「每 5 分钟强制重连」会和 daemon 的批次间重连打架，
    // 导致 refresh() 的 ENTER_GAME 在会话重建期超时 → 后勤 actions=0 / power=?。
    if (r.ws?.state?.closed) {
      await r.reconnect();
      // 重连后给服务端一点时间完成会话注册，否则 ENTER_GAME 仍可能扑空
      await new Promise(res => setTimeout(res, 1200));
    }
    return await fn(r);
  } finally {
    if (wasRunning) r.daemon.resume();
  }
}

// ── 离线快照（阶段 0 / WS 关闭时）──────────────────────────
function offlineStatus(extra: Record<string, unknown> = {}) {
  const status5raw = readJson("status5.json");
  const status5 = status5raw ? {
    level: status5raw.level, exp: status5raw.exp, money: status5raw.money,
    power: status5raw.power, battles: status5raw.battles, deaths: status5raw.deaths,
    progress: status5raw.progress, lastMaintain: status5raw.lastMaintain,
  } : null;
  const goalState = readJson("goal_state.json");
  const pidNote = v5HoldsSession() ? " / 检测到 v5 supervisor PID 文件" : "";
  return {
    mode: "OFFLINE",
    stage: STAGE,
    wsDisabled: WS_DISABLED,
    reason: WS_DISABLED
      ? "未连接（防踢保护）：TL_DISABLE_WS=" + (process.env.TL_DISABLE_WS ?? "unset") +
        " / TL_ENABLE_WS=" + (process.env.TL_ENABLE_WS ?? "unset") + pidNote
      : (lastError || "WS 未连接"),
    status5,
    goalState: goalState ? {
      at: goalState.at, rank: goalState.rank, total: goalState.total,
      me: goalState.me, pets: goalState.pets, blocks: goalState.blocks,
      gap: goalState.gap, top1: goalState.top1, todo: goalState.todo,
    } : null,
    calibration: calibrationHealth(status5?.power ?? null),
    note: "离线数据来自 status5.json / goal_state.json；实时面板需停 v5 且 TL_ENABLE_WS=1",
    ...extra,
  };
}

function compactSummary(r: Runtime | null) {
  if (!r) return offlineStatus();
  const s = r.store.getSnapshot();
  return {
    at: s.at,
    mode: "LIVE",
    stage: STAGE,
    me: s.me,
    combat: s.combat,
    rates: s.rates,
    pets: s.pets,
    health: s.health,
    calibration: calibrationHealth(s.me?.power ?? null),
  };
}

// ══════════════════════════════════════════════════════════
// T1 bot_status_and_benchmark
// ══════════════════════════════════════════════════════════
const statusTool = defineTool({
  name: "bot_status_and_benchmark",
  label: "Bot Status & Benchmark",
  description:
    "读取天龙挂机当前状态：自身面板（战力/等级/金币/装备值/最弱 2 部位）、珍兽、挂机速率（XP·h / Gold·h）、排行榜 Top1 差距拆解、ROI 方向推荐、告警位（未知协议数 / 卡死标记 / 校准偏差）。只读。",
  promptSnippet: "查看挂机面板、榜一差距与 ROI 方向（只读）",
  promptGuidelines: [
    "Use bot_status_and_benchmark first in every patrol round; it is read-only.",
    "Keep patrol rounds to <=8 tool calls and <=2000 output tokens; if nothing changed since last round, reply with one short line.",
  ],
  parameters: Type.Object({
    includeTop1: Type.Optional(Type.Boolean({ description: "是否拉取排行榜 Top1（默认 true）" })),
    includeShop: Type.Optional(Type.Boolean({ description: "是否扫商城（慢，默认 false）" })),
  }),
  executionMode: "sequential",
  async execute(_id: string, params: any, _signal: any, _onUpdate: any, _ctx: any) {
    const includeTop1 = params?.includeTop1 !== false;
    const includeShop = params?.includeShop === true;
    if (isHalted()) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ mode: "HALTED", stage: STAGE, reason: ".halt 存在：已停止一切主动发包，只保留 ws 心跳", offline: offlineStatus({ includeTop1, includeShop }) }, null, 1) }],
        details: { mode: "HALTED" },
      };
    }
    let r = await getRuntime();
    if (r && r.ws?.state?.closed) {
      try { r = await withPaused(async rr => rr); } catch { r = null; }
    }
    if (!r) {
      return { content: [{ type: "text" as const, text: JSON.stringify(offlineStatus({ includeTop1, includeShop }), null, 1) }], details: { mode: "OFFLINE" } };
    }
    let report: any;
    try {
      report = await probeAll(r.ws, r.store, { allowWrite: STAGE >= 1, includeShop });
    } catch (e: any) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ mode: "LIVE", error: e?.message || String(e), stage: STAGE }, null, 1) }],
        details: { mode: "LIVE", error: true },
      };
    }
    const snap = r.store.getSnapshot();
    const out = {
      mode: "LIVE", stage: STAGE, writeOpsAllowed: STAGE >= 2,
      self: report.self,
      pets: report.pets,
      leaderboard: includeTop1 && report.leaderboard ? {
        rank: report.leaderboard.rank, total: report.leaderboard.total,
        top1: report.leaderboard.top1, top5: report.leaderboard.top5, gap: report.leaderboard.gap,
      } : null,
      gap: report.gap,
      roi: report.roi,
      rates: report.rates,
      combat: { ...report.combat, daemon: r.daemon.status() },
      health: report.health ?? snap.health,
      calibration: calibrationHealth(report.self?.power ?? snap.me?.power ?? null),
      drops: report.drops,
      shop: report.shop,
      crossCheck: report.crossCheck,
      errors: report.errors,
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 1) }], details: { mode: "LIVE", rank: report.leaderboard?.rank ?? null } };
  },
});

// ══════════════════════════════════════════════════════════
// T2 bot_configure_combat
// ══════════════════════════════════════════════════════════
const combatTool = defineTool({
  name: "bot_configure_combat",
  label: "Configure Combat",
  description:
    "控制挂机战斗循环（纯 JS，零 token）：start 开始 / pause 暂停 / resume 恢复 / update 修改地图或喝药阈值。阶段 0 下 start 返回 DRY_RUN。",
  promptSnippet: "启停/暂停挂机战斗，切换地图或喝药阈值",
  promptGuidelines: [
    "Use bot_configure_combat to switch maps only when data/live_drops.json or the benchmark gives a measured reason.",
    "Do not start combat during stage 0; the tool will return DRY_RUN.",
  ],
  parameters: Type.Object({
    action: Type.Union([Type.Literal("start"), Type.Literal("pause"), Type.Literal("resume"), Type.Literal("update")]),
    mapId: Type.Optional(Type.Number({ description: "目标地图 ID，如 10027" })),
    monsterId: Type.Optional(Type.Number()),
    potionThreshold: Type.Optional(Type.Number({ description: "喝药阈值 %，默认 70" })),
  }),
  executionMode: "sequential",
  async execute(_id: string, params: any) {
    const action = params?.action;
    const patch: any = {};
    if (params?.mapId != null) patch.mapId = Number(params.mapId);
    if (params?.monsterId != null) patch.monsterId = Number(params.monsterId);
    if (params?.potionThreshold != null) patch.potionThreshold = Number(params.potionThreshold);
    if (Object.keys(patch).length) daemonConfig = { ...daemonConfig, ...patch };

    if (action === "pause" || action === "resume") {
      // 阶段 0 只读：不接管战斗，pause/resume 都是空操作
      if (STAGE < 1) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ action, mode: "DRY_RUN", stage: STAGE, reason: "阶段 0 不接管战斗" }, null, 1) }], details: { mode: "DRY_RUN" } };
      }
      const r = await getRuntime();
      if (!r) return { content: [{ type: "text" as const, text: JSON.stringify({ action, mode: "OFFLINE", ...offlineStatus() }, null, 1) }], details: { mode: "OFFLINE" } };
      const st = action === "pause" ? r.daemon.pause("tool") : (wantDaemon = true, r.daemon.resume());
      return { content: [{ type: "text" as const, text: JSON.stringify({ action, ...st }, null, 1) }], details: {} };
    }

    if (action === "start") {
      if (STAGE < 1) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ action, mode: "DRY_RUN", reason: "阶段 0：不接管战斗", config: daemonConfig }, null, 1) }],
          details: { mode: "DRY_RUN" },
        };
      }
      if (isHalted()) return { content: [{ type: "text" as const, text: JSON.stringify({ action, error: ".halt 存在，拒绝启动" }) }], details: {} };
      wantDaemon = true;
      const r = await getRuntime();
      if (!r) return { content: [{ type: "text" as const, text: JSON.stringify({ action, mode: "OFFLINE", ...offlineStatus() }, null, 1) }], details: { mode: "OFFLINE" } };
      const st = r.daemon.configure(daemonConfig).running ? r.daemon.status() : r.daemon.start();
      return { content: [{ type: "text" as const, text: JSON.stringify({ action, ...st }, null, 1) }], details: {} };
    }

    // update
    if (action === "update") {
      const r = await getRuntime();
      if (!r) return { content: [{ type: "text" as const, text: JSON.stringify({ action, mode: "OFFLINE", config: daemonConfig }, null, 1) }], details: { mode: "OFFLINE" } };
      const st = r.daemon.configure(patch);
      return { content: [{ type: "text" as const, text: JSON.stringify({ action, ...st }, null, 1) }], details: {} };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: "未知 action" }) }], details: {} };
  },
});

// ══════════════════════════════════════════════════════════
// T3 bot_run_activity
// ══════════════════════════════════════════════════════════
const activityTool = defineTool({
  name: "bot_run_activity",
  label: "Run Activity",
  description:
    "执行日常/塔/刷蛋：daily_tasks（暗器/双倍/比武/珍兽/副本）、tower（无相浮屠）、hunt_pet（玄武岛刷蛋）。内部自动 pause → 执行 → resume，返回战报。阶段 <2 返回 DRY_RUN。",
  promptSnippet: "执行日常、爬塔或刷珍兽蛋（自动暂停/恢复挂机）",
  promptGuidelines: [
    "Use bot_run_activity for daily_tasks only when the day rolled over or the benchmark shows a daily blocker.",
    "bot_run_activity pauses combat automatically; do not call it in parallel with other tools.",
  ],
  parameters: Type.Object({
    activity: Type.Union([Type.Literal("daily_tasks"), Type.Literal("tower"), Type.Literal("hunt_pet")]),
    options: Type.Optional(Type.Any({ description: "daily_tasks: {skip?:[]}；tower: {maxFloors?}；hunt_pet: {rounds?, target?, keep?}" })),
  }),
  executionMode: "sequential",
  async execute(_id: string, params: any) {
    const activity = params?.activity;
    const options = params?.options ?? {};
    if (STAGE < 2) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ activity, mode: "DRY_RUN", stage: STAGE, reason: "阶段 <2：活动未接管", options }, null, 1) }],
        details: { mode: "DRY_RUN" },
      };
    }
    if (isHalted()) return { content: [{ type: "text" as const, text: JSON.stringify({ activity, error: ".halt 存在，拒绝执行" }) }], details: {} };
    return withPaused(async r => {
      if (!r) return { content: [{ type: "text" as const, text: JSON.stringify({ activity, mode: "OFFLINE", ...offlineStatus() }, null, 1) }], details: { mode: "OFFLINE" } };
      let result: any;
      try {
        if (activity === "daily_tasks") result = await r.activities.dailyTasks(options);
        else if (activity === "tower") result = await r.activities.tower(options);
        else if (activity === "hunt_pet") result = await r.activities.huntPet(options);
        else result = { error: "未知 activity" };
      } catch (e: any) {
        result = { error: e?.message || String(e) };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ activity, result }, null, 1) }], details: {} };
    });
  },
});

// ══════════════════════════════════════════════════════════
// T4 bot_manage_gear_and_pet
// ══════════════════════════════════════════════════════════
const gearTool = defineTool({
  name: "bot_manage_gear_and_pet",
  label: "Manage Gear & Pet",
  description:
    "后勤：auto_maintain（补药/清仓/配装/商城/镶嵌/鉴定/珍兽/技能）、craft_slot（单槽最优）、upgrade_pet（喂经验）、list_auction（挂售清仓）、resolve（递归解析目标：背包/仓库差多少、去哪张图刷哪个怪）。所有写操作强制过 core/redlines.mjs；阶段 <2 只出 DRY_RUN 报告。",
  promptSnippet: "自动维护装备与珍兽（红线闸门 + dry-run 报告）",
  promptGuidelines: [
    "Use bot_manage_gear_and_pet with action auto_maintain for routine upkeep; every write is checked by redlines.",
    "Never attempt to sell or release items yourself via bot_safe_ws_probe; bot_manage_gear_and_pet enforces the top-2-per-slot and best-pet rules.",
  ],
  parameters: Type.Object({
    action: Type.Union([Type.Literal("auto_maintain"), Type.Literal("craft_slot"), Type.Literal("upgrade_pet"), Type.Literal("list_auction"), Type.Literal("resolve")]),
    params: Type.Optional(Type.Any({ description: "craft_slot:{slot}；upgrade_pet:{petId?}；resolve:{target,count?}" })),
  }),
  executionMode: "sequential",
  async execute(_id: string, params: any) {
    const action = params?.action;
    const p = params?.params ?? {};
    if (isHalted()) return { content: [{ type: "text" as const, text: JSON.stringify({ action, error: ".halt 存在，拒绝执行" }) }], details: {} };
    return withPaused(async r => {
      if (!r) return { content: [{ type: "text" as const, text: JSON.stringify({ action, mode: "OFFLINE", ...offlineStatus() }, null, 1) }], details: { mode: "OFFLINE" } };
      let result: any;
      try {
        if (action === "auto_maintain") result = await r.logistics.maintain();
        else if (action === "craft_slot") result = await r.logistics.craftSlot(p?.slot);
        else if (action === "upgrade_pet") result = await r.logistics.upgradePet(p?.petId);
        else if (action === "list_auction") result = await r.logistics.listAuction();
        else if (action === "resolve") result = await r.logistics.resolve(p?.target ?? p?.name ?? p, p);
        else result = { error: "未知 action" };
      } catch (e: any) {
        result = { error: e?.message || String(e) };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ action, result }, null, 1) }], details: {} };
    });
  },
});

// ══════════════════════════════════════════════════════════
// T5 bot_safe_ws_probe ⭐
// ══════════════════════════════════════════════════════════
const probeTool = defineTool({
  name: "bot_safe_ws_probe",
  label: "Safe WS Probe",
  description:
    "安全协议探测器：发送前后各做一次 {元宝, 金币, 已穿戴 ID 集合} 快照对比。若元宝减少或核心装备消失且非预期，立即永久禁用该 cmd 并返回错误。阶段 <1 或 expectWrite 时只做红线预检并返回 DRY_RUN，不实际发包。",
  promptSnippet: "探测未知协议（带元宝/装备快照闸门）",
  promptGuidelines: [
    "Use bot_safe_ws_probe only for unknown protocol exploration, never for selling, releasing pets, or spending.",
    "bot_safe_ws_probe is permanently locked for any cmd that reduces yuanbao or loses equipped items unexpectedly.",
  ],
  parameters: Type.Object({
    cmd: Type.String({ description: "协议命令名，例如 CONSIGNMENT_LIST" }),
    payload: Type.Optional(Type.Any({ description: "请求体（对象）" })),
    expectWrite: Type.Optional(Type.Boolean({ description: "是否预期为写操作" })),
    dryRun: Type.Optional(Type.Boolean({ description: "强制 dry-run（默认 true）" })),
  }),
  executionMode: "sequential",
  async execute(_id: string, params: any) {
    const cmd = String(params?.cmd || "");
    const payload = params?.payload ?? {};
    const expectWrite = params?.expectWrite === true;
    const dryRunRequested = params?.dryRun !== false;
    const forceDry = STAGE < 1 || dryRunRequested || expectWrite;

    if (!cmd) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "cmd 必填" }) }], details: {} };
    if (isHalted()) return { content: [{ type: "text" as const, text: JSON.stringify({ cmd, mode: "HALTED", sent: false, reason: ".halt 存在" }, null, 1) }], details: { mode: "HALTED" } };
    if (isLocked(cmd)) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: `命令 ${cmd} 已被永久禁用`, locked: lockedCmds() }) }], details: { blocked: true } };
    }

    // 红线预检（不发包就能判的）
    const precheck: any = { redline: null, error: null };
    try {
      assertNotLocked(cmd);
      const r = assertSafe({ action: cmd, op: cmd, dryRun: true, ...(payload || {}) });
      precheck.redline = { ok: r.ok, notes: r.notes, snapshot: r.snapshot };
    } catch (e: any) {
      if (e instanceof RedlineError) {
        precheck.error = { code: e.code, message: e.message };
        return { content: [{ type: "text" as const, text: JSON.stringify({ cmd, blockedByRedline: precheck.error, sent: false }, null, 1) }], details: { blocked: true, code: e.code } };
      }
      precheck.error = { code: "UNKNOWN", message: e?.message || String(e) };
    }

    if (forceDry) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            cmd, mode: "DRY_RUN", stage: STAGE, sent: false,
            reason: STAGE < 1 ? "阶段 0：不发送任何包" : (expectWrite ? "expectWrite=true 需显式确认" : "dryRun 请求"),
            wouldSend: { type: cmd, payload }, precheck,
          }, null, 1),
        }],
        details: { mode: "DRY_RUN", sent: false },
      };
    }

    let r = await getRuntime();
    if (r && r.ws?.state?.closed) {
      try { r = await withPaused(async rr => rr); } catch { r = null; }
    }
    if (!r) return { content: [{ type: "text" as const, text: JSON.stringify({ cmd, mode: "OFFLINE", sent: false, ...offlineStatus() }, null, 1) }], details: { mode: "OFFLINE" } };

    const src = { ...(r.store.st || {}), role: r.store.st?.role };
    const before = safeSnapshot(src);
    let resp: any = null, thrown: string | null = null;
    try {
      resp = await r.ws.req(cmd, payload, { ms: 10000, revision: expectWrite });
    } catch (e: any) { thrown = e?.message || String(e); }
    const after = safeSnapshot({ ...(r.store.st || {}), role: r.store.st?.role });

    const yuanbaoLost = (before.yuanbao ?? 0) - (after.yuanbao ?? 0);
    const lostEquipped = before.equippedIds.filter((id: number) => !after.equippedIds.includes(id));
    const violations: string[] = [];
    if (yuanbaoLost > 0) violations.push(`元宝 -${yuanbaoLost}`);
    if (lostEquipped.length && !expectWrite) violations.push(`已穿戴装备消失: ${lostEquipped.join(",")}`);

    if (violations.length) {
      lockCmd(cmd, violations.join("; "));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ cmd, sent: true, error: "快照闸门拦截，该 cmd 已永久禁用", violations, before, after, resp }, null, 1) }],
        isError: true, details: { blocked: true, violations },
      };
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          cmd, mode: "LIVE", sent: true, thrown, before, after,
          delta: { yuanbao: (after.yuanbao ?? 0) - (before.yuanbao ?? 0), gold: (after.gold ?? 0) - (before.gold ?? 0) },
          resp,
        }, null, 1),
      }],
      details: { mode: "LIVE", sent: true },
    };
  },
});

// ══════════════════════════════════════════════════════════
// T6 bot_run_contract —— 任务契约（Mission Contract）
// ══════════════════════════════════════════════════════════
const contractTool = defineTool({
  name: "bot_run_contract",
  label: "Run Mission Contract",
  description:
    "给 CombatDaemon 下发一张 JSON 任务契约：target 描述 + mapId + stopWhen（itemId/itemName/count/bagFull/bagCount）+ maxGoldSpend + maxMinutes + maxDeaths。后台纯 JS 执行，完成/超时/死亡/满包后自动唤醒 Pi 签发下一张。阶段 <1 返回 DRY_RUN。",
  promptSnippet: "给后台挂机下发任务契约（目标/地图/停止条件/预算）",
  promptGuidelines: [
    "Use bot_run_contract to hand a concrete 30-minute farming contract to the daemon instead of micromanaging combat.",
    "Set stopWhen.itemId or itemName + count so the daemon knows exactly when to stop; always set maxGoldSpend and maxMinutes.",
  ],
  parameters: Type.Object({
    target: Type.String({ description: "目标描述，例如「刷满 50 个玄铁」" }),
    mapId: Type.Number({ description: "目标地图 ID" }),
    monsterId: Type.Optional(Type.Number()),
    stopWhen: Type.Optional(Type.Object({
      itemId: Type.Optional(Type.Number()),
      itemName: Type.Optional(Type.String()),
      count: Type.Optional(Type.Number()),
      bagFull: Type.Optional(Type.Boolean()),
      bagCount: Type.Optional(Type.Number()),
    })),
    maxGoldSpend: Type.Optional(Type.Number({ description: "金币预算，默认 0（不花钱）" })),
    maxMinutes: Type.Optional(Type.Number({ description: "契约时限，默认 30 分钟" })),
    maxDeaths: Type.Optional(Type.Number({ description: "允许死亡次数，默认 3" })),
  }),
  executionMode: "sequential",
  async execute(_id: string, params: any) {
    if (STAGE < 1) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ mode: "DRY_RUN", reason: "阶段 0 不接管战斗", contract: params }, null, 1) }], details: { mode: "DRY_RUN" } };
    }
    if (isHalted()) return { content: [{ type: "text" as const, text: JSON.stringify({ error: ".halt 存在，拒绝下发契约" }) }], details: {} };
    const r = await getRuntime();
    if (!r) return { content: [{ type: "text" as const, text: JSON.stringify({ mode: "OFFLINE", ...offlineStatus() }, null, 1) }], details: { mode: "OFFLINE" } };
    const money = r.store?.st?.role?.money ?? 0;
    const budget = Number(params?.maxGoldSpend ?? 0) || 0;
    if (budget > money * 0.3) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "R4：maxGoldSpend 超过当前金币 30%", budget, money, limit: Math.floor(money * 0.3) }, null, 1) }],
        isError: true, details: { blocked: true, code: "R4" },
      };
    }
    try {
      const res = r.daemon.startContract({
        target: params?.target, mapId: params?.mapId, monsterId: params?.monsterId,
        stopWhen: params?.stopWhen, maxGoldSpend: budget,
        maxMinutes: params?.maxMinutes, maxDeaths: params?.maxDeaths,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(res, null, 1) }], details: { contract: res.contract?.id } };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e?.message || String(e) }, null, 1) }], isError: true, details: {} };
    }
  },
});

// ══════════════════════════════════════════════════════════
// 定时调度（纯 JS，零 token）：后勤 / 日常 / 塔
// ══════════════════════════════════════════════════════════
setInterval(async () => {
  if (STAGE < 2 || !AUTOPILOT || isHalted()) return;
  if (!rt || rt.ws?.state?.closed) return;

  // 1) 后勤 / 日常（schedBusy 独占会话）
  if (!schedBusy) {
    const actions = decideActions(schedState, Date.now(), {
      maintenanceMs: MAINT_MS, dailyHour: DAILY_HOUR, dailyMinute: DAILY_MINUTE,
    });
    if (actions.length) {
      schedBusy = true;
      try {
        for (const action of actions) {
          if (action === "maintain") {
            const rep = await withPaused(async r => r ? r.logistics.maintain() : null);
            schedState.lastMaintainAt = Date.now();
            saveSched(schedState);
            log(`[sched] 后勤完成 actions=${rep?.actions?.length || 0} blocked=${rep?.blocked?.length || 0} errors=${rep?.errors?.length || 0} power=${rep?.after?.power ?? '?'}`);
          } else if (action === "daily") {
            const res = await withPaused(async r => {
              if (!r) return null;
              const daily = await r.activities.dailyTasks();
              const tower = await r.activities.tower({ maxFloors: Number(process.env.TL_TOWER_FLOORS || 5) });
              return { daily, tower };
            });
            schedState.lastDailyKey = dateKey(Date.now());
            saveSched(schedState);
            log(`[sched] 日常完成 dailyErrors=${res?.daily?.errors?.length || 0} towerErrors=${res?.tower?.errors?.length || 0}`);
          }
        }
      } catch (e: any) {
        log("[sched] 异常", e?.message || String(e));
      } finally { schedBusy = false; }
    }
  }

  // 2) 定时 LLM 巡检（纯 JS 只负责唤醒；预算与 watchdog 共用 ≤3 次/小时）
  //    ★ 必须放在 schedBusy 块外，否则永远被“后勤正在跑”挡住
  if (autobotEnabled && !schedBusy && Date.now() - lastPatrolAt >= patrolMs && canWake()) {
    lastPatrolAt = Date.now();
    wakeTimes.push(lastPatrolAt);
    lastWakeAt = lastPatrolAt;
    autoRunPending = true;
    try {
      piRef?.sendUserMessage(
        "[tlbot 定时巡检] 调用 bot_status_and_benchmark，对照榜一差距和最弱 2 部位；只在有实测依据时执行 1 件最有价值的事（≤8 次工具调用）。需要刷图/刷材料时用 bot_run_contract 下发契约（target/mapId/stopWhen/maxMinutes），不要自己逐条发 COMBAT_*。无实质变化只回一行「无变化」。禁 pgrep/pkill/kill/launchctl；停进程用 .halt。",
        { deliverAs: "followUp" },
      );
      log("[sched] 已发送定时巡检");
    } catch (e: any) { autoRunPending = false; log("[sched] 巡检发送失败", e?.message || String(e)); }
  }
}, 60_000).unref?.();

// ══════════════════════════════════════════════════════════
// Watchdog（纯 JS 判定，≤3 次/小时）
// ══════════════════════════════════════════════════════════
const wakeTimes: number[] = [];
let lastWakeAt = 0;
let lastExp: number | null = null;
let lastGold: number | null = null;
let lastProgressAt = Date.now();
const BAG_CAP = Number(process.env.TL_BAG_CAP || 60);

function canWake() {
  if (!AUTOPILOT || STAGE < 2 || isHalted()) return false;
  const now = Date.now();
  if (now - lastWakeAt < 15 * 60_000) return false;
  const hourAgo = now - 60 * 60_000;
  while (wakeTimes.length && wakeTimes[0] < hourAgo) wakeTimes.shift();
  return wakeTimes.length < 3;
}

function watchdogTick(pi: ExtensionAPI) {
  if (schedBusy) return;   // 日常/后勤正在独占会话，别插队
  if (!rt || rt.ws?.state?.closed) return;
  const st = rt.store.st;
  const exp = st.role?.currentExp ?? null;
  const gold = st.role?.money ?? null;
  if (exp !== lastExp || gold !== lastGold) { lastExp = exp; lastGold = gold; lastProgressAt = Date.now(); }

  const reasons: string[] = [];
  if (Date.now() - lastProgressAt > 30 * 60_000) reasons.push('XP/金币 30 分钟无变化');
  if ((st.bagItems || []).length >= BAG_CAP) reasons.push(`背包 ${st.bagItems.length}/${BAG_CAP}（≥95%）`);
  const ch = calibrationHealth(st.role?.combatPower ?? null);
  if (ch.needsCalibration) reasons.push(`校准偏差 ${(ch.relAbsBias * 100).toFixed(1)}%`);
  if (!reasons.length || !canWake()) return;

  lastWakeAt = Date.now();
  wakeTimes.push(lastWakeAt);
  const s = rt.store.getSnapshot();
  const msg =
    `[tlbot watchdog] ${reasons.join('；')}。` +
    `Lv.${s.me?.level ?? '?'} 战力${s.me?.power ?? '?'} 金币${s.me?.gold ?? '?'} ` +
    `战斗${s.combat?.stage ?? '-'} ${s.combat?.progress ?? ''} 速率${s.rates?.xpPerHour ?? '-'} XP/h。` +
    `请跑一次标准巡检（bot_status_and_benchmark → 必要时 bot_manage_gear_and_pet 或 bot_run_contract），无变化只回一行。`;
  autoRunPending = true;
  try { pi.sendUserMessage(msg, { deliverAs: "followUp" }); } catch { autoRunPending = false; }
}
setInterval(() => { try { watchdogTick(piRef!); } catch { } }, 60_000).unref?.();
let piRef: ExtensionAPI | null = null;

// ══════════════════════════════════════════════════════════
// extension 入口
// ══════════════════════════════════════════════════════════
export default function tlbot(pi: ExtensionAPI) {
  piRef = pi;
  pi.registerTool(statusTool);
  pi.registerTool(combatTool);
  pi.registerTool(activityTool);
  pi.registerTool(gearTool);
  pi.registerTool(probeTool);
  pi.registerTool(contractTool);

  // /autobot start|stop|interval <min>|status —— Extension 内部常驻自唤醒
  pi.registerCommand("autobot", {
    description: "自动巡检开关：start | stop | interval <分钟> | status",
    handler: async (args: string, ctx: any) => {
      const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
      const cmd = parts[0] || "status";
      if (cmd === "start") {
        autobotEnabled = true;
        lastPatrolAt = Date.now() - patrolMs + 10_000;
        saveAutoState();
        try { ctx?.ui?.notify?.(`autobot 已启动 · interval=${Math.round(patrolMs / 60000)}min`, "info"); } catch { }
        autoRunPending = true;
        try {
          pi.sendUserMessage("[autobot] 已启动自动巡检。先调用 bot_status_and_benchmark，再按需下发 bot_run_contract；无变化只回一行。", { deliverAs: "followUp" });
        } catch { autoRunPending = false; }
        return;
      }
      if (cmd === "stop") {
        autobotEnabled = false;
        saveAutoState();
        try { ctx?.ui?.notify?.("autobot 已停止（挂机循环继续，不再自动唤醒 LLM）", "info"); } catch { }
        return;
      }
      if (cmd === "interval") {
        const m = Number(parts[1]);
        if (Number.isFinite(m) && m > 0) { patrolMs = m * 60_000; saveAutoState(); }
        try { ctx?.ui?.notify?.(`autobot interval=${Math.round(patrolMs / 60000)}min`, "info"); } catch { }
        return;
      }
      try {
        ctx?.ui?.notify?.(
          `autobot=${autobotEnabled ? "on" : "off"} interval=${Math.round(patrolMs / 60000)}min rounds=${patrolRounds}/8 pending=${autoRunPending}`,
          "info",
        );
      } catch { }
    },
  });

  // 每 8 轮自动巡检 + GOAL.md 已更新 → 触发压缩，防止 7×24 上下文溢出
  pi.on("agent_end", async (_event: any, ctx: any) => {
    if (!autoRunPending) return;
    autoRunPending = false;
    patrolRounds++;
    saveAutoState();
    log(`[autobot] 巡检轮次 ${patrolRounds}/8`);
    if (patrolRounds < 8 || compacting) return;
    let goalMtime = 0;
    try { goalMtime = fs.statSync(path.join(ROOT, "GOAL.md")).mtimeMs; } catch { }
    if (goalMtime <= lastCompactionAt) {
      log("[autobot] GOAL.md 未更新，暂不压缩");
      return;
    }
    compacting = true;
    lastCompactionAt = Date.now();
    patrolRounds = 0;
    saveAutoState();
    try {
      if (typeof ctx?.compact === "function") {
        ctx.compact({ customInstructions: "保留：目标、当前战力/榜一差距、最近 10 条决策、未完成契约；丢弃重复日志和已完成的探测细节。" });
        log("[autobot] 已触发上下文压缩");
      } else log("[autobot] ctx.compact 不可用，跳过压缩");
    } catch (e: any) {
      log("[autobot] 压缩失败", e?.message || String(e));
    }
    setTimeout(() => { compacting = false; }, 120_000).unref?.();
  });

  // 启动摘要（阶段/WS 状态一眼可见）
  pi.on("session_start", async (_event: any, ctx: any) => {
    try {
      ctx?.ui?.notify?.(
        `tlbot 已加载 · stage=${STAGE} · ws=${WS_DISABLED ? "DISABLED(防踢)" : "enabled"} · autopilot=${AUTOPILOT ? "on" : "off"}`,
        "info",
      );
    } catch { }
    // 阶段 >=1 且显式开启 WS → 自动接管挂机
    if (STAGE >= 1 && !WS_DISABLED && AUTOPILOT && !isHalted()) {
      wantDaemon = true;
      await getRuntime();
    }
  });

  // 每次 LLM 调用前注入一行紧凑状态（PRD §3 context）
  pi.on("context", async (event: any) => {
    if (STAGE < 1 || !AUTOPILOT || isHalted()) return;
    const r = rt;
    if (!r || r.ws?.state?.closed) return;
    const s = r.store.getSnapshot();
    const line =
      `[tlbot/live] stage=${STAGE} Lv.${s.me?.level ?? '?'} 战力${s.me?.power ?? '?'} ` +
      `金币${s.me?.gold ?? '?'} 战斗${s.combat?.stage ?? '-'} ${s.combat?.progress ?? ''} ` +
      `XP/h=${s.rates?.xpPerHour ?? '-'} 未知包=${s.health?.unknown ?? 0} 卡死=${s.health?.stalled ? 'yes' : 'no'}`;
    return { messages: [{ role: "system", content: line }, ...(event.messages || [])] };
  });

  // 压缩前保留关键信息（目标 + 最新状态 + 最近决策）
  pi.on("session_before_compact", async (event: any) => {
    const goal = (() => { try { return fs.readFileSync(path.join(ROOT, "GOAL.md"), "utf8").slice(0, 6000); } catch { return ""; } })();
    const s = rt?.store?.getSnapshot?.();
    const summary =
      "tlbot 压缩摘要（自动生成）\n\n" +
      "## 当前状态\n" + JSON.stringify(compactSummary(rt), null, 1).slice(0, 3000) + "\n\n" +
      "## GOAL.md（节选）\n" + goal;
    return {
      compaction: {
        summary,
        firstKeptEntryId: event.preparation?.firstKeptEntryId,
        tokensBefore: event.preparation?.tokensBefore,
      },
    };
  });

  pi.on("session_shutdown", async () => {
    try { await rt?.daemon?.stop?.(); } catch { }
    destroyRuntime();
  });
}
