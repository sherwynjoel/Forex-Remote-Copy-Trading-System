# Master EA — Setup

This Expert Advisor detects trading activity on a Master MT5 account via the
native `OnTradeTransaction()` callback (zero polling) and transmits normalized
events to the backend. It contains no trading/business logic by design.

## Prerequisites

- MetaTrader 5 terminal installed, with a demo (or live, once you're ready)
  account logged in.
- The backend running and reachable from the machine the terminal is on
  (`npm run dev` in `backend/`, see the top-level README).
- A registered Master + connector token:

  ```bash
  curl -X POST http://localhost:4000/api/masters \
    -H "Content-Type: application/json" \
    -d '{"name":"My Master","accountNumber":"12345678","broker":"MyBroker","platform":"MT5","server":"MyBroker-Demo"}'

  curl -X POST http://localhost:4000/api/masters/<masterId>/connectors \
    -H "Content-Type: application/json" -d '{"version":"1.0.0"}'
  ```

  The second call returns a `token` **once** — copy it, you'll paste it into
  the EA's `ConnectorToken` input. Only its hash is stored server-side.

## Install into the terminal

1. In MetaTrader 5: **File → Open Data Folder**.
2. Copy `ForexCopyMasterEA.mq5` into `MQL5/Experts/`.
3. Copy the `Include/ForexCopy/` folder into `MQL5/Include/ForexCopy/`.
4. In MetaEditor, open `ForexCopyMasterEA.mq5` and compile (F7). Fix any
   compiler warnings for your build before proceeding — this file has been
   written and reviewed carefully but not compiled against a live MetaEditor
   toolchain, so treat the first compile as the real verification step.

## Allow the backend URL

MT5 blocks outbound `WebRequest()` calls to non-allow-listed hosts by
default. In the terminal: **Tools → Options → Expert Advisors**, check
**Allow WebRequest for listed URL**, and add your backend's URL
(e.g. `http://localhost:4000`, or your real domain in production —
**use `https://` for anything beyond local development**).

## Enable AlgoTrading

Click the **AlgoTrading** button in the toolbar (or Ctrl+E) so it's green —
the EA won't call `WebRequest()` otherwise.

## Attach the EA

Drag `ForexCopyMasterEA` onto any chart (symbol/timeframe don't matter — it
reacts to account-level trade transactions, not chart ticks). In the inputs
dialog, set:

- `BackendUrl` — e.g. `http://localhost:4000`
- `ConnectorToken` — the token from the registration call above
- `BrokerGmtOffsetHours` — your broker server's UTC offset (check your
  broker's contract specification or the terminal's server time vs. UTC).
  This matters for latency numbers to be meaningful — see the note below.

Check the **Experts** tab in the terminal for
`ForexCopy Master EA initialized for account ...` to confirm it started.

## Prove it end-to-end

Place a small test trade on the Master account (any symbol, minimum
volume). Watch:

- The terminal's **Experts** log for a send confirmation (or a retry-queue
  warning if the backend is unreachable).
- The backend's logs (`npm run dev`) for a `trade event ingested` line with
  a `latency` breakdown.
- `SELECT * FROM trade_events ORDER BY created_at DESC LIMIT 1;` in Postgres.

Then modify the SL/TP, partially close it, and fully close it, and confirm
each produces its own event (`MODIFY`, `PARTIAL_CLOSE`, `CLOSE`).

## Known Phase 1 limitations (by design — see the project plan)

- **Timestamp accuracy** depends on `BrokerGmtOffsetHours` being set
  correctly; MT5 has no built-in way for an EA to know the broker's exact
  UTC offset. An uncalibrated offset will not affect trade replication
  correctness (Phase 2+), only the accuracy of the latency dashboard.
- **Position reversals** (`DEAL_ENTRY_INOUT`) are not yet handled.
- **Pending order cancellation** is reported for every `ORDER_DELETE`,
  including the case where the order was actually triggered into a deal
  (which also emits its own `DEAL_ADD` event). The backend reconciles this
  pairing rather than the EA guessing.
- There is no Slave yet — this EA only proves Master-side detection and
  transmission, per Phase 1 of the project plan.
