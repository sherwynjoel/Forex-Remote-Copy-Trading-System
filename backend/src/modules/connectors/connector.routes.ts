import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateConnector, recordHeartbeat } from "./connector.service.js";

const heartbeatBodySchema = z
  .object({
    balance: z.number().nonnegative().optional(),
    equity: z.number().optional(),
  })
  .optional();

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

    const parsed = heartbeatBodySchema.safeParse(request.body);
    const accountInfo =
      parsed.success && parsed.data?.balance !== undefined && parsed.data.equity !== undefined
        ? { balance: parsed.data.balance, equity: parsed.data.equity }
        : undefined;

    await recordHeartbeat(auth.connectorId, accountInfo);
    return reply.code(200).send({ status: "OK", receivedAt: new Date().toISOString() });
  });
}
