/**
 * Risk limits (spec section 15) that are directly derivable from data the
 * system already has — allowed/blocked symbols, max concurrent positions,
 * max exposure, emergency stop. Max daily loss and max drawdown are
 * deliberately deferred (need equity-history tracking not yet built).
 *
 * Pure functions, no I/O — mirrors volumeCalculator.ts. Gates OPEN only;
 * the Copy Engine never calls these for CLOSE/MODIFY, since a limit or an
 * emergency stop exists to prevent new risk, not to trap existing risk
 * open.
 */

export interface EntryCheckInput {
  emergencyStop: boolean;
  allowedSymbols: string[];
  blockedSymbols: string[];
  symbol: string;
  maxPositions: number | null;
  currentOpenPositions: number;
}

export interface ExposureCheckInput {
  maxExposure: number | null;
  currentOpenExposure: number;
  incomingVolume: number;
}

export type RiskCheckResult = { allowed: true } | { allowed: false; reason: string };

/** Runs before volume calculation — cheap checks that don't need a computed size. */
export function checkEntryAllowed(input: EntryCheckInput): RiskCheckResult {
  if (input.emergencyStop) {
    return { allowed: false, reason: "EMERGENCY_STOP_ACTIVE" };
  }
  if (input.blockedSymbols.includes(input.symbol)) {
    return { allowed: false, reason: "SYMBOL_BLOCKED" };
  }
  if (input.allowedSymbols.length > 0 && !input.allowedSymbols.includes(input.symbol)) {
    return { allowed: false, reason: "SYMBOL_NOT_ALLOWED" };
  }
  if (input.maxPositions !== null && input.currentOpenPositions >= input.maxPositions) {
    return { allowed: false, reason: "MAX_POSITIONS_REACHED" };
  }
  return { allowed: true };
}

/** Runs after volume calculation — exposure is about the sized lot amount, not the raw Master volume. */
export function checkExposureAllowed(input: ExposureCheckInput): RiskCheckResult {
  if (input.maxExposure !== null && input.currentOpenExposure + input.incomingVolume > input.maxExposure) {
    return { allowed: false, reason: "MAX_EXPOSURE_EXCEEDED" };
  }
  return { allowed: true };
}
