# Forex Remote Copy Trading System

A production-oriented system that replicates trading activity from a Master
MT5 account to multiple Slave MT5 accounts in real time. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full layered design and
current build status.

**Status: Phase 2** — Master trade detection, transmission, and one full
Master → Backend → Slave copy loop (OPEN/CLOSE/MODIFY) proven end-to-end.
No multiple Slaves, risk/volume logic, reconciliation, or dashboard yet (see
"What's next" in the architecture doc).

## Repository layout

- `backend/` — Node.js + TypeScript API (Fastify), PostgreSQL (Prisma),
  Redis. Ingest endpoint, connector auth, Copy Engine, and the
  Master/Slave real-time transport layer all live here.
- `connectors/master-ea/` — the MQL5 Expert Advisor that runs on the Master
  MT5 terminal.
- `connectors/slave-service/` — the Python service that runs on the Slave
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
npm run seed                   # creates a dev Master + Slave, each with a connector token
npm run simulate:slave         # fake Slave: connects, waits for instructions

# in a third terminal:
npm run simulate -- --event OPEN --ticket 700001 --symbol XAUUSD --volume 1.0 --sl 3340.20 --tp 3370.20
npm run simulate -- --event MODIFY --ticket 700001 --symbol XAUUSD --sl 3345.00 --tp 3375.00
npm run simulate -- --event CLOSE --ticket 700001 --symbol XAUUSD --volume 1.0
```

Watch the `simulate:slave` terminal print each instruction it receives and
the synthetic execution result it sends back; check `GET
http://localhost:4000/api/system/health`; and confirm in Postgres:

```sql
SELECT master_ticket, type, status, slave_ticket, execution_price FROM copy_orders ORDER BY created_at;
```

MODIFY and CLOSE should both resolve the same `slave_ticket` that the OPEN
was executed with. Stop `simulate:slave` and send another OPEN to confirm
it fails immediately with `SLAVE_OFFLINE` rather than hanging.

Run the test suite (requires Postgres/Redis up, as above):

```bash
npm test
```

When you're ready to connect real MT5 terminals instead of the simulators,
follow [connectors/master-ea/README.md](connectors/master-ea/README.md) and
[connectors/slave-service/README.md](connectors/slave-service/README.md).
