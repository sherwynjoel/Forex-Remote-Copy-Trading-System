import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { createMasterSchema } from "./master.schema.js";
import { registerConnector } from "../connectors/connector.service.js";
import { writeAudit } from "../audit/audit.service.js";

export async function masterRoutes(app: FastifyInstance) {
  app.post("/api/masters", async (request, reply) => {
    const parsed = createMasterSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ status: "INVALID_PAYLOAD", errors: parsed.error.flatten() });
    }

    const master = await prisma.master.create({ data: parsed.data });
    await writeAudit({
      actor: "admin",
      action: "MASTER_CREATED",
      entity: `master:${master.id}`,
      newValue: master,
      ip: request.ip,
    });

    return reply.code(201).send(master);
  });

  app.get("/api/masters", async (_request, reply) => {
    const masters = await prisma.master.findMany({
      include: { connectors: { select: { id: true, status: true, lastHeartbeatAt: true } } },
      orderBy: { createdAt: "desc" },
    });
    return reply.send(masters);
  });

  app.get("/api/masters/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const master = await prisma.master.findUnique({
      where: { id },
      include: { connectors: true },
    });
    if (!master) return reply.code(404).send({ status: "NOT_FOUND" });
    return reply.send(master);
  });

  // Issues a connector token for a master. The raw token is returned exactly
  // once here — only its hash is ever persisted. This is how you provision
  // the Authorization bearer token that the Master EA (or the simulator
  // tool) is configured with.
  app.post("/api/masters/:id/connectors", async (request, reply) => {
    const { id } = request.params as { id: string };
    const master = await prisma.master.findUnique({ where: { id } });
    if (!master) return reply.code(404).send({ status: "NOT_FOUND" });

    const body = (request.body ?? {}) as { version?: string };
    const { connectorId, token } = await registerConnector({ masterId: id }, body.version);

    await writeAudit({
      actor: "admin",
      action: "CONNECTOR_REGISTERED",
      entity: `connector:${connectorId}`,
      newValue: { masterId: id },
      ip: request.ip,
    });

    return reply.code(201).send({ connectorId, masterId: id, token });
  });
}
