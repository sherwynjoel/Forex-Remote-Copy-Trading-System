import type { FastifyInstance } from "fastify";
import { authenticateConnector, recordHeartbeat } from "./connector.service.js";

export async function connectorRoutes(app: FastifyInstance) {
  app.post("/api/connectors/heartbeat", async (request, reply) => {
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    if (!token) {
      return reply.code(401).send({ status: "UNAUTHORIZED" });
    }

    const auth = await authenticateConnector(token);
    if (!auth) {
      return reply.code(401).send({ status: "UNAUTHORIZED" });
    }

    await recordHeartbeat(auth.connectorId);
    return reply.code(200).send({ status: "OK", receivedAt: new Date().toISOString() });
  });
}
