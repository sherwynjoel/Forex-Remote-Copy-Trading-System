import { z } from "zod";

export const COPY_ACTIONS = ["OPEN", "CLOSE", "MODIFY"] as const;
export type CopyAction = (typeof COPY_ACTIONS)[number];

/**
 * Instruction pushed from the backend to a Slave connector over /ws/slave.
 * Mirrors the shape from the project spec's Copy Engine section — slaveTicket
 * is only present for CLOSE/MODIFY, resolved server-side before sending.
 */
export interface CopyInstruction {
  copyId: string;
  action: CopyAction;
  symbol: string;
  side?: "BUY" | "SELL";
  volume?: number;
  sl?: number;
  tp?: number;
  slaveTicket?: string;
}

export const executionResultSchema = z.object({
  copyId: z.string().min(1),
  status: z.enum(["EXECUTED", "FAILED"]),
  slaveTicket: z.string().optional(),
  executionPrice: z.number().optional(),
  reason: z.string().optional(),
});

export type ExecutionResult = z.infer<typeof executionResultSchema>;
