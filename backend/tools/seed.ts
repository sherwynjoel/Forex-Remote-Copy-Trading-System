/**
 * Creates a development Master + two Slaves, each with a registered
 * connector, and writes their bearer tokens to .dev-connector-token /
 * .dev-slave-connector-token / .dev-slave-2-connector-token so the
 * simulator tools (and later, the real EA/Python service) can use them.
 * Two Slaves so `simulate:slave` can be run twice concurrently to prove
 * Phase 3's multi-slave fan-out by hand. Safe to re-run: reuses existing
 * DEV-MASTER-001 / DEV-SLAVE-00N records instead of creating duplicates.
 */
import { writeFile } from "node:fs/promises";
import { prisma } from "../src/db/client.js";
import { redis, redisSub } from "../src/config/redis.js";
import { registerConnector } from "../src/modules/connectors/connector.service.js";

const DEV_MASTER_ACCOUNT_NUMBER = "DEV-MASTER-001";
const MASTER_TOKEN_FILE = ".dev-connector-token";

const DEV_SLAVES = [
  { accountNumber: "DEV-SLAVE-001", name: "Dev Slave 1", tokenFile: ".dev-slave-connector-token" },
  { accountNumber: "DEV-SLAVE-002", name: "Dev Slave 2", tokenFile: ".dev-slave-2-connector-token" },
];

async function main() {
  let master = await prisma.master.findUnique({ where: { accountNumber: DEV_MASTER_ACCOUNT_NUMBER } });

  if (!master) {
    master = await prisma.master.create({
      data: {
        name: "Dev Master",
        accountNumber: DEV_MASTER_ACCOUNT_NUMBER,
        broker: "Demo Broker",
        platform: "MT5",
        server: "Demo-Server",
      },
    });
    console.log(`Created master ${master.id} (${master.accountNumber})`);
  } else {
    console.log(`Reusing existing master ${master.id} (${master.accountNumber})`);
  }

  const { connectorId: masterConnectorId, token: masterToken } = await registerConnector(
    { masterId: master.id },
    "dev-seed",
  );
  await writeFile(MASTER_TOKEN_FILE, masterToken, "utf-8");
  console.log(`Registered master connector ${masterConnectorId}, token written to ${MASTER_TOKEN_FILE}`);

  for (const dev of DEV_SLAVES) {
    let slave = await prisma.slave.findUnique({ where: { accountNumber: dev.accountNumber } });

    if (!slave) {
      slave = await prisma.slave.create({
        data: {
          masterId: master.id,
          name: dev.name,
          accountNumber: dev.accountNumber,
          broker: "Demo Broker",
          platform: "MT5",
          server: "Demo-Server",
        },
      });
      console.log(`Created slave ${slave.id} (${slave.accountNumber}), assigned to master ${master.id}`);
    } else {
      console.log(`Reusing existing slave ${slave.id} (${slave.accountNumber})`);
    }

    const { connectorId: slaveConnectorId, token: slaveToken } = await registerConnector(
      { slaveId: slave.id },
      "dev-seed",
    );
    await writeFile(dev.tokenFile, slaveToken, "utf-8");
    console.log(`Registered slave connector ${slaveConnectorId}, token written to ${dev.tokenFile}`);
    console.log(`  slaveId=${slave.id}`);
  }

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
