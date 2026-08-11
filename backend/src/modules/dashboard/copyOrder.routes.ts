import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Recent copy_orders for the Live Trades / Trade Monitoring page (spec section 20) — the initial load before real-time updates arrive over /ws/admin. */
export async function copyOrderRoutes(app: FastifyInstance) {
  app.get("/api/copy-orders", async (request, reply) => {
    const { masterId, slaveId, limit } = request.query as { masterId?: string; slaveId?: string; limit?: string };
    const take = Math.min(limit ? Number(limit) || DEFAULT_LIMIT : DEFAULT_LIMIT, MAX_LIMIT);

    const copyOrders = await prisma.copyOrder.findMany({
      where: {
        ...(masterId ? { masterId } : {}),
        ...(slaveId ? { slaveId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take,
      include: {
        tradeEvent: { select: { symbol: true, side: true } },
        master: { select: { name: true, accountNumber: true } },
        slave: { select: { name: true, accountNumber: true } },
      },
    });

    return reply.send(copyOrders);
  });
}
