import type { LatencyBreakdown } from "../../types/tradeEvent.js";

/**
 * All inputs are ISO-8601 timestamps. detectionLatency should sit close to
 * zero since OnTradeTransaction is a native MT5 event, not a poll — a
 * consistently non-trivial value here would indicate the EA is doing
 * unexpected work between detecting and sending the event.
 */
export function computeLatency(params: {
  masterEventTime: string;
  eaSentTime: string;
  backendReceivedTime: string;
}): LatencyBreakdown {
  const masterEventMs = Date.parse(params.masterEventTime);
  const eaSentMs = Date.parse(params.eaSentTime);
  const backendReceivedMs = Date.parse(params.backendReceivedTime);

  const detectionLatencyMs = Math.max(0, eaSentMs - masterEventMs);
  const networkLatencyMs = Math.max(0, backendReceivedMs - eaSentMs);

  return {
    detectionLatencyMs,
    networkLatencyMs,
    totalLatencyMs: detectionLatencyMs + networkLatencyMs,
  };
}
