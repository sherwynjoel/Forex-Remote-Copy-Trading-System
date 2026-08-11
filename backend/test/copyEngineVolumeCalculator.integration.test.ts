import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { redis, redisSub } from "../src/config/redis.js";
import { registerConnector } from "../src/modules/connectors/connector.service.js";
import { startCopyEngine } from "../src/modules/copy-engine/copyEngine.js";

/**
 * Proves the Volume Calculator is actually wired into the live OPEN path —
 * not just correct in isolation (see volumeCalculator.test.ts). Each slave
 * is configured with a different sizing mode; the instruction the fake
 * slave receives, and the copy_orders row, must reflect the calculated
 * size, not the raw Master volume.
 */
describe("Copy Engine: volume calculator wired into OPEN", () => {
  let app: ReturnType<typeof buildApp>;
  let masterToken: string;
  let masterId: string;

  const slaveIds: Record<string, string> = {};
  const slaveTokens: Record<string, string> = {};

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    startCopyEngine();

    const master = await prisma.master.create({
      data: {
        name: "Volume Calc Test Master",
        accountNumber: `TEST-VC-M-${randomUUID()}`,
        broker: "Test Broker",
        platform: "MT5",
        server: "Test-Server",
        balance: 10000,
        equity: 10000,
      },
    });
    masterId = master.id;
    masterToken = (await registerConnector({ masterId }, "test")).token;

    const slaveConfigs = {
      multiplier: { copyMode: "MULTIPLIER" as const, multiplier: 2 },
      balanceProportional: { copyMode: "BALANCE_PROPORTIONAL" as const, balance: 5000, equity: 5000 },
      maxLotClamp: { copyMode: "MULTIPLIER" as const, multiplier: 50, maxLot: 5.0 },
      rejected: { copyMode: "FIXED_LOT" as const, fixedLot: null },
    };

    for (const [key, config] of Object.entries(slaveConfigs)) {
      const slave = await prisma.slave.create({
        data: {
          masterId,
          name: `Volume Calc Test Slave (${key})`,
          accountNumber: `TEST-VC-S-${key}-${randomUUID()}`,
          broker: "Test Broker",
          platform: "MT5",
          server: "Test-Server",
          ...config,
        },
      });
      slaveIds[key] = slave.id;
      slaveTokens[key] = (await registerConnector({ slaveId: slave.id }, "test")).token;
    }
  });

  afterAll(async () => {
    await prisma.copyOrder.deleteMany({ where: { masterId } });
    await prisma.tradeEvent.deleteMany({ where: { masterId } });
    await prisma.connector.deleteMany({ where: { OR: [{ masterId }, { slaveId: { in: Object.values(slaveIds) } }] } });
    await prisma.slave.deleteMany({ where: { id: { in: Object.values(slaveIds) } } });
    await prisma.master.delete({ where: { id: masterId } });
    await app.close();
    redisSub.disconnect();
    redis.disconnect();
    await prisma.$disconnect();
  });

  function masterOpenPayload(masterTicket: string, volume: number) {
    const now = new Date();
    return {
      eventId: `CP-${randomUUID()}`,
      masterTicket,
      type: "OPEN",
      symbol: "EURUSD",
      side: "BUY",
      volume,
      price: 1.085,
      masterEventTime: now.toISOString(),
      eaSentTime: new Date(now.getTime() + 1).toISOString(),
    };
  }

  async function sendMasterOpen(masterTicket: string, volume: number): Promise<void> {
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest/trade-event",
      headers: { authorization: `Bearer ${masterToken}` },
      payload: masterOpenPayload(masterTicket, volume),
    });
    expect(response.statusCode).toBe(202);
  }

  async function connectFakeSlave(key: string): Promise<WebSocket> {
    return app.injectWS("/ws/slave", { headers: { authorization: `Bearer ${slaveTokens[key]}` } });
  }

  async function closeWs(ws: WebSocket): Promise<void> {
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.terminate();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  it("MULTIPLIER: sizes the instruction to masterVolume * multiplier", async () => {
    const ws = await connectFakeSlave("multiplier");
    const instructionReceived = new Promise<Record<string, unknown>>((resolve) => {
      ws.on("message", (raw: Buffer) => resolve(JSON.parse(raw.toString("utf-8"))));
    });

    const ticket = `VC-MULT-${randomUUID()}`;
    await sendMasterOpen(ticket, 1.0);
    const instruction = await instructionReceived;

    expect(instruction.volume).toBe(2.0);

    const copyOrder = await prisma.copyOrder.findFirst({ where: { slaveId: slaveIds.multiplier, masterTicket: ticket } });
    expect(Number(copyOrder?.requestedVolume)).toBe(2.0);

    await closeWs(ws);
  });

  it("BALANCE_PROPORTIONAL: sizes by the slave/master balance ratio", async () => {
    const ws = await connectFakeSlave("balanceProportional");
    const instructionReceived = new Promise<Record<string, unknown>>((resolve) => {
      ws.on("message", (raw: Buffer) => resolve(JSON.parse(raw.toString("utf-8"))));
    });

    const ticket = `VC-BAL-${randomUUID()}`;
    await sendMasterOpen(ticket, 1.0); // master balance 10000, slave balance 5000 -> 0.5
    const instruction = await instructionReceived;

    expect(instruction.volume).toBe(0.5);

    await closeWs(ws);
  });

  it("clamps an oversized MULTIPLIER result to maxLot instead of rejecting", async () => {
    const ws = await connectFakeSlave("maxLotClamp");
    const instructionReceived = new Promise<Record<string, unknown>>((resolve) => {
      ws.on("message", (raw: Buffer) => resolve(JSON.parse(raw.toString("utf-8"))));
    });

    const ticket = `VC-CLAMP-${randomUUID()}`;
    await sendMasterOpen(ticket, 1.0); // 1.0 * 50 = 50, clamped to maxLot 5.0
    const instruction = await instructionReceived;

    expect(instruction.volume).toBe(5.0);

    await closeWs(ws);
  });

  it("rejects (never sends) when the Volume Calculator can't size the trade", async () => {
    const ws = await connectFakeSlave("rejected");
    let receivedAnything = false;
    ws.on("message", () => {
      receivedAnything = true;
    });

    const ticket = `VC-REJECT-${randomUUID()}`;
    await sendMasterOpen(ticket, 1.0); // FIXED_LOT with no fixedLot configured
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(receivedAnything).toBe(false);

    const copyOrder = await prisma.copyOrder.findFirst({ where: { slaveId: slaveIds.rejected, masterTicket: ticket } });
    expect(copyOrder?.status).toBe("FAILED");
    expect(copyOrder?.errorReason).toBe("FIXED_LOT_NOT_CONFIGURED");

    await closeWs(ws);
  });
});
