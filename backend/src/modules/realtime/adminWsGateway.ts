import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { logger } from "../../config/logger.js";

/**
 * Broadcast-style WS gateway for the Super Admin dashboard's Live Trades
 * page: every connected browser gets every event, unlike the 1:1 Slave
 * gateway (modules/realtime/wsGateway.ts). Auth is handled by
 * requireAdminAuth, applied as a preHandler to the whole nested scope this
 * route is registered in (see app.ts) — nothing to check here.
 * @fastify/websocket itself is already registered at the root app level by
 * wsGateway.ts, so this file doesn't need to register it again — Fastify
 * decorations flow down from parent to child scopes.
 */

const adminSockets = new Set<WebSocket>();

/** Called by the Copy Engine on every copy_orders transition — see copyEngine.ts. */
export function broadcastToAdmins(payload: unknown): void {
  if (adminSockets.size === 0) return;
  const message = JSON.stringify(payload);
  for (const socket of adminSockets) {
    if (socket.readyState === socket.OPEN) socket.send(message);
  }
}

export async function registerAdminWsGateway(app: FastifyInstance): Promise<void> {
  app.get("/ws/admin", { websocket: true }, (socket) => {
    adminSockets.add(socket);
    logger.info({ connectedAdmins: adminSockets.size }, "admin dashboard client connected");

    socket.on("close", () => {
      adminSockets.delete(socket);
      logger.info({ connectedAdmins: adminSockets.size }, "admin dashboard client disconnected");
    });
  });
}
