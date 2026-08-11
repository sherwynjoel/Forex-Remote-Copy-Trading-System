# Forex Remote Copy Trading System

A production-oriented system that replicates trading activity from a Master
MT5 account to multiple Slave MT5 accounts in real time. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full layered design and
current build status.

**Status: Phase 1** — Master trade detection and transmission, proven
end-to-end. No Slave, Copy Engine, risk logic, or dashboard yet (see
"What's next" in the architecture doc).

## Repository layout

- `backend/` — Node.js + TypeScript API (Fastify), PostgreSQL (Prisma),
  Redis. The ingest endpoint, connector auth, and real-time pub/sub layer
  live here.
- `connectors/master-ea/` — the MQL5 Expert Advisor that runs on the Master
  MT5 terminal.
- `docs/` — architecture and design notes.

## Quickstart (Phase 1)

```bash
cd backend
cp .env.example .env
docker compose up -d           # Postgres + Redis
npm install
npm run prisma:migrate         # applies the schema
npm run dev                    # starts the API on :4000

# in another terminal:
npm run seed                   # creates a dev Master + connector token
npm run simulate -- --event OPEN --symbol XAUUSD --volume 1.0 --sl 3340.20 --tp 3370.20
```

Check `GET http://localhost:4000/api/system/health`, and confirm the
simulated event shows up in the `trade_events` table with a latency
breakdown logged to the console.

Run the test suite (requires Postgres/Redis up, as above):

```bash
npm test
```

When you're ready to connect a real MT5 terminal instead of the simulator,
follow [connectors/master-ea/README.md](connectors/master-ea/README.md).
