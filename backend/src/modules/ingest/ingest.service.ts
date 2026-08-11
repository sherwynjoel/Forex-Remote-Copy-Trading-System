import { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { logger } from "../../config/logger.js";
import type { NormalizedTradeEvent } from "../../types/tradeEvent.js";

/**
 * Persists a trade event to Postgres. Called after the response has already
 * been sent to the connector — this must never sit in the critical path.
 * A unique constraint on event_id is the last line of defense against
 * duplicates if two requests raced past the Redis idempotency check.
 */
export async function persistTradeEvent(event: NormalizedTradeEvent): Promise<void> {
  try {
    await prisma.tradeEvent.create({
      data: {
        eventId: event.eventId,
        masterId: event.masterId,
        masterTicket: event.masterTicket,
        type: event.type,
        symbol: event.symbol,
        side: event.side,
        volume: event.volume,
        price: event.price,
        sl: event.sl,
        tp: event.tp,
        rawPayload: event as unknown as Prisma.InputJsonValue,
        masterEventTime: new Date(event.masterEventTime),
        eaSentTime: new Date(event.eaSentTime),
        backendReceivedTime: new Date(event.backendReceivedTime),
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      logger.warn({ eventId: event.eventId }, "duplicate event_id at persistence layer (idempotency race)");
      return;
    }
    logger.error({ err, eventId: event.eventId }, "failed to persist trade event");
  }
}
