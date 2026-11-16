# tlbot

A WebSocket automation engine for a browser MMORPG. Reverse-engineered protocol, modular design, built for 24/7 unattended operation.

No browser automation — it talks to the game server directly.

```
                   ┌─────────────────────────────────┐
                   │  engine/runtime.mjs             │
                   │    sole WebSocket holder        │
  ┌────────────────┤    combat / logistics / daily   │
  │  agent layer   └──────────────┬──────────────────┘
  │                               │
  │  HTTP :9527                   │  ENTER_GAME returns
  │  ├ /status                    │  the entire game
  │  ├ /gear      ────────────────┤  definition:
  │  ├ /gamedata                  │   · 42 maps
  │  └ /maintain                  │   · 5078 equipment templates
  │                               │   · 52 sets, 76 shop items
  pi · Alma · Claude · curl       │   · skill costs, constants
  └───────────────────────────────┘
```

## What makes it different

**The engine is standalone.** It runs as a plain Node process with zero agent dependencies. Any LLM — or no LLM at all — can drive it over a small HTTP API. If your agent dies, the bot keeps farming.

**Game data is self-discovering.** `ENTER_GAME` returns the full game definition, so there are no hardcoded map tables to maintain. Every reconnect diffs the metadata and logs what changed — map added, drop table changed, shop restocked, constants shifted. Game updates are detected, not manually patched.

**Equipment decisions come from the server.** The game exposes `EQUIPMENT_EVALUATE`, which returns the exact damage/hit/dodge/critical delta for swapping a piece. We tried building our own stat-weight model first; across three swaps it was wrong twice. Now the server decides, and our model is demoted to pre-filtering and pricing.

**Red lines are assertions, not documentation.** Selling, releasing pets, spending premium currency — every write goes through `core/redlines.mjs`. Violations throw before the packet is sent.

## Quick start

```bash
# credentials
cp creds.example.json creds.json     # or: TL_USER=... TL_PASS=...

# run
./enginectl.sh start

# watch
./enginectl.sh status
./enginectl.sh logs
./enginectl.sh wlogs
```

The engine exposes its state at `http://127.0.0.1:9527/status/brief`.

## Layout

```
engine/
  runtime.mjs      WebSocket + combat loop + scheduler (standalone)
  http.mjs         HTTP control surface — any agent can drive
  gamedata.mjs     auto-discovery and diffing of game metadata
  watchdog.mjs     probe DNS/HTTP/WS; start engine when server returns

core/
  lib-ws.mjs       session wrapper (persistenceRevision optimistic lock)
  lib-value.mjs    item valuation, set analysis, loadout search
  lib-power.mjs    combat power formula
  redlines.mjs     assertions guarding irreversible operations
  sets.json        52 set definitions

src/
  state-store.mjs    in-memory state tree + unknown-packet capture
  combat-daemon.mjs  battle loop (pause/resume hard boundary)
  logistics.mjs      potions → cleanup → equip → shop → gems → appraise → pets → skills
  activities.mjs     daily tasks / dungeons / tower / pet eggs
  evaluate.mjs       official equipment scoring
  probe-benchmark.mjs state capture + leaderboard gap
  verifier.mjs       predicted vs measured deviation log

.pi/                 optional Pi coding-agent adapter
```

## Design notes

### One account, one session

The server allows exactly one WebSocket per account. A second connection kicks the first with `4001 Session replaced`. This single constraint shapes everything:

- Only one process may hold the socket
- Starting a new system requires stopping the old one first
- Start scripts check for stale pidfiles before connecting

Debugging story: we once ran two engines against the same account for hours. Each reconnect kicked the other, and both kept "recovering," producing 4,355 `Session replaced` events before anyone noticed.

### Batch completion is judged by state, not by clock

A naive "if no progress in 60 seconds, restart the batch" check looks reasonable and is catastrophic. One batch of 80 monsters takes 2–3 minutes; a slow wave trips the timer, the batch aborts, and the full maintenance sequence runs again — buying 600 potions, feeding 5M exp to a pet, re-evaluating gear. We measured 286 spurious aborts: gold drained from 8.34M to 1.88M and deaths accumulated from 4 to 830.

The correct signal is the state stream itself:

