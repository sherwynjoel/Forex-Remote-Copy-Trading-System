import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { redis, redisSub } from "../src/config/redis.js";
import { registerConnector } from "../src/modules/connectors/connector.service.js";
import { startCopyEngine } from "../src/modules/copy-engine/copyEngine.js";

/**
 * Drives the same flow as `npm run simulate` + `npm run simulate:slave`, but
 * with the "slave" being an in-process WebSocket client (via
 * @fastify/websocket's injectWS) instead of a separate process — no real
 * network port needed.
 */
describe("Copy Engine: Master event -> Slave WS instruction -> execution result", () => {
  let app: ReturnType<typeof buildApp>;
  let masterToken: string;
  let slaveToken: string;
  let masterId: string;
  let slaveId: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    startCopyEngine();

    const master = await prisma.master.create({
      data: {
        name: "CE Test Master",
        accountNumber: `TEST-CE-M-${randomUUID()}`,
        broker: "Test Broker",
        platform: "MT5",
        server: "Test-Server",
      },
    });
    masterId = master.id;
    masterToken = (await registerConnector({ masterId }, "test")).token;

    const slave = await prisma.slave.create({
      data: {
        masterId,
        name: "CE Test Slave",
        accountNumber: `TEST-CE-S-${randomUUID()}`,
        broker: "Test Broker",
        platform: "MT5",
        server: "Test-Server",
      },
    });
    slaveId = slave.id;
    slaveToken = (await registerConnector({ slaveId }, "test")).token;
  });

  afterAll(async () => {
    await prisma.copyOrder.deleteMany({ where: { masterId } });
    await prisma.tradeEvent.deleteMany({ where: { masterId } });
    await prisma.connector.deleteMany({ where: { OR: [{ masterId }, { slaveId }] } });
    await prisma.slave.delete({ where: { id: slaveId } });
    await prisma.master.delete({ where: { id: masterId } });
    await app.close();
    redisSub.disconnect();
    redis.disconnect();
    await prisma.$disconnect();
  });

  function masterEventPayload(overrides: Record<string, unknown> = {}) {
    const now = new Date();
    return {
      eventId: `CP-${randomUUID()}`,
      masterTicket: "999888",
      type: "OPEN",
      symbol: "XAUUSD",
      side: "BUY",
      volume: 1.0,
      price: 3350.2,
      sl: 3340.2,
      tp: 3370.2,
      masterEventTime: now.toISOString(),
      eaSentTime: new Date(now.getTime() + 1).toISOString(),
      ...overrides,
    };
  }

  async function sendMasterEvent(payload: Record<string, unknown>): Promise<void> {
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest/trade-event",
      headers: { authorization: `Bearer ${masterToken}` },
      payload,
    });
    expect(response.statusCode).toBe(202);
  }

  async function connectFakeSlave(): Promise<WebSocket> {
    return app.injectWS("/ws/slave", { headers: { authorization: `Bearer ${slaveToken}` } });
  }

  async function closeWs(ws: WebSocket): Promise<void> {
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.terminate();
    });
    // Give the server-side "close" handler a moment to update its
    // in-memory connection map before the next assertion relies on it.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  it("routes an OPEN to the connected slave and records EXECUTED on the reply", async () => {
    const ws = await connectFakeSlave();
    const instructionReceived = new Promise<Record<string, unknown>>((resolve) => {
      ws.on("message", (raw: Buffer) => resolve(JSON.parse(raw.toString("utf-8"))));
    });

    await sendMasterEvent(masterEventPayload({ eventId: `CP-${randomUUID()}`, masterTicket: "999888", type: "OPEN" }));

    const instruction = await instructionReceived;
    expect(instruction.action).toBe("OPEN");
    expect(instruction.symbol).toBe("XAUUSD");
    expect(instruction.slaveTicket).toBeUndefined();

    ws.send(
      JSON.stringify({ copyId: instruction.copyId, status: "EXECUTED", slaveTicket: "555444", executionPrice: 3350.5 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    const copyOrder = await prisma.copyOrder.findUnique({ where: { id: instruction.copyId as string } });
    expect(copyOrder?.status).toBe("EXECUTED");
    expect(copyOrder?.slaveTicket).toBe("555444");
    expect(copyOrder?.type).toBe("OPEN");

    await closeWs(ws);
  });

  it("resolves the prior OPEN's slave ticket for a subsequent CLOSE", async () => {
    const ws = await connectFakeSlave();
    const instructionReceived = new Promise<Record<string, unknown>>((resolve) => {
      ws.on("message", (raw: Buffer) => resolve(JSON.parse(raw.toString("utf-8"))));
    });

    await sendMasterEvent(
      masterEventPayload({ eventId: `CP-${randomUUID()}`, masterTicket: "999888", type: "CLOSE", sl: undefined, tp: undefined }),
    );

    const instruction = await instructionReceived;
    expect(instruction.action).toBe("CLOSE");
    expect(instruction.slaveTicket).toBe("555444"); // from the prior test's EXECUTED OPEN

    ws.send(JSON.stringify({ copyId: instruction.copyId, status: "EXECUTED", slaveTicket: "555444", executionPrice: 3351.0 }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    const copyOrder = await prisma.copyOrder.findUnique({ where: { id: instruction.copyId as string } });
    expect(copyOrder?.status).toBe("EXECUTED");
    expect(copyOrder?.type).toBe("CLOSE");

    await closeWs(ws);
  });

  it("fails a CLOSE with NO_MATCHING_OPEN_COPY when there's no prior executed OPEN", async () => {
    const ws = await connectFakeSlave();
    // No message expected from the server in this case — the copy engine
    // fails before ever sending an instruction. Assert on copy_orders directly.
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the connection register

    await sendMasterEvent(
      masterEventPayload({ eventId: `CP-${randomUUID()}`, masterTicket: "NEVER-OPENED", type: "CLOSE" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 400));

    const copyOrder = await prisma.copyOrder.findFirst({
      where: { masterTicket: "NEVER-OPENED" },
      orderBy: { createdAt: "desc" },
    });
    expect(copyOrder?.status).toBe("FAILED");
    expect(copyOrder?.errorReason).toBe("NO_MATCHING_OPEN_COPY");

    await closeWs(ws);
  });

  it("fails immediately with SLAVE_OFFLINE when no slave is connected", async () => {
    // Deliberately no connectFakeSlave() call here.
    await sendMasterEvent(masterEventPayload({ eventId: `CP-${randomUUID()}`, masterTicket: "111222", type: "OPEN" }));
    await new Promise((resolve) => setTimeout(resolve, 400));

    const copyOrder = await prisma.copyOrder.findFirst({
      where: { masterTicket: "111222" },
      orderBy: { createdAt: "desc" },
    });
    expect(copyOrder?.status).toBe("FAILED");
    expect(copyOrder?.errorReason).toBe("SLAVE_OFFLINE");
  });
});
