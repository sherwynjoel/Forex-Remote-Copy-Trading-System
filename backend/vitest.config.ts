import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // src/config/env.ts loads .env itself (process.loadEnvFile), so no
    // separate test setup file is needed here.
    testTimeout: 10000,
  },
});
