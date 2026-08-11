import { z } from "zod";

// Loads .env for local dev; in production, real env vars are expected to be
// set by the process manager/container, so a missing file is not an error.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env file present — fall back to whatever's already in the environment
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default("info"),
  EVENT_IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  CONNECTOR_OFFLINE_THRESHOLD_SECONDS: z.coerce.number().int().positive().default(15),
});

export const env = envSchema.parse(process.env);
