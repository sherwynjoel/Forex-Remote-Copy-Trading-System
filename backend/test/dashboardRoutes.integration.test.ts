import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { redis, redisSub } from "../src/config/redis.js";
import { getTestAdminToken, deleteTestAdmin } from "./testAuth.js";

/**
 * Seeds data directly via Prisma (rather than driving it through the live
 * ingest/Copy Engine pipeline, already covered elsewhere) so the dashboard
 * summary counts and copy-orders listing can be asserted deterministically.
 */
describe("Dashboard routes", () => {
  let app: ReturnType<typeof buildApp>;
  let adminToken: string;
  let adminId: string;
  let masterId: string;
  let onlineSlaveId: string;
  let offlineSlaveId: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    ({ token: adminToken, adminId } = await getTestAdminToken());

    const master = await prisma.master.create({
      data: {
        name: "Dashboard Test Master",
        accountNumber: `TEST-DB-M-${randomUUID()}`,
        broker: "Test Broker",
        platform: "MT5",
        server: "Test-Server",
      },
    });
    masterId = master.id;

    const onlineSlave = await prisma.slave.create({
      data: {
        masterId,
        name: "Dashboard Test Slave Online",
        accountNumber: `TEST-DB-S1-${randomUUID()}`,
        broker: "Test Broker",
        platform: "MT5",
        server: "Test-Server",
        status: "ONLINE",
        copyEnabled: true,
      },
    });
    onlineSlaveId = onlineSlave.id;

    const offlineSlave = await prisma.slave.create({
      data: {
        masterId,
        name: "Dashboard Test Slave Offline",
        accountNumber: `TEST-DB-S2-${randomUUID()}`,
        broker: "Test Broker",
        platform: "MT5",
        server: "Test-Server",
        status: "OFFLINE",
        copyEnabled: false,
      },
    });
    offlineSlaveId = offlineSlave.id;

    const tradeEvent = await prisma.tradeEvent.create({
      data: {
        eventId: `CP-${randomUUID()}`,
        masterId,
        masterTicket: "DB-M1",
        type: "OPEN",
        symbol: "XAUUSD",
        side: "BUY",
        volume: 1.0,
        rawPayload: {},
        masterEventTime: new Date(),
        eaSentTime: new Date(),
        backendReceivedTime: new Date(),
        detectionLatencyMs: 2,
        networkLatencyMs: 38,
        totalLatencyMs: 40,
      },
    });

    await prisma.copyOrder.create({
      data: {
        tradeEventId: tradeEvent.id,
        masterId,
        slaveId: onlineSlaveId,
        masterTicket: "DB-M1",
        type: "OPEN",
        status: "EXECUTED",
        requestedVolume: 1.0,
        slaveTicket: "DB-S1-TICKET",
      },
    });
    await prisma.copyOrder.create({
      data: {
        tradeEventId: tradeEvent.id,
        masterId,
        slaveId: offlineSlaveId,
        masterTicket: "DB-M1",
        type: "OPEN",
        status: "FAILED",
        errorReason: "SLAVE_OFFLINE",
      },
    });
  });

  afterAll(async () => {
    await prisma.copyOrder.deleteMany({ where: { masterId } });
    await prisma.tradeEvent.deleteMany({ where: { masterId } });
    await prisma.slave.deleteMany({ where: { masterId } });
    await prisma.master.delete({ where: { id: masterId } });
    await deleteTestAdmin(adminId);
    await app.close();
    redisSub.disconnect();
    redis.disconnect();
    await prisma.$disconnect();
  });

  function authHeader() {
    return { authorization: `Bearer ${adminToken}` };
  }

  it("rejects requests without a valid admin token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/dashboard/summary" });
    expect(response.statusCode).toBe(401);
  });

  it("GET /api/dashboard/summary reflects seeded counts", async () => {
    const response = await app.inject({ method: "GET", url: "/api/dashboard/summary", headers: authHeader() });
    expect(response.statusCode).toBe(200);
    const summary = response.json();

    expect(summary.totalMasters).toBeGreaterThanOrEqual(1);
    expect(summary.totalSlaves).toBeGreaterThanOrEqual(2);
    expect(summary.onlineSlaves).toBeGreaterThanOrEqual(1);
    expect(summary.offlineSlaves).toBeGreaterThanOrEqual(1);
    expect(summary.tradesToday).toBeGreaterThanOrEqual(1);
    expect(summary.successfulCopiesToday).toBeGreaterThanOrEqual(1);
    expect(summary.failedCopiesToday).toBeGreaterThanOrEqual(1);
    expect(summary.successRate).not.toBeNull();
    expect(summary.avgLatencyMs).not.toBeNull();
  });

  it("GET /api/copy-orders returns joined rows filtered by master", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/copy-orders?masterId=${masterId}`,
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    const rows = response.json();
    expect(rows).toHaveLength(2);
    expect(rows[0].tradeEvent.symbol).toBe("XAUUSD");
    expect(rows[0].master.name).toBe("Dashboard Test Master");
    expect(new Set(rows.map((r: { status: string }) => r.status))).toEqual(new Set(["EXECUTED", "FAILED"]));
  });

  it("GET /api/copy-orders respects the slaveId filter", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/copy-orders?slaveId=${onlineSlaveId}`,
      headers: authHeader(),
    });
    const rows = response.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("EXECUTED");
  });

  it("GET /api/masters/:id includes assigned slaves", async () => {
    const response = await app.inject({ method: "GET", url: `/api/masters/${masterId}`, headers: authHeader() });
    expect(response.statusCode).toBe(200);
    const master = response.json();
    expect(master.slaves).toHaveLength(2);
  });
});
