import Fastify from "fastify";
import { logger } from "./config/logger.js";
import { healthRoutes } from "./modules/monitoring/health.routes.js";
import { masterRoutes } from "./modules/masters/master.routes.js";
import { slaveRoutes } from "./modules/slaves/slave.routes.js";
import { connectorRoutes } from "./modules/connectors/connector.routes.js";
import { ingestRoutes } from "./modules/ingest/ingest.routes.js";
import { registerWsGateway } from "./modules/realtime/wsGateway.js";
import { reconciliationRoutes } from "./modules/reconciliation/reconciliation.routes.js";

export function buildApp() {
  const app = Fastify({ loggerInstance: logger });

  app.register(healthRoutes);
  app.register(masterRoutes);
  app.register(slaveRoutes);
  app.register(connectorRoutes);
  app.register(ingestRoutes);
  app.register(registerWsGateway);
  app.register(reconciliationRoutes);

  return app;
}
