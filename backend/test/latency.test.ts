import { describe, expect, it } from "vitest";
import { computeLatency } from "../src/modules/monitoring/latency.js";

describe("computeLatency", () => {
  it("computes detection and network latency from the three timestamps", () => {
    const masterEventTime = "2026-08-11T10:21:32.123Z";
    const eaSentTime = "2026-08-11T10:21:32.126Z"; // +3ms detection/serialize time
    const backendReceivedTime = "2026-08-11T10:21:32.138Z"; // +12ms network time

    const latency = computeLatency({ masterEventTime, eaSentTime, backendReceivedTime });

    expect(latency.detectionLatencyMs).toBe(3);
    expect(latency.networkLatencyMs).toBe(12);
    expect(latency.totalLatencyMs).toBe(15);
  });

  it("clamps negative latency to zero instead of going negative on clock skew", () => {
    const masterEventTime = "2026-08-11T10:21:32.500Z";
    const eaSentTime = "2026-08-11T10:21:32.100Z"; // out of order due to clock skew
    const backendReceivedTime = "2026-08-11T10:21:32.100Z";

    const latency = computeLatency({ masterEventTime, eaSentTime, backendReceivedTime });

    expect(latency.detectionLatencyMs).toBe(0);
    expect(latency.networkLatencyMs).toBe(0);
  });
});
