import { prisma } from "../../db/client.js";

/**
 * Resolves the symbol this Slave's broker actually uses for a given Master
 * symbol (spec section 14, e.g. XAUUSD -> XAUUSDm). Falls back to the
 * Master's symbol unchanged when no mapping is configured — the default
 * behavior before this module existed, preserved so unmapped Slaves keep
 * working exactly as before.
 */
export async function resolveSlaveSymbol(slaveId: string, masterSymbol: string): Promise<string> {
  const mapping = await prisma.symbolMapping.findUnique({
    where: { slaveId_masterSymbol: { slaveId, masterSymbol } },
  });
  return mapping?.slaveSymbol ?? masterSymbol;
}

export async function upsertSymbolMapping(slaveId: string, masterSymbol: string, slaveSymbol: string) {
  return prisma.symbolMapping.upsert({
    where: { slaveId_masterSymbol: { slaveId, masterSymbol } },
    create: { slaveId, masterSymbol, slaveSymbol },
    update: { slaveSymbol },
  });
}

export async function listSymbolMappings(slaveId: string) {
  return prisma.symbolMapping.findMany({ where: { slaveId }, orderBy: { masterSymbol: "asc" } });
}

export async function deleteSymbolMapping(slaveId: string, mappingId: string): Promise<boolean> {
  const result = await prisma.symbolMapping.deleteMany({ where: { id: mappingId, slaveId } });
  return result.count > 0;
}
