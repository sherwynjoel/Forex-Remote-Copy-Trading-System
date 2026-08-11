import { randomBytes, createHash } from "node:crypto";
import { prisma } from "../../db/client.js";
import { redis } from "../../config/redis.js";
import { env } from "../../config/env.js";

const TOKEN_CACHE_PREFIX = "connector:token:";
const TOKEN_CACHE_TTL_SECONDS = 300;

export function generateConnectorToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface AuthenticatedConnector {
  connectorId: string;
  masterId: string;
}

/**
 * Resolves a bearer token to a connector/master pair. Reads through a Redis
 * cache first so the trade-event critical path avoids a Postgres round trip
 * on the common case.
 */
export async function authenticateConnector(token: string): Promise<AuthenticatedConnector | null> {
  const tokenHash = hashToken(token);
  const cacheKey = TOKEN_CACHE_PREFIX + tokenHash;

  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as AuthenticatedConnector;
  }

  const connector = await prisma.connector.findUnique({
    where: { tokenHash },
    select: { id: true, masterId: true },
  });

  if (!connector) return null;

  const result: AuthenticatedConnector = { connectorId: connector.id, masterId: connector.masterId };
  await redis.set(cacheKey, JSON.stringify(result), "EX", TOKEN_CACHE_TTL_SECONDS);
  return result;
}

export async function registerConnector(masterId: string, version?: string) {
  const token = generateConnectorToken();
  const connector = await prisma.connector.create({
    data: {
      masterId,
      tokenHash: hashToken(token),
      version,
      status: "CONNECTING",
    },
  });
  // Token is returned once; only the hash is ever persisted.
  return { connectorId: connector.id, token };
}

export async function recordHeartbeat(connectorId: string): Promise<void> {
  const now = new Date();
  await redis.set(
    `connector:${connectorId}:heartbeat`,
    now.toISOString(),
    "EX",
    env.CONNECTOR_OFFLINE_THRESHOLD_SECONDS * 2,
  );
  await prisma.connector.update({
    where: { id: connectorId },
    data: { lastHeartbeatAt: now, status: "ONLINE" },
  });
}

/**
 * Marks any connector whose last heartbeat is older than the configured
 * threshold as OFFLINE. Intended to be run on a fixed interval from server.ts.
 */
export async function sweepOfflineConnectors(): Promise<number> {
  const staleBefore = new Date(Date.now() - env.CONNECTOR_OFFLINE_THRESHOLD_SECONDS * 1000);
  const result = await prisma.connector.updateMany({
    where: {
      status: "ONLINE",
      OR: [{ lastHeartbeatAt: { lt: staleBefore } }, { lastHeartbeatAt: null }],
    },
    data: { status: "OFFLINE" },
  });
  return result.count;
}
