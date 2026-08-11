import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { redis, redisSub } from "../src/config/redis.js";
import { getTestAdminToken, deleteTestAdmin } from "./testAuth.js";

describe("Reconciliation routes", () => {
  let app: ReturnType<typeof buildApp>;
  let masterId: string;
  let slaveId: string;
  let adminToken: string;
  let adminId: string;
  const masterTicket = "RR-M1";

  beforeAll(async () => {
    app = buildApp();
    await app.ready();

    ({ token: adminToken, adminId } = await getTestAdminToken());

    const master = await prisma.master.create({
      data: {
        name: "Reconciliation Route Test Master",
        accountNumber: `TEST-RR-M-${randomUUID()}`,
        broker: "Test Broker",
        platform: "MT5",
        server: "Test-Server",
        positionSnapshot: [{ ticket: masterTicket, symbol: "XAUUSD", volume: 1.0 }],
        positionSnapshotAt: new Date(),
      },
    });
    masterId = master.id;

    const slave = await prisma.slave.create({
      data: {
        masterId,
        name: "Reconciliation Route Test Slave",
        accountNumber: `TEST-RR-S-${randomUUID()}`,
        broker: "Test Broker",
        platform: "MT5",
        server: "Test-Server",
        // No copy_orders exist for this masterTicket at all, so a run
        // should surface exactly one MISSING_COPY finding.
        positionSnapshot: [],
        positionSnapshotAt: new Date(),
      },
    });
    slaveId = slave.id;
  });

  afterAll(async () => {
    await prisma.reconciliationFinding.deleteMany({ where: { masterId, slaveId } });
    await prisma.slave.delete({ where: { id: slaveId } });
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
    const response = await app.inject({ method: "GET", url: "/api/reconciliation/findings" });
    expect(response.statusCode).toBe(401);
  });

  it("POST /api/reconciliation/run triggers a run and returns a summary", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/reconciliation/run?masterId=${masterId}&slaveId=${slaveId}`,
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    const summary = response.json();
    expect(summary.pairsScanned).toBe(1);
    expect(summary.findingsCreated).toBe(1);
  });

  it("GET /api/reconciliation/findings returns the persisted finding", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/reconciliation/findings?masterId=${masterId}&slaveId=${slaveId}`,
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    const findings = response.json();
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("MISSING_COPY");
    expect(findings[0].masterTicket).toBe(masterTicket);
  });

  it("filters findings by an unrelated masterId to an empty list", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/reconciliation/findings?masterId=${randomUUID()}`,
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});
