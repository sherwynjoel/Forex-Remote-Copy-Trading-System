import { prisma } from "../../db/client.js";

/**
 * Shared "what does the system think is open/closed for this Slave"
 * queries — copy_orders is the source of truth, nothing is tracked
 * separately. Used by riskChecks' maxPositions/maxExposure (via
 * getOpenPositionsSummary) and by the Reconciliation Engine, which needs
 * the fuller detail.
 */

export interface OpenCopyOrderInfo {
  id: string;
  masterTicket: string;
  slaveTicket: string | null;
  requestedVolume: number | null;
  tradeEventId: string;
}

export interface ClosedCopyOrderInfo {
  masterTicket: string;
  slaveTicket: string | null;
}

export async function getCopyOrderPositions(
  slaveId: string,
): Promise<{ open: OpenCopyOrderInfo[]; closed: ClosedCopyOrderInfo[] }> {
  const [opens, closes] = await Promise.all([
    prisma.copyOrder.findMany({
      where: { slaveId, type: "OPEN", status: "EXECUTED" },
      select: { id: true, masterTicket: true, slaveTicket: true, requestedVolume: true, tradeEventId: true },
    }),
    prisma.copyOrder.findMany({
      where: { slaveId, type: "CLOSE", status: "EXECUTED" },
      select: { masterTicket: true, slaveTicket: true },
    }),
  ]);

  const closedTickets = new Set(closes.map((c) => c.masterTicket));
  const open = opens
    .filter((o) => !closedTickets.has(o.masterTicket))
    .map((o) => ({
      id: o.id,
      masterTicket: o.masterTicket,
      slaveTicket: o.slaveTicket,
      requestedVolume: o.requestedVolume ? Number(o.requestedVolume) : null,
      tradeEventId: o.tradeEventId,
    }));

  return { open, closed: closes };
}

/** Feeds riskChecks' maxPositions/maxExposure (spec section 15). */
export async function getOpenPositionsSummary(slaveId: string): Promise<{ count: number; totalVolume: number }> {
  const { open } = await getCopyOrderPositions(slaveId);
  const totalVolume = open.reduce((sum, o) => sum + (o.requestedVolume ?? 0), 0);
  return { count: open.length, totalVolume };
}

/**
 * The Slave ticket a CLOSE/MODIFY should act on — the most recent EXECUTED
 * OPEN copy for this (slaveId, masterTicket). Used both when dispatching
 * (copyEngine.ts::copyToSlave) and, independently, when a polling-based
 * Slave (MT4 — see connectorPolling.routes.ts) picks up a queued
 * instruction later. Those two calls can be milliseconds to ~1s apart, but
 * the answer is deterministic either way: a CLOSE/MODIFY is never even
 * dispatched without this already existing.
 */
export async function findExecutedOpenSlaveTicket(slaveId: string, masterTicket: string): Promise<string | null> {
  const priorOpen = await prisma.copyOrder.findFirst({
    where: { slaveId, masterTicket, type: "OPEN", status: "EXECUTED" },
    orderBy: { createdAt: "desc" },
  });
  return priorOpen?.slaveTicket ?? null;
}

/**
 * The SL/TP a Slave position for this masterTicket is currently expected
 * to have — from the *latest* EXECUTED OPEN-or-MODIFY copy, not just the
 * original OPEN, since a Master MODIFY after the open changes the
 * expectation. Joins through the existing tradeEventId FK (trade_events
 * already has sl/tp — no new schema needed).
 */
export async function getExpectedSlTp(
  slaveId: string,
  masterTicket: string,
): Promise<{ sl: number | null; tp: number | null } | null> {
  const latest = await prisma.copyOrder.findFirst({
    where: { slaveId, masterTicket, status: "EXECUTED", type: { in: ["OPEN", "MODIFY"] } },
    orderBy: { createdAt: "desc" },
    include: { tradeEvent: { select: { sl: true, tp: true } } },
  });
  if (!latest) return null;
  return {
    sl: latest.tradeEvent.sl ? Number(latest.tradeEvent.sl) : null,
    tp: latest.tradeEvent.tp ? Number(latest.tradeEvent.tp) : null,
  };
}
