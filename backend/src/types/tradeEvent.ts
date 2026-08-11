import { z } from "zod";

export const TRADE_EVENT_TYPES = [
  "OPEN",
  "CLOSE",
  "MODIFY",
  "PARTIAL_CLOSE",
  "PENDING_OPEN",
  "PENDING_MODIFY",
  "PENDING_CANCEL",
] as const;

export const TRADE_SIDES = ["BUY", "SELL"] as const;

/**
 * Shape of the normalized event the Master EA sends. This is the contract
 * between connectors/master-ea and the backend ingest endpoint — the
 * simulator tool in tools/simulate-master-event.ts produces the same shape.
 */
export const tradeEventPayloadSchema = z.object({
  eventId: z.string().min(1),
  masterTicket: z.string().min(1),
  type: z.enum(TRADE_EVENT_TYPES),
  symbol: z.string().min(1),
  side: z.enum(TRADE_SIDES).optional(),
  volume: z.number().positive().optional(),
  price: z.number().positive().optional(),
  sl: z.number().nonnegative().optional(),
  tp: z.number().nonnegative().optional(),
  // ISO-8601 timestamps captured on the connector side
  masterEventTime: z.string().datetime(),
  eaSentTime: z.string().datetime(),
});

export type TradeEventPayload = z.infer<typeof tradeEventPayloadSchema>;

export interface NormalizedTradeEvent extends TradeEventPayload {
  masterId: string;
  backendReceivedTime: string;
}

export interface LatencyBreakdown {
  detectionLatencyMs: number;
  networkLatencyMs: number;
  totalLatencyMs: number;
}
