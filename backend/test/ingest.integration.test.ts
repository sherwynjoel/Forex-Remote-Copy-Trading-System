import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { redis, redisSub } from "../src/config/redis.js";
import { registerConnector } from "../src/modules/connectors/connector.service.js";

/**
 * Requires Postgres + Redis to be reachable (see backend/docker-compose.yml)
 * and DATABASE_URL/REDIS_URL to be set — same as running the app itself.
 */
describe("POST /api/ingest/trade-event", () => {
  let app: ReturnType<typeof buildApp>;
  let token: string;
  let masterId: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();

    const master = await prisma.master.create({
      data: {
        name: "Integration Test Master",
        accountNumber: `TEST-${randomUUID()}`,
        broker: "Test Broker",
        platform: "MT5",
        server: "Test-Server",
      },
    });
    masterId = master.id;

    const registered = await registerConnector({ masterId }, "test");
    token = registered.token;
  });

  afterAll(async () => {
    await prisma.tradeEvent.deleteMany({ where: { masterId } });
    await prisma.connector.deleteMany({ where: { masterId } });
    await prisma.master.delete({ where: { id: masterId } });
    await app.close();
    redisSub.disconnect();
    redis.disconnect();
    await prisma.$disconnect();
  });

  function samplePayload(eventId: string) {
    const now = new Date();
    return {
      eventId,
      masterTicket: "555111",
      type: "OPEN",
      symbol: "XAUUSD",
      side: "BUY",
      volume: 1.0,
      price: 3350.2,
      sl: 3340.2,
      tp: 3370.2,
      masterEventTime: now.toISOString(),
      eaSentTime: new Date(now.getTime() + 1).toISOString(),
    };
  }

  it("rejects requests without a valid connector token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest/trade-event",
      payload: samplePayload(`CP-${randomUUID()}`),
    });
    expect(response.statusCode).toBe(401);
  });

  it("accepts a new event, publishes it, and persists exactly one row", async () => {
    const eventId = `CP-${randomUUID()}`;

    const published: string[] = [];
    await redisSub.subscribe(`master:${masterId}:events`);
    redisSub.on("message", (_channel: string, message: string) => published.push(message));

    const response = await app.inject({
      method: "POST",
      url: "/api/ingest/trade-event",
      headers: { authorization: `Bearer ${token}` },
      payload: samplePayload(eventId),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe("ACCEPTED");

    // Give the pub/sub message and the fire-and-forget persistence a moment.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(published.some((m) => JSON.parse(m).eventId === eventId)).toBe(true);

    const rows = await prisma.tradeEvent.findMany({ where: { eventId } });
    expect(rows).toHaveLength(1);
  });

  it("ignores a duplicate event_id and does not create a second row", async () => {
    const eventId = `CP-${randomUUID()}`;
    const payload = samplePayload(eventId);

    const first = await app.inject({
      method: "POST",
      url: "/api/ingest/trade-event",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: "POST",
      url: "/api/ingest/trade-event",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe("DUPLICATE_IGNORED");

    await new Promise((resolve) => setTimeout(resolve, 200));

    const rows = await prisma.tradeEvent.findMany({ where: { eventId } });
    expect(rows).toHaveLength(1);
  });
});
