import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { sweepOfflineConnectors } from "./modules/connectors/connector.service.js";
import { startCopyEngine } from "./modules/copy-engine/copyEngine.js";

const app = buildApp();

const sweepInterval = setInterval(() => {
  sweepOfflineConnectors().catch((err) => logger.error({ err }, "offline connector sweep failed"));
}, 5000);

startCopyEngine();

app
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .then(() => logger.info({ port: env.PORT }, "backend listening"))
  .catch((err) => {
    logger.error({ err }, "failed to start server");
    process.exit(1);
  });

async function shutdown() {
  clearInterval(sweepInterval);
  await app.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
