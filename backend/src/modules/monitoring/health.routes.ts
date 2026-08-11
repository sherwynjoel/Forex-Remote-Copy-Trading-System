import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { redis } from "../../config/redis.js";

async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function checkRedis(): Promise<boolean> {
  try {
    return (await redis.ping()) === "PONG";
  } catch {
    return false;
  }
}

export async function healthRoutes(app: FastifyInstance) {
  app.get("/api/system/health", async (_request, reply) => {
    const [dbOk, redisOk] = await Promise.all([checkDatabase(), checkRedis()]);
    const overall = dbOk && redisOk ? "ONLINE" : "DEGRADED";

    return reply.code(overall === "ONLINE" ? 200 : 503).send({
      status: overall,
      components: {
        api: "ONLINE",
        database: dbOk ? "ONLINE" : "OFFLINE",
        redis: redisOk ? "ONLINE" : "OFFLINE",
      },
      timestamp: new Date().toISOString(),
    });
  });
}
