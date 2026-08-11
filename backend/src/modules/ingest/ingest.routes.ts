import type { FastifyInstance } from "fastify";
import { redis } from "../../config/redis.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { authenticateConnector } from "../connectors/connector.service.js";
import { tradeEventPayloadSchema, type NormalizedTradeEvent } from "../../types/tradeEvent.js";
import { publishTradeEvent } from "../realtime/publisher.js";
import { computeLatency } from "../monitoring/latency.js";
import { persistTradeEvent } from "./ingest.service.js";

const IDEMPOTENCY_PREFIX = "event:";

export async function ingestRoutes(app: FastifyInstance) {
  app.post("/api/ingest/trade-event", async (request, reply) => {
    // backendReceivedTime is stamped as early as possible, before any
    // parsing/auth work, so latency numbers reflect the actual wire time.
    const backendReceivedTime = new Date().toISOString();

    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    if (!token) {
      return reply.code(401).send({ status: "UNAUTHORIZED" });
    }

    const auth = await authenticateConnector(token);
    if (!auth || auth.ownerType !== "MASTER" || !auth.masterId) {
      // A Slave connector's token must never be usable to inject Master
      // trade events — never trust an arbitrary client connection.
      return reply.code(401).send({ status: "UNAUTHORIZED" });
    }
    const masterId = auth.masterId;

    const parsed = tradeEventPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ status: "INVALID_PAYLOAD", errors: parsed.error.flatten() });
    }
    const payload = parsed.data;

    // Idempotency: first writer wins. SET NX also serves as the lock, so a
    // retried/duplicated event from the EA's retry queue never produces a
    // second downstream side effect, even under concurrent delivery.
    const idempotencyKey = IDEMPOTENCY_PREFIX + payload.eventId;
    const firstSeen = await redis.set(idempotencyKey, "1", "EX", env.EVENT_IDEMPOTENCY_TTL_SECONDS, "NX");
    if (firstSeen === null) {
      return reply.code(200).send({ status: "DUPLICATE_IGNORED", eventId: payload.eventId });
    }

    const event: NormalizedTradeEvent = {
      ...payload,
      masterId,
      backendReceivedTime,
    };

    // Critical path ends here: the event is durably deduped and on the
    // real-time bus. Everything below is logging/persistence, off the path.
    await publishTradeEvent(event);

    const latency = computeLatency(event);
    reply.code(202).send({
      status: "ACCEPTED",
      eventId: event.eventId,
      backendReceivedTime,
      latency,
    });

    logger.info({ eventId: event.eventId, masterId: event.masterId, type: event.type, symbol: event.symbol, latency }, "trade event ingested");

    // Fire-and-forget: persistence must not add latency to the connector's
    // response, but failures still need to surface in logs.
    void persistTradeEvent(event, latency);
  });
}
