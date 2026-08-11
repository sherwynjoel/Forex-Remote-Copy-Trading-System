import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyAdminToken } from "./auth.service.js";

/**
 * Fastify preHandler protecting the admin API/dashboard. Same
 * `Authorization: Bearer <token>` header shape connectors already use for
 * ordinary HTTP calls — no new cookie-parsing plugin needed. Applied to a
 * whole route group at once in app.ts (see the nested scope there) rather
 * than added to every individual route, so no existing route file needed
 * to change.
 *
 * Also accepts `?token=` as a fallback: the browser WebSocket API (unlike
 * Node's `ws` client the Slave connector uses) cannot set custom headers
 * on the handshake request, so /ws/admin — the one WS route in this same
 * protected scope — has no other way to authenticate.
 */
export async function requireAdminAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;
  const headerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  const queryToken = (request.query as Record<string, unknown> | undefined)?.token;
  const token = headerToken ?? (typeof queryToken === "string" ? queryToken : undefined);

  const payload = token ? verifyAdminToken(token) : null;
  if (!payload) {
    return reply.code(401).send({ status: "UNAUTHORIZED" });
  }
}
