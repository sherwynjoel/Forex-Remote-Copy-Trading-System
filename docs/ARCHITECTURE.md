# Architecture

## Layering (never bypassed)

```
TRADING PLATFORM (MT5)
       |
CONNECTOR (MQL5 EA on Master, Python service on Slave)
       |
REAL-TIME TRANSPORT (Redis pub/sub master:*:events, WebSocket /ws/slave)
       |
COPY ENGINE
       |
SYMBOL MAPPING + RISK CHECKS (allowed/blocked symbols, max positions,
                               max exposure, emergency stop)
       |
VOLUME CALCULATOR (fixed/multiplier/balance/equity sizing, min/max/step)
       |
EXECUTION (Slave connector)
       |
TRADING PLATFORM (MT5)
```

The frontend (Phase 6) will only ever talk to the backend's REST/WebSocket
API — never directly to MT4/MT5.

## Phase 1: Master detection

```
MT5 Terminal (Master)
   |  OnTradeTransaction()      <- native platform event, zero polling
   v
ForexCopyMasterEA.mq5
   |  WebRequest() POST          <- event-driven push, HTTP, no DLL
   v
Backend: POST /api/ingest/trade-event
   1. authenticate connector token   (Redis-cached, DB fallback)
   2. validate payload                (zod)
   3. idempotency check               (Redis SETNX, event_id)
   4. publish to master:<id>:events   (Redis pub/sub — Copy Engine subscribes here)
   5. respond 202 to the EA
   6. persist to Postgres trade_events (after responding — never blocks the EA)
```

Every stage above is on the measured critical path except step 6. Latency
fields (`detectionLatencyMs`, `networkLatencyMs`, `totalLatencyMs`) are
computed from real timestamps captured by the EA and the backend — see
`backend/src/modules/monitoring/latency.ts`. Nothing is hardcoded.

## Phase 2: Slave connector + Copy Engine (one Slave, OPEN/CLOSE/MODIFY)

```
Redis PSUBSCRIBE master:*:events        (Copy Engine, same backend process)
  -> event arrives (OPEN/CLOSE/MODIFY only — PARTIAL_CLOSE/PENDING_* are Phase 3+)
  -> find slaves where masterId matches, copyEnabled, status != DISABLED
  -> for CLOSE/MODIFY: resolve slaveTicket from the most recent EXECUTED
     OPEN copy_orders row for (slaveId, masterTicket) — this is the trade
     identity mapping (never assume Master ticket == Slave ticket)
  -> create copy_orders row (PENDING)
  -> if slave not connected on /ws/slave: FAILED "SLAVE_OFFLINE", stop
  -> push instruction over /ws/slave: {copyId, action, symbol, side,
     volume, sl, tp, slaveTicket?}
  -> copy_orders.status = SENT

Slave connector executes via MetaTrader5.order_send(), replies:
  {copyId, status: EXECUTED|FAILED, slaveTicket, executionPrice, reason?}

WS gateway routes the reply back to the Copy Engine by copyId
  -> copy_orders.status = EXECUTED|FAILED — only now is anything "copied";
     never assumed on send (spec's EVENT SENT vs ORDER EXECUTED distinction)
```

`connectors` is shared between Master and Slave (nullable `masterId` /
`slaveId`, exactly one set) — one auth/heartbeat/offline-sweep
implementation instead of two near-identical ones. `copy_orders` has one row
per `(trade_event, slave)`, not per position, so CLOSE and MODIFY each get
their own tracked status/latency alongside OPEN.

## Phase 3: multiple Slaves, concurrent fan-out

Scoped narrowly to match the spec's own Phase 3 definition: prove one
Master event reaching several concurrently connected Slaves, each with a
fully independent outcome — not PARTIAL_CLOSE or pending orders (still
Phase 3+, deliberately deferred).

