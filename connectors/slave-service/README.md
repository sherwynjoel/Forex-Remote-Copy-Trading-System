# Slave Connector — Setup

A Python service that holds a live WebSocket to the backend and executes
copy instructions directly against a locally running, logged-in MT5
terminal via the official `MetaTrader5` package. No EA, no DLL — see
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for why Master and Slave
use different connector technologies.

## Prerequisites

- Windows, with an MT5 terminal installed and **logged in** to the Slave
  account (the `MetaTrader5` Python package attaches to a running terminal
  via IPC — it does not manage login itself unless you pass credentials).
- Python 3.9+ (for `asyncio.to_thread`).
- The backend running and reachable (see the top-level README).
- A registered Slave + connector token:

  ```bash
  curl -X POST http://localhost:4000/api/slaves \
    -H "Content-Type: application/json" \
    -d '{"masterId":"<masterId>","name":"My Slave","accountNumber":"87654321","broker":"MyBroker","platform":"MT5","server":"MyBroker-Demo"}'

  curl -X POST http://localhost:4000/api/slaves/<slaveId>/connectors \
    -H "Content-Type: application/json" -d '{"version":"1.0.0"}'
  ```

  The second call returns a `token` **once** — that's your `CONNECTOR_TOKEN`.

## Install

```bash
cd connectors/slave-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## Run

```bash
set BACKEND_WS_URL=ws://localhost:4000/ws/slave
set CONNECTOR_TOKEN=<token from registration>
python main.py
```

(Use `https`/`wss` for anything beyond local development.)

On startup it calls `MetaTrader5.initialize()`, which attaches to whichever
terminal is already running and logged in on this machine — make sure
that's the Slave account, not something else. If you need this service to
launch/log into the terminal itself rather than attach to one already
running, pass `login`/`password`/`server` to `mt5.initialize(...)` in
`ensure_mt5_ready()` — left out by default since attaching to an
already-logged-in terminal is the simpler, more common setup.

## Prove it end-to-end

With no MT5 terminal available yet, use the Node-based fake Slave instead
(`npm run simulate:slave` in `backend/`) to prove the backend's Copy Engine,
WebSocket gateway, and `copy_orders` lifecycle — it speaks the exact same
protocol as this file. Once MT5 is installed, run this service for real and
repeat the same OPEN → MODIFY → CLOSE sequence from the top-level README's
Phase 2 verification steps; the only difference should be a real
`slaveTicket` and `executionPrice` coming back instead of synthetic ones.

`heartbeat_loop` also includes this account's current `balance`/`equity`
(via `mt5.account_info()`) — the only source of that data for
`BALANCE_PROPORTIONAL`/`EQUITY_PROPORTIONAL` volume sizing — plus a full
open-position snapshot (`build_positions_snapshot()`, via
`mt5.positions_get()`, including each position's order `comment`) — the
"Slave state" side of periodic reconciliation (spec §21). See
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md). Sizing and symbol
translation are both computed entirely on the backend before an
instruction is ever sent here — `execute_open` just uses whatever
`symbol`/`volume` it's given, tagging the resulting order with
`comment=copy:<copyId>` so reconciliation can trace it back later.

## Known limitations

- Only OPEN, CLOSE, and MODIFY are handled — PARTIAL_CLOSE and pending
  orders are still deferred.
- `execute_open`/`execute_close` use `ORDER_FILLING_IOC`; if your broker
  requires a different filling mode you'll see a `retcode` failure in the
  logs — adjust `type_filling` for your broker's requirements.
