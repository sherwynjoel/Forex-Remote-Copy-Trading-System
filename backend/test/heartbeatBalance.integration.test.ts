import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { redis, redisSub } from "../src/config/redis.js";
import { registerConnector } from "../src/modules/connectors/connector.service.js";

/**
 * Balance/equity is the only data BALANCE_PROPORTIONAL / EQUITY_PROPORTIONAL
 * volume sizing has to work with, and it arrives exclusively via each
 * connector's heartbeat (see connector.service.ts::recordHeartbeat). This
 * proves both the Master's HTTP heartbeat and the Slave's WS heartbeat
 * actually persist it to the right row.
 */
describe("Heartbeat balance/equity tracking", () => {
  let app: ReturnType<typeof buildApp>;
  let masterId: string;
  let masterToken: string;
  let slaveId: string;
  let slaveToken: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();

    const master = await prisma.master.create({
      data: {
        name: "Heartbeat Test Master",
        accountNumber: `TEST-HB-M-${randomUUID()}`,
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
        name: "Heartbeat Test Slave",
        accountNumber: `TEST-HB-S-${randomUUID()}`,
        broker: "Test Broker",
        platform: "MT5",
        server: "Test-Server",
      },
    });
    slaveId = slave.id;
    slaveToken = (await registerConnector({ slaveId }, "test")).token;
  });

  afterAll(async () => {
    await prisma.connector.deleteMany({ where: { OR: [{ masterId }, { slaveId }] } });
    await prisma.slave.delete({ where: { id: slaveId } });
    await prisma.master.delete({ where: { id: masterId } });
    await app.close();
    redisSub.disconnect();
    redis.disconnect();
    await prisma.$disconnect();
  });

  it("persists balance/equity/positions from the Master's HTTP heartbeat", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/connectors/heartbeat",
      headers: { authorization: `Bearer ${masterToken}` },
      payload: {
        balance: 12345.67,
        equity: 12000.5,
        positions: [{ ticket: "M1", symbol: "XAUUSD", side: "BUY", volume: 1.0, sl: 3340.2, tp: 3370.2 }],
      },
    });
    expect(response.statusCode).toBe(200);

    const master = await prisma.master.findUnique({ where: { id: masterId } });
    expect(Number(master?.balance)).toBe(12345.67);
    expect(Number(master?.equity)).toBe(12000.5);
    expect(master?.positionSnapshot).toEqual([
      { ticket: "M1", symbol: "XAUUSD", side: "BUY", volume: 1.0, sl: 3340.2, tp: 3370.2 },
    ]);
    expect(master?.positionSnapshotAt).not.toBeNull();
  });

  it("leaves balance/equity untouched when a heartbeat omits them", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/connectors/heartbeat",
      headers: { authorization: `Bearer ${masterToken}` },
      payload: {},
    });
    expect(response.statusCode).toBe(200);

    const master = await prisma.master.findUnique({ where: { id: masterId } });
    expect(Number(master?.balance)).toBe(12345.67); // unchanged from the previous test
  });

  it("persists balance/equity/positions from the Slave's WS heartbeat message", async () => {
    const ws = await app.injectWS("/ws/slave", { headers: { authorization: `Bearer ${slaveToken}` } });
    // injectWS() resolves as soon as the client side is connected, which can
    // be before the server's async auth handshake has finished registering
    // its message listener — give it a moment (same race handled elsewhere
    // in copyEngineMultiSlave.integration.test.ts).
    await new Promise((resolve) => setTimeout(resolve, 50));

    ws.send(
      JSON.stringify({
        type: "heartbeat",
        balance: 5432.1,
        equity: 5400.0,
        positions: [{ ticket: "S1", symbol: "XAUUSDm", side: "BUY", volume: 1.0, comment: "copy:CP1" }],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    const slave = await prisma.slave.findUnique({ where: { id: slaveId } });
    expect(Number(slave?.balance)).toBe(5432.1);
    expect(Number(slave?.equity)).toBe(5400.0);
    expect(slave?.positionSnapshot).toEqual([
      { ticket: "S1", symbol: "XAUUSDm", side: "BUY", volume: 1.0, comment: "copy:CP1" },
    ]);
    expect(slave?.positionSnapshotAt).not.toBeNull();

    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.terminate();
    });
  });
});
