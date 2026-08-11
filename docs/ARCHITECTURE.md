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

Reconciliation (spec §21) sits outside this per-trade flow — it runs on
its own interval, comparing state after the fact rather than gating any
single trade. See "Reconciliation" below.

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
tracked separately: `getOpenPositionsSummary()` in
`modules/copy-engine/copyOrderQueries.ts` finds EXECUTED `OPEN`s whose
`masterTicket` has no EXECUTED `CLOSE` yet — same lookup style already
used for the CLOSE/MODIFY prior-ticket resolution. Fetched once per `OPEN`
and reused for both checks. The repeated "create a `copy_orders` row
straight to `FAILED` with a reason, never send anything" pattern (now four
call sites: no matching open copy, volume-calculator rejection, entry-risk
rejection, exposure rejection) is a single `failCopyOrder()` helper rather
than copy-pasted.

## Reconciliation

Per spec §21: periodically compares Master state vs. system state vs.
Slave state and surfaces drift. Everything built before this trusted that
once `copy_orders` said `EXECUTED`, the Slave's position actually matched
— nothing ever checked that against reality.

**Foundational gap found during planning**: doing this for real needs each
platform's *actual current* open positions, not just the event log
(`trade_events`/`copy_orders`) already collected. Neither connector
reported that. Rather than add a new endpoint/message type/timer, the
existing heartbeat (already flowing every ~5s from both connectors,
already updating `balance`/`equity` in the same write) grew an optional
`positions` array — `masters`/`slaves` gained `positionSnapshot` (JSON) +
`positionSnapshotAt`. The *comparison* still runs on its own slower
interval (`RECONCILIATION_INTERVAL_SECONDS`, default 60); only the *data
collection* rides the heartbeat.

`modules/reconciliation/reconciliationEngine.ts::compareState()` is pure,
like `volumeCalculator.ts`/`riskChecks.ts`:

```
MISSING_COPY               Master has an open position with no open-or-closed copy at all
SLAVE_POSITION_MISSING     system has an open copy, Slave doesn't have that ticket
VOLUME_MISMATCH            Slave's actual volume differs from requested beyond RECONCILIATION_VOLUME_TOLERANCE
SLTP_MISMATCH              Slave's actual SL/TP differs from expected beyond RECONCILIATION_PRICE_TOLERANCE
                              (expected SL/TP comes from the *latest* EXECUTED OPEN-or-MODIFY
                               copy for that ticket, not just the original open — a Master
                               MODIFY changes the expectation)
SLAVE_NOT_CLOSED            system has a closed copy, but a Slave position with that ticket is still present
UNEXPECTED_SLAVE_POSITION   a Slave position's order comment doesn't trace back to a known open copy
DUPLICATE_SLAVE_POSITION    two Slave positions share the same "copy:<copyId>" comment
```

The `comment` field is the trace-back key: `slave-service/main.py`'s
`execute_open()` already tags every order `copy:<copyId>` (Phase 2), so
reconciliation gets duplicate/unexpected detection for free once the
Slave reports its comments in its snapshot.

Orchestration (`reconciliation.service.ts::runReconciliation()`, called on
an interval from `server.ts` — same `setInterval` pattern as
`sweepOfflineConnectors`, and idempotent like `startCopyEngine()`) skips
any Master/Slave pair whose snapshot is older than
`RECONCILIATION_STALENESS_SECONDS` (default 30) — a stale snapshot from a
disconnected connector must never produce a false finding. Findings for a
pair are **replaced** each run (`deleteMany` then insert): the
`reconciliation_findings` table represents *current* known issues, not an
ever-growing history — the queryable surface spec §21's "show this
immediately to the administrator" resolves to before there's a dashboard
(`GET /api/reconciliation/findings`, plus `POST /api/reconciliation/run`
to trigger an off-cycle run).

## Phase 6: Super Admin Dashboard (MVP)

Scoped to the spec's "operational core" (§33-34): login, an overview, a
Masters list/detail, a Slaves list/detail with pause/resume and
volume/risk config editing, and a real-time Live Trades monitor. Trade
History, a Symbol Mapping UI, a Reconciliation Findings viewer, Audit
Logs, and Settings are explicitly deferred.

**Required prerequisite, not optional**: before this phase there was zero
authentication anywhere in the backend — every admin API was wide open.
Shipping a control UI on top of that would let anyone who finds the URL
pause a Slave, flip the emergency stop, or edit risk config. A minimal
single Super Admin login (JWT) now gates the admin API, completely
separate from the connector-token auth Masters/Slaves already use:

```
POST /api/auth/login {username, password}
  -> bcrypt.compare against admins.password_hash
  -> jsonwebtoken.sign({adminId, username}, JWT_SECRET, {expiresIn: JWT_EXPIRES_IN})

requireAdminAuth (preHandler, app.ts wraps masters/slaves/reconciliation/
                  dashboard/copy-orders/ws-admin in one nested Fastify
                  scope with this hook — ingest/connector/ws-slave routes
                  are untouched, still connector-token-only)
  -> Authorization: Bearer <jwt>, OR ?token=<jwt> query param
     (browsers' native WebSocket API cannot set custom headers, so
     /ws/admin needs the query-param fallback — a real production
     requirement, not a test workaround)
  -> jwt.verify, 401 on anything invalid/missing/expired
```

