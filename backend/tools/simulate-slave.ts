/**
 * A fake Slave connector: connects to the real /ws/slave gateway, prints
 * every copy instruction it receives, and replies with a synthetic
 * execution result. Proves the Copy Engine's full loop (routing, copy_orders
 * lifecycle, offline handling) without a real MT5 terminal — the real
 * Python service in connectors/slave-service/ speaks the exact same
 * protocol and is a drop-in replacement once MT5 is available.
 *
 * Usage:
 *   npm run simulate:slave -- --token <slave-connector-token>
 *   npm run simulate:slave                                      (reads .dev-slave-connector-token)
 *   npm run simulate:slave -- --fail                             (always replies FAILED, for testing)
 */
import { readFile } from "node:fs/promises";
import WebSocket from "ws";

const TOKEN_FILE = ".dev-slave-connector-token";
const PORT = process.env.PORT ?? "4000";
const WS_URL = process.env.SLAVE_WS_URL ?? `ws://localhost:${PORT}/ws/slave`;

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
  if (process.env.SLAVE_CONNECTOR_TOKEN) return process.env.SLAVE_CONNECTOR_TOKEN;
  try {
    return (await readFile(TOKEN_FILE, "utf-8")).trim();
  } catch {
    throw new Error(`No slave connector token found. Register one, or pass --token <token>.`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = await loadToken(args.token);
  const alwaysFail = args.fail === "true";

  const socket = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${token}` } });

  socket.on("open", () => {
    console.log(`[fake-slave] connected to ${WS_URL}`);
  });

  socket.on("message", (raw) => {
    const instruction = JSON.parse(raw.toString("utf-8"));
    console.log("[fake-slave] received instruction:", instruction);

    const result = alwaysFail
      ? { copyId: instruction.copyId, status: "FAILED", reason: "SIMULATED_FAILURE" }
      : {
          copyId: instruction.copyId,
          status: "EXECUTED",
          slaveTicket: instruction.slaveTicket ?? String(Math.floor(100000 + Math.random() * 900000)),
          executionPrice: Number((3350 + Math.random()).toFixed(2)),
        };

    setTimeout(() => {
      socket.send(JSON.stringify(result));
      console.log("[fake-slave] sent result:", result);
    }, 20); // simulate a small, realistic execution delay
  });

  socket.on("close", (code, reason) => {
    console.log(`[fake-slave] disconnected (${code} ${reason.toString()})`);
    process.exit(0);
  });

  socket.on("error", (err) => {
    console.error("[fake-slave] error:", err.message);
  });

  // Keep the process alive; also doubles as a heartbeat so the connector
  // doesn't get swept OFFLINE while it's just sitting parked.
  setInterval(() => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: "heartbeat" }));
    }
  }, 5000);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
