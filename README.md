# Forex Remote Copy Trading System

A production-oriented system that replicates trading activity from a Master
MT5 account to multiple Slave MT5 accounts in real time. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full layered design and
current build status.

**Status**: Master trade detection/transmission, Master → Backend → Slave
copying (OPEN/CLOSE/MODIFY) fanning out concurrently to multiple Slaves,
per-Slave volume sizing (fixed lot / multiplier / balance- or
equity-proportional), per-Slave symbol mapping, and risk limits (allowed/
blocked symbols, max positions, max exposure, emergency stop) all proven
end-to-end. No PARTIAL_CLOSE/pending orders, max daily loss/drawdown,
reconciliation, or dashboard yet (see "What's next" in the architecture
doc).

## Repository layout

- `backend/` — Node.js + TypeScript API (Fastify), PostgreSQL (Prisma),
  Redis. Ingest endpoint, connector auth, Copy Engine, and the
  Master/Slave real-time transport layer all live here.
- `connectors/master-ea/` — the MQL5 Expert Advisor that runs on the Master
  MT5 terminal.
- `connectors/slave-service/` — the Python service that runs on each Slave
  MT5 terminal.
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
npm run seed                   # creates a dev Master + two dev Slaves, each with a connector token
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

### Trying the Volume Calculator

The dev Slaves seeded above default to `MULTIPLIER` with `multiplier=1`
(1:1 copying). To see sizing actually change the copied volume:

```bash
curl -X PATCH http://localhost:4000/api/slaves/<slaveId> \
  -H "Content-Type: application/json" \
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
  -H "Content-Type: application/json" -d '{"masterSymbol":"XAUUSD","slaveSymbol":"XAUUSDm"}'

# Block a symbol, cap concurrent positions, cap total exposure, or hit the
# emergency stop -- all via the same PATCH used for volume config:
curl -X PATCH http://localhost:4000/api/slaves/<slaveId> \
  -H "Content-Type: application/json" \
  -d '{"blockedSymbols":["XAUUSD"],"maxPositions":5,"maxExposure":2.0}'

curl -X PATCH http://localhost:4000/api/slaves/<slaveId> \
  -H "Content-Type: application/json" -d '{"emergencyStop":true}'
```

A Master OPEN for `XAUUSD` should arrive at the fake Slave as `XAUUSDm`
once mapped. With `blockedSymbols` set, that same OPEN should fail in
`copy_orders` with `SYMBOL_BLOCKED` and nothing should be sent. With
`emergencyStop` on, new OPENs are rejected (`EMERGENCY_STOP_ACTIVE`) but a
CLOSE for a position already open on that Slave still goes through — the
checks only ever gate new risk, never a reduction of existing risk.

Run the test suite (requires Postgres/Redis up, as above):

```bash
npm test
```

When you're ready to connect real MT5 terminals instead of the simulators,
follow [connectors/master-ea/README.md](connectors/master-ea/README.md) and
[connectors/slave-service/README.md](connectors/slave-service/README.md).
