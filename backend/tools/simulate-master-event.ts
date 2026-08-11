/**
 * Sends a synthetic normalized trade event through the real ingest endpoint,
 * in the exact shape the Master EA will eventually send. Lets us prove the
 * full pipeline (auth -> idempotency -> Redis publish -> Postgres persist ->
 * latency logging) before any MT5 terminal exists.
 *
 * Usage:
 *   npm run simulate -- --event OPEN --symbol XAUUSD --volume 1.0 --sl 3340.20 --tp 3370.20
 *   npm run simulate -- --event OPEN --event-id CP-FIXED-1   (repeat to test dedupe)
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const TOKEN_FILE = ".dev-connector-token";
const DEFAULT_PORT = process.env.PORT ?? "4000";
const BASE_URL = process.env.BACKEND_URL ?? `http://localhost:${DEFAULT_PORT}`;

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw?.startsWith("--")) {
      const key = raw.slice(2);
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        args[key] = value;
        i += 1;
      } else {
        args[key] = "true";
      }
    }
  }
  return args;
}

async function loadToken(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (process.env.CONNECTOR_TOKEN) return process.env.CONNECTOR_TOKEN;
  try {
    return (await readFile(TOKEN_FILE, "utf-8")).trim();
  } catch {
    throw new Error(
      `No connector token found. Run "npm run seed" first, or pass --token <token>.`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = await loadToken(args.token);

  const now = new Date();
  const eaSentTime = new Date(now.getTime() + 2); // simulate ~2ms of EA-side work

  const payload = {
    eventId: args["event-id"] ?? `CP-${randomUUID()}`,
    masterTicket: args.ticket ?? String(Math.floor(100000 + Math.random() * 900000)),
    type: args.event ?? "OPEN",
    symbol: args.symbol ?? "XAUUSD",
    side: args.side ?? "BUY",
    volume: args.volume ? Number(args.volume) : 1.0,
    price: args.price ? Number(args.price) : 3350.2,
    sl: args.sl ? Number(args.sl) : undefined,
    tp: args.tp ? Number(args.tp) : undefined,
    masterEventTime: now.toISOString(),
    eaSentTime: eaSentTime.toISOString(),
  };

  const response = await fetch(`${BASE_URL}/api/ingest/trade-event`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json();
  console.log(`HTTP ${response.status}`);
  console.log(JSON.stringify({ sent: payload, response: body }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
