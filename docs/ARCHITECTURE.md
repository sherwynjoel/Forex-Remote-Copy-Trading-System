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
RISK ENGINE (Phase 4)
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
`copy_orders` — see `backend/src/db/prisma/schema.prisma`. Later phases add
`execution_logs`, `risk_settings`, `symbol_mappings` on top, without
reshaping what's here.

## What's next (not built yet)

- **Phase 3** — multiple Slaves at scale, PARTIAL_CLOSE, pending orders.
- **Phase 4** — Risk Engine (fixed lot, multiplier, balance/equity
  proportional, symbol mapping, max lot/drawdown/exposure) — Phase 2 copies
  volume 1:1 with no risk logic.
- **Phase 5** — reconciliation (Master vs. system vs. Slave state).
- **Phase 6** — Super Admin dashboard (React/TS/Tailwind), WebSocket
  gateway to the browser.
- **Phase 7/8** — load testing, production deployment.

Each of these gets its own short plan before implementation, per the
project's "explain the architecture before implementing each major module"
instruction.
