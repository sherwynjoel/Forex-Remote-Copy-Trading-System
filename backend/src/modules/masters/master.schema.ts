import { z } from "zod";

export const createMasterSchema = z.object({
  name: z.string().min(1),
  accountNumber: z.string().min(1),
  broker: z.string().min(1),
  platform: z.string().default("MT5"),
  server: z.string().min(1),
});

export type CreateMasterInput = z.infer<typeof createMasterSchema>;
