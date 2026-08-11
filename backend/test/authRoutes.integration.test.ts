import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { redis, redisSub } from "../src/config/redis.js";
import { createAdmin } from "../src/modules/auth/auth.service.js";

describe("POST /api/auth/login", () => {
  let app: ReturnType<typeof buildApp>;
  let username: string;
  let adminId: string;
  const password = "correct-password";

  beforeAll(async () => {
    app = buildApp();
    await app.ready();

    username = `login-route-test-${randomUUID()}`;
    const admin = await createAdmin(username, password);
    adminId = admin.id;
  });

  afterAll(async () => {
    await prisma.admin.delete({ where: { id: adminId } });
    await app.close();
    redisSub.disconnect();
    redis.disconnect();
    await prisma.$disconnect();
  });

  it("returns a token for correct credentials", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username, password },
    });
    expect(response.statusCode).toBe(200);
    expect(typeof response.json().token).toBe("string");
  });

  it("rejects an incorrect password with 401", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username, password: "wrong" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a missing password with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username },
    });
    expect(response.statusCode).toBe(400);
  });

  it("the returned token actually unlocks a protected route", async () => {
    const loginResponse = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username, password },
    });
    const { token } = loginResponse.json();

    const protectedResponse = await app.inject({
      method: "GET",
      url: "/api/masters",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(protectedResponse.statusCode).toBe(200);
  });
});
