import Fastify from "fastify";
import { logger } from "./config/logger.js";
import { healthRoutes } from "./modules/monitoring/health.routes.js";
import { masterRoutes } from "./modules/masters/master.routes.js";
import { connectorRoutes } from "./modules/connectors/connector.routes.js";
import { ingestRoutes } from "./modules/ingest/ingest.routes.js";

export function buildApp() {
  const app = Fastify({ loggerInstance: logger });

  app.register(healthRoutes);
  app.register(masterRoutes);
  app.register(connectorRoutes);
  app.register(ingestRoutes);

  return app;
}
