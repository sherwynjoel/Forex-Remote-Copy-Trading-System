import { describe, expect, it } from "vitest";
import { checkEntryAllowed, checkExposureAllowed, type EntryCheckInput } from "../src/modules/copy-engine/riskChecks.js";

const baseEntry: EntryCheckInput = {
  emergencyStop: false,
  allowedSymbols: [],
  blockedSymbols: [],
  symbol: "XAUUSD",
  maxPositions: null,
  currentOpenPositions: 0,
};

describe("checkEntryAllowed", () => {
  it("allows a trade with no restrictions configured", () => {
    expect(checkEntryAllowed(baseEntry)).toEqual({ allowed: true });
  });

  it("rejects when emergencyStop is active, before any other check", () => {
    const result = checkEntryAllowed({ ...baseEntry, emergencyStop: true, blockedSymbols: ["EURUSD"] });
    expect(result).toEqual({ allowed: false, reason: "EMERGENCY_STOP_ACTIVE" });
  });

  it("rejects a blocked symbol", () => {
    const result = checkEntryAllowed({ ...baseEntry, blockedSymbols: ["XAUUSD"] });
    expect(result).toEqual({ allowed: false, reason: "SYMBOL_BLOCKED" });
  });

  it("treats an empty allowedSymbols list as no restriction", () => {
    const result = checkEntryAllowed({ ...baseEntry, allowedSymbols: [] });
    expect(result).toEqual({ allowed: true });
  });

  it("rejects a symbol not in a non-empty allowedSymbols list", () => {
    const result = checkEntryAllowed({ ...baseEntry, allowedSymbols: ["EURUSD", "GBPUSD"] });
    expect(result).toEqual({ allowed: false, reason: "SYMBOL_NOT_ALLOWED" });
  });

  it("allows a symbol that is in the allowedSymbols list", () => {
    const result = checkEntryAllowed({ ...baseEntry, allowedSymbols: ["XAUUSD", "EURUSD"] });
    expect(result).toEqual({ allowed: true });
  });

  it("allows when currentOpenPositions is below maxPositions", () => {
    const result = checkEntryAllowed({ ...baseEntry, maxPositions: 5, currentOpenPositions: 4 });
    expect(result).toEqual({ allowed: true });
  });

  it("rejects when currentOpenPositions has reached maxPositions", () => {
    const result = checkEntryAllowed({ ...baseEntry, maxPositions: 5, currentOpenPositions: 5 });
    expect(result).toEqual({ allowed: false, reason: "MAX_POSITIONS_REACHED" });
  });

  it("treats maxPositions: null as no limit regardless of current count", () => {
    const result = checkEntryAllowed({ ...baseEntry, maxPositions: null, currentOpenPositions: 1000 });
    expect(result).toEqual({ allowed: true });
  });
});

describe("checkExposureAllowed", () => {
  it("allows when there is no maxExposure configured", () => {
    const result = checkExposureAllowed({ maxExposure: null, currentOpenExposure: 100, incomingVolume: 50 });
    expect(result).toEqual({ allowed: true });
  });

  it("allows when the new total stays within maxExposure", () => {
    const result = checkExposureAllowed({ maxExposure: 2.0, currentOpenExposure: 1.0, incomingVolume: 0.5 });
    expect(result).toEqual({ allowed: true });
  });

  it("allows when the new total exactly equals maxExposure", () => {
    const result = checkExposureAllowed({ maxExposure: 1.5, currentOpenExposure: 1.0, incomingVolume: 0.5 });
    expect(result).toEqual({ allowed: true });
  });

  it("rejects when the new total would exceed maxExposure", () => {
    const result = checkExposureAllowed({ maxExposure: 1.0, currentOpenExposure: 0.8, incomingVolume: 0.5 });
    expect(result).toEqual({ allowed: false, reason: "MAX_EXPOSURE_EXCEEDED" });
  });
});
