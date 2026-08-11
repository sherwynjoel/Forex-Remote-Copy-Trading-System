import type { Slave } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { redisSub } from "../../config/redis.js";
import { logger } from "../../config/logger.js";
import { onSlaveMessage, sendToSlave, isSlaveConnected } from "../realtime/wsGateway.js";
import { executionResultSchema, type CopyAction, type CopyInstruction } from "../../types/copyOrder.js";
import type { NormalizedTradeEvent } from "../../types/tradeEvent.js";
import { calculateVolume } from "./volumeCalculator.js";

const MASTER_EVENTS_PATTERN = "master:*:events";

// PARTIAL_CLOSE and PENDING_* are detected by the Master EA (Phase 1) but
// not yet copied — out of scope for Phase 2 per the project's own phase
// breakdown (BUY, SELL, CLOSE, MODIFY only).
function isCopyableEvent(event: NormalizedTradeEvent): event is NormalizedTradeEvent & { type: CopyAction } {
  return event.type === "OPEN" || event.type === "CLOSE" || event.type === "MODIFY";
}

let started = false;

// Idempotent: redisSub.on("pmessage", ...) is additive, so calling this
// more than once against the same connection (e.g. two test files sharing
// a worker's module cache, or an accidental double-call in production)
// would otherwise attach a second listener and process every master event
// twice, tripping the copy_orders (tradeEventId, slaveId) unique
// constraint. Guarding here is cheap and removes an entire class of bug.
export function startCopyEngine(): void {
  if (started) {
    logger.warn("startCopyEngine() called again; ignoring — already running");
    return;
  }
  started = true;

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

  // Volume sizing needs the Master's account snapshot; fetched once here
  // (kept fresh by the Master EA's heartbeat — see connector.service.ts)
  // rather than once per slave, since it's the same for every slave in
  // this fan-out.
  const master = await prisma.master.findUnique({
    where: { id: event.masterId },
    select: { balance: true, equity: true },
  });

  // Fan out concurrently, not sequentially — with N slaves, a for/await
  // loop would make the Nth slave wait on the first N-1's DB round trips
  // before its own even starts. Each copyToSlave() call is independently
  // scoped by slaveId, so one slave's failure never affects another's.
  const results = await Promise.allSettled(
    slaves.map((slave) =>
      copyToSlave(slave, tradeEvent.id, event, {
        masterBalance: master?.balance ? Number(master.balance) : null,
        masterEquity: master?.equity ? Number(master.equity) : null,
      }),
    ),
  );
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      logger.error({ err: result.reason, slaveId: slaves[index]?.id }, "copyToSlave threw unexpectedly");
    }
  }
}

async function copyToSlave(
  slave: Slave,
  tradeEventId: string,
  event: NormalizedTradeEvent & { type: CopyAction },
  masterAccount: { masterBalance: number | null; masterEquity: number | null },
): Promise<void> {
  const slaveId = slave.id;
  let slaveTicket: string | undefined;
  let volume = event.volume;

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
  } else if (event.type === "OPEN") {
    // Only OPEN needs sizing — CLOSE always closes the Slave's existing
    // full position (see slave-service/main.py::execute_close) and MODIFY
    // doesn't involve volume at all.
    const sizing = calculateVolume({
      copyMode: slave.copyMode,
      masterVolume: event.volume ?? 0,
      fixedLot: slave.fixedLot ? Number(slave.fixedLot) : null,
      multiplier: Number(slave.multiplier),
      masterBalance: masterAccount.masterBalance,
      masterEquity: masterAccount.masterEquity,
      slaveBalance: slave.balance ? Number(slave.balance) : null,
      slaveEquity: slave.equity ? Number(slave.equity) : null,
      minLot: Number(slave.minLot),
      maxLot: Number(slave.maxLot),
      lotStep: Number(slave.lotStep),
    });

    if ("rejected" in sizing) {
      await prisma.copyOrder.create({
        data: {
          tradeEventId,
          masterId: event.masterId,
          slaveId,
          masterTicket: event.masterTicket,
          type: event.type,
          status: "FAILED",
          requestedVolume: event.volume,
          errorReason: sizing.reason,
        },
      });
      logger.warn({ slaveId, masterTicket: event.masterTicket, reason: sizing.reason }, "volume calculator rejected the trade");
      return;
    }
    volume = sizing.volume;
  }

  const copyOrder = await prisma.copyOrder.create({
    data: {
      tradeEventId,
      masterId: event.masterId,
      slaveId,
      masterTicket: event.masterTicket,
      type: event.type,
      status: "PENDING",
      requestedVolume: volume,
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
    volume,
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
