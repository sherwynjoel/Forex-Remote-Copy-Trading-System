import { z } from "zod";
import { CopyMode } from "@prisma/client";

const volumeConfigFields = {
  copyMode: z.nativeEnum(CopyMode).optional(),
  fixedLot: z.number().positive().optional(),
  multiplier: z.number().positive().optional(),
  minLot: z.number().positive().optional(),
  maxLot: z.number().positive().optional(),
  lotStep: z.number().positive().optional(),
};

export const createSlaveSchema = z.object({
  masterId: z.string().uuid(),
  name: z.string().min(1),
  accountNumber: z.string().min(1),
  broker: z.string().min(1),
  platform: z.string().default("MT5"),
  server: z.string().min(1),
  ...volumeConfigFields,
});

export type CreateSlaveInput = z.infer<typeof createSlaveSchema>;

export const updateSlaveSchema = z.object({
  copyEnabled: z.boolean().optional(),
  ...volumeConfigFields,
});

export type UpdateSlaveInput = z.infer<typeof updateSlaveSchema>;
