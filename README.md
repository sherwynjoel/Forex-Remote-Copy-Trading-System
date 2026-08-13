# Forex Remote Copy Trading System

A production-oriented system that replicates trading activity from a Master
MT4/MT5 account to multiple Slave MT4/MT5 accounts in real time. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full layered design and
current build status, and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for
running this on a real server instead of localhost.

**Status**: Master trade detection/transmission, Master → Backend → Slave
copying (OPEN/CLOSE/MODIFY) fanning out concurrently to multiple Slaves,
per-Slave volume sizing (fixed lot / multiplier / balance- or
equity-proportional), per-Slave symbol mapping, risk limits (allowed/
blocked symbols, max positions, max exposure, emergency stop), periodic
Master/system/Slave reconciliation, and a JWT-authenticated Super Admin
dashboard (login, live overview, Masters/Slaves management, real-time
Live Trades) all proven end-to-end. No PARTIAL_CLOSE/pending orders, max
daily loss/drawdown, or the dashboard's deferred pages (Trade History,
Symbol Mapping UI, Reconciliation viewer, Audit Logs, Settings) yet (see
"What's next" in the architecture doc).

## Repository layout

- `backend/` — Node.js + TypeScript API (Fastify), PostgreSQL (Prisma),
  Redis. Ingest endpoint, connector auth, Copy Engine, admin auth/API, and
  the Master/Slave real-time transport layer all live here.
- `frontend/` — Vite + React + TypeScript + Tailwind Super Admin
  dashboard: login, live overview, Masters/Slaves management, real-time
  Live Trades.
- `connectors/master-ea/` — the MQL5 Expert Advisor that runs on the Master
  MT5 terminal.
- `connectors/master-ea-mt4/` — the MQL4 equivalent for a Master on MT4.
  Written and code-reviewed but **not yet compiled or run against a real
  MT4 terminal** — treat the first compile as the real verification step,
  same caveat the MT5 EA started with.
- `connectors/slave-service/` — the Python service that runs on each Slave
  MT5 terminal.
- `connectors/slave-ea-mt4/` — the MQL4 equivalent for a Slave on MT4:
  polls the backend instead of holding a WebSocket, since MQL4 has no
  IPC package like MT5's. Same not-yet-compiled caveat as
  `master-ea-mt4/`.
- `docker-compose.prod.yml`, `deploy/`, `backend/Dockerfile` — the
  production stack (Postgres, Redis, backend, Caddy for automatic HTTPS).
  See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- `docs/` — architecture and design notes.

## Quickstart

```bash
cd backend
cp .env.example .env
docker compose up -d           # Postgres + Redis
npm install
npm run prisma:migrate         # applies the schema
npm run dev                    # starts the API on :4000

# in another terminal:
npm run seed                   # creates a default Admin + a dev Master + two dev Slaves, each with a connector token
npm run simulate:slave         # fake Slave 1: connects, waits for instructions

# in a third terminal (a second fake Slave, to see multi-slave fan-out):
npm run simulate:slave -- --token "$(cat .dev-slave-2-connector-token)"

# in a fourth terminal:
npm run simulate -- --event OPEN --ticket 700001 --symbol XAUUSD --volume 1.0 --sl 3340.20 --tp 3370.20
npm run simulate -- --event MODIFY --ticket 700001 --symbol XAUUSD --sl 3345.00 --tp 3375.00
npm run simulate -- --event CLOSE --ticket 700001 --symbol XAUUSD --volume 1.0
```

Watch both `simulate:slave` terminals print the instruction they each
received (independently, at roughly the same time) and the synthetic
execution result each sends back; check `GET
http://localhost:4000/api/system/health`; and confirm in Postgres:

```sql
SELECT master_ticket, type, status, slave_id, slave_ticket, execution_price FROM copy_orders ORDER BY created_at;
```

You should see two rows per event (one per Slave) with distinct
`slave_ticket`s, and MODIFY/CLOSE should each resolve the same
`slave_ticket` their own Slave's OPEN was executed with. Stop one
`simulate:slave` and send another OPEN to confirm that Slave's copy fails
immediately with `SLAVE_OFFLINE` while the still-connected one still
succeeds.

### Admin API access

`/api/masters`, `/api/slaves`, `/api/reconciliation`, `/api/dashboard`,
`/api/copy-orders`, and `/ws/admin` all require a Super Admin JWT (the
ingest/connector/`/ws/slave` routes the EA and Slave service use stay
unauthenticated by this token — separate system). Get one with the
default seeded credentials (`ADMIN_USERNAME`/`ADMIN_PASSWORD` in `.env`,
default `admin`/`admin` — change both for anything beyond local dev):

