import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // src/config/env.ts loads .env itself (process.loadEnvFile), so no
    // separate test setup file is needed here.
    testTimeout: 10000,
    // Integration tests that call startCopyEngine() each stand up a full
    // Copy Engine instance sharing one real Postgres + Redis (there's
    // exactly one Copy Engine in production; these tests intentionally
    // mirror that). Running test files in parallel would run multiple
    // independent Copy Engine instances against the same Redis pub/sub
    // stream, each racing to process every file's events and tripping the
    // copy_orders unique constraint. Sequential execution matches the
    // real single-instance topology.
    fileParallelism: false,
  },
});
