import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { redis, redisSub } from "../src/config/redis.js";
import { registerConnector } from "../src/modules/connectors/connector.service.js";
import { startCopyEngine } from "../src/modules/copy-engine/copyEngine.js";

/**
 * Phase 3: one Master event must fan out to every assigned, connected Slave
 * concurrently, with each Slave's outcome (EXECUTED/FAILED/offline)
 * completely independent of the others.
 */
describe("Copy Engine: multi-slave fan-out", () => {
  let app: ReturnType<typeof buildApp>;
  let masterToken: string;
  let masterId: string;
  let slaveIds: string[];
  let slaveTokens: string[];

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    startCopyEngine();

    const master = await prisma.master.create({
      data: {
        name: "Multi-Slave Test Master",
        accountNumber: `TEST-MS-M-${randomUUID()}`,
        broker: "Test Broker",
        platform: "MT5",
        server: "Test-Server",
      },
    });
    masterId = master.id;
    masterToken = (await registerConnector({ masterId }, "test")).token;

    slaveIds = [];
    slaveTokens = [];
    for (let i = 0; i < 3; i += 1) {
      const slave = await prisma.slave.create({
        data: {
          masterId,
          name: `Multi-Slave Test Slave ${i}`,
          accountNumber: `TEST-MS-S${i}-${randomUUID()}`,
          broker: "Test Broker",
          platform: "MT5",
          server: "Test-Server",
        },
      });
      slaveIds.push(slave.id);
      slaveTokens.push((await registerConnector({ slaveId: slave.id }, "test")).token);
    }
  });

  afterAll(async () => {
    await prisma.copyOrder.deleteMany({ where: { masterId } });
    await prisma.tradeEvent.deleteMany({ where: { masterId } });
    await prisma.connector.deleteMany({ where: { OR: [{ masterId }, { slaveId: { in: slaveIds } }] } });
    await prisma.slave.deleteMany({ where: { id: { in: slaveIds } } });
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
      masterTicket: "MS-TICKET-1",
      type: "OPEN",
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.5,
      price: 1.085,
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

  async function connectFakeSlave(token: string): Promise<WebSocket> {
    return app.injectWS("/ws/slave", { headers: { authorization: `Bearer ${token}` } });
  }

  async function closeWs(ws: WebSocket): Promise<void> {
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.terminate();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  it("dispatches one OPEN concurrently to all connected slaves, each with an independent EXECUTED outcome", async () => {
    const sockets = await Promise.all(slaveTokens.map((token) => connectFakeSlave(token)));
    const receivedAt: number[] = [];

    const instructions = sockets.map(
      (ws) =>
        new Promise<Record<string, unknown>>((resolve) => {
          ws.on("message", (raw: Buffer) => {
            receivedAt.push(Date.now());
            resolve(JSON.parse(raw.toString("utf-8")));
          });
        }),
    );

    await sendMasterEvent(masterEventPayload({ eventId: `CP-${randomUUID()}`, masterTicket: "MS-TICKET-1", type: "OPEN" }));

    const results = await Promise.all(instructions);
    expect(results).toHaveLength(3);
    results.forEach((instruction) => expect(instruction.action).toBe("OPEN"));

    // Loose concurrency signal: if dispatch were sequential (three DB
    // round-trips awaited one after another), the spread between the first
    // and last slave receiving its instruction would track that. Concurrent
    // dispatch keeps it tight.
    const spread = Math.max(...receivedAt) - Math.min(...receivedAt);
    expect(spread).toBeLessThan(150);

    sockets.forEach((ws, i) => {
      ws.send(
        JSON.stringify({
          copyId: results[i]?.copyId,
          status: "EXECUTED",
          slaveTicket: `SLV-${i}-TICKET`,
          executionPrice: 1.0851 + i * 0.0001,
        }),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    for (let i = 0; i < 3; i += 1) {
      const copyOrder = await prisma.copyOrder.findUnique({ where: { id: results[i]?.copyId as string } });
      expect(copyOrder?.status).toBe("EXECUTED");
      expect(copyOrder?.slaveTicket).toBe(`SLV-${i}-TICKET`);
    }

    await Promise.all(sockets.map(closeWs));
  });

  it("keeps outcomes independent: one slave offline, one replies FAILED, one EXECUTED", async () => {
    // slave 0 stays offline entirely.
    const ws1 = await connectFakeSlave(slaveTokens[1] as string);
    const ws2 = await connectFakeSlave(slaveTokens[2] as string);

    const instruction1 = new Promise<Record<string, unknown>>((resolve) => {
      ws1.on("message", (raw: Buffer) => resolve(JSON.parse(raw.toString("utf-8"))));
    });
    const instruction2 = new Promise<Record<string, unknown>>((resolve) => {
      ws2.on("message", (raw: Buffer) => resolve(JSON.parse(raw.toString("utf-8"))));
    });

    await sendMasterEvent(masterEventPayload({ eventId: `CP-${randomUUID()}`, masterTicket: "MS-TICKET-2", type: "OPEN" }));

    const [received1, received2] = await Promise.all([instruction1, instruction2]);

    ws1.send(JSON.stringify({ copyId: received1?.copyId, status: "FAILED", reason: "MARKET_CLOSED" }));
    ws2.send(JSON.stringify({ copyId: received2?.copyId, status: "EXECUTED", slaveTicket: "SLV-2-TICKET", executionPrice: 1.0855 }));

    await new Promise((resolve) => setTimeout(resolve, 400));

    const offlineOrder = await prisma.copyOrder.findFirst({
      where: { masterId, slaveId: slaveIds[0], masterTicket: "MS-TICKET-2" },
    });
    expect(offlineOrder?.status).toBe("FAILED");
    expect(offlineOrder?.errorReason).toBe("SLAVE_OFFLINE");

    const failedOrder = await prisma.copyOrder.findUnique({ where: { id: received1?.copyId as string } });
    expect(failedOrder?.status).toBe("FAILED");
    expect(failedOrder?.errorReason).toBe("MARKET_CLOSED");

    const executedOrder = await prisma.copyOrder.findUnique({ where: { id: received2?.copyId as string } });
    expect(executedOrder?.status).toBe("EXECUTED");
    expect(executedOrder?.slaveTicket).toBe("SLV-2-TICKET");

    await Promise.all([closeWs(ws1), closeWs(ws2)]);
  });
});
