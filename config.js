// config.js
import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000),

  OPENAI_API_KEY: z.string().min(10),

  REDIS_URL: z.union([z.string().min(8), z.literal("")]).default(""),

  REDIS_ENABLED: z
    .union([z.literal("true"), z.literal("false"), z.literal("")])
    .optional()
    .default(""),

  CORS_ORIGINS: z.string().optional().default("")
});

const env = schema.parse(process.env);

const isProd = env.NODE_ENV === "production";

function parseOrigins(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  openaiKey: env.OPENAI_API_KEY,

  redisUrl: env.REDIS_URL,
  redisEnabled: env.REDIS_ENABLED, // "true" | "false" | ""
  corsOrigins: parseOrigins(env.CORS_ORIGINS),
  isProd
};