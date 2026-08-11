import { z } from "zod";

export const createSlaveSchema = z.object({
  masterId: z.string().uuid(),
  name: z.string().min(1),
  accountNumber: z.string().min(1),
  broker: z.string().min(1),
  platform: z.string().default("MT5"),
  server: z.string().min(1),
});

export type CreateSlaveInput = z.infer<typeof createSlaveSchema>;

export const updateSlaveSchema = z.object({
  copyEnabled: z.boolean().optional(),
});

export type UpdateSlaveInput = z.infer<typeof updateSlaveSchema>;
