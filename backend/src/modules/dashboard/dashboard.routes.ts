import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** One-call summary for the dashboard's overview cards (spec section 16) — avoids the frontend making 8 separate requests. */
export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/api/dashboard/summary", async (_request, reply) => {
    const todayStart = startOfTodayUtc();

    const [
      totalMasters,
      totalSlaves,
      onlineSlaves,
      offlineSlaves,
      copyingSlaves,
      pausedSlaves,
      failedSlaves,
      tradesToday,
      executedToday,
      failedToday,
      latencyAgg,
    ] = await Promise.all([
      prisma.master.count(),
      prisma.slave.count(),
      prisma.slave.count({ where: { status: "ONLINE" } }),
      prisma.slave.count({ where: { status: "OFFLINE" } }),
      prisma.slave.count({ where: { copyEnabled: true } }),
      prisma.slave.count({ where: { copyEnabled: false } }),
      prisma.slave.count({ where: { status: "ERROR" } }),
      prisma.tradeEvent.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.copyOrder.count({ where: { status: "EXECUTED", createdAt: { gte: todayStart } } }),
      prisma.copyOrder.count({ where: { status: "FAILED", createdAt: { gte: todayStart } } }),
      prisma.tradeEvent.aggregate({
        where: { createdAt: { gte: todayStart }, totalLatencyMs: { not: null } },
        _avg: { totalLatencyMs: true },
      }),
    ]);

    const totalCopyOutcomes = executedToday + failedToday;
    const successRate = totalCopyOutcomes > 0 ? (executedToday / totalCopyOutcomes) * 100 : null;

    return reply.send({
      totalMasters,
      totalSlaves,
      onlineSlaves,
      offlineSlaves,
      copyingSlaves,
      pausedSlaves,
      failedSlaves,
      tradesToday,
      successfulCopiesToday: executedToday,
      failedCopiesToday: failedToday,
      successRate,
      avgLatencyMs: latencyAgg._avg.totalLatencyMs,
    });
  });
}
