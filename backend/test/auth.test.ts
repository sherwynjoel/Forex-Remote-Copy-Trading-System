import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { prisma } from "../src/db/client.js";
import { createAdmin, login, verifyAdminToken } from "../src/modules/auth/auth.service.js";

describe("auth.service", () => {
  const createdAdminIds: string[] = [];

  afterAll(async () => {
    await prisma.admin.deleteMany({ where: { id: { in: createdAdminIds } } });
    await prisma.$disconnect();
  });

  async function makeTestAdmin(password = "correct-password") {
    const admin = await createAdmin(`auth-test-${randomUUID()}`, password);
    createdAdminIds.push(admin.id);
    return admin;
  }

  it("issues a verifiable JWT for correct credentials", async () => {
    const admin = await makeTestAdmin("correct-password");

    const token = await login(admin.username, "correct-password");
    expect(token).not.toBeNull();

    const payload = verifyAdminToken(token as string);
    expect(payload?.adminId).toBe(admin.id);
    expect(payload?.username).toBe(admin.username);
  });

  it("rejects an incorrect password", async () => {
    const admin = await makeTestAdmin("correct-password");
    const token = await login(admin.username, "wrong-password");
    expect(token).toBeNull();
  });

  it("rejects a username that doesn't exist", async () => {
    const token = await login(`nonexistent-${randomUUID()}`, "anything");
    expect(token).toBeNull();
  });

  it("never stores the plaintext password", async () => {
    const admin = await makeTestAdmin("correct-password");
    expect(admin.passwordHash).not.toBe("correct-password");
    expect(admin.passwordHash.length).toBeGreaterThan(20); // bcrypt hashes are ~60 chars
  });

  it("rejects a malformed/garbage token", () => {
    expect(verifyAdminToken("not-a-real-token")).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    // Simulates a forged token — jwt.sign with the wrong key should never verify.
    const forged = jwt.sign({ adminId: "x", username: "y" }, "wrong-secret");
    expect(verifyAdminToken(forged)).toBeNull();
  });
});
