import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/db/client.js";
import { runReconciliation } from "../src/modules/reconciliation/reconciliation.service.js";

/**
 * Exercises the orchestration layer (staleness gating, findings
 * persistence, replace-on-rerun) on top of the already-unit-tested pure
 * compareState() — seeds trade_events/copy_orders directly and sets
 * positionSnapshot the same way a real heartbeat would have written it.
 */
describe("runReconciliation", () => {
  let masterId: string;
  let slaveId: string;
  let tradeEventId: string;
  let copyOrderId: string;
  const masterTicket = "RECON-M1";

  beforeEach(async () => {
    const master = await prisma.master.create({
      data: {
        name: "Reconciliation Test Master",
        accountNumber: `TEST-RC-M-${randomUUID()}`,
        broker: "Test Broker",
        platform: "MT5",
        server: "Test-Server",
      },
    });
    masterId = master.id;

    const slave = await prisma.slave.create({
      data: {
        masterId,
        name: "Reconciliation Test Slave",
        accountNumber: `TEST-RC-S-${randomUUID()}`,
        broker: "Test Broker",
        platform: "MT5",
        server: "Test-Server",
      },
    });
    slaveId = slave.id;

    const tradeEvent = await prisma.tradeEvent.create({
      data: {
        eventId: `CP-${randomUUID()}`,
        masterId,
        masterTicket,
        type: "OPEN",
        symbol: "XAUUSD",
        side: "BUY",
        volume: 1.0,
        sl: 3340.2,
        tp: 3370.2,
        rawPayload: {},
        masterEventTime: new Date(),
        eaSentTime: new Date(),
        backendReceivedTime: new Date(),
      },
    });
    tradeEventId = tradeEvent.id;

    const copyOrder = await prisma.copyOrder.create({
      data: {
        tradeEventId,
        masterId,
        slaveId,
        masterTicket,
        type: "OPEN",
        status: "EXECUTED",
        requestedVolume: 1.0,
        slaveTicket: "RECON-S1",
      },
    });
    copyOrderId = copyOrder.id;
  });

  afterEach(async () => {
    await prisma.reconciliationFinding.deleteMany({ where: { masterId, slaveId } });
    await prisma.copyOrder.deleteMany({ where: { masterId, slaveId } });
    await prisma.tradeEvent.deleteMany({ where: { masterId } });
    await prisma.slave.delete({ where: { id: slaveId } });
    await prisma.master.delete({ where: { id: masterId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function setSnapshots(params: {
    masterPositions: unknown;
    slavePositions: unknown;
    masterSnapshotAt?: Date;
    slaveSnapshotAt?: Date;
  }) {
    const now = new Date();
    await prisma.master.update({
      where: { id: masterId },
      data: {
        positionSnapshot: params.masterPositions as object,
        positionSnapshotAt: params.masterSnapshotAt ?? now,
      },
    });
    await prisma.slave.update({
      where: { id: slaveId },
      data: {
        positionSnapshot: params.slavePositions as object,
        positionSnapshotAt: params.slaveSnapshotAt ?? now,
      },
    });
  }

  it("produces no findings when Master and Slave snapshots agree with the system", async () => {
    await setSnapshots({
      masterPositions: [{ ticket: masterTicket, symbol: "XAUUSD", volume: 1.0 }],
      slavePositions: [
        { ticket: "RECON-S1", symbol: "XAUUSDm", volume: 1.0, sl: 3340.2, tp: 3370.2, comment: `copy:${copyOrderId}` },
      ],
    });

    const summary = await runReconciliation({ masterId, slaveId });
    expect(summary).toEqual({ pairsScanned: 1, pairsSkippedStale: 0, findingsCreated: 0 });

    const findings = await prisma.reconciliationFinding.findMany({ where: { masterId, slaveId } });
    expect(findings).toHaveLength(0);
  });

  it("persists a VOLUME_MISMATCH finding when the Slave's actual volume differs", async () => {
    await setSnapshots({
      masterPositions: [{ ticket: masterTicket, symbol: "XAUUSD", volume: 1.0 }],
      slavePositions: [
        { ticket: "RECON-S1", symbol: "XAUUSDm", volume: 2.0, sl: 3340.2, tp: 3370.2, comment: `copy:${copyOrderId}` },
      ],
    });

    const summary = await runReconciliation({ masterId, slaveId });
    expect(summary.findingsCreated).toBe(1);

    const findings = await prisma.reconciliationFinding.findMany({ where: { masterId, slaveId } });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.type).toBe("VOLUME_MISMATCH");
    expect(findings[0]?.masterTicket).toBe(masterTicket);
  });

  it("skips a pair with a stale snapshot instead of producing false findings", async () => {
    const staleDate = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago, well past staleness threshold
    await setSnapshots({
      masterPositions: [{ ticket: masterTicket, symbol: "XAUUSD", volume: 1.0 }],
      slavePositions: [], // would otherwise look like SLAVE_POSITION_MISSING
      slaveSnapshotAt: staleDate,
    });

    const summary = await runReconciliation({ masterId, slaveId });
    expect(summary).toEqual({ pairsScanned: 0, pairsSkippedStale: 1, findingsCreated: 0 });

    const findings = await prisma.reconciliationFinding.findMany({ where: { masterId, slaveId } });
    expect(findings).toHaveLength(0);
  });

  it("replaces prior findings on the next run rather than accumulating them", async () => {
    await setSnapshots({
      masterPositions: [{ ticket: masterTicket, symbol: "XAUUSD", volume: 1.0 }],
      slavePositions: [
        // sl/tp match so only the volume mismatch fires, keeping this
        // scenario a clean single-finding case.
        { ticket: "RECON-S1", symbol: "XAUUSDm", volume: 3.0, sl: 3340.2, tp: 3370.2, comment: `copy:${copyOrderId}` },
      ],
    });
    await runReconciliation({ masterId, slaveId });
    expect(await prisma.reconciliationFinding.count({ where: { masterId, slaveId } })).toBe(1);

    // Fix it and run again.
    await setSnapshots({
      masterPositions: [{ ticket: masterTicket, symbol: "XAUUSD", volume: 1.0 }],
      slavePositions: [
        { ticket: "RECON-S1", symbol: "XAUUSDm", volume: 1.0, sl: 3340.2, tp: 3370.2, comment: `copy:${copyOrderId}` },
      ],
    });
    const summary = await runReconciliation({ masterId, slaveId });
    expect(summary.findingsCreated).toBe(0);
    expect(await prisma.reconciliationFinding.count({ where: { masterId, slaveId } })).toBe(0);
  });
});
