import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import websocketPlugin from "@fastify/websocket";
import { z } from "zod";
import type { WebSocket } from "ws";
import { authenticateConnector, recordHeartbeat, type AccountSnapshot } from "../connectors/connector.service.js";
import { logger } from "../../config/logger.js";

/**
 * Generic Slave connector transport: authenticate, track the live socket per
 * slaveId, send/receive JSON. Deliberately has no knowledge of copy_orders
 * or the Copy Engine — see modules/copy-engine, which is the sole consumer
 * of onSlaveMessage/sendToSlave.
 */

const connections = new Map<string, WebSocket>();

type SlaveMessageHandler = (slaveId: string, message: unknown) => void;
let messageHandler: SlaveMessageHandler | null = null;

export function onSlaveMessage(handler: SlaveMessageHandler): void {
  messageHandler = handler;
}

export function isSlaveConnected(slaveId: string): boolean {
  const socket = connections.get(slaveId);
  return !!socket && socket.readyState === socket.OPEN;
}

export function sendToSlave(slaveId: string, payload: unknown): boolean {
  const socket = connections.get(slaveId);
  if (!socket || socket.readyState !== socket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

const heartbeatMessageSchema = z.object({
  type: z.literal("heartbeat"),
  balance: z.number().nonnegative().optional(),
  equity: z.number().optional(),
});

type HeartbeatParseResult = { isHeartbeat: true; accountInfo?: AccountSnapshot } | { isHeartbeat: false };

function parseHeartbeatMessage(message: unknown): HeartbeatParseResult {
  const parsed = heartbeatMessageSchema.safeParse(message);
  if (!parsed.success) return { isHeartbeat: false };
  const { balance, equity } = parsed.data;
  return {
    isHeartbeat: true,
    accountInfo: balance !== undefined && equity !== undefined ? { balance, equity } : undefined,
  };
}

// fastify-plugin breaks encapsulation so @fastify/websocket's decorations
// (injectWS, websocketServer) bubble up to the root app instance, instead
// of staying scoped to a nested plugin context.
export const registerWsGateway = fp(async function registerWsGateway(app: FastifyInstance): Promise<void> {
  await app.register(websocketPlugin);

  app.get("/ws/slave", { websocket: true }, (socket, request) => {
    void (async () => {
      const authHeader = request.headers.authorization;
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
      const auth = token ? await authenticateConnector(token) : null;

      if (!auth || auth.ownerType !== "SLAVE" || !auth.slaveId) {
        socket.close(4401, "UNAUTHORIZED");
        return;
      }
      const slaveId = auth.slaveId;
      const connectorId = auth.connectorId;

      connections.set(slaveId, socket);
      logger.info({ slaveId, connectorId }, "slave connector connected");
      void recordHeartbeat(connectorId);

      socket.on("message", (raw: Buffer) => {
        let message: unknown;
        try {
          message = JSON.parse(raw.toString("utf-8"));
        } catch {
          logger.warn({ slaveId }, "received malformed message from slave connector");
          return;
        }

        const heartbeat = parseHeartbeatMessage(message);
        if (heartbeat.isHeartbeat) {
          void recordHeartbeat(connectorId, heartbeat.accountInfo);
          return;
        }

        // Any inbound message (not just heartbeats) is itself a liveness
        // signal, so it still refreshes the heartbeat clock.
        void recordHeartbeat(connectorId);
        messageHandler?.(slaveId, message);
      });

      socket.on("close", () => {
        if (connections.get(slaveId) === socket) {
          connections.delete(slaveId);
        }
        logger.info({ slaveId }, "slave connector disconnected");
      });
    })();
  });
});
