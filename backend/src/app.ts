import Fastify from "fastify";
import cors from "@fastify/cors";
import { logger } from "./config/logger.js";
import { env } from "./config/env.js";
import { healthRoutes } from "./modules/monitoring/health.routes.js";
import { masterRoutes } from "./modules/masters/master.routes.js";
import { slaveRoutes } from "./modules/slaves/slave.routes.js";
import { connectorRoutes } from "./modules/connectors/connector.routes.js";
import { ingestRoutes } from "./modules/ingest/ingest.routes.js";
import { registerWsGateway } from "./modules/realtime/wsGateway.js";
import { reconciliationRoutes } from "./modules/reconciliation/reconciliation.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { requireAdminAuth } from "./modules/auth/requireAdminAuth.js";
import { dashboardRoutes } from "./modules/dashboard/dashboard.routes.js";
import { copyOrderRoutes } from "./modules/dashboard/copyOrder.routes.js";
import { registerAdminWsGateway } from "./modules/realtime/adminWsGateway.js";

export function buildApp() {
  const app = Fastify({ loggerInstance: logger });

  // The dashboard frontend runs on a different origin (Vite dev server /
  // eventual static host) than the API — without CORS, every fetch() call
  // it makes fails at the browser before the request even reaches auth.
  // Connector traffic (EA/Slave service) isn't a browser, so this doesn't
  // affect it either way.
  app.register(cors, {
    origin: env.CORS_ORIGIN,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
  });

  // Public: system health, and the Master/Slave connector-token-authenticated
  // flows (EA heartbeat/ingest, Slave WS) — completely untouched by admin auth.
  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(connectorRoutes);
  app.register(ingestRoutes);
  app.register(registerWsGateway);

  // Admin-only: everything a browser dashboard touches, gated by one JWT
  // check applied to the whole nested scope rather than every route.
  app.register(async (adminScope) => {
    adminScope.addHook("preHandler", requireAdminAuth);
    await adminScope.register(masterRoutes);
    await adminScope.register(slaveRoutes);
    await adminScope.register(reconciliationRoutes);
    await adminScope.register(dashboardRoutes);
    await adminScope.register(copyOrderRoutes);
    await adminScope.register(registerAdminWsGateway);
  });

  return app;
}
