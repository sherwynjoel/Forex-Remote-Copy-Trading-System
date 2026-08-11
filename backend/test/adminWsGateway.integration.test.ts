import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { redis, redisSub } from "../src/config/redis.js";
import { registerConnector } from "../src/modules/connectors/connector.service.js";
import { startCopyEngine } from "../src/modules/copy-engine/copyEngine.js";
import { getTestAdminToken, deleteTestAdmin } from "./testAuth.js";

describe("/ws/admin gateway", () => {
  let app: ReturnType<typeof buildApp>;
  let adminToken: string;
  let adminId: string;
  let masterId: string;
  let masterToken: string;
  let slaveId: string;
  let slaveToken: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    startCopyEngine();
    ({ token: adminToken, adminId } = await getTestAdminToken());

    const master = await prisma.master.create({
      data: {
        name: "Admin WS Test Master",
        accountNumber: `TEST-AWS-M-${randomUUID()}`,
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
        name: "Admin WS Test Slave",
        accountNumber: `TEST-AWS-S-${randomUUID()}`,
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
    await deleteTestAdmin(adminId);
    await app.close();
    redisSub.disconnect();
    redis.disconnect();
    await prisma.$disconnect();
  });

  it("rejects a connection with no token", async () => {
    await expect(app.injectWS("/ws/admin")).rejects.toBeTruthy();
  });

  it("broadcasts a copy_orders transition to connected admin dashboards", async () => {
    const adminWs = await app.injectWS(`/ws/admin?token=${adminToken}`);
    const slaveWs = await app.injectWS("/ws/slave", { headers: { authorization: `Bearer ${slaveToken}` } });
    await new Promise((resolve) => setTimeout(resolve, 50)); // let both handshakes finish registering

    const broadcastReceived = new Promise<Record<string, unknown>>((resolve) => {
      adminWs.on("message", (raw: Buffer) => resolve(JSON.parse(raw.toString("utf-8"))));
    });

    // The Slave is intentionally never actually replied to here — we only
    // need the SENT transition, which is broadcast before any execution result.
    slaveWs.on("message", () => {
      /* swallow the instruction; this test only cares about the admin broadcast */
    });

    const now = new Date();
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest/trade-event",
      headers: { authorization: `Bearer ${masterToken}` },
      payload: {
        eventId: `CP-${randomUUID()}`,
        masterTicket: "AWS-M1",
        type: "OPEN",
        symbol: "XAUUSD",
        side: "BUY",
        volume: 1.0,
        masterEventTime: now.toISOString(),
        eaSentTime: new Date(now.getTime() + 1).toISOString(),
      },
    });
    expect(response.statusCode).toBe(202);

    const broadcast = await broadcastReceived;
    expect(broadcast.masterTicket).toBe("AWS-M1");
    expect(broadcast.status).toBe("SENT");
    expect(broadcast.symbol).toBe("XAUUSD");

    await Promise.all(
      [adminWs, slaveWs].map(
        (ws: WebSocket) =>
          new Promise<void>((resolve) => {
            ws.once("close", () => resolve());
            ws.terminate();
          }),
      ),
    );
  });
});
