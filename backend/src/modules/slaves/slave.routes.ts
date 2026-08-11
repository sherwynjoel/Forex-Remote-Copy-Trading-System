import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { createSlaveSchema, updateSlaveSchema, createSymbolMappingSchema } from "./slave.schema.js";
import { registerConnector } from "../connectors/connector.service.js";
import { writeAudit } from "../audit/audit.service.js";
import { upsertSymbolMapping, listSymbolMappings, deleteSymbolMapping } from "./symbolMapping.service.js";

export async function slaveRoutes(app: FastifyInstance) {
  app.post("/api/slaves", async (request, reply) => {
    const parsed = createSlaveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ status: "INVALID_PAYLOAD", errors: parsed.error.flatten() });
    }

    const master = await prisma.master.findUnique({ where: { id: parsed.data.masterId } });
    if (!master) return reply.code(404).send({ status: "MASTER_NOT_FOUND" });

    const slave = await prisma.slave.create({ data: parsed.data });
    await writeAudit({
      actor: "admin",
      action: "SLAVE_CREATED",
      entity: `slave:${slave.id}`,
      // Round-tripped through JSON so Prisma Decimal fields (multiplier,
      // minLot, maxLot, lotStep) serialize to plain strings.
      newValue: JSON.parse(JSON.stringify(slave)),
      ip: request.ip,
    });

    return reply.code(201).send(slave);
  });

  app.get("/api/slaves", async (request, reply) => {
    const { masterId } = request.query as { masterId?: string };
    const slaves = await prisma.slave.findMany({
      where: masterId ? { masterId } : undefined,
      include: { connectors: { select: { id: true, status: true, lastHeartbeatAt: true } } },
      orderBy: { createdAt: "desc" },
    });
    return reply.send(slaves);
  });

  app.get("/api/slaves/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const slave = await prisma.slave.findUnique({ where: { id }, include: { connectors: true } });
    if (!slave) return reply.code(404).send({ status: "NOT_FOUND" });
    return reply.send(slave);
  });

  // Pause/resume copying for a Slave without detaching it from its Master.
  app.patch("/api/slaves/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateSlaveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ status: "INVALID_PAYLOAD", errors: parsed.error.flatten() });
    }

    const existing = await prisma.slave.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ status: "NOT_FOUND" });

    const slave = await prisma.slave.update({ where: { id }, data: parsed.data });

    // Record only the fields that were actually part of this request, with
    // their before/after values — the spec calls for risk-config changes
    // to be individually auditable, not just "something changed." Values
    // are round-tripped through JSON so Prisma Decimal fields serialize to
    // plain strings rather than being passed as class instances.
    const changedKeys = Object.keys(parsed.data) as (keyof typeof parsed.data)[];
    const pick = (source: Record<string, unknown>) =>
      JSON.parse(JSON.stringify(Object.fromEntries(changedKeys.map((key) => [key, source[key]]))));
    await writeAudit({
      actor: "admin",
      action: "SLAVE_UPDATED",
      entity: `slave:${id}`,
      oldValue: pick(existing),
      newValue: pick(slave),
      ip: request.ip,
    });

    return reply.send(slave);
  });

  // Issues a connector token for a slave, exactly like POST /api/masters/:id/connectors.
  app.post("/api/slaves/:id/connectors", async (request, reply) => {
    const { id } = request.params as { id: string };
    const slave = await prisma.slave.findUnique({ where: { id } });
    if (!slave) return reply.code(404).send({ status: "NOT_FOUND" });

    const body = (request.body ?? {}) as { version?: string };
    const { connectorId, token } = await registerConnector({ slaveId: id }, body.version);

    await writeAudit({
      actor: "admin",
      action: "CONNECTOR_REGISTERED",
      entity: `connector:${connectorId}`,
      newValue: { slaveId: id },
      ip: request.ip,
    });

    return reply.code(201).send({ connectorId, slaveId: id, token });
  });

  // Master-symbol -> Slave-symbol translation (spec section 14). Upserts
  // by (slaveId, masterSymbol) — posting the same masterSymbol again just
  // updates its mapping rather than erroring.
  app.post("/api/slaves/:id/symbol-mappings", async (request, reply) => {
    const { id } = request.params as { id: string };
    const slave = await prisma.slave.findUnique({ where: { id } });
    if (!slave) return reply.code(404).send({ status: "NOT_FOUND" });

    const parsed = createSymbolMappingSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ status: "INVALID_PAYLOAD", errors: parsed.error.flatten() });
    }

    const mapping = await upsertSymbolMapping(id, parsed.data.masterSymbol, parsed.data.slaveSymbol);
    await writeAudit({
      actor: "admin",
      action: "SYMBOL_MAPPING_SET",
      entity: `slave:${id}`,
      newValue: { masterSymbol: mapping.masterSymbol, slaveSymbol: mapping.slaveSymbol },
      ip: request.ip,
    });

    return reply.code(201).send(mapping);
  });

  app.get("/api/slaves/:id/symbol-mappings", async (request, reply) => {
    const { id } = request.params as { id: string };
    const mappings = await listSymbolMappings(id);
    return reply.send(mappings);
  });

  app.delete("/api/slaves/:id/symbol-mappings/:mappingId", async (request, reply) => {
    const { id, mappingId } = request.params as { id: string; mappingId: string };
    const deleted = await deleteSymbolMapping(id, mappingId);
    if (!deleted) return reply.code(404).send({ status: "NOT_FOUND" });

    await writeAudit({
      actor: "admin",
      action: "SYMBOL_MAPPING_DELETED",
      entity: `slave:${id}`,
      oldValue: { mappingId },
      ip: request.ip,
    });

    return reply.code(204).send();
  });
}
