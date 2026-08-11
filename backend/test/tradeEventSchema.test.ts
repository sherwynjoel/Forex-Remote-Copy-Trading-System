import { describe, expect, it } from "vitest";
import { tradeEventPayloadSchema } from "../src/types/tradeEvent.js";

const basePayload = {
  eventId: "CP-1",
  masterTicket: "123456",
  type: "OPEN",
  symbol: "XAUUSD",
  side: "BUY",
  volume: 1.0,
  price: 3350.2,
  sl: 3340.2,
  tp: 3370.2,
  masterEventTime: new Date().toISOString(),
  eaSentTime: new Date().toISOString(),
};

describe("tradeEventPayloadSchema", () => {
  it("accepts a well-formed OPEN event", () => {
    const result = tradeEventPayloadSchema.safeParse(basePayload);
    expect(result.success).toBe(true);
  });

  it("accepts a MODIFY event without volume/side", () => {
    const { volume, side, ...rest } = basePayload;
    const result = tradeEventPayloadSchema.safeParse({ ...rest, type: "MODIFY" });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown event type", () => {
    const result = tradeEventPayloadSchema.safeParse({ ...basePayload, type: "TELEPORT" });
    expect(result.success).toBe(false);
  });

  it("rejects a negative or zero volume", () => {
    const result = tradeEventPayloadSchema.safeParse({ ...basePayload, volume: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects a missing symbol", () => {
    const { symbol, ...rest } = basePayload;
    const result = tradeEventPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO timestamp", () => {
    const result = tradeEventPayloadSchema.safeParse({ ...basePayload, masterEventTime: "not-a-date" });
    expect(result.success).toBe(false);
  });
});
