/**
 * Creates a development Master + Slave, each with a registered connector,
 * and writes their bearer tokens to .dev-connector-token /
 * .dev-slave-connector-token so the simulator tools (and later, the real
 * EA/Python service) can use them. Safe to re-run: reuses the existing
 * DEV-MASTER-001 / DEV-SLAVE-001 records instead of creating duplicates.
 */
import { writeFile } from "node:fs/promises";
import { prisma } from "../src/db/client.js";
import { redis, redisSub } from "../src/config/redis.js";
import { registerConnector } from "../src/modules/connectors/connector.service.js";

const DEV_MASTER_ACCOUNT_NUMBER = "DEV-MASTER-001";
const DEV_SLAVE_ACCOUNT_NUMBER = "DEV-SLAVE-001";
const MASTER_TOKEN_FILE = ".dev-connector-token";
const SLAVE_TOKEN_FILE = ".dev-slave-connector-token";

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

  let slave = await prisma.slave.findUnique({ where: { accountNumber: DEV_SLAVE_ACCOUNT_NUMBER } });

  if (!slave) {
    slave = await prisma.slave.create({
      data: {
        masterId: master.id,
        name: "Dev Slave",
        accountNumber: DEV_SLAVE_ACCOUNT_NUMBER,
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
  await writeFile(SLAVE_TOKEN_FILE, slaveToken, "utf-8");
  console.log(`Registered slave connector ${slaveConnectorId}, token written to ${SLAVE_TOKEN_FILE}`);

  console.log(`\nmasterId=${master.id}`);
  console.log(`slaveId=${slave.id}`);
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
