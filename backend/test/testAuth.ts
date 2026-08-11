import { randomUUID } from "node:crypto";
import { prisma } from "../src/db/client.js";
import { createAdmin, login } from "../src/modules/auth/auth.service.js";

/** Creates a throwaway admin and returns a valid JWT for hitting protected routes in tests. */
export async function getTestAdminToken(): Promise<{ token: string; adminId: string }> {
  const username = `test-admin-${randomUUID()}`;
  const password = "test-password";
  const admin = await createAdmin(username, password);
  const token = await login(username, password);
  if (!token) throw new Error("failed to log in the freshly-created test admin");
  return { token, adminId: admin.id };
}

export async function deleteTestAdmin(adminId: string): Promise<void> {
  await prisma.admin.delete({ where: { id: adminId } });
}
