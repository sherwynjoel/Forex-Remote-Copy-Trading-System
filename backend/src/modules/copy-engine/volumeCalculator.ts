import { CopyMode } from "@prisma/client";

/**
 * Volume Calculator (spec section 13). Pure function, no I/O — the Copy
 * Engine fetches the Master/Slave balance & equity snapshots (kept fresh by
 * each connector's heartbeat) and passes plain numbers in here.
 */
export interface VolumeCalculatorInput {
  copyMode: CopyMode;
  masterVolume: number;
  fixedLot?: number | null;
  multiplier: number;
  masterBalance?: number | null;
  masterEquity?: number | null;
  slaveBalance?: number | null;
  slaveEquity?: number | null;
  minLot: number;
  maxLot: number;
  lotStep: number;
}

export type VolumeCalculatorResult = { volume: number } | { rejected: true; reason: string };

export function calculateVolume(input: VolumeCalculatorInput): VolumeCalculatorResult {
  let raw: number;

  switch (input.copyMode) {
    case CopyMode.FIXED_LOT: {
      if (!input.fixedLot || input.fixedLot <= 0) {
        return { rejected: true, reason: "FIXED_LOT_NOT_CONFIGURED" };
      }
      raw = input.fixedLot;
      break;
    }
    case CopyMode.MULTIPLIER: {
      raw = input.masterVolume * input.multiplier;
      break;
    }
    case CopyMode.BALANCE_PROPORTIONAL: {
      if (!input.masterBalance || input.masterBalance <= 0) {
        return { rejected: true, reason: "MASTER_BALANCE_UNKNOWN" };
      }
      if (input.slaveBalance === null || input.slaveBalance === undefined) {
        return { rejected: true, reason: "SLAVE_BALANCE_UNKNOWN" };
      }
      raw = input.masterVolume * (input.slaveBalance / input.masterBalance);
      break;
    }
    case CopyMode.EQUITY_PROPORTIONAL: {
      if (!input.masterEquity || input.masterEquity <= 0) {
        return { rejected: true, reason: "MASTER_EQUITY_UNKNOWN" };
      }
      if (input.slaveEquity === null || input.slaveEquity === undefined) {
        return { rejected: true, reason: "SLAVE_EQUITY_UNKNOWN" };
      }
      raw = input.masterVolume * (input.slaveEquity / input.masterEquity);
      break;
    }
    default: {
      // Exhaustive per the CopyMode enum today; guards against a future
      // enum value landing here with no handler instead of silently
      // executing an uncalculated size.
      return { rejected: true, reason: `UNSUPPORTED_COPY_MODE:${input.copyMode}` };
    }
  }

  // Round down, never up — conservative by default, per "never blindly
  // copy the Master volume." Max lot is a cap (still executes, just
  // smaller), min lot is a hard floor (does not execute at all).
  const stepped = roundDownToStep(raw, input.lotStep);
  const clamped = Math.min(stepped, input.maxLot);

  if (clamped < input.minLot) {
    return { rejected: true, reason: "BELOW_MIN_LOT" };
  }

  return { volume: clamped };
}

function roundDownToStep(value: number, step: number): number {
  if (step <= 0 || value <= 0) return Math.max(value, 0);
  // Epsilon guards against float error (e.g. 0.29999999999999993) rounding
  // a step boundary down to the wrong multiple.
  const steps = Math.floor(value / step + 1e-9);
  return Number((steps * step).toFixed(8));
}