`handleMasterEvent` dispatches to every assigned Slave with
`Promise.allSettled(slaves.map(slave => copyToSlave(...)))` rather than a
sequential `for...await` — with N slaves, a sequential loop makes the Nth
slave's DB round-trips wait on the first N-1 finishing, which is exactly
the kind of unnecessary serialization the spec calls out. Each
`copyToSlave()` call was already fully self-contained (its own
`copy_orders` row, its own prior-ticket lookup scoped by `slaveId`, its own
WS send), so parallelizing the dispatch loop was the only change needed —
one Slave's failure or absence can't block or affect another's.

`startCopyEngine()` is now idempotent (a second call is a no-op, logged as
a warning) — defense in depth against ever double-registering the Redis
`pmessage` listener, which would otherwise process every master event
twice. This was actually load-bearing: with multiple integration test
files each standing up their own full Copy Engine instance against the
same shared Postgres/Redis (mirroring a topology that should never happen
in production — there's exactly one Copy Engine instance), running those
files in parallel caused independent instances to race on the same
`copy_orders` unique constraint. Fixed by making the test suite run files
sequentially (`fileParallelism: false` in `vitest.config.ts`) so the tests
reflect the real single-instance topology, with the idempotency guard as a
second line of defense.

## Phase 4: Volume Calculator

Scoped to exactly the spec's own Phase 4 list — fixed lot, multiplier,
balance-proportional, equity-proportional sizing, plus min/max lot and
lot-step enforcement (grouped with volume calc in the spec, not the
separate risk-limits section: a computed size is meaningless without
clamping it to what the broker will accept). Symbol mapping and the
broader risk limits (max daily loss/drawdown/positions/exposure, emergency
stop) are explicitly deferred.

Planning surfaced a foundational gap: balance-proportional and
equity-proportional sizing need real account numbers, and neither Master
nor Slave balance/equity was tracked anywhere. Both now ride on the
heartbeat each connector already sends every few seconds —
`connector.service.ts::recordHeartbeat(connectorId, accountInfo?)` persists
`{balance, equity}` to whichever entity (`masters` or `slaves`) the
connector belongs to, via the Master's `POST /api/connectors/heartbeat`
body or the Slave's `{"type":"heartbeat","balance":...,"equity":...}` WS
message.

`modules/copy-engine/volumeCalculator.ts` is a pure function — no I/O,
easy to unit test directly:

```
calculateVolume({ copyMode, masterVolume, fixedLot, multiplier,
                   masterBalance, masterEquity, slaveBalance, slaveEquity,
                   minLot, maxLot, lotStep })
  FIXED_LOT             -> fixedLot (reject FIXED_LOT_NOT_CONFIGURED if unset)
  MULTIPLIER            -> masterVolume * multiplier
  BALANCE_PROPORTIONAL  -> masterVolume * (slaveBalance / masterBalance)
  EQUITY_PROPORTIONAL   -> masterVolume * (slaveEquity / masterEquity)
    (reject MASTER_*_UNKNOWN / SLAVE_*_UNKNOWN if either side is missing)
  -> round DOWN to lotStep (never up), clamp to maxLot (cap, not reject)
  -> reject BELOW_MIN_LOT if the clamped result is still under minLot
```

Wired into `copyEngine.ts`'s `copyToSlave` for `OPEN` events only — `CLOSE`
always closes the Slave's existing full position and `MODIFY` doesn't
involve volume, so neither needs sizing. A rejection creates the
`copy_orders` row straight to `FAILED` with the calculator's reason and
never sends an instruction, the same pattern already used for
`NO_MATCHING_OPEN_COPY` and `SLAVE_OFFLINE`.

## Symbol Mapping + Risk Limits

Scoped to symbol mapping (spec §14) plus the four risk limits (spec §15)
directly derivable from data the system already has — allowed/blocked
symbols, max concurrent positions, max exposure, emergency stop. Max daily
loss and max drawdown need equity-history tracking (a start-of-day
snapshot and a running peak equity) this system doesn't have yet, and are
explicitly deferred rather than approximated.

**Design rule**: every check here gates `OPEN` only. `CLOSE` and `MODIFY`
always go through unmodified — a limit or an emergency stop exists to
prevent *new* risk; blocking a CLOSE during an emergency stop would trap
risk open, which is backwards from what "emergency stop" is for.

`symbol_mappings` (per-Slave Master-symbol → Slave-symbol, e.g. `XAUUSD` →
`XAUUSDm`) is resolved by `modules/slaves/symbolMapping.service.ts`,
falling back to the Master's symbol unchanged when no mapping exists —
today's behavior, preserved as the default. Destination-symbol *existence*
validation was already handled before this change:
`slave-service/main.py::execute_open` calls `mt5.symbol_select()` and
fails with a reason if the broker doesn't recognize it (Phase 1) — only
the Slave's own terminal knows its broker's symbol universe, so that check
has to stay there regardless of what the backend does with the name.

`modules/copy-engine/riskChecks.ts` is pure, like `volumeCalculator.ts`:

```
checkEntryAllowed(...)     // before sizing — cheap, fails fast
  emergencyStop -> EMERGENCY_STOP_ACTIVE
  blockedSymbols.includes(symbol) -> SYMBOL_BLOCKED
  allowedSymbols non-empty and missing symbol -> SYMBOL_NOT_ALLOWED
  currentOpenPositions >= maxPositions -> MAX_POSITIONS_REACHED

checkExposureAllowed(...)  // after sizing — exposure is about the
                            // calculated lot amount, not the raw Master volume
  currentOpenExposure + incomingVolume > maxExposure -> MAX_EXPOSURE_EXCEEDED
```

"Open positions" (feeding both checks) is derived from `copy_orders`, not
tracked separately: `getOpenPositionsSummary()` in `copyEngine.ts` finds
EXECUTED `OPEN`s whose `masterTicket` has no EXECUTED `CLOSE` yet — same
lookup style already used for the CLOSE/MODIFY prior-ticket resolution.
Fetched once per `OPEN` and reused for both checks. The repeated "create a
`copy_orders` row straight to `FAILED` with a reason, never send anything"
pattern (now four call sites: no matching open copy, volume-calculator
rejection, entry-risk rejection, exposure rejection) is a single
`failCopyOrder()` helper rather than copy-pasted.

## Why the Master and Slave connectors are different technologies

- **Master** needs true event-driven *detection* — the most latency-critical
  stage per the project spec. Only MQL5's `OnTradeTransaction()` gives a
  zero-polling platform hook; that's only available inside an EA.
- **Slave** only needs to *receive a push and execute an order* against a
  locally running, logged-in terminal. The official `MetaTrader5` Python
  package can call `order_send()` directly and hold a real WebSocket to the
  backend for push delivery — no EA, no DLL, no polling, and much simpler
  to build/test/debug than a second MQL5 codebase.

## Data model

`masters`, `connectors`, `trade_events`, `audit_logs`, `slaves`,
`copy_orders`, `symbol_mappings` — see
`backend/src/db/prisma/schema.prisma`. `masters` and `slaves` also carry
`balance`/`equity` (heartbeat-updated); `slaves` carries its Volume
Calculator config (`copyMode`, `fixedLot`, `multiplier`, `minLot`,
`maxLot`, `lotStep`) and risk config (`emergencyStop`, `allowedSymbols`,
`blockedSymbols`, `maxPositions`, `maxExposure`). Later phases add
`execution_logs`, `risk_settings` (max daily loss/drawdown) on top,
without reshaping what's here.

## What's next (not built yet)

- **PARTIAL_CLOSE and pending orders** — the Master EA already detects
  these (Phase 1) but the Copy Engine still ignores them
  (`isCopyableEvent` in `copyEngine.ts`); deliberately deferred out of
  Phase 3's scope.
- **Max daily loss and max drawdown** — need a start-of-day equity
  snapshot and a running peak equity, neither tracked yet; deliberately
  deferred rather than approximated. Percentage-risk volume sizing.
- **Phase 5** — reconciliation (Master vs. system vs. Slave state).
- **Phase 6** — Super Admin dashboard (React/TS/Tailwind), WebSocket
  gateway to the browser.
- **Phase 7/8** — load testing, production deployment.

Each of these gets its own short plan before implementation, per the
project's "explain the architecture before implementing each major module"
instruction.
