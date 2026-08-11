# Architecture

## Layering (never bypassed)

```
TRADING PLATFORM (MT5)
       |
CONNECTOR (MQL5 EA on Master, Python service on Slave — Phase 2)
       |
REAL-TIME TRANSPORT (Redis pub/sub)
       |
COPY ENGINE (Phase 3)
       |
RISK ENGINE (Phase 4)
       |
EXECUTION (Slave connector — Phase 2)
       |
TRADING PLATFORM (MT5)
```

The frontend (Phase 6) will only ever talk to the backend's REST/WebSocket
API — never directly to MT4/MT5.

## Phase 1 (current): Master detection

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
   4. publish to master:<id>:events   (Redis pub/sub — the seam Phase 2/3 attach to)
   5. respond 202 to the EA
   6. persist to Postgres trade_events (after responding — never blocks the EA)
```

Every stage above is on the measured critical path except step 6. Latency
fields (`detectionLatencyMs`, `networkLatencyMs`, `totalLatencyMs`) are
computed from real timestamps captured by the EA and the backend — see
`backend/src/modules/monitoring/latency.ts`. Nothing is hardcoded.

## Why the Master and Slave connectors are different technologies

- **Master** needs true event-driven *detection* — the most latency-critical
  stage per the project spec. Only MQL5's `OnTradeTransaction()` gives a
  zero-polling platform hook; that's only available inside an EA.
- **Slave** (Phase 2) only needs to *receive a push and execute an order*
  against a locally running, logged-in terminal. The official `MetaTrader5`
  Python package can call `order_send()` directly and hold a real WebSocket
  to the backend for push delivery — no EA, no DLL, no polling, and much
  simpler to build/test/debug than a second MQL5 codebase.

## Data model (Phase 1 subset)

`masters`, `connectors`, `trade_events`, `audit_logs` — see
`backend/src/db/prisma/schema.prisma`. Later phases add `slaves`,
`master_slave_mapping`, `copy_orders`, `execution_logs`, `risk_settings`,
`symbol_mappings` on top, without reshaping what's here.

## What's next (not built yet)

- **Phase 2** — Slave connector (Python + MetaTrader5 package), Copy Engine
  subscribes to `master:<id>:events` and routes an OPEN/CLOSE/MODIFY to one
  Slave, trade identity mapping (`copy_orders` linking master ticket to
  slave ticket).
- **Phase 3** — multiple Slaves, execution routing, retry/failure handling.
- **Phase 4** — Risk Engine (fixed lot, multiplier, balance/equity
  proportional, symbol mapping, max lot/drawdown/exposure).
- **Phase 5** — reconciliation (Master vs. system vs. Slave state).
- **Phase 6** — Super Admin dashboard (React/TS/Tailwind), WebSocket
  gateway to the browser.
- **Phase 7/8** — load testing, production deployment.

Each of these gets its own short plan before implementation, per the
project's "explain the architecture before implementing each major module"
instruction.
