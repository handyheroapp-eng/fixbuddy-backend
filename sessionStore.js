// sessionStore.js
import { getRedis } from "./redisClient.js";

/*
  FixBuddy Redis Session Store

  Keys:
    fx:session:{sessionId}
    fx:chat:{sessionId}
    fx:idem:{sessionId}:{actionId}
*/

const SESSION_TTL_SECONDS = 24 * 60 * 60;       // 24 hours
const CHAT_TTL_SECONDS = 24 * 60 * 60;          // 24 hours
const IDEMPOTENCY_TTL_SECONDS = 20 * 60;        // 20 minutes

const PREFIX = "fx";

const kSession = (id) => `${PREFIX}:session:${id}`;
const kChat = (id) => `${PREFIX}:chat:${id}`;
const kIdem = (sessionId, actionId) =>
  `${PREFIX}:idem:${sessionId}:${actionId}`;

/* =========================================================
   Helpers
========================================================= */

function normalizeId(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length ? s : null;
}

function safeJsonParse(text, fallback) {
  if (!text || typeof text !== "string") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return JSON.stringify({ error: "serialization_failed" });
  }
}

function normalizeTTL(value, fallback, minSeconds = 60) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(minSeconds, Math.floor(n));
}

function r() {
  return getRedis(); // real Redis or memory fallback
}

/* =========================================================
   Session Store
========================================================= */

export const sessionStore = {
  ttlSeconds: SESSION_TTL_SECONDS,

  /* =========================
     SESSION
  ========================= */

  async getSession(sessionId) {
    const id = normalizeId(sessionId);
    if (!id) return null;

    const raw = await r().get(kSession(id));
    if (!raw) return null;

    const parsed = safeJsonParse(raw, null);
    if (!parsed) return null;

    // Refresh TTL on read
    await r().expire(kSession(id), SESSION_TTL_SECONDS);

    return parsed;
  },

  async setSession(session, ttlSeconds = SESSION_TTL_SECONDS) {
    const id = normalizeId(session?.sessionId);
    if (!id) throw new Error("setSession missing sessionId");

    const ttl = normalizeTTL(ttlSeconds, SESSION_TTL_SECONDS);

    await r().set(kSession(id), safeJsonStringify(session), "EX", ttl);

    return session;
  },

  async touchSession(sessionId, ttlSeconds = SESSION_TTL_SECONDS) {
    const id = normalizeId(sessionId);
    if (!id) return false;

    const ttl = normalizeTTL(ttlSeconds, SESSION_TTL_SECONDS);
    const result = await r().expire(kSession(id), ttl);

    return result === 1;
  },

  async deleteSession(sessionId) {
    const id = normalizeId(sessionId);
    if (!id) return 0;

    await r().del(kChat(id)); // also clean chat
    return r().del(kSession(id));
  },

  /* =========================
     CHAT HISTORY
  ========================= */

  async getChatHistory(sessionId) {
    const id = normalizeId(sessionId);
    if (!id) return [];

    const raw = await r().get(kChat(id));
    if (!raw) return [];

    const parsed = safeJsonParse(raw, []);
    const history = Array.isArray(parsed) ? parsed : [];

    // Keep chat aligned with session TTL
    await r().expire(kChat(id), CHAT_TTL_SECONDS);

    return history;
  },

  async setChatHistory(sessionId, history, ttlSeconds = CHAT_TTL_SECONDS) {
    const id = normalizeId(sessionId);
    if (!id) throw new Error("setChatHistory missing sessionId");

    const ttl = normalizeTTL(ttlSeconds, CHAT_TTL_SECONDS);

    const safe = Array.isArray(history) ? history : [];

    await r().set(kChat(id), safeJsonStringify(safe), "EX", ttl);

    return safe;
  },

  async deleteChatHistory(sessionId) {
    const id = normalizeId(sessionId);
    if (!id) return 0;

    return r().del(kChat(id));
  },

  /* =========================
     IDEMPOTENCY
  ========================= */

  async getIdempotency(sessionId, actionId) {
    const sid = normalizeId(sessionId);
    const aid = normalizeId(actionId);
    if (!sid || !aid) return null;

    const raw = await r().get(kIdem(sid, aid));
    if (!raw) return null;

    return safeJsonParse(raw, null);
  },

  async setIdempotency(
    sessionId,
    actionId,
    payload,
    ttlSeconds = IDEMPOTENCY_TTL_SECONDS
  ) {
    const sid = normalizeId(sessionId);
    const aid = normalizeId(actionId);
    if (!sid || !aid) return;

    const ttl = normalizeTTL(ttlSeconds, IDEMPOTENCY_TTL_SECONDS, 10);

    await r().set(
      kIdem(sid, aid),
      safeJsonStringify(payload),
      "EX",
      ttl
    );
  },

  async deleteIdempotency(sessionId, actionId) {
    const sid = normalizeId(sessionId);
    const aid = normalizeId(actionId);
    if (!sid || !aid) return 0;

    return r().del(kIdem(sid, aid));
  }
};