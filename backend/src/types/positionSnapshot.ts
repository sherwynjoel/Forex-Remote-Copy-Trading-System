import { z } from "zod";

/**
 * Shape of one open position as reported by either connector's heartbeat.
 * `comment` is Slave-only — the MT5 order comment set by
 * slave-service/main.py::execute_open ("copy:<copyId>"), which is how
 * reconciliation traces a Slave position back to the copy that created it.
 */
export const positionSnapshotItemSchema = z.object({
  ticket: z.string().min(1),
  symbol: z.string().min(1),
  side: z.enum(["BUY", "SELL"]).optional(),
  volume: z.number().nonnegative(),
  sl: z.number().optional(),
  tp: z.number().optional(),
  comment: z.string().optional(),
});

export type PositionSnapshotItem = z.infer<typeof positionSnapshotItemSchema>;

export const positionSnapshotSchema = z.array(positionSnapshotItemSchema);
