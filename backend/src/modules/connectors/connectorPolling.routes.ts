import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { authenticateConnector, recordHeartbeat } from "./connector.service.js";
import { resolveSlaveSymbol } from "../slaves/symbolMapping.service.js";
import { findExecutedOpenSlaveTicket } from "../copy-engine/copyOrderQueries.js";
import { handleSlaveMessage, broadcastCopyOrder } from "../copy-engine/copyEngine.js";
import { executionResultSchema, type CopyAction, type CopyInstruction } from "../../types/copyOrder.js";
import { logger } from "../../config/logger.js";

/**
 * HTTP-polling transport for Slave connectors that can't hold a persistent
 * push connection — MQL4 has no equivalent to MetaTrader5's Python IPC
 * package (see connectors/master-ea-mt4/README.md). Mirrors /ws/slave's
 * contract exactly: same CopyInstruction shape out, same
 * executionResultSchema shape back in, same connector-token auth. An MT5
 * Slave never touches these routes; an MT4 Slave never touches /ws/slave —
 * copyEngine.ts's copyToSlave() picks the transport per-Slave by platform.
 */
export async function connectorPollingRoutes(app: FastifyInstance) {
  // Polled by the MT4 Slave EA on a short timer (default 500ms). Drains
  // copy_orders the same way /ws/slave's push does — oldest PENDING row
  // for this Slave, marked SENT the moment it's handed over — except the
  // instruction is rebuilt from the row + its trade_event here rather than
  // carried in memory from dispatch time, since dispatch and pickup are
  // now two separate, arbitrarily-spaced requests.
  app.get("/api/connectors/pending-instruction", async (request, reply) => {
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    if (!token) return reply.code(401).send({ status: "UNAUTHORIZED" });

    const auth = await authenticateConnector(token);
    if (!auth || auth.ownerType !== "SLAVE" || !auth.slaveId) {
      return reply.code(401).send({ status: "UNAUTHORIZED" });
    }
    const slaveId = auth.slaveId;

    // A poll is itself a liveness signal — refresh the heartbeat clock
    // without waiting for the Slave EA's separate, slower heartbeat call.
    void recordHeartbeat(auth.connectorId);

    const copyOrder = await prisma.copyOrder.findFirst({
      where: { slaveId, status: "PENDING" },
      orderBy: { createdAt: "asc" },
      include: { tradeEvent: { select: { symbol: true, side: true, sl: true, tp: true } } },
    });
    if (!copyOrder) return reply.code(204).send();

    let slaveTicket: string | undefined;
    if (copyOrder.type === "CLOSE" || copyOrder.type === "MODIFY") {
      const ticket = await findExecutedOpenSlaveTicket(slaveId, copyOrder.masterTicket);
      if (!ticket) {
        // Shouldn't happen — copyToSlave() already checked this before
        // ever creating the row — but guard anyway rather than delivering
        // a CLOSE/MODIFY with nothing to act on.
        await prisma.copyOrder.update({
          where: { id: copyOrder.id },
          data: { status: "FAILED", errorReason: "NO_MATCHING_OPEN_COPY" },
        });
        broadcastCopyOrder({
          copyId: copyOrder.id,
          masterId: copyOrder.masterId,
          slaveId,
          masterTicket: copyOrder.masterTicket,
          type: copyOrder.type,
          status: "FAILED",
          symbol: copyOrder.tradeEvent.symbol,
          side: copyOrder.tradeEvent.side ?? undefined,
          errorReason: "NO_MATCHING_OPEN_COPY",
        });
        return reply.code(204).send();
      }
      slaveTicket = ticket;
    }

    const resolvedSymbol = await resolveSlaveSymbol(slaveId, copyOrder.tradeEvent.symbol);
    const volume = copyOrder.requestedVolume ? Number(copyOrder.requestedVolume) : undefined;

    const instruction: CopyInstruction = {
      copyId: copyOrder.id,
      action: copyOrder.type as CopyAction,
      symbol: resolvedSymbol,
      side: copyOrder.tradeEvent.side ?? undefined,
      volume,
      sl: copyOrder.tradeEvent.sl ? Number(copyOrder.tradeEvent.sl) : undefined,
      tp: copyOrder.tradeEvent.tp ? Number(copyOrder.tradeEvent.tp) : undefined,
      slaveTicket,
    };

    await prisma.copyOrder.update({ where: { id: copyOrder.id }, data: { status: "SENT", sentAt: new Date() } });
    broadcastCopyOrder({
      copyId: copyOrder.id,
      masterId: copyOrder.masterId,
      slaveId,
      masterTicket: copyOrder.masterTicket,
      type: copyOrder.type,
      status: "SENT",
      symbol: copyOrder.tradeEvent.symbol,
      side: copyOrder.tradeEvent.side ?? undefined,
      volume,
      slaveTicket,
    });

    return reply.code(200).send(instruction);
  });

  // Posted by the MT4 Slave EA after executing (or failing to execute) an
  // instruction it received above. Same payload shape /ws/slave expects,
  // same handling — handleSlaveMessage() doesn't know or care which
  // transport a result arrived over.
  app.post("/api/connectors/execution-result", async (request, reply) => {
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    if (!token) return reply.code(401).send({ status: "UNAUTHORIZED" });

    const auth = await authenticateConnector(token);
    if (!auth || auth.ownerType !== "SLAVE" || !auth.slaveId) {
      return reply.code(401).send({ status: "UNAUTHORIZED" });
    }

    const parsed = executionResultSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ status: "INVALID_PAYLOAD", errors: parsed.error.flatten() });
    }

    void recordHeartbeat(auth.connectorId);
    await handleSlaveMessage(auth.slaveId, parsed.data).catch((err) =>
      logger.error({ err, slaveId: auth.slaveId }, "failed to process polled execution result"),
    );

    return reply.code(200).send({ status: "OK" });
  });
}
