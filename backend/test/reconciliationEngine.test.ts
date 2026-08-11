import { describe, expect, it } from "vitest";
import { compareState, type CompareStateInput } from "../src/modules/reconciliation/reconciliationEngine.js";

function baseInput(overrides: Partial<CompareStateInput> = {}): CompareStateInput {
  return {
    masterPositions: [],
    openCopies: [],
    closedCopies: [],
    slavePositions: [],
    expectedSlTpByMasterTicket: {},
    ...overrides,
  };
}

describe("compareState", () => {
  it("produces no findings when everything is in sync", () => {
    const findings = compareState(
      baseInput({
        masterPositions: [{ ticket: "M1", symbol: "XAUUSD", volume: 1.0 }],
        openCopies: [{ copyId: "CP1", masterTicket: "M1", slaveTicket: "S1", requestedVolume: 1.0 }],
        slavePositions: [{ ticket: "S1", symbol: "XAUUSDm", volume: 1.0, sl: 3340.2, tp: 3370.2, comment: "copy:CP1" }],
        expectedSlTpByMasterTicket: { M1: { sl: 3340.2, tp: 3370.2 } },
      }),
    );
    expect(findings).toEqual([]);
  });

  it("flags MISSING_COPY when a Master position has no copy at all", () => {
    const findings = compareState(
      baseInput({
        masterPositions: [{ ticket: "M1", symbol: "XAUUSD", volume: 1.0 }],
      }),
    );
    expect(findings).toEqual([
      { type: "MISSING_COPY", masterTicket: "M1", details: { symbol: "XAUUSD", volume: 1.0 } },
    ]);
  });

  it("does not flag MISSING_COPY when a closed copy accounts for the Master ticket", () => {
    const findings = compareState(
      baseInput({
        masterPositions: [{ ticket: "M1", symbol: "XAUUSD", volume: 1.0 }],
        closedCopies: [{ masterTicket: "M1", slaveTicket: "S1" }],
      }),
    );
    expect(findings.some((f) => f.type === "MISSING_COPY")).toBe(false);
  });

  it("flags SLAVE_POSITION_MISSING when the system thinks a copy is open but the Slave doesn't have it", () => {
    const findings = compareState(
      baseInput({
        openCopies: [{ copyId: "CP1", masterTicket: "M1", slaveTicket: "S1", requestedVolume: 1.0 }],
      }),
    );
    expect(findings).toEqual([{ type: "SLAVE_POSITION_MISSING", masterTicket: "M1", slaveTicket: "S1", details: {} }]);
  });

  it("flags VOLUME_MISMATCH when the Slave's actual volume differs beyond tolerance", () => {
    const findings = compareState(
      baseInput({
        openCopies: [{ copyId: "CP1", masterTicket: "M1", slaveTicket: "S1", requestedVolume: 1.0 }],
        slavePositions: [{ ticket: "S1", symbol: "XAUUSD", volume: 1.5, comment: "copy:CP1" }],
      }),
    );
    expect(findings).toContainEqual({
      type: "VOLUME_MISMATCH",
      masterTicket: "M1",
      slaveTicket: "S1",
      details: { expected: 1.0, actual: 1.5 },
    });
  });

  it("does not flag VOLUME_MISMATCH when the difference is within tolerance", () => {
    const findings = compareState(
      baseInput({
        openCopies: [{ copyId: "CP1", masterTicket: "M1", slaveTicket: "S1", requestedVolume: 1.0 }],
        slavePositions: [{ ticket: "S1", symbol: "XAUUSD", volume: 1.005, comment: "copy:CP1" }],
        volumeTolerance: 0.01,
      }),
    );
    expect(findings.some((f) => f.type === "VOLUME_MISMATCH")).toBe(false);
  });

  it("flags SLTP_MISMATCH when SL/TP differ beyond tolerance", () => {
    const findings = compareState(
      baseInput({
        openCopies: [{ copyId: "CP1", masterTicket: "M1", slaveTicket: "S1", requestedVolume: 1.0 }],
        slavePositions: [{ ticket: "S1", symbol: "XAUUSD", volume: 1.0, sl: 3335.0, tp: 3370.2, comment: "copy:CP1" }],
        expectedSlTpByMasterTicket: { M1: { sl: 3340.2, tp: 3370.2 } },
      }),
    );
    expect(findings).toContainEqual({
      type: "SLTP_MISMATCH",
      masterTicket: "M1",
      slaveTicket: "S1",
      details: { expectedSl: 3340.2, expectedTp: 3370.2, actualSl: 3335.0, actualTp: 3370.2 },
    });
  });

  it("flags SLAVE_NOT_CLOSED when a closed copy's Slave position is still present", () => {
    const findings = compareState(
      baseInput({
        closedCopies: [{ masterTicket: "M1", slaveTicket: "S1" }],
        slavePositions: [{ ticket: "S1", symbol: "XAUUSD", volume: 1.0, comment: "copy:CP1" }],
      }),
    );
    expect(findings).toContainEqual({ type: "SLAVE_NOT_CLOSED", masterTicket: "M1", slaveTicket: "S1", details: {} });
  });

  it("flags UNEXPECTED_SLAVE_POSITION for a position with no known copy comment", () => {
    const findings = compareState(
      baseInput({
        slavePositions: [{ ticket: "S99", symbol: "EURUSD", volume: 0.5 }],
      }),
    );
    expect(findings).toEqual([
      {
        type: "UNEXPECTED_SLAVE_POSITION",
        slaveTicket: "S99",
        details: { symbol: "EURUSD", volume: 0.5, comment: null },
      },
    ]);
  });

  it("flags UNEXPECTED_SLAVE_POSITION when the comment points to a copy that isn't open", () => {
    const findings = compareState(
      baseInput({
        slavePositions: [{ ticket: "S99", symbol: "EURUSD", volume: 0.5, comment: "copy:UNKNOWN-ID" }],
      }),
    );
    expect(findings.some((f) => f.type === "UNEXPECTED_SLAVE_POSITION")).toBe(true);
  });

  it("flags DUPLICATE_SLAVE_POSITION when two Slave positions share the same copy comment", () => {
    const findings = compareState(
      baseInput({
        openCopies: [{ copyId: "CP1", masterTicket: "M1", slaveTicket: "S1", requestedVolume: 1.0 }],
        slavePositions: [
          { ticket: "S1", symbol: "XAUUSD", volume: 1.0, comment: "copy:CP1" },
          { ticket: "S2", symbol: "XAUUSD", volume: 1.0, comment: "copy:CP1" },
        ],
      }),
    );
    const duplicates = findings.filter((f) => f.type === "DUPLICATE_SLAVE_POSITION");
    expect(duplicates).toHaveLength(2);
    expect(duplicates.map((f) => f.slaveTicket).sort()).toEqual(["S1", "S2"]);
  });
});
