# Master EA (MT4) — Setup

MT4 variant of the Master connector. Sends the exact same event shape to
the exact same backend endpoint as the [MT5 EA](../master-ea/README.md) —
the backend doesn't know or care which platform a Master event came from.
The only real difference is *how* a trade is detected; see
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for why.

## Why this isn't just the MT5 EA recompiled

MQL4 has no `OnTradeTransaction()` — no account-wide "something changed"
event at all. This EA instead snapshots every open and pending order on a
timer (default every 500ms) and diffs it against the previous snapshot to
figure out what changed. That timer runs on wall-clock time via
`EventSetMillisecondTimer()`, deliberately **not** driven by `OnTick()` —
`OnTick()` only fires for the symbol of the chart the EA happens to be
attached to, which would silently miss trades placed on any other symbol.

Practical effect: detection latency here is bounded by `TimerIntervalMs`
(so up to ~500ms by default) rather than the MT5 EA's effectively-zero
latency. That's a real, honest tradeoff of the platform, not a shortcut —
tighten `TimerIntervalMs` if you need it faster; MT4 has no cheaper way to
close that gap without a compiled DLL bridge.

## Prerequisites

- MetaTrader 4 terminal installed, with a demo (or live, once you're ready)
  account logged in.
- The backend running and reachable from the machine the terminal is on.
- A registered Master + connector token — same registration flow as MT5
  (a Master is a Master regardless of platform; the `platform` field just
  records `"MT4"` instead of `"MT5"`). Both calls need an admin token
  first (`POST /api/auth/login`):

  ```bash
  curl -X POST http://localhost:4000/api/masters \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
    -d '{"name":"My MT4 Master","accountNumber":"12345678","broker":"Exness","platform":"MT4","server":"Exness-MT4Real17"}'

  curl -X POST http://localhost:4000/api/masters/<masterId>/connectors \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"version":"1.0.0"}'
  ```

  The second call returns a `token` **once** — paste it into the EA's
  `ConnectorToken` input. This is a separate credential from the admin
  token above; the EA only ever uses this one.

## Install into the terminal

1. In MetaTrader 4: **File → Open Data Folder**.
2. Copy `ForexCopyMasterEA.mq4` into `MQL4/Experts/`.
3. Copy the `Include/ForexCopy/` folder into `MQL4/Include/ForexCopy/`
   (this is a different folder tree from the MT5 EA's — MT4 and MT5 each
   need their own copy on disk even though the file contents are
   identical).
4. In MetaEditor, open `ForexCopyMasterEA.mq4` and compile (F7). Fix any
   compiler warnings for your build before proceeding — like the MT5 EA,
   this has been written and reviewed carefully but not compiled against a
   live MetaEditor toolchain, so treat the first compile as the real
   verification step.

## Allow the backend URL

Same as MT5: **Tools → Options → Expert Advisors**, check **Allow
WebRequest for listed URL**, and add your backend's URL. **No DLL imports
needed** — `WebRequest()` is a native MQL4 function (since MT4 build
600+), same as MQL5.

## Enable AlgoTrading

Click **AlgoTrading** in the toolbar so it's green.

## Attach the EA

Drag `ForexCopyMasterEA` onto **any single chart** — which chart doesn't
matter (detection scans your whole account on a timer, not per-symbol
ticks), but it must be attached to exactly one chart, not one per symbol.
In the inputs dialog, set:

- `BackendUrl`, `ConnectorToken` — as above.
- `TimerIntervalMs` — detection-scan cadence; 500 is a reasonable default,
  lower it if you need faster detection and your account's order count is
  small enough that scanning it 5-10x/second isn't wasteful.
- `BrokerGmtOffsetHours` — same purpose as the MT5 EA: affects only the
  latency dashboard's accuracy, never trade-copying correctness.

Check the **Experts** tab for `ForexCopy Master EA (MT4) initialized for
account ...` to confirm it started. On first attach it silently baselines
against your current open trades — it will not report your existing
positions as new OPENs, only genuine changes from that point forward.

## Prove it end-to-end

Same as the MT5 EA's verification steps: place a small test trade, watch
the **Experts** log and the backend's `npm run dev` output for an ingest
line, and confirm the row lands in `trade_events`. Then modify SL/TP,
partially close, and fully close it, confirming each produces its own
event (`MODIFY`, `PARTIAL_CLOSE`, `CLOSE`). Also test a pending order
(place, modify, then either let it trigger or cancel it) to confirm
`PENDING_OPEN`/`PENDING_MODIFY`/`PENDING_CANCEL` all fire correctly and
that a triggered pending order produces a clean `OPEN` rather than also
firing a spurious cancel.

## Known limitations

- **Partial-close price** is looked up from recent order history by
  matching the closed lot size; if that lookup fails (e.g. very rapid
  repeated partial closes on the same ticket within one scan interval) the
  event is still sent with the price field simply omitted — the Slave
  always executes at its own market price regardless, so this only
  affects the latency/price dashboard, never copy correctness.
- **Partial-close ticket continuity** assumes standard MT4 behavior: the
  original ticket stays open with reduced lots, and the closed portion's
  history entry uses the same ticket number. This holds for standard
  Exness MT4 accounts; if your broker's MT4 build behaves differently,
  partial closes may misreport as a full close followed by a new open —
  worth confirming in the end-to-end test above before trusting it live.
- **Detection latency is bounded by `TimerIntervalMs`**, not instant like
  the MT5 EA — see "Why this isn't just the MT5 EA recompiled" above.
- Position reversals are not handled, same as the MT5 EA.
