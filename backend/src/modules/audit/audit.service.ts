import { prisma } from "../../db/client.js";

export async function writeAudit(params: {
  actor: string;
  action: string;
  entity: string;
  oldValue?: unknown;
  newValue?: unknown;
  ip?: string;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actor: params.actor,
      action: params.action,
      entity: params.entity,
      oldValue: params.oldValue === undefined ? undefined : (params.oldValue as object),
      newValue: params.newValue === undefined ? undefined : (params.newValue as object),
      ip: params.ip,
    },
  });
}
