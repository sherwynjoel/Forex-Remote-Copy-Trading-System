import type { ReconciliationFindingType } from "@prisma/client";

/**
 * Reconciliation Engine (spec section 21): compares Master state vs.
 * system state vs. Slave state and surfaces drift. Pure function, no
 * I/O — mirrors volumeCalculator.ts / riskChecks.ts. Orchestration
 * (fetching the three inputs, persisting findings, staleness gating)
 * lives in reconciliation.service.ts.
 */

export interface MasterPositionInfo {
  ticket: string;
  symbol: string;
  volume: number;
}

export interface SlavePositionInfo {
  ticket: string;
  symbol: string;
  volume: number;
  sl?: number;
  tp?: number;
  comment?: string;
}

/** An EXECUTED OPEN copy with no EXECUTED CLOSE yet — "the system thinks this is open." */
export interface OpenCopyInfo {
  copyId: string;
  masterTicket: string;
  slaveTicket: string | null;
  requestedVolume: number | null;
}

/** An EXECUTED CLOSE copy — "the system thinks this was closed on the Slave." */
export interface ClosedCopyInfo {
  masterTicket: string;
  slaveTicket: string | null;
}

export interface ExpectedSlTp {
  sl: number | null;
  tp: number | null;
}

export interface Finding {
  type: ReconciliationFindingType;
  masterTicket?: string;
  slaveTicket?: string;
  details: Record<string, unknown>;
}

export interface CompareStateInput {
  masterPositions: MasterPositionInfo[];
  openCopies: OpenCopyInfo[];
  closedCopies: ClosedCopyInfo[];
  slavePositions: SlavePositionInfo[];
  /** Latest expected SL/TP per masterTicket — from the most recent EXECUTED OPEN-or-MODIFY, not just the original open. */
  expectedSlTpByMasterTicket: Record<string, ExpectedSlTp | undefined>;
  volumeTolerance?: number;
  priceTolerance?: number;
}

const DEFAULT_VOLUME_TOLERANCE = 0.01;
const DEFAULT_PRICE_TOLERANCE = 0.0001;

const COPY_COMMENT_PATTERN = /^copy:(.+)$/;

function extractCopyId(comment: string | undefined): string | null {
  if (!comment) return null;
  const match = comment.match(COPY_COMMENT_PATTERN);
  return match ? (match[1] as string) : null;
}

export function compareState(input: CompareStateInput): Finding[] {
  const volumeTolerance = input.volumeTolerance ?? DEFAULT_VOLUME_TOLERANCE;
  const priceTolerance = input.priceTolerance ?? DEFAULT_PRICE_TOLERANCE;
  const findings: Finding[] = [];

  const openByMasterTicket = new Map(input.openCopies.map((c) => [c.masterTicket, c]));
  const closedByMasterTicket = new Map(input.closedCopies.map((c) => [c.masterTicket, c]));
  const slavePositionByTicket = new Map(input.slavePositions.map((p) => [p.ticket, p]));

  // Master has an open position we never even attempted to copy.
  for (const masterPos of input.masterPositions) {
    if (!openByMasterTicket.has(masterPos.ticket) && !closedByMasterTicket.has(masterPos.ticket)) {
      findings.push({
        type: "MISSING_COPY",
        masterTicket: masterPos.ticket,
        details: { symbol: masterPos.symbol, volume: masterPos.volume },
      });
    }
  }

  // System thinks a copy is open — check the Slave actually has it, and
  // that its volume/SL/TP still match what was requested.
  for (const copy of input.openCopies) {
    if (!copy.slaveTicket) continue; // shouldn't happen for an EXECUTED copy, but guard anyway
    const slavePos = slavePositionByTicket.get(copy.slaveTicket);

    if (!slavePos) {
      findings.push({
        type: "SLAVE_POSITION_MISSING",
        masterTicket: copy.masterTicket,
        slaveTicket: copy.slaveTicket,
        details: {},
      });
      continue;
    }

    if (copy.requestedVolume !== null && Math.abs(slavePos.volume - copy.requestedVolume) > volumeTolerance) {
      findings.push({
        type: "VOLUME_MISMATCH",
        masterTicket: copy.masterTicket,
        slaveTicket: copy.slaveTicket,
        details: { expected: copy.requestedVolume, actual: slavePos.volume },
      });
    }

    const expected = input.expectedSlTpByMasterTicket[copy.masterTicket];
    if (expected) {
      const slMismatch =
        expected.sl !== null && (slavePos.sl === undefined || Math.abs(slavePos.sl - expected.sl) > priceTolerance);
      const tpMismatch =
        expected.tp !== null && (slavePos.tp === undefined || Math.abs(slavePos.tp - expected.tp) > priceTolerance);
      if (slMismatch || tpMismatch) {
        findings.push({
          type: "SLTP_MISMATCH",
          masterTicket: copy.masterTicket,
          slaveTicket: copy.slaveTicket,
          details: { expectedSl: expected.sl, expectedTp: expected.tp, actualSl: slavePos.sl, actualTp: slavePos.tp },
        });
      }
    }
  }

  // System thinks a copy was closed — but the Slave position is still there.
  for (const copy of input.closedCopies) {
    if (copy.slaveTicket && slavePositionByTicket.has(copy.slaveTicket)) {
      findings.push({
        type: "SLAVE_NOT_CLOSED",
        masterTicket: copy.masterTicket,
        slaveTicket: copy.slaveTicket,
        details: {},
      });
    }
  }

  // Trace every Slave position's order comment ("copy:<copyId>", set by
  // slave-service/main.py::execute_open) back to a known open copy.
  const openCopyIds = new Set(input.openCopies.map((c) => c.copyId));
  const positionsByCopyId = new Map<string, SlavePositionInfo[]>();

  for (const slavePos of input.slavePositions) {
    const copyId = extractCopyId(slavePos.comment);
    if (!copyId || !openCopyIds.has(copyId)) {
      findings.push({
        type: "UNEXPECTED_SLAVE_POSITION",
        slaveTicket: slavePos.ticket,
        details: { symbol: slavePos.symbol, volume: slavePos.volume, comment: slavePos.comment ?? null },
      });
      continue;
    }
    const list = positionsByCopyId.get(copyId) ?? [];
    list.push(slavePos);
    positionsByCopyId.set(copyId, list);
  }

  for (const [copyId, positions] of positionsByCopyId) {
    if (positions.length <= 1) continue;
    for (const pos of positions) {
      findings.push({
        type: "DUPLICATE_SLAVE_POSITION",
        slaveTicket: pos.ticket,
        details: { copyId, duplicateCount: positions.length },
      });
    }
  }

  return findings;
}
