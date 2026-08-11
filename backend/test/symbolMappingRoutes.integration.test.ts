import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { redis, redisSub } from "../src/config/redis.js";

describe("Symbol mapping routes", () => {
  let app: ReturnType<typeof buildApp>;
  let masterId: string;
  let slaveId: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();

    const master = await prisma.master.create({
      data: {
        name: "Symbol Mapping Route Test Master",
        accountNumber: `TEST-SM-M-${randomUUID()}`,
        broker: "Test Broker",
        platform: "MT5",
        server: "Test-Server",
      },
    });
    masterId = master.id;

    const slave = await prisma.slave.create({
      data: {
        masterId,
        name: "Symbol Mapping Route Test Slave",
        accountNumber: `TEST-SM-S-${randomUUID()}`,
        broker: "Test Broker",
        platform: "MT5",
        server: "Test-Server",
      },
    });
    slaveId = slave.id;
  });

  afterAll(async () => {
    await prisma.symbolMapping.deleteMany({ where: { slaveId } });
    await prisma.slave.delete({ where: { id: slaveId } });
    await prisma.master.delete({ where: { id: masterId } });
    await app.close();
    redisSub.disconnect();
    redis.disconnect();
    await prisma.$disconnect();
  });

  it("creates, lists, and deletes a symbol mapping", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: `/api/slaves/${slaveId}/symbol-mappings`,
      payload: { masterSymbol: "XAUUSD", slaveSymbol: "XAUUSDm" },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created.masterSymbol).toBe("XAUUSD");
    expect(created.slaveSymbol).toBe("XAUUSDm");

    const listResponse = await app.inject({ method: "GET", url: `/api/slaves/${slaveId}/symbol-mappings` });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toHaveLength(1);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/slaves/${slaveId}/symbol-mappings/${created.id}`,
    });
    expect(deleteResponse.statusCode).toBe(204);

    const listAfterDelete = await app.inject({ method: "GET", url: `/api/slaves/${slaveId}/symbol-mappings` });
    expect(listAfterDelete.json()).toHaveLength(0);
  });

  it("upserts on a repeated masterSymbol instead of erroring", async () => {
    await app.inject({
      method: "POST",
      url: `/api/slaves/${slaveId}/symbol-mappings`,
      payload: { masterSymbol: "EURUSD", slaveSymbol: "EURUSD.a" },
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: `/api/slaves/${slaveId}/symbol-mappings`,
      payload: { masterSymbol: "EURUSD", slaveSymbol: "EURUSD.b" },
    });
    expect(secondResponse.statusCode).toBe(201);
    expect(secondResponse.json().slaveSymbol).toBe("EURUSD.b");

    const listResponse = await app.inject({ method: "GET", url: `/api/slaves/${slaveId}/symbol-mappings` });
    expect(listResponse.json()).toHaveLength(1);
  });

  it("404s deleting a mapping that doesn't belong to the slave", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/slaves/${slaveId}/symbol-mappings/${randomUUID()}`,
    });
    expect(response.statusCode).toBe(404);
  });
});
