# Forex Remote Copy Trading System

A production-oriented system that replicates trading activity from a Master
MT5 account to multiple Slave MT5 accounts in real time. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full layered design and
current build status.

**Status: Phase 3** — Master trade detection/transmission, and Master →
Backend → Slave copying (OPEN/CLOSE/MODIFY) fanning out concurrently to
multiple Slaves at once, each with an independent outcome, proven
end-to-end. No PARTIAL_CLOSE/pending orders, risk/volume logic,
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

Run the test suite (requires Postgres/Redis up, as above):

```bash
npm test
```

When you're ready to connect real MT5 terminals instead of the simulators,
follow [connectors/master-ea/README.md](connectors/master-ea/README.md) and
[connectors/slave-service/README.md](connectors/slave-service/README.md).
