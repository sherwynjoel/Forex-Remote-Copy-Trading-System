# Deployment

Everything up to this point has run on localhost. This is the one-time
setup for a real, always-on backend that your Master and Slave terminals
(on their own separate VPS boxes, per the plan discussed in-session) can
actually reach over the internet. It's one small VPS running four
containers: Postgres, Redis, the backend API, and Caddy — Caddy fronts
everything, serves the built dashboard, and automatically provisions/
renews HTTPS via Let's Encrypt, so there's no manual certificate work.

This has been built and verified locally (the Docker image genuinely
boots, connects to Postgres/Redis, and serves real requests — see the
commit history) but **not yet run on a real VPS**. Treat the first real
run as the actual verification step, same as every EA in this project.

## What you need before starting

- A VPS running Ubuntu 22.04+ (or any modern Linux) with Docker + the
  Docker Compose plugin installed. Any provider works — this doesn't need
  much: 1-2 vCPU, 2GB RAM is comfortable headroom for this workload.
- A domain name, with its DNS A (and AAAA, if the VPS has IPv6) record
  pointed at the VPS's IP address. Caddy needs this to be live and
  resolving *before* you start the stack, or it can't obtain a
  certificate.
- Ports 80 and 443 open/reachable on the VPS (needed for Let's Encrypt's
  HTTP-01 challenge and for HTTPS itself).

## 1. Get the code onto the VPS

```bash
git clone https://github.com/sherwynjoel/Forex-Remote-Copy-Trading-System.git
cd Forex-Remote-Copy-Trading-System
```

## 2. Configure real secrets

```bash
cp .env.production.example .env.production
```

Edit `.env.production` and replace every `REPLACE_WITH_*` placeholder:

- `POSTGRES_PASSWORD` — a real random password (keep it consistent with
  the same value inside `DATABASE_URL` further down the file).
- `JWT_SECRET` — generate with `openssl rand -hex 32`. This signs every
  admin session; a guessable value defeats the entire point of the
  Phase 6 auth work.
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — your real Super Admin login, not
  `admin`/`admin`.
- `CORS_ORIGIN` and `DOMAIN` — your actual domain, `https://` included on
  `CORS_ORIGIN`.

This file holds real secrets and is already excluded by `.gitignore` —
double check `git status` never shows it before any commit.

## 3. Build the dashboard for this domain

Vite bakes `VITE_API_URL` into the static bundle at build time, so this
has to happen with the real domain already set, and has to be rebuilt if
that ever changes:

```bash
cd frontend
cp .env.production.example .env.production
# edit .env.production: VITE_API_URL=https://your-real-domain
npm install
npm run build
cd ..
```

This produces `frontend/dist/` — the compose file mounts it straight into
the Caddy container as static files.

## 4. Bring up the stack

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

First run will take a minute (building the backend image, Caddy
requesting its certificate). Check it's healthy:

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs caddy --tail 30
```

## 5. Apply the schema and bootstrap the admin

The backend image ships with the Prisma CLI specifically so this can run
as a one-off command against the same image already built above — no
separate toolchain needed:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm backend npm run prisma:migrate:deploy
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm backend npm run seed:admin
```

Use `seed:admin`, not `seed` — the latter also creates
`DEV-MASTER-001`/`DEV-SLAVE-00N` fixtures for local testing, which have no
place in a production database.

## 6. Verify

```bash
curl https://your-real-domain/api/system/health
```

Should return `{"status":"ONLINE",...}` over real HTTPS, with a
browser-trusted certificate (check in an actual browser, not just curl,
to confirm Caddy's certificate is trusted, not self-signed). Log into the
dashboard at `https://your-real-domain` with the admin credentials from
step 2.

Confirm the split still holds in production exactly like it does locally:
`https://your-real-domain/api/system/health` needs no auth,
`https://your-real-domain/api/masters` 401s without a token, and a real
`POST /api/auth/login` issues one.

## 7. Point your connectors at it

Follow the connector READMEs
([master-ea](../connectors/master-ea/README.md),
[master-ea-mt4](../connectors/master-ea-mt4/README.md),
[slave-service](../connectors/slave-service/README.md),
[slave-ea-mt4](../connectors/slave-ea-mt4/README.md)) exactly as before,
except:

- `BackendUrl` / `BACKEND_WS_URL` is now `https://your-real-domain` /
  `wss://your-real-domain/ws/slave` — **`https`/`wss`, not `http`/`ws`**.
- Register real Masters/Slaves against this backend (get an admin token
  from step 6's login first, same as the "Admin API access" section in
  the top-level README).
- On the MT4/MT5 side, allow-list `https://your-real-domain` under
  **Tools → Options → Expert Advisors**, same as local dev.

Per the project's own rule, prove this whole path on Exness **demo**
accounts before pointing any of it at live money — same verification
steps as every connector README's "prove it end-to-end" section, just
against the real backend instead of localhost.

## Updating

```bash
git pull
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build backend
# if the frontend changed:
cd frontend && npm run build && cd ..
# if the schema changed:
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm backend npm run prisma:migrate:deploy
```

## What this doesn't cover yet

- **Backups** — `forex_copy_pg` is a named Docker volume with no automated
  backup. Before trusting this with real trading history, set up a
  scheduled `pg_dump` (or your provider's volume-snapshot feature)
  somewhere off the VPS itself.
- **Monitoring/alerting** — `GET /api/system/health` exists for this, but
  nothing polls it or pages anyone yet.
- **Horizontal scaling** — there's exactly one Copy Engine instance by
  design (see docs/ARCHITECTURE.md); this setup matches that, not a
  cluster.
- **Windows-side process supervision** — keeping the Master/Slave
  terminals themselves running (auto-login, EA reattachment after a VPS
  reboot) is a Windows-VPS concern, not something this repo automates.