`tools/seed.ts` bootstraps a default Admin from `ADMIN_USERNAME`/
`ADMIN_PASSWORD` env vars if none exists yet (idempotent) — documented as
insecure dev-only defaults that must change for anything beyond local dev.

**Two smaller foundational gaps found during planning**, both cheap fixes
bundled in rather than deferred:
- Per-event latency (`detectionLatencyMs`/`networkLatencyMs`/
  `totalLatencyMs`, already computed in Phase 1's ingest path) was only
  logged, never stored — there was no queryable data for the dashboard's
  "AVG LATENCY" card. `trade_events` gained the three columns, populated
  from the same `latency` object `ingest.routes.ts` already computes.
- There was no general-purpose endpoint to list recent `copy_orders` at
  all (only single-entity lookups and reconciliation findings existed) —
  needed for the Live Trades page's initial load before real-time updates
  start arriving. `GET /api/copy-orders?masterId=&slaveId=&limit=`
  (default 100, max 500, newest first) fills that gap, joined through to
  `trade_event` (symbol/side) and master/slave (names).

`GET /api/dashboard/summary` returns the spec §16 card set in one call
(counts by Master/Slave status, trades today, success rate, avg latency)
rather than the frontend making eight separate requests.

**Real-time is scoped to Live Trades only** — everything else in the MVP
(Masters/Slaves lists, dashboard summary) polls every ~7s rather than
pushing. The spec's "no polling" principle is about the trade *execution*
path (Phase 1-5); it doesn't extend to admin-UI refresh cadence, so this
is a deliberate MVP simplification, not a compromise of anything already
built.

```
copyEngine.ts, at the same points it already writes a copy_orders row
(failCopyOrder, the PENDING->SENT/SEND_FAILED transition, and
handleSlaveMessage's EXECUTED/FAILED update)
  -> broadcastToAdmins({copyId, masterId, slaveId, masterTicket, type,
                         status, symbol, side, volume, slaveTicket?,
                         executionPrice?, errorReason?, timestamp})

adminWsGateway.ts: GET /ws/admin (admin-JWT-authenticated)
  -> every connected browser gets every event (broadcast, not the 1:1
     routing /ws/slave uses for Slave connectors)
```

Frontend (`frontend/`): Vite + React + TypeScript + Tailwind CSS — the
stack the spec names. A thin `apiFetch` wrapper attaches the JWT and logs
the user out globally on any 401; `useAdminTradeFeed` wraps `/ws/admin`
with auto-reconnect; `usePolling` drives every non-realtime page. One
gotcha documented directly in `frontend/src/lib/types.ts`: Prisma
`Decimal` columns (balance, equity, volumes, exposure) serialize to
**strings** in JSON, not numbers — every display/edit path has to
`Number(...)` them first.

Verified live (not just type-checked/unit-tested): logged in, confirmed
each page renders real backend data, toggled a Slave's pause/resume from
the UI and confirmed `copy_enabled` flipped directly in Postgres, and
fired a simulated Master trade while watching it arrive on the Live
Trades page over the WebSocket in real time — one Slave correctly showing
`SLAVE_OFFLINE`, the other `SENT` -> `EXECUTED`. Confirmed the ingest/
connector/`/ws/slave` paths remain fully unauthenticated by the admin JWT
(a separate auth system) while every admin route correctly 401s without
one.

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
`copy_orders`, `symbol_mappings`, `reconciliation_findings`, `admins` —
see `backend/src/db/prisma/schema.prisma`. `masters` and `slaves` also
carry `balance`/`equity` and `positionSnapshot`/`positionSnapshotAt`
(heartbeat-updated); `slaves` carries its Volume Calculator config
(`copyMode`, `fixedLot`, `multiplier`, `minLot`, `maxLot`, `lotStep`) and
risk config (`emergencyStop`, `allowedSymbols`, `blockedSymbols`,
`maxPositions`, `maxExposure`); `trade_events` carries the per-event
latency breakdown (`detectionLatencyMs`, `networkLatencyMs`,
`totalLatencyMs`); `admins` (`username`, `passwordHash`) backs the Super
Admin login (Phase 6), a single-credential system with no roles/RBAC yet.
Later work adds `execution_logs`, `risk_settings` (max daily loss/
drawdown) on top, without reshaping what's here.

## What's next (not built yet)

- **PARTIAL_CLOSE and pending orders** — the Master EA already detects
  these (Phase 1) but the Copy Engine still ignores them
  (`isCopyableEvent` in `copyEngine.ts`); deliberately deferred out of
  Phase 3's scope.
- **Max daily loss and max drawdown** — need a start-of-day equity
  snapshot and a running peak equity, neither tracked yet; deliberately
  deferred rather than approximated. Percentage-risk volume sizing.
- **Automatic remediation of reconciliation findings** — detection +
  visibility only, per spec; no auto-fix. A historical findings trend
  (today's table holds only current state).
- **Dashboard, beyond the Phase 6 MVP** — Trade History, a Symbol Mapping
  UI, a Reconciliation Findings viewer, Audit Logs viewer, Settings page,
  real-time push for Masters/Slaves/dashboard summary (currently polling),
  Latency Monitor charts, multi-user/RBAC (still one shared credential).
- **Phase 7/8** — load testing, production deployment.

Each of these gets its own short plan before implementation, per the
project's "explain the architecture before implementing each major module"
instruction.
