import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { runReconciliation } from "./reconciliation.service.js";

export async function reconciliationRoutes(app: FastifyInstance) {
  // The queryable surface "show this immediately to the administrator"
  // (spec section 21) resolves to before there's a dashboard (Phase 6).
  app.get("/api/reconciliation/findings", async (request, reply) => {
    const { masterId, slaveId } = request.query as { masterId?: string; slaveId?: string };
    const findings = await prisma.reconciliationFinding.findMany({
      where: {
        ...(masterId ? { masterId } : {}),
        ...(slaveId ? { slaveId } : {}),
      },
      orderBy: { detectedAt: "desc" },
    });
    return reply.send(findings);
  });

  // Triggers an immediate run rather than waiting for the interval —
  // useful for ops and for testing.
  app.post("/api/reconciliation/run", async (request, reply) => {
    const { masterId, slaveId } = request.query as { masterId?: string; slaveId?: string };
    const summary = await runReconciliation({ masterId, slaveId });
    return reply.send(summary);
  });
}
