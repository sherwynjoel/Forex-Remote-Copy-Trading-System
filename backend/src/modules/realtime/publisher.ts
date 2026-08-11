import { redis } from "../../config/redis.js";
import type { NormalizedTradeEvent } from "../../types/tradeEvent.js";

export function masterEventsChannel(masterId: string): string {
  return `master:${masterId}:events`;
}

/**
 * Publishes a validated, de-duplicated trade event onto the real-time layer.
 * Phase 1 has no subscribers yet — this is the seam the Copy Engine (Phase 3)
 * and the Slave connector delivery path (Phase 2) attach to, so the ingest
 * critical path doesn't change shape when those land.
 */
export async function publishTradeEvent(event: NormalizedTradeEvent): Promise<void> {
  await redis.publish(masterEventsChannel(event.masterId), JSON.stringify(event));
}