1. Must observe `defeated < total` first (proves the batch actually started — the first frame after connecting often carries the previous batch's leftover count)
2. Then `defeated >= total` means the batch is done
3. Three consecutive `idle` frames also means done
4. Stall detection counts *state packets without progress*, with the tolerance window derived from this batch's own observed kill rate

`preparing` retry has a matching trap: `Date.now() - start > 25s` is true forever once it becomes true, so re-sending `COMBAT_START` on every subsequent frame means the bot keeps interrupting its own fight.

### Combat power is not the whole story

The formula the server reports is incomplete — it omits set `all_atk%` bonuses and the defense mitigation curve `def/(def+5000)`. Our own model filled those gaps but drifted: three recorded swap predictions had errors of +1416, −55, and −408 against measured power.

Then we found `EQUIPMENT_EVALUATE`. It returns four separate percentages (damage, hit, dodge, critical) relative to the current loadout. That is exactly the "actual offense and defense effect" a single power number hides — and it revealed that swapping for a +3.16% damage item cost 732 total power, because the item traded defense for attack. On a bot whose throughput depends on not dying, that is a losing trade.

Gear changes therefore require all three: damage not negative, official equipment power not down more than 2%, and combined score meaningfully better.

### Pets

- `form` is `BABY` (91–119% aptitude) or `MUTANT` (164–197%)
- Breeding needs both parents ≥30, never bred, deposited in Suzhou; each parent yields one offspring after an hour
- Feeding 40M exp at once changed neither level nor combat power — feeding is capped at 5M per cycle and auto-disabled after two consecutive cycles with no level gain

### Enhance and smelt

- Enhancement multiplies `baseStats` only; multipliers `{1:10, 2:20, 3:30, 4:45, 5:65, 6:90, 7:120, 8:155, 9:195}%`
- Appraisal is weapon-only, `req ≥ 50`
- Smelting requires both `extScore` and `intScore` above 1500
- An appraised weapon can be re-rolled for a different aptitude at the cost of one diamond sand

## Configuration

Environment variables:

| Variable | Meaning | Default |
|---|---|---|
| `TL_USER` / `TL_PASS` | credentials | — |
| `TL_WS_URL` | game endpoint | see `core/lib-ws.mjs` |
| `TL_MAP` | farming map id | 10027 |
| `TL_STAGE` | 0 read-only / 1 combat / 2 full | 2 |
| `TL_PORT` | HTTP control port (0 disables) | 9527 |
| `TL_MAINT_MS` | maintenance interval | 30 min |
| `TL_AUTOPILOT` | `off` = loop only, no dailies | `on` |

## HTTP API

```
GET  /status              full snapshot
GET  /status/brief        one-line summary (cheapest for agents)
GET  /gear                loadout + official scoring suggestions
GET  /drops?map=&limit=   drop statistics
GET  /gamedata            metadata summary + recent changes
GET  /gamedata/maps       map list (?type=normal|dungeon)
GET  /gamedata/best-map   highest-tier map for current level
GET  /gamedata/skills     skill upgrade plan with exp requirements
POST /maintain            run maintenance now
POST /daily               run dailies now
POST /combat/{start|pause|resume}
POST /config              { mapId, potionThreshold }
POST /reconnect           force a new session
POST /halt | /unhalt      emergency stop
```

## Safety

`core/redlines.mjs` enforces six rules before any write packet:

1. Top-2 gear per slot — never sold, never dismantled, never released
2. Highest-aptitude pet — never released
3. Any premium-currency spend — dry-run first
4. Gold spend above 30% of balance — refused
5. Removing worn gear — snapshot item ids first
6. Irreversible operations (smelt / re-roll / sell) — dry-run first

These are assertion functions. They throw; the packet is not sent.

## Emergency stop

```bash
touch .halt
```

All outbound packets stop within five seconds. Works regardless of what state the engine is in.

## Known ceilings

- Enhancement essence does not drop in open-field maps — only dungeon bosses
- Socket materials are premium-currency shop only
- Smelting needs double aptitude > 1500; best observed is 1469
- Set pieces rarely appear in the shop, so completing a set is luck-bound
- Ancient Tomb maps have real drop tables but the monsters there out-damage a mid-gear character; they are the only open-field source of set drops

## Disclaimer

For learning WebSocket protocol work and automation techniques. Use at your own risk and respect the game's terms of service.

## License

MIT
