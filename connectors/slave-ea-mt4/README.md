# Slave EA (MT4) — Setup

MT4 variant of the Slave connector. Executes the exact same instruction
shape the Python [slave-service](../slave-service/README.md) does, against
the exact same backend — the Copy Engine picks HTTP polling (this EA) vs.
WebSocket push (the Python service) per-Slave automatically, based on that
Slave's `platform` field. Nothing about copyEngine.ts's risk/volume/symbol
logic changes for either transport.

## Why this isn't a WebSocket client

MQL4 has no native WebSocket support, and no official IPC package like
MetaTrader5's Python `MetaTrader5` module — there's no way for this EA to
hold a live connection the backend can push to. `WebRequest()` is
outbound-only on both MT4 and MT5. So this EA polls instead: every
`PollIntervalMs` (default 500), it asks the backend "anything pending for
me?", executes whatever comes back, and posts the result. That interval
is the real "how fast does a copy actually fire" number for an MT4
Slave — tighten it if 500ms isn't fast enough for your use case.

## Prerequisites

- MetaTrader 4 terminal installed, with a demo (or live, once you're
  ready) account logged in.
- The backend running and reachable from this machine, with the MT4
  Master EA (or an MT5 Master) already sending events.
- A registered Slave + connector token. Both calls need an admin token
  first (`POST /api/auth/login`):

  ```bash
  curl -X POST http://localhost:4000/api/slaves \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
    -d '{"masterId":"<masterId>","name":"My MT4 Slave","accountNumber":"87654321","broker":"Exness","platform":"MT4","server":"Exness-MT4Real17"}'

  curl -X POST http://localhost:4000/api/slaves/<slaveId>/connectors \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"version":"1.0.0"}'
  ```

  The second call returns a `token` **once** — that's your
  `ConnectorToken` input. Setting `"platform":"MT4"` on the Slave is what
  makes the Copy Engine dispatch to it via polling instead of trying to
  push over `/ws/slave` — get this right or the Slave will be treated as
  an MT5 Slave and every copy to it will fail with `SLAVE_OFFLINE`.

## Install into the terminal

1. In MetaTrader 4: **File → Open Data Folder**.
2. Copy `ForexCopySlaveEA.mq4` into `MQL4/Experts/`.
3. Copy the `Include/ForexCopy/` folder into `MQL4/Include/ForexCopy/`.
4. In MetaEditor, open `ForexCopySlaveEA.mq4` and compile (F7). Fix any
   compiler warnings for your build before proceeding — like every other
   EA in this project, this has been written and reviewed carefully but
   not compiled against a live MetaEditor toolchain, so treat the first
   compile as the real verification step.

## Allow the backend URL

Same as every other connector: **Tools → Options → Expert Advisors**,
check **Allow WebRequest for listed URL**, add your backend's URL. No DLL
imports needed.

## Enable AlgoTrading

Click **AlgoTrading** in the toolbar so it's green.

## Attach the EA

Drag `ForexCopySlaveEA` onto any chart — same as the MT4 Master EA, which
chart doesn't matter. In the inputs dialog, set:

- `BackendUrl`, `ConnectorToken` — as above.
- `PollIntervalMs` — 500 is a reasonable default; lower it for faster
  copying if your account's activity level makes that many requests/second
  reasonable.
- `SlippagePoints` — passed straight through to `OrderSend`/`OrderClose`,
  same meaning as in any other MT4 EA.
- `MagicNumber` — optional, if you want copied orders tagged for your own
  bookkeeping alongside the `copy:<copyId>` order comment this EA already
  sets (that comment, not the magic number, is what reconciliation
  actually uses to trace a position back to its copy).

Check the **Experts** tab for `ForexCopy Slave EA (MT4) initialized ...`
to confirm it started.

## Prove it end-to-end

Send a test trade from whichever Master (MT4 or MT5) is assigned to this
Slave. Watch the **Experts** tab print `copy <id> (OPEN) -> {...}` with
`"status":"EXECUTED"`, confirm the position actually appears in this
terminal, and check `copy_orders` in Postgres shows the matching row as
`EXECUTED` with a `slave_ticket` and `execution_price`. Then modify the
Master's SL/TP and close it, confirming both reach this Slave too. Pause
this EA (or its terminal) and send another Master trade — the resulting
`copy_orders` row should fail with `SLAVE_OFFLINE` once the connector's
heartbeat goes stale (`CONNECTOR_OFFLINE_THRESHOLD_SECONDS`, default 15s),
matching how an offline MT5 Slave already behaves.

## Known limitations

- **CLOSE always closes the Slave's entire existing position**, ignoring
  whatever volume the instruction carries — same behavior as the Python
  slave-service's `execute_close`, not a gap specific to this EA.
- **PARTIAL_CLOSE and pending orders** are not handled — same deferred
  scope as everywhere else in this project.
- **Execution price on MODIFY** is not meaningful (a MODIFY only changes
  SL/TP) and is omitted from the result; this matches the Python
  service's `execute_modify` too.
- If `WebRequest` to `/api/connectors/execution-result` fails after a
  trade actually executed, the result is queued and retried (backoff up
  to 60s, up to 8 attempts) rather than lost — but if the terminal itself
  goes down before a retry succeeds, that specific result is lost and the
  `copy_orders` row stays at `SENT`. Reconciliation (spec §21) is the
  backstop for this: it compares actual Slave positions against what the
  system expects and will surface the drift.