```bash
export ADMIN_TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" -d '{"username":"admin","password":"admin"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
```

Every `curl` below against an admin route needs
`-H "Authorization: Bearer $ADMIN_TOKEN"`.

### Trying the Volume Calculator

The dev Slaves seeded above default to `MULTIPLIER` with `multiplier=1`
(1:1 copying). To see sizing actually change the copied volume:

```bash
curl -X PATCH http://localhost:4000/api/slaves/<slaveId> \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"copyMode":"MULTIPLIER","multiplier":0.5}'
```

Then send another Master OPEN — the fake Slave should receive half the
Master's volume. For `BALANCE_PROPORTIONAL`/`EQUITY_PROPORTIONAL`, both
sides need a balance on record first (normally supplied by each
connector's heartbeat):

```bash
npm run simulate:master-heartbeat -- --balance 10000 --equity 10000
# restart simulate:slave with --balance/--equity, e.g.:
npm run simulate:slave -- --balance 5000 --equity 5000
```

with the Slave set to `copyMode=BALANCE_PROPORTIONAL`, a Master OPEN of
`1.0` should size to `0.5` on that Slave. A Slave with `FIXED_LOT` and no
`fixedLot` configured, or a size that rounds below `minLot`, should fail
the `copy_orders` row with a reason instead of sending anything.

### Trying symbol mapping and risk limits

```bash
# Map XAUUSD to a broker-specific symbol name for one Slave:
curl -X POST http://localhost:4000/api/slaves/<slaveId>/symbol-mappings \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"masterSymbol":"XAUUSD","slaveSymbol":"XAUUSDm"}'

# Block a symbol, cap concurrent positions, cap total exposure, or hit the
# emergency stop -- all via the same PATCH used for volume config:
curl -X PATCH http://localhost:4000/api/slaves/<slaveId> \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"blockedSymbols":["XAUUSD"],"maxPositions":5,"maxExposure":2.0}'

curl -X PATCH http://localhost:4000/api/slaves/<slaveId> \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"emergencyStop":true}'
```

A Master OPEN for `XAUUSD` should arrive at the fake Slave as `XAUUSDm`
once mapped. With `blockedSymbols` set, that same OPEN should fail in
`copy_orders` with `SYMBOL_BLOCKED` and nothing should be sent. With
`emergencyStop` on, new OPENs are rejected (`EMERGENCY_STOP_ACTIVE`) but a
CLOSE for a position already open on that Slave still goes through — the
checks only ever gate new risk, never a reduction of existing risk.

### Trying reconciliation

The fake Slave tracks its own "open positions" locally and reports them on
every heartbeat, exactly like the real Python service does from
`mt5.positions_get()`. To see a deliberate mismatch get caught:

```bash
# Report the Master's open position so the system has something to compare against:
npm run simulate:master-heartbeat -- --positions '[{"ticket":"700001","symbol":"XAUUSD","volume":1.0,"sl":3340.20,"tp":3370.20}]'

# Restart the fake Slave under-reporting that position (simulates it having
# silently vanished on the Slave side after being marked EXECUTED):
npm run simulate:slave -- --drop-position <the slaveTicket the fake slave printed on EXECUTED>

# Trigger a run immediately rather than waiting for the interval:
curl -X POST http://localhost:4000/api/reconciliation/run -H "Authorization: Bearer $ADMIN_TOKEN"
curl http://localhost:4000/api/reconciliation/findings -H "Authorization: Bearer $ADMIN_TOKEN"
```

You should see a `SLAVE_POSITION_MISSING` finding. Fix the Master/Slave
snapshots to agree and run again — the finding disappears (`findings` only
ever reflects the *current* known issues, not a history).

### Trying the Super Admin dashboard

```bash
# in a fifth terminal:
cd frontend
cp .env.example .env             # VITE_API_URL=http://localhost:4000
npm install
npm run dev                      # serves the dashboard on :5173
```

Open `http://localhost:5173`, log in with the seeded credentials
(`admin`/`admin` by default), and you should see live counts on the
Dashboard page, both dev Slaves on the Slaves page (pause/resume them and
confirm `copy_enabled` flips — check with the SQL above), and any Master
trade you send via `npm run simulate` appear on the Live Trades page
immediately, no refresh needed.

Run the test suite (requires Postgres/Redis up, as above):

```bash
npm test
```

When you're ready to connect real MT5 terminals instead of the simulators,
follow [connectors/master-ea/README.md](connectors/master-ea/README.md) and
[connectors/slave-service/README.md](connectors/slave-service/README.md).
