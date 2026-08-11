import { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { positionSnapshotSchema, type PositionSnapshotItem } from "../../types/positionSnapshot.js";
import { getCopyOrderPositions, getExpectedSlTp } from "../copy-engine/copyOrderQueries.js";
import { compareState, type ExpectedSlTp, type Finding } from "./reconciliationEngine.js";

export interface ReconciliationRunOptions {
  masterId?: string;
  slaveId?: string;
}

export interface ReconciliationRunSummary {
  pairsScanned: number;
  pairsSkippedStale: number;
  findingsCreated: number;
}

function parsePositionSnapshot(raw: unknown): PositionSnapshotItem[] {
  const parsed = positionSnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

function isFresh(snapshotAt: Date | null, now: number): boolean {
  if (!snapshotAt) return false;
  return now - snapshotAt.getTime() <= env.RECONCILIATION_STALENESS_SECONDS * 1000;
}

/**
 * Runs the Master vs. system vs. Slave comparison for every (Master, Slave)
 * pair matching the given filter (or all pairs, by default), replacing
 * each pair's findings with whatever this run detects — the table
 * represents current known issues, not a historical log.
 */
export async function runReconciliation(options: ReconciliationRunOptions = {}): Promise<ReconciliationRunSummary> {
  const slaves = await prisma.slave.findMany({
    where: {
      ...(options.slaveId ? { id: options.slaveId } : {}),
      ...(options.masterId ? { masterId: options.masterId } : {}),
    },
    include: { master: true },
  });

  const now = Date.now();
  let pairsScanned = 0;
  let pairsSkippedStale = 0;
  let findingsCreated = 0;

  for (const slave of slaves) {
    const master = slave.master;

    if (!isFresh(master.positionSnapshotAt, now) || !isFresh(slave.positionSnapshotAt, now)) {
      pairsSkippedStale += 1;
      continue;
    }

    const masterPositions = parsePositionSnapshot(master.positionSnapshot);
    const slavePositions = parsePositionSnapshot(slave.positionSnapshot);
    const { open, closed } = await getCopyOrderPositions(slave.id);

    const expectedSlTpByMasterTicket: Record<string, ExpectedSlTp | undefined> = {};
    for (const copy of open) {
      expectedSlTpByMasterTicket[copy.masterTicket] = (await getExpectedSlTp(slave.id, copy.masterTicket)) ?? undefined;
    }

    const findings: Finding[] = compareState({
      masterPositions,
      openCopies: open.map((o) => ({
        copyId: o.id,
        masterTicket: o.masterTicket,
        slaveTicket: o.slaveTicket,
        requestedVolume: o.requestedVolume,
      })),
      closedCopies: closed,
      slavePositions,
      expectedSlTpByMasterTicket,
      volumeTolerance: env.RECONCILIATION_VOLUME_TOLERANCE,
      priceTolerance: env.RECONCILIATION_PRICE_TOLERANCE,
    });

    await prisma.reconciliationFinding.deleteMany({ where: { masterId: master.id, slaveId: slave.id } });
    if (findings.length > 0) {
      await prisma.reconciliationFinding.createMany({
        data: findings.map((f) => ({
          masterId: master.id,
          slaveId: slave.id,
          type: f.type,
          masterTicket: f.masterTicket,
          slaveTicket: f.slaveTicket,
          details: f.details as Prisma.InputJsonValue,
        })),
      });
      logger.warn({ masterId: master.id, slaveId: slave.id, count: findings.length }, "reconciliation findings detected");
    }

    pairsScanned += 1;
    findingsCreated += findings.length;
  }

  return { pairsScanned, pairsSkippedStale, findingsCreated };
}

let started = false;

/** Idempotent, same pattern as copyEngine.ts::startCopyEngine — a second call is a no-op. */
export function startReconciliationEngine(): void {
  if (started) {
    logger.warn("startReconciliationEngine() called again; ignoring — already running");
    return;
  }
  started = true;

  setInterval(() => {
    runReconciliation().catch((err) => logger.error({ err }, "reconciliation run failed"));
  }, env.RECONCILIATION_INTERVAL_SECONDS * 1000);

  logger.info({ intervalSeconds: env.RECONCILIATION_INTERVAL_SECONDS }, "reconciliation engine started");
}
