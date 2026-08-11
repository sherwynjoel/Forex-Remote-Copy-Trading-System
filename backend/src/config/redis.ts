import Redis from "ioredis";
import { env } from "./env.js";

// Two connections: one for normal commands, one dedicated to pub/sub
// subscriptions (ioredis requires a subscriber connection to be exclusive).
export const redis = new Redis(env.REDIS_URL);
export const redisSub = new Redis(env.REDIS_URL);
