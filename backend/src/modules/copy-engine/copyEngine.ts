import { prisma } from "../../db/client.js";
import { redisSub } from "../../config/redis.js";
import { logger } from "../../config/logger.js";
import { onSlaveMessage, sendToSlave, isSlaveConnected } from "../realtime/wsGateway.js";
import { executionResultSchema, type CopyAction, type CopyInstruction } from "../../types/copyOrder.js";
import type { NormalizedTradeEvent } from "../../types/tradeEvent.js";

const MASTER_EVENTS_PATTERN = "master:*:events";

// PARTIAL_CLOSE and PENDING_* are detected by the Master EA (Phase 1) but
// not yet copied — out of scope for Phase 2 per the project's own phase
// breakdown (BUY, SELL, CLOSE, MODIFY only).
function isCopyableEvent(event: NormalizedTradeEvent): event is NormalizedTradeEvent & { type: CopyAction } {
  return event.type === "OPEN" || event.type === "CLOSE" || event.type === "MODIFY";
}

export function startCopyEngine(): void {
  onSlaveMessage((slaveId, message) => {
    void handleSlaveMessage(slaveId, message).catch((err) =>
      logger.error({ err, slaveId }, "copy engine failed to process slave execution result"),
    );
  });

  redisSub.on("pmessage", (_pattern: string, _channel: string, raw: string) => {
    void handleMasterEvent(JSON.parse(raw) as NormalizedTradeEvent).catch((err) =>
      logger.error({ err }, "copy engine failed to process master event"),
    );
  });

  void redisSub.psubscribe(MASTER_EVENTS_PATTERN);
  logger.info({ pattern: MASTER_EVENTS_PATTERN }, "copy engine subscribed to master events");
}

async function handleMasterEvent(event: NormalizedTradeEvent): Promise<void> {
  if (!isCopyableEvent(event)) return;

  let tradeEvent = await prisma.tradeEvent.findUnique({ where: { eventId: event.eventId } });
  if (!tradeEvent) {
    // Ingest persists asynchronously after responding to the EA, so a brief
    // race between the pub/sub publish and the Postgres write is possible.
    // One short wait covers it without resorting to a polling loop.
    await new Promise((resolve) => setTimeout(resolve, 250));
    tradeEvent = await prisma.tradeEvent.findUnique({ where: { eventId: event.eventId } });
  }
  if (!tradeEvent) {
    logger.error({ eventId: event.eventId }, "copy engine: trade event not yet persisted, dropping");
    return;
  }

  const slaves = await prisma.slave.findMany({
    where: { masterId: event.masterId, copyEnabled: true, status: { not: "DISABLED" } },
  });

  for (const slave of slaves) {
    await copyToSlave(slave.id, tradeEvent.id, event);
  }
}

async function copyToSlave(slaveId: string, tradeEventId: string, event: NormalizedTradeEvent & { type: CopyAction }): Promise<void> {
  let slaveTicket: string | undefined;

  if (event.type === "CLOSE" || event.type === "MODIFY") {
    const priorOpen = await prisma.copyOrder.findFirst({
      where: { slaveId, masterTicket: event.masterTicket, type: "OPEN", status: "EXECUTED" },
      orderBy: { createdAt: "desc" },
    });

    if (!priorOpen?.slaveTicket) {
      await prisma.copyOrder.create({
        data: {
          tradeEventId,
          masterId: event.masterId,
          slaveId,
          masterTicket: event.masterTicket,
          type: event.type,
          status: "FAILED",
          errorReason: "NO_MATCHING_OPEN_COPY",
        },
      });
      logger.warn({ slaveId, masterTicket: event.masterTicket, type: event.type }, "no matching open copy to act on");
      return;
    }
    slaveTicket = priorOpen.slaveTicket;
  }

  const copyOrder = await prisma.copyOrder.create({
    data: {
      tradeEventId,
      masterId: event.masterId,
      slaveId,
      masterTicket: event.masterTicket,
      type: event.type,
      status: "PENDING",
      requestedVolume: event.volume,
    },
  });

  if (!isSlaveConnected(slaveId)) {
    await prisma.copyOrder.update({
      where: { id: copyOrder.id },
      data: { status: "FAILED", errorReason: "SLAVE_OFFLINE" },
    });
    logger.warn({ slaveId, copyId: copyOrder.id }, "slave offline, copy order failed immediately");
    return;
  }

  const instruction: CopyInstruction = {
    copyId: copyOrder.id,
    action: event.type,
    symbol: event.symbol,
    side: event.side,
    volume: event.volume,
    sl: event.sl,
    tp: event.tp,
    slaveTicket,
  };

  const sent = sendToSlave(slaveId, instruction);
  await prisma.copyOrder.update({
    where: { id: copyOrder.id },
    data: sent ? { status: "SENT", sentAt: new Date() } : { status: "FAILED", errorReason: "SEND_FAILED" },
  });
}

async function handleSlaveMessage(slaveId: string, rawMessage: unknown): Promise<void> {
  const parsed = executionResultSchema.safeParse(rawMessage);
  if (!parsed.success) {
    logger.warn({ slaveId, rawMessage }, "malformed execution result from slave connector");
    return;
  }
  const result = parsed.data;

  const copyOrder = await prisma.copyOrder.findUnique({ where: { id: result.copyId } });
  if (!copyOrder || copyOrder.slaveId !== slaveId) {
    logger.warn({ slaveId, copyId: result.copyId }, "execution result for unknown/mismatched copy order");
    return;
  }

  await prisma.copyOrder.update({
    where: { id: result.copyId },
    data: {
      status: result.status,
      slaveTicket: result.slaveTicket ?? copyOrder.slaveTicket,
      executionPrice: result.executionPrice,
      errorReason: result.reason,
      executedAt: new Date(),
    },
  });

  logger.info({ copyId: result.copyId, slaveId, status: result.status }, "copy order execution result recorded");
}
