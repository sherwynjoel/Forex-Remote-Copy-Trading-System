/**
 * Creates a development Master + Connector and writes the connector's bearer
 * token to .dev-connector-token so tools/simulate-master-event.ts (and later,
 * a real EA's input parameters) can use it. Safe to re-run: reuses an
 * existing DEV-MASTER-001 master instead of creating duplicates.
 */
import { writeFile } from "node:fs/promises";
import { prisma } from "../src/db/client.js";
import { redis, redisSub } from "../src/config/redis.js";
import { registerConnector } from "../src/modules/connectors/connector.service.js";

const DEV_ACCOUNT_NUMBER = "DEV-MASTER-001";
const TOKEN_FILE = ".dev-connector-token";

async function main() {
  let master = await prisma.master.findUnique({ where: { accountNumber: DEV_ACCOUNT_NUMBER } });

  if (!master) {
    master = await prisma.master.create({
      data: {
        name: "Dev Master",
        accountNumber: DEV_ACCOUNT_NUMBER,
        broker: "Demo Broker",
        platform: "MT5",
        server: "Demo-Server",
      },
    });
    console.log(`Created master ${master.id} (${master.accountNumber})`);
  } else {
    console.log(`Reusing existing master ${master.id} (${master.accountNumber})`);
  }

  const { connectorId, token } = await registerConnector(master.id, "dev-seed");
  await writeFile(TOKEN_FILE, token, "utf-8");

  console.log(`Registered connector ${connectorId}`);
  console.log(`Token written to ${TOKEN_FILE}`);
  console.log(`\nmasterId=${master.id}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    redis.disconnect();
    redisSub.disconnect();
  });
