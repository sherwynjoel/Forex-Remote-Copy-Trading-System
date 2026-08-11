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

  // Reconciliation (spec section 21) — see modules/reconciliation/reconciliationEngine.ts.
  RECONCILIATION_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  // A snapshot older than this is treated as unreliable rather than
  // compared — a disconnected connector's stale "last known" positions
  // must never produce a false MISSING_COPY/UNEXPECTED_SLAVE_POSITION.
  RECONCILIATION_STALENESS_SECONDS: z.coerce.number().int().positive().default(30),
  RECONCILIATION_VOLUME_TOLERANCE: z.coerce.number().positive().default(0.01),
  RECONCILIATION_PRICE_TOLERANCE: z.coerce.number().positive().default(0.0001),

  // Super Admin auth (see modules/auth). The dev default secret/credentials
  // below are fine for local dev only — anything beyond that must set real
  // values, since a guessable JWT_SECRET or default password defeats the
  // entire point of adding auth in the first place.
  JWT_SECRET: z.string().min(1).default("dev-only-insecure-secret-change-me"),
  JWT_EXPIRES_IN: z.string().default("12h"),
  ADMIN_USERNAME: z.string().min(1).default("admin"),
  ADMIN_PASSWORD: z.string().min(1).default("admin"),
});

export const env = envSchema.parse(process.env);
