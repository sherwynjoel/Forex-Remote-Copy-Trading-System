/**
 * Sends a single synthetic Master heartbeat with balance/equity, in the
 * exact shape ForexCopyMasterEA.mq5's OnTimer() sends. There's no
 * "simulate master" long-running process (unlike simulate-slave.ts) since
 * the Master only needs this one field pair for BALANCE_PROPORTIONAL /
 * EQUITY_PROPORTIONAL sizing on its Slaves — running this once before
 * testing those modes is enough.
 *
 * Usage:
 *   npm run simulate:master-heartbeat -- --balance 10000 --equity 9800
 *   npm run simulate:master-heartbeat                                  (reads .dev-connector-token, defaults to 10000/10000)
 */
import { readFile } from "node:fs/promises";

const TOKEN_FILE = ".dev-connector-token";
const PORT = process.env.PORT ?? "4000";
const BASE_URL = process.env.BACKEND_URL ?? `http://localhost:${PORT}`;

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
    throw new Error(`No connector token found. Run "npm run seed" first, or pass --token <token>.`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = await loadToken(args.token);
  const balance = args.balance ? Number(args.balance) : 10000;
  const equity = args.equity ? Number(args.equity) : balance;

  const response = await fetch(`${BASE_URL}/api/connectors/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ balance, equity }),
  });

  console.log(`HTTP ${response.status}`);
  console.log(JSON.stringify({ sent: { balance, equity }, response: await response.json() }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
