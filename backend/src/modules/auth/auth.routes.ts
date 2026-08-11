import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { login } from "./auth.service.js";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ status: "INVALID_PAYLOAD", errors: parsed.error.flatten() });
    }

    const token = await login(parsed.data.username, parsed.data.password);
    if (!token) {
      return reply.code(401).send({ status: "INVALID_CREDENTIALS" });
    }

    return reply.send({ token });
  });
}
