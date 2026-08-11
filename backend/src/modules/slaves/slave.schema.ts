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

// Risk limits (spec section 15) — all optional; omitting a field leaves it
// at its "off / no restriction" default (see schema.prisma).
const riskConfigFields = {
  emergencyStop: z.boolean().optional(),
  allowedSymbols: z.array(z.string().min(1)).optional(),
  blockedSymbols: z.array(z.string().min(1)).optional(),
  maxPositions: z.number().int().positive().optional(),
  maxExposure: z.number().positive().optional(),
};

export const createSlaveSchema = z.object({
  masterId: z.string().uuid(),
  name: z.string().min(1),
  accountNumber: z.string().min(1),
  broker: z.string().min(1),
  platform: z.string().default("MT5"),
  server: z.string().min(1),
  ...volumeConfigFields,
  ...riskConfigFields,
});

export type CreateSlaveInput = z.infer<typeof createSlaveSchema>;

export const updateSlaveSchema = z.object({
  copyEnabled: z.boolean().optional(),
  ...volumeConfigFields,
  ...riskConfigFields,
});

export type UpdateSlaveInput = z.infer<typeof updateSlaveSchema>;

export const createSymbolMappingSchema = z.object({
  masterSymbol: z.string().min(1),
  slaveSymbol: z.string().min(1),
});

export type CreateSymbolMappingInput = z.infer<typeof createSymbolMappingSchema>;
