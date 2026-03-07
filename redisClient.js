// redisClient.js
import Redis from "ioredis";
import { config } from "./config.js";

/**
 * In-memory Redis-like fallback for dev when Redis is disabled or unavailable.
 * Supports: ping, get, set (with EX or PX), del, expire
 */
function createMemoryRedis() {
  const map = new Map(); // key -> { value: string, expiresAtMs: number | null }

  const now = () => Date.now();
  const expired = (entry) => entry?.expiresAtMs && entry.expiresAtMs <= now();

  return {
    isMemory: true,

    async ping() {
      return "PONG";
    },

    async get(key) {
      const entry = map.get(key);
      if (!entry) return null;
      if (expired(entry)) {
        map.delete(key);
        return null;
      }
      return entry.value;
    },

    // Accepts common Redis set shapes:
    // set(key, value)
    // set(key, value, "EX", seconds)
    // set(key, value, "PX", ms)
    async set(key, value, mode, ttl) {
      let expiresAtMs = null;

      if (typeof mode === "undefined") {
        map.set(key, { value: String(value), expiresAtMs });
        return "OK";
      }

      const m = String(mode).toUpperCase();

      if (m === "EX" && Number.isFinite(Number(ttl))) {
        expiresAtMs = now() + Number(ttl) * 1000;
        map.set(key, { value: String(value), expiresAtMs });
        return "OK";
      }

      if (m === "PX" && Number.isFinite(Number(ttl))) {
        expiresAtMs = now() + Number(ttl);
        map.set(key, { value: String(value), expiresAtMs });
        return "OK";
      }

      map.set(key, { value: String(value), expiresAtMs: null });
      return "OK";
    },

    async del(key) {
      map.delete(key);
      return 1;
    },

    async expire(key, ttlSeconds) {
      const entry = map.get(key);
      if (!entry) return 0;
      entry.expiresAtMs = now() + Number(ttlSeconds) * 1000;
      map.set(key, entry);
      return 1;
    }
  };
}

function isProd() {
  return String(config.nodeEnv || "").toLowerCase() === "production";
}

function isRedisEnabled() {
  const flag = String(config.redisEnabled || "").toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  return isProd();
}

function createRedisClient(url) {
  const client = new Redis(url, {
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      const base = Math.min(2000, 50 * Math.pow(2, Math.min(times, 6)));
      const jitter = Math.floor(Math.random() * 100);
      return base + jitter;
    }
  });

  let lastState = "init";
  let lastErrMsg = "";

  const logState = (state, extra) => {
    if (state === lastState && !extra) return;
    lastState = state;
    const suffix = extra ? ` ${extra}` : "";
    console.log(`redisClient: ${state}${suffix}`);
  };

  client.on("connecting", () => logState("connecting"));
  client.on("ready", () => logState("ready"));
  client.on("close", () => logState("closed"));
  client.on("reconnecting", () => logState("reconnecting"));

  client.on("error", (err) => {
    const msg = err?.message || String(err);
    if (msg !== lastErrMsg) {
      lastErrMsg = msg;
      console.error(`redisClient: error ${msg}`);
    }
  });

  return client;
}

/* =========================================================
   Internal State
========================================================= */

let redisClient = null; // real redis OR memory fallback
let redisMode = "none"; // "redis" | "memory" | "disabled" | "none"
let lastRedisError = null;

// convenience export for legacy imports
export let redis = null;

// SINGLETON memory fallback
let memoryFallback = null;
function getMemoryFallback() {
  if (!memoryFallback) {
    memoryFallback = createMemoryRedis();
  }
  return memoryFallback;
}

/* =========================================================
   Initialization
========================================================= */

export async function initRedis() {
  const enabled = isRedisEnabled();
  const url = config.redisUrl;

  if (!enabled) {
    redisMode = "disabled";
    console.log("redisClient: disabled by config, using memory store");
    redisClient = getMemoryFallback();
    redis = redisClient;
    return redisClient;
  }

  if (!url) {
    redisMode = "memory";
    console.log("redisClient: redisUrl missing, using memory store");
    redisClient = getMemoryFallback();
    redis = redisClient;
    return redisClient;
  }

  const client = createRedisClient(url);

  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Redis connect timeout")), 1500)
      )
    ]);

    await Promise.race([
      client.ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Redis ping timeout")), 1000)
      )
    ]);

    redisMode = "redis";
    redisClient = client;
    redis = redisClient;

    console.log("redisClient: connected and healthy");
    return redisClient;
  } catch (err) {
    lastRedisError = err;

    if (isProd()) {
      console.error("redisClient: failed to connect in production");
      throw err;
    }

    console.warn(
      `redisClient: failed to connect in dev, falling back to memory: ${
        err?.message || err
      }`
    );

    try {
      client.disconnect();
    } catch {}

    redisMode = "memory";
    redisClient = getMemoryFallback();
    redis = redisClient;

    return redisClient;
  }
}

/* =========================================================
   Accessors
========================================================= */

export function getRedis() {
  if (!redisClient) {
    if (!isProd()) {
      redisMode = redisMode === "none" ? "memory" : redisMode;
      redisClient = getMemoryFallback();
      redis = redisClient;
      return redisClient;
    }

    throw new Error("Redis not initialized. Call initRedis() during server startup.");
  }

  return redisClient;
}

export function getRedisStatus() {
  const isMemory = Boolean(redisClient?.isMemory);

  const status =
    redisMode === "redis"
      ? "up"
      : redisMode === "disabled"
        ? "disabled"
        : redisMode === "memory"
          ? "degraded"
          : "unknown";

  return {
    status,
    mode: redisMode,
    isMemory,
    urlConfigured: Boolean(config.redisUrl),
    lastError: lastRedisError
      ? lastRedisError.message || String(lastRedisError)
      : null
  };
}

export async function closeRedis() {
  if (!redisClient || redisClient?.isMemory) return;

  try {
    await redisClient.quit();
  } catch {
    try {
      redisClient.disconnect();
    } catch {}
  }
}