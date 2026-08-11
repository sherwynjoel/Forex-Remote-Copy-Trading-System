import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../../db/client.js";
import { env } from "../../config/env.js";

const BCRYPT_ROUNDS = 12;

export interface AdminTokenPayload {
  adminId: string;
  username: string;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function createAdmin(username: string, password: string) {
  return prisma.admin.create({ data: { username, passwordHash: await hashPassword(password) } });
}

/** Returns a signed JWT on success, or null on a bad username/password. */
export async function login(username: string, password: string): Promise<string | null> {
  const admin = await prisma.admin.findUnique({ where: { username } });
  if (!admin) return null;

  const valid = await bcrypt.compare(password, admin.passwordHash);
  if (!valid) return null;

  const payload: AdminTokenPayload = { adminId: admin.id, username: admin.username };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
}

/** Returns the decoded payload, or null if the token is missing/invalid/expired. */
export function verifyAdminToken(token: string): AdminTokenPayload | null {
  try {
    return jwt.verify(token, env.JWT_SECRET) as AdminTokenPayload;
  } catch {
    return null;
  }
}
