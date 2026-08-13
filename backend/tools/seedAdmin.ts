/**
 * Bootstraps the Super Admin from ADMIN_USERNAME/ADMIN_PASSWORD, and
 * nothing else — no dev Master/Slave fixtures. This is the production-safe
 * script (see docs/DEPLOYMENT.md); tools/seed.ts is the local-dev version
 * that also creates DEV-MASTER-001/DEV-SLAVE-00N and calls this function
 * for the admin part, so the two never drift apart.
 */
import { fileURLToPath } from "node:url";
import { prisma } from "../src/db/client.js";
import { env } from "../src/config/env.js";
import { createAdmin } from "../src/modules/auth/auth.service.js";

export async function ensureAdmin(): Promise<void> {
  const existingAdmin = await prisma.admin.findUnique({ where: { username: env.ADMIN_USERNAME } });
  if (!existingAdmin) {
    await createAdmin(env.ADMIN_USERNAME, env.ADMIN_PASSWORD);
    console.log(`Created admin "${env.ADMIN_USERNAME}" (password from ADMIN_PASSWORD env var)`);
  } else {
    console.log(`Reusing existing admin "${env.ADMIN_USERNAME}"`);
  }
}

// Only run as a standalone script (not when imported by tools/seed.ts) —
// the standard ESM "was this module the entry point" check, robust to
// running under tsx (.ts) or the compiled production build (.js) alike.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureAdmin()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
