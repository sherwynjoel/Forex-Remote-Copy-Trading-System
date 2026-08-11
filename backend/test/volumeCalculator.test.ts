import { describe, expect, it } from "vitest";
import { CopyMode } from "@prisma/client";
import { calculateVolume, type VolumeCalculatorInput } from "../src/modules/copy-engine/volumeCalculator.js";

const base: VolumeCalculatorInput = {
  copyMode: CopyMode.MULTIPLIER,
  masterVolume: 1.0,
  fixedLot: null,
  multiplier: 1.0,
  masterBalance: null,
  masterEquity: null,
  slaveBalance: null,
  slaveEquity: null,
  minLot: 0.01,
  maxLot: 10.0,
  lotStep: 0.01,
};

describe("calculateVolume", () => {
  describe("FIXED_LOT", () => {
    it("uses the configured fixed lot regardless of master volume", () => {
      const result = calculateVolume({ ...base, copyMode: CopyMode.FIXED_LOT, fixedLot: 0.25, masterVolume: 5.0 });
      expect(result).toEqual({ volume: 0.25 });
    });

    it("rejects when no fixed lot is configured", () => {
      const result = calculateVolume({ ...base, copyMode: CopyMode.FIXED_LOT, fixedLot: null });
      expect(result).toEqual({ rejected: true, reason: "FIXED_LOT_NOT_CONFIGURED" });
    });
  });

  describe("MULTIPLIER", () => {
    it("scales master volume by the multiplier", () => {
      const result = calculateVolume({ ...base, copyMode: CopyMode.MULTIPLIER, masterVolume: 1.0, multiplier: 2 });
      expect(result).toEqual({ volume: 2.0 });
    });

    it("supports fractional multipliers", () => {
      const result = calculateVolume({ ...base, copyMode: CopyMode.MULTIPLIER, masterVolume: 1.0, multiplier: 0.5 });
      expect(result).toEqual({ volume: 0.5 });
    });
  });

  describe("BALANCE_PROPORTIONAL", () => {
    it("scales by the slave/master balance ratio", () => {
      const result = calculateVolume({
        ...base,
        copyMode: CopyMode.BALANCE_PROPORTIONAL,
        masterVolume: 1.0,
        masterBalance: 10000,
        slaveBalance: 5000,
      });
      expect(result).toEqual({ volume: 0.5 });
    });

    it("rejects when master balance is unknown", () => {
      const result = calculateVolume({
        ...base,
        copyMode: CopyMode.BALANCE_PROPORTIONAL,
        masterBalance: null,
        slaveBalance: 5000,
      });
      expect(result).toEqual({ rejected: true, reason: "MASTER_BALANCE_UNKNOWN" });
    });

    it("rejects when slave balance is unknown", () => {
      const result = calculateVolume({
        ...base,
        copyMode: CopyMode.BALANCE_PROPORTIONAL,
        masterBalance: 10000,
        slaveBalance: null,
      });
      expect(result).toEqual({ rejected: true, reason: "SLAVE_BALANCE_UNKNOWN" });
    });
  });

  describe("EQUITY_PROPORTIONAL", () => {
    it("scales by the slave/master equity ratio", () => {
      const result = calculateVolume({
        ...base,
        copyMode: CopyMode.EQUITY_PROPORTIONAL,
        masterVolume: 2.0,
        masterEquity: 20000,
        slaveEquity: 5000,
      });
      expect(result).toEqual({ volume: 0.5 });
    });

    it("rejects when master equity is unknown", () => {
      const result = calculateVolume({ ...base, copyMode: CopyMode.EQUITY_PROPORTIONAL, masterEquity: null, slaveEquity: 5000 });
      expect(result).toEqual({ rejected: true, reason: "MASTER_EQUITY_UNKNOWN" });
    });
  });

  describe("lot step / min / max enforcement", () => {
    it("rounds down to the nearest lot step, never up", () => {
      const result = calculateVolume({ ...base, copyMode: CopyMode.MULTIPLIER, masterVolume: 1.0, multiplier: 0.37, lotStep: 0.1 });
      // 0.37 -> floor to nearest 0.1 -> 0.3
      expect(result).toEqual({ volume: 0.3 });
    });

    it("clamps to maxLot instead of rejecting an oversized result", () => {
      const result = calculateVolume({ ...base, copyMode: CopyMode.MULTIPLIER, masterVolume: 1.0, multiplier: 50, maxLot: 5.0 });
      expect(result).toEqual({ volume: 5.0 });
    });

    it("rejects when the result rounds below minLot", () => {
      const result = calculateVolume({ ...base, copyMode: CopyMode.MULTIPLIER, masterVolume: 1.0, multiplier: 0.001, minLot: 0.01 });
      expect(result).toEqual({ rejected: true, reason: "BELOW_MIN_LOT" });
    });

    it("handles a realistic float-precision case without rounding errors", () => {
      // 0.29 is a classic float-precision trap (0.29 / 0.01 can compute as
      // 28.999999999999996 without an epsilon guard).
      const result = calculateVolume({ ...base, copyMode: CopyMode.MULTIPLIER, masterVolume: 0.29, multiplier: 1, lotStep: 0.01 });
      expect(result).toEqual({ volume: 0.29 });
    });
  });
});
