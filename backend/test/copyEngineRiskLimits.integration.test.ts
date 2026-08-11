import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { redis, redisSub } from "../src/config/redis.js";
import { registerConnector } from "../src/modules/connectors/connector.service.js";
import { startCopyEngine } from "../src/modules/copy-engine/copyEngine.js";
import { upsertSymbolMapping } from "../src/modules/slaves/symbolMapping.service.js";

/**
 * Proves symbol mapping and the four "cheap" risk limits are actually
 * wired into the live OPEN path, and — the key design rule for this
 * change — that none of them ever block a CLOSE or MODIFY.
 */
describe("Copy Engine: symbol mapping + risk limits", () => {
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
        name: "Risk Limits Test Master",
        accountNumber: `TEST-RL-M-${randomUUID()}`,
        broker: "Test Broker",
        platform: "MT5",
        server: "Test-Server",
      },
    });
    masterId = master.id;
    masterToken = (await registerConnector({ masterId }, "test")).token;

    const slaveConfigs = {
      symbolMapped: {},
      noMapping: {},
      blockedSymbol: { blockedSymbols: ["XAUUSD"] },
      allowedSymbolMiss: { allowedSymbols: ["EURUSD"] },
      emergencyStopBypass: {}, // flipped to emergencyStop=true mid-test, after an initial OPEN
      maxPositions: { maxPositions: 1 },
      maxExposure: { maxExposure: 1.0 },
    };

    for (const [key, config] of Object.entries(slaveConfigs)) {
      const slave = await prisma.slave.create({
        data: {
          masterId,
          name: `Risk Limits Test Slave (${key})`,
          accountNumber: `TEST-RL-S-${key}-${randomUUID()}`,
          broker: "Test Broker",
          platform: "MT5",
          server: "Test-Server",
          ...config,
        },
      });
      slaveIds[key] = slave.id;
      slaveTokens[key] = (await registerConnector({ slaveId: slave.id }, "test")).token;
    }

    await upsertSymbolMapping(slaveIds.symbolMapped as string, "XAUUSD", "XAUUSDm");
  });

  afterAll(async () => {
    await prisma.symbolMapping.deleteMany({ where: { slaveId: { in: Object.values(slaveIds) } } });
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

  function masterEventPayload(overrides: Record<string, unknown>) {
    const now = new Date();
    return {
      eventId: `CP-${randomUUID()}`,
      masterTicket: "RL-TICKET",
      type: "OPEN",
      symbol: "XAUUSD",
      side: "BUY",
      volume: 1.0,
      price: 3350.2,
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

  it("uses the mapped symbol in the instruction when a mapping is configured", async () => {
    const ws = await connectFakeSlave("symbolMapped");
    const instructionReceived = new Promise<Record<string, unknown>>((resolve) => {
      ws.on("message", (raw: Buffer) => resolve(JSON.parse(raw.toString("utf-8"))));
    });

    await sendMasterEvent(masterEventPayload({ eventId: `CP-${randomUUID()}`, masterTicket: `RL-MAP-${randomUUID()}` }));
    const instruction = await instructionReceived;

    expect(instruction.symbol).toBe("XAUUSDm");
    await closeWs(ws);
  });

  it("falls back to the Master's symbol unchanged when no mapping is configured", async () => {
    const ws = await connectFakeSlave("noMapping");
    const instructionReceived = new Promise<Record<string, unknown>>((resolve) => {
      ws.on("message", (raw: Buffer) => resolve(JSON.parse(raw.toString("utf-8"))));
    });

    await sendMasterEvent(masterEventPayload({ eventId: `CP-${randomUUID()}`, masterTicket: `RL-NOMAP-${randomUUID()}` }));
    const instruction = await instructionReceived;

    expect(instruction.symbol).toBe("XAUUSD");
    await closeWs(ws);
  });

  it("rejects a blocked symbol without sending anything", async () => {
    const ws = await connectFakeSlave("blockedSymbol");
    let received = false;
    ws.on("message", () => {
      received = true;
    });

    const ticket = `RL-BLOCK-${randomUUID()}`;
    await sendMasterEvent(masterEventPayload({ eventId: `CP-${randomUUID()}`, masterTicket: ticket }));
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(received).toBe(false);
    const copyOrder = await prisma.copyOrder.findFirst({ where: { slaveId: slaveIds.blockedSymbol, masterTicket: ticket } });
    expect(copyOrder?.status).toBe("FAILED");
    expect(copyOrder?.errorReason).toBe("SYMBOL_BLOCKED");

    await closeWs(ws);
  });

  it("rejects a symbol missing from a non-empty allowedSymbols list", async () => {
    const ws = await connectFakeSlave("allowedSymbolMiss");
    let received = false;
    ws.on("message", () => {
      received = true;
    });

    const ticket = `RL-ALLOWMISS-${randomUUID()}`;
    await sendMasterEvent(masterEventPayload({ eventId: `CP-${randomUUID()}`, masterTicket: ticket })); // symbol XAUUSD, allowlist is [EURUSD]
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(received).toBe(false);
    const copyOrder = await prisma.copyOrder.findFirst({ where: { slaveId: slaveIds.allowedSymbolMiss, masterTicket: ticket } });
    expect(copyOrder?.status).toBe("FAILED");
    expect(copyOrder?.errorReason).toBe("SYMBOL_NOT_ALLOWED");

    await closeWs(ws);
  });

  it("rejects a second OPEN once maxPositions is reached", async () => {
    const ws = await connectFakeSlave("maxPositions");
    const instructions: Record<string, unknown>[] = [];
    ws.on("message", (raw: Buffer) => instructions.push(JSON.parse(raw.toString("utf-8"))));

    const firstTicket = `RL-MAXPOS-1-${randomUUID()}`;
    await sendMasterEvent(masterEventPayload({ eventId: `CP-${randomUUID()}`, masterTicket: firstTicket }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(instructions).toHaveLength(1);

    // Mark the first as EXECUTED so it counts as an open position.
    ws.send(JSON.stringify({ copyId: instructions[0]?.copyId, status: "EXECUTED", slaveTicket: "999111", executionPrice: 3350.5 }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const secondTicket = `RL-MAXPOS-2-${randomUUID()}`;
    await sendMasterEvent(masterEventPayload({ eventId: `CP-${randomUUID()}`, masterTicket: secondTicket }));
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(instructions).toHaveLength(1); // second OPEN never sent
    const secondOrder = await prisma.copyOrder.findFirst({ where: { slaveId: slaveIds.maxPositions, masterTicket: secondTicket } });
    expect(secondOrder?.status).toBe("FAILED");
    expect(secondOrder?.errorReason).toBe("MAX_POSITIONS_REACHED");

    await closeWs(ws);
  });

  it("rejects an OPEN whose sized volume would exceed maxExposure", async () => {
    const ws = await connectFakeSlave("maxExposure");
    const instructions: Record<string, unknown>[] = [];
    ws.on("message", (raw: Buffer) => instructions.push(JSON.parse(raw.toString("utf-8"))));

    const firstTicket = `RL-MAXEXP-1-${randomUUID()}`;
    await sendMasterEvent(masterEventPayload({ eventId: `CP-${randomUUID()}`, masterTicket: firstTicket, volume: 0.8 }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(instructions).toHaveLength(1);
    expect(instructions[0]?.volume).toBe(0.8);

    ws.send(JSON.stringify({ copyId: instructions[0]?.copyId, status: "EXECUTED", slaveTicket: "888222", executionPrice: 3350.5 }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const secondTicket = `RL-MAXEXP-2-${randomUUID()}`;
    await sendMasterEvent(masterEventPayload({ eventId: `CP-${randomUUID()}`, masterTicket: secondTicket, volume: 0.5 })); // 0.8 + 0.5 > 1.0
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(instructions).toHaveLength(1); // second OPEN never sent
    const secondOrder = await prisma.copyOrder.findFirst({ where: { slaveId: slaveIds.maxExposure, masterTicket: secondTicket } });
    expect(secondOrder?.status).toBe("FAILED");
    expect(secondOrder?.errorReason).toBe("MAX_EXPOSURE_EXCEEDED");

    await closeWs(ws);
  });

  it("emergency stop blocks a new OPEN but never blocks a CLOSE for an existing position", async () => {
    const ws = await connectFakeSlave("emergencyStopBypass");
    const instructions: Record<string, unknown>[] = [];
    ws.on("message", (raw: Buffer) => instructions.push(JSON.parse(raw.toString("utf-8"))));

    const ticket = `RL-ESTOP-${randomUUID()}`;

    // Open a position while the slave is still normal.
    await sendMasterEvent(masterEventPayload({ eventId: `CP-${randomUUID()}`, masterTicket: ticket }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(instructions).toHaveLength(1);
    expect(instructions[0]?.action).toBe("OPEN");

    ws.send(JSON.stringify({ copyId: instructions[0]?.copyId, status: "EXECUTED", slaveTicket: "777333", executionPrice: 3350.5 }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Flip the emergency stop on.
    await prisma.slave.update({ where: { id: slaveIds.emergencyStopBypass }, data: { emergencyStop: true } });

    // A brand new OPEN must now be rejected.
    const newTicket = `RL-ESTOP-NEW-${randomUUID()}`;
    await sendMasterEvent(masterEventPayload({ eventId: `CP-${randomUUID()}`, masterTicket: newTicket }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(instructions).toHaveLength(1); // still just the first OPEN — new one never sent
    const rejectedOpen = await prisma.copyOrder.findFirst({ where: { slaveId: slaveIds.emergencyStopBypass, masterTicket: newTicket } });
    expect(rejectedOpen?.status).toBe("FAILED");
    expect(rejectedOpen?.errorReason).toBe("EMERGENCY_STOP_ACTIVE");

    // But CLOSE on the position opened before the stop must still go through.
    await sendMasterEvent(masterEventPayload({ eventId: `CP-${randomUUID()}`, masterTicket: ticket, type: "CLOSE" }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(instructions).toHaveLength(2);
    expect(instructions[1]?.action).toBe("CLOSE");

    await closeWs(ws);
  });
});
