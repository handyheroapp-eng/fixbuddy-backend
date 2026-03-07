import cors from "cors";
import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";

import { config } from "./config.js";
import { initRedis, getRedis, getRedisStatus, closeRedis } from "./redisClient.js";
import { sessionStore } from "./sessionStore.js";

const app = express();
const PORT = config.port;

app.use(express.json({ limit: "1mb" }));

const corsOptions =
  config.corsOrigins.length > 0
    ? { origin: config.corsOrigins, credentials: true }
    : config.isProd
      ? { origin: false }
      : { origin: true, credentials: true };

app.use(cors(corsOptions));

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  res.setTimeout(30000);
  next();
});

const client = new OpenAI({
  apiKey: config.openaiKey,
  timeout: 30000
});

console.log("Loaded server.js with Redis session store");
console.log("OpenAI key loaded:", !!config.openaiKey);
console.log("Env:", config.nodeEnv);

process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

/* =========================================================
   Value tracking stores (in memory)
========================================================= */

const userValueStore = new Map();
const jobValueStore = new Map();

function clampNumber(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function normalizeConfidence(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n > 0 && n <= 1) return Math.round(n * 100);
  return clampNumber(n, 0, 100);
}

function money(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
}

function minutes(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x) : 0;
}

const BASELINE = {
  serviceCall: {
    default: 150,
    refrigerator: 160,
    dishwasher: 150,
    washer: 150,
    dryer: 140,
    oven: 160,
    microwave: 140,
    hvac: 200
  },
  laborHourly: { default: 125 },
  replacement: {
    default: 1000,
    refrigerator: 1600,
    dishwasher: 800,
    washer: 900,
    dryer: 850,
    oven: 1200,
    microwave: 350,
    hvac: 6500
  },
  typicalLaborHours: {
    default: 1.0,
    refrigerator: 1.0,
    dishwasher: 1.2,
    washer: 1.2,
    dryer: 1.0,
    oven: 1.3,
    microwave: 0.8,
    hvac: 2.0
  },
  typicalTimeSavedMinutes: {
    default: 60,
    refrigerator: 75,
    dishwasher: 70,
    washer: 75,
    dryer: 60,
    oven: 80,
    microwave: 45,
    hvac: 120
  }
};

function normalizeApplianceType(type) {
  if (!type) return "default";
  const t = String(type).trim().toLowerCase();
  const map = {
    fridge: "refrigerator",
    refrigerator: "refrigerator",
    dish: "dishwasher",
    dishwasher: "dishwasher",
    washer: "washer",
    washingmachine: "washer",
    dryer: "dryer",
    oven: "oven",
    range: "oven",
    microwave: "microwave",
    hvac: "hvac",
    ac: "hvac"
  };
  return map[t] || t || "default";
}

function estimateCosts({ applianceType, laborHoursOverride }) {
  const a = normalizeApplianceType(applianceType);

  const serviceCall = BASELINE.serviceCall[a] ?? BASELINE.serviceCall.default;
  const laborHourly = BASELINE.laborHourly.default;

  const laborHours = Number.isFinite(Number(laborHoursOverride))
    ? clampNumber(laborHoursOverride, 0, 10)
    : (BASELINE.typicalLaborHours[a] ?? BASELINE.typicalLaborHours.default);

  const laborCost = money(laborHourly * laborHours);
  const replacementCost = BASELINE.replacement[a] ?? BASELINE.replacement.default;

  const timeSaved = BASELINE.typicalTimeSavedMinutes[a] ?? BASELINE.typicalTimeSavedMinutes.default;

  return {
    applianceType: a,
    estimatedServiceCallCost: money(serviceCall),
    estimatedLaborCost: money(laborCost),
    estimatedReplacementCost: money(replacementCost),
    estimatedTimeSavedMinutes: minutes(timeSaved)
  };
}

function calculateSavings({ estimatedServiceCallCost, estimatedLaborCost, actualPartCost, actualToolCost }) {
  const serviceCall = money(estimatedServiceCallCost);
  const labor = money(estimatedLaborCost);
  const part = money(actualPartCost);
  const tool = money(actualToolCost);

  const totalAvoidedCost = money(serviceCall + labor);
  const outOfPocket = money(part + tool);
  const netSavings = money(totalAvoidedCost - outOfPocket);

  const roiPercentage = outOfPocket <= 0 ? null : Math.round((netSavings / outOfPocket) * 100);

  return { totalAvoidedCost, outOfPocket, netSavings, roiPercentage };
}

function getOrCreateUserValue(userId) {
  if (!userValueStore.has(userId)) {
    userValueStore.set(userId, {
      userId,
      totals: {
        totalJobsCompleted: 0,
        totalNetSavings: 0,
        totalAvoidedCost: 0,
        totalOutOfPocket: 0,
        totalTimeSavedMinutes: 0
      },
      jobs: []
    });
  }
  return userValueStore.get(userId);
}

function buildValueSummaryForSession(session, opts = {}) {
  const applianceType =
    opts.applianceType || session?.appliance || session?.partLookup?.applianceType || "default";

  const laborHours = opts.laborHours;

  const costs = estimateCosts({ applianceType, laborHoursOverride: laborHours });

  const savings = calculateSavings({
    estimatedServiceCallCost: costs.estimatedServiceCallCost,
    estimatedLaborCost: costs.estimatedLaborCost,
    actualPartCost: opts.actualPartCost ?? 0,
    actualToolCost: opts.actualToolCost ?? 0
  });

  return {
    userId: session?.userId || null,
    applianceType: costs.applianceType,

    estimatedServiceCallCost: costs.estimatedServiceCallCost,
    estimatedLaborCost: costs.estimatedLaborCost,
    estimatedReplacementCost: costs.estimatedReplacementCost,
    estimatedTimeSavedMinutes: costs.estimatedTimeSavedMinutes,

    actualPartCost: money(opts.actualPartCost ?? 0),
    actualToolCost: money(opts.actualToolCost ?? 0),

    totalAvoidedCost: savings.totalAvoidedCost,
    outOfPocket: savings.outOfPocket,
    netSavings: savings.netSavings,
    roiPercentage: savings.roiPercentage
  };
}

/* =========================================================
   Small utils
========================================================= */

function arr(v) {
  return Array.isArray(v) ? v : [];
}
function str(v) {
  return typeof v === "string" ? v : "";
}
function normalizeText(v) {
  return String(v ?? "").trim();
}
function containsAny(text, words) {
  const t = normalizeText(text).toLowerCase();
  return words.some((w) => t.includes(String(w).toLowerCase()));
}
function looksLikePlaceholder(value) {
  const v = (value || "").trim().toLowerCase();
  if (!v) return false;
  if (v.includes("put_") || v.includes("placeholder") || v.includes("example")) return true;
  if (v === "n/a" || v === "na" || v === "unknown") return true;
  return false;
}
function looksLikeNoAccess(value) {
  const v = (value || "").trim().toLowerCase();
  if (!v) return false;
  return (
    v.includes("cannot") ||
    v.includes("can't") ||
    v.includes("cant") ||
    v.includes("no access") ||
    v.includes("unable") ||
    v.includes("not accessible")
  );
}
function normalizeId(value) {
  return (value || "").trim();
}

function trimHistory(history, maxMessages = 12) {
  if (history.length > maxMessages) return history.slice(history.length - maxMessages);
  return history;
}

function componentRequiresPowerOff(suspectedComponent) {
  const k = (suspectedComponent || "").toLowerCase();
  return k.includes("condenser") || k.includes("fan") || k.includes("motor") || k.includes("compressor");
}
function normalizeChoiceText(v) {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function coerceChoiceAnswer(message, choices) {
  const msg = normalizeChoiceText(message);
  if (!msg) return null;

  const list = Array.isArray(choices) ? choices : [];
  if (!list.length) return null;

  for (const c of list) {
    if (normalizeChoiceText(c) === msg) return c;
  }

  if (["y", "yes", "yeah", "yep", "true"].includes(msg)) {
    const hit = list.find((c) => normalizeChoiceText(c) === "yes");
    if (hit) return hit;
  }
  if (["n", "no", "nope", "false"].includes(msg)) {
    const hit = list.find((c) => normalizeChoiceText(c) === "no");
    if (hit) return hit;
  }
  if (["not sure", "unsure", "idk", "i dont know", "i don't know"].includes(msg)) {
    const hit = list.find((c) => normalizeChoiceText(c) === "not sure");
    if (hit) return hit;
  }

  for (const c of list) {
    const cc = normalizeChoiceText(c);
    if (cc && (msg.includes(cc) || cc.includes(msg))) return c;
  }

  return null;
}

function bindMessageToPendingQuestion(session, incomingMessage) {
  ensureDiagnosisFields(session);

  const msg = normalizeText(incomingMessage);
  if (!msg) return null;

  const q = session?.diagnosis?.currentQuestion;
  if (!q || typeof q !== "object") return null;

  const key = normalizeText(q.key);
  if (!key) return null;

  const type = normalizeText(q.type || q.input?.type || "");
  const choices = Array.isArray(q.choices) ? q.choices : Array.isArray(q.input?.choices) ? q.input.choices : [];

  if (type === "choice") {
    const coerced = coerceChoiceAnswer(msg, choices);
    return { key, value: coerced ?? msg, usedCoercion: coerced != null };
  }

  if (type === "text") {
    return { key, value: msg, usedCoercion: false };
  }

  return { key, value: msg, usedCoercion: false };
}

/* =========================================================
   Diagnosis question quality enforcement
========================================================= */

function markAsked(session, key) {
  ensureDiagnosisFields(session);
  const k = String(key || "").trim();
  if (!k) return;
  if (!Array.isArray(session.diagnosis.askedKeys)) session.diagnosis.askedKeys = [];
  if (!session.diagnosis.askedKeys.includes(k)) session.diagnosis.askedKeys.push(k);
}

function alreadyAsked(session, key) {
  ensureDiagnosisFields(session);
  const k = String(key || "").trim();
  if (!k) return false;
  const list = Array.isArray(session?.diagnosis?.askedKeys) ? session.diagnosis.askedKeys : [];
  return list.includes(k);
}

function selectHighValueFallbackQuestion(session) {
  const a = String(session.appliance || "").toLowerCase();
  const cat = String(session.issueCategory || "").toLowerCase();

  if (a === "refrigerator" && cat === "noise") {
    return {
      assistant: "When does the noise happen most: only when cooling, only after the door closes, or constantly?",
      input: { type: "choice", key: "whenHappens", choices: ["during cooling", "after door closes", "constant"] },
      questionMeta: {
        goal: "disambiguate",
        reason: "This separates fan motor noise from compressor mounts and from ice maker related noise.",
        rulesUsed: ["fridge_noise_top_causes"],
        eliminates: ["some unrelated causes"],
        narrowsTo: ["condenser fan motor", "evaporator fan motor", "compressor or mounts", "ice maker or auger"]
      }
    };
  }

  return {
    assistant: "What is the single main symptom right now, and when does it happen?",
    input: { type: "text", key: "symptomDetails", choices: [] },
    questionMeta: {
      goal: "disambiguate",
      reason: "A clear symptom and timing lets us narrow to a component and choose the next safe check.",
      rulesUsed: ["general_triage"],
      eliminates: [],
      narrowsTo: ["top_likely_components"]
    }
  };
}

function isUsefulQuestion(turn) {
  const assistant = normalizeText(turn?.assistant).toLowerCase();
  const input = turn?.input && typeof turn.input === "object" ? turn.input : null;
  const meta = turn?.questionMeta && typeof turn.questionMeta === "object" ? turn.questionMeta : {};

  if (!input) return false;

  const goalOk = typeof meta.goal === "string" && ["disambiguate", "confirm", "safety"].includes(meta.goal);
  const reasonOk = typeof meta.reason === "string" && meta.reason.trim().length >= 10;
  const narrowsOk = Array.isArray(meta.narrowsTo) && meta.narrowsTo.length >= 1;

  const bannedTopicWords = [
    "food",
    "groceries",
    "leftovers",
    "milk",
    "vegetables",
    "stocked",
    "shopping",
    "personal preference",
    "lifestyle"
  ];
  const banned = bannedTopicWords.some((w) => assistant.includes(w));

  const inputOk =
    input.type === "text" ||
    (input.type === "choice" && Array.isArray(input.choices) && input.choices.length >= 2 && input.choices.length <= 6) ||
    input.type === "none";

  return goalOk && reasonOk && narrowsOk && !banned && inputOk;
}

function normalizeTurnInput(turn) {
  const input =
    turn?.input && typeof turn.input === "object"
      ? {
          type: normalizeText(turn.input.type || "text") || "text",
          key: normalizeText(turn.input.key || "details") || "details",
          choices: Array.isArray(turn.input.choices) ? turn.input.choices : []
        }
      : { type: "text", key: "details", choices: [] };

  if (!["text", "choice", "none"].includes(input.type)) input.type = "text";
  if (!input.key && input.type !== "none") input.key = "details";
  if (input.type !== "choice") input.choices = [];
  if (input.type === "choice") {
    input.choices = (Array.isArray(input.choices) ? input.choices : [])
      .map((x) => normalizeText(x))
      .filter(Boolean)
      .slice(0, 6);
    if (input.choices.length < 2) {
      input.type = "text";
      input.choices = [];
    }
  }

  return input;
}

/* =========================================================
   Scripted diagnosis (refrigerator noise)
========================================================= */

function getScriptedNextQuestion(session) {
  const a = (session.appliance || "").toLowerCase();
  const cat = (session.issueCategory || "").toLowerCase();

  const dx = session.diagnosis || {};
  const answers = dx.answers || {};

  if (a === "refrigerator" && cat === "noise") {
    const order = [
      {
        key: "doorStopsNoise",
        prompt: "Does the noise stop when you open the fridge door?",
        type: "choice",
        choices: ["yes", "no", "not sure"]
      },
      {
        key: "location",
        prompt: "Where is the noise loudest?",
        type: "choice",
        choices: ["back bottom", "back top", "inside freezer", "inside fridge", "cannot tell"]
      },
      {
        key: "soundType",
        prompt: "Which best describes the sound?",
        type: "choice",
        choices: ["squeal", "grinding", "rattle", "humming", "clicking", "buzzing", "other"]
      },
      {
        key: "whenHappens",
        prompt: "When does it happen most?",
        type: "choice",
        choices: ["always", "intermittent", "during cooling", "after door closes", "during ice maker", "not sure"]
      },
      {
        key: "frostBuildup",
        prompt: "Do you see frost buildup on the back wall inside the freezer?",
        type: "choice",
        choices: ["yes", "no", "not sure"]
      }
    ];

    for (const q of order) {
      if (typeof answers[q.key] === "undefined") return q;
    }
    return null;
  }

  return null;
}

function scoreFridgeNoise(session) {
  const a = session.diagnosis?.answers || {};

  const scores = {
    "condenser fan motor": 0,
    "evaporator fan motor": 0,
    "compressor or mounts": 0,
    "ice maker or auger": 0,
    "defrost or airflow issue": 0,
    unknown: 10
  };

  const doorStops = String(a.doorStopsNoise || "").toLowerCase();
  const location = String(a.location || "").toLowerCase();
  const soundType = String(a.soundType || "").toLowerCase();
  const whenHappens = String(a.whenHappens || "").toLowerCase();
  const frost = String(a.frostBuildup || "").toLowerCase();

  if (doorStops === "yes") scores["evaporator fan motor"] += 45;
  if (doorStops === "no") scores["condenser fan motor"] += 10;

  if (location === "back bottom") scores["condenser fan motor"] += 45;
  if (location === "inside freezer") scores["evaporator fan motor"] += 40;
  if (location === "inside fridge") scores["evaporator fan motor"] += 20;
  if (location === "back top") scores["compressor or mounts"] += 20;

  if (whenHappens === "during ice maker") scores["ice maker or auger"] += 55;
  if (whenHappens === "during cooling") {
    scores["condenser fan motor"] += 10;
    scores["compressor or mounts"] += 10;
  }

  if (soundType === "squeal" || soundType === "grinding") scores["condenser fan motor"] += 20;
  if (soundType === "rattle") scores["compressor or mounts"] += 20;
  if (soundType === "clicking") scores["compressor or mounts"] += 15;

  if (frost === "yes") {
    scores["defrost or airflow issue"] += 40;
    scores["evaporator fan motor"] += 10;
  }

  const ranked = Object.entries(scores)
    .map(([cause, confidence]) => ({ cause, confidence: clampNumber(confidence, 0, 100), notes: "" }))
    .sort((x, y) => y.confidence - x.confidence);

  const top = ranked[0] || { cause: "unknown", confidence: 0 };
  const second = ranked[1] || { cause: "unknown", confidence: 0 };

  const confidence = clampNumber(top.confidence, 0, 100);
  const locked = confidence >= 70 && top.confidence - second.confidence >= 15;

  return { ranked, topCause: top.cause, confidence, locked };
}

function tryApplyScriptedScoring(session) {
  const a = (session.appliance || "").toLowerCase();
  const cat = (session.issueCategory || "").toLowerCase();

  if (a === "refrigerator" && cat === "noise") {
    const s = scoreFridgeNoise(session);

    session.diagnosis.likelyCauses = s.ranked;
    session.diagnosis.confidence = s.confidence;

    const suggested = s.topCause === "unknown" ? null : s.topCause;
    session.diagnosis.suggestedComponent = suggested;
    session.diagnosis.component = suggested;

    if (s.locked && suggested) {
      session.diagnosis.recommendedPath = "repair";
      session.diagnosis.status = "complete";
      session.diagnosis.stage = "locked";
      session.diagnosis.locked = true;

      session.partLookup = session.partLookup || {};
      session.partLookup.applianceType = session.partLookup.applianceType || session.appliance || null;
      session.partLookup.suspectedComponent = suggested;

      session.mode = "diagnose_locked";

      return {
        locked: true,
        reason: "scripted_scoring_locked",
        confidence: s.confidence,
        suggestedComponent: suggested
      };
    }

    return {
      locked: false,
      reason: "scripted_scoring_not_locked",
      confidence: s.confidence,
      suggestedComponent: suggested
    };
  }

  return { locked: false, reason: "no_scripted_scoring" };
}

/* =========================================================
   Safety profile
========================================================= */

function ensureSafetyProfile(session) {
  session.safetyProfile = session.safetyProfile || {
    status: "needs_ack",
    requiredAcks: [],
    acknowledged: {},
    blockRepair: false,
    reason: null,
    prompt: null,
    updatedAt: null
  };

  const sp = session.safetyProfile;
  if (!sp.status) sp.status = "needs_ack";
  if (!Array.isArray(sp.requiredAcks)) sp.requiredAcks = [];
  if (!sp.acknowledged || typeof sp.acknowledged !== "object") sp.acknowledged = {};
  if (typeof sp.blockRepair !== "boolean") sp.blockRepair = false;
  if (typeof sp.reason === "undefined") sp.reason = null;
  if (typeof sp.prompt === "undefined") sp.prompt = null;
  if (typeof sp.updatedAt === "undefined") sp.updatedAt = null;
}

function setSafetyProfile(session, { requiredAcks = [], blockRepair = false, reason = null, prompt = null } = {}) {
  ensureSafetyProfile(session);

  session.safetyProfile.requiredAcks = Array.isArray(requiredAcks) ? requiredAcks : [];
  session.safetyProfile.blockRepair = !!blockRepair;
  session.safetyProfile.reason = reason || null;
  session.safetyProfile.prompt = prompt || null;
  session.safetyProfile.updatedAt = new Date().toISOString();

  const allMet = session.safetyProfile.requiredAcks.every((k) => session.safetyProfile.acknowledged?.[k] === true);
  session.safetyProfile.status = allMet ? "acked" : "needs_ack";
}

function applySafetyAcks(session, acks) {
  ensureSafetyProfile(session);
  const list = Array.isArray(acks) ? acks : [];
  for (const k of list) {
    const key = normalizeText(k);
    if (!key) continue;
    session.safetyProfile.acknowledged[key] = true;
  }
  session.safetyProfile.updatedAt = new Date().toISOString();
  const allMet = (session.safetyProfile.requiredAcks || []).every(
    (k) => session.safetyProfile.acknowledged?.[k] === true
  );
  session.safetyProfile.status = allMet ? "acked" : "needs_ack";
}

function computeDynamicSafetyFromText({ appliance, issueCategory, symptoms, userDescription, safetyFlags }) {
  const a = normalizeApplianceType(appliance);
  const txt = `${a || ""} ${issueCategory || ""} ${(symptoms || []).join(" ")} ${userDescription || ""} ${(
    safetyFlags || []
  ).join(" ")}`.toLowerCase();

  const electricContext = containsAny(txt, [
    "electric",
    "electrical",
    "outlet",
    "plug",
    "cord",
    "breaker",
    "wiring",
    "wire",
    "bare wire",
    "exposed wire",
    "panel",
    "control board",
    "voltage"
  ]);

  const danger = {
    burning: containsAny(txt, ["burn", "burning", "smoke", "smoking", "melt", "melting"]),
    sparks: containsAny(txt, ["spark", "sparks", "arcing", "arc"]),
    gas: containsAny(txt, ["gas smell", "natural gas", "propane"]),
    refrigerant: containsAny(txt, ["refrigerant", "freon", "hissing", "chemical smell"]),
    shockRisk:
      containsAny(txt, ["shocked", "electric shock", "zapped", "tingle when touching", "tingling when touching"]) ||
      (electricContext && containsAny(txt, ["tingle", "tingling", "buzzing"])),
    waterNearElectric: containsAny(txt, ["water", "leak", "flood", "puddle"]) && electricContext
  };

  const mustEscalate =
    danger.burning || danger.sparks || danger.gas || danger.refrigerant || danger.shockRisk || danger.waterNearElectric;

  const requiredAcks = ["ack_general", "ack_power_off_before_opening"];

  if (a === "hvac") requiredAcks.push("ack_no_live_wires");

  const panelOrWiring = containsAny(txt, [
    "wire",
    "wiring",
    "connector",
    "panel",
    "cover",
    "control board",
    "capacitor",
    "voltage"
  ]);
  if (panelOrWiring) requiredAcks.push("ack_eye_protection");

  const movingParts = containsAny(txt, ["fan", "blower", "motor", "compressor"]);
  if (movingParts) requiredAcks.push("ack_hands_clear_moving_parts");

  let blockRepair = false;
  let reason = null;
  let prompt = "Before continuing, confirm basic safety. Turn power off before touching wiring or opening panels.";

  if (mustEscalate) {
    blockRepair = true;
    reason = "High risk indicators present. Stop and escalate to a professional.";
    prompt =
      "Stop now. If you smell burning, see smoke or sparks, suspect gas, suspect refrigerant, or see water near electrical, do not continue. Shut off power only if it is safe, then contact a professional.";
    requiredAcks.push("ack_stop_and_escalate");
  }

  return {
    requiredAcks: Array.from(new Set(requiredAcks)),
    blockRepair,
    reason,
    prompt
  };
}

function safetyGateInfo(session) {
  ensureSafetyProfile(session);
  const sp = session.safetyProfile;
  const required = Array.isArray(sp.requiredAcks) ? sp.requiredAcks : [];
  const missing = required.filter((k) => sp.acknowledged?.[k] !== true);
  return {
    status: sp.status,
    requiredAcks: required,
    missingAcks: missing,
    acknowledged: Object.keys(sp.acknowledged || {}).filter((k) => sp.acknowledged[k] === true),
    blockRepair: sp.blockRepair === true,
    reason: sp.reason || null,
    prompt: sp.prompt || null
  };
}

function listSatisfiedAcks(session) {
  ensureSafetyProfile(session);
  const ack = session?.safetyProfile?.acknowledged || {};
  if (!ack || typeof ack !== "object") return [];
  return Object.keys(ack).filter((k) => ack[k] === true);
}

function buildSafetySummary(session) {
  const gate = safetyGateInfo(session);
  return {
    requiredAcks: gate.requiredAcks,
    satisfiedAcks: gate.acknowledged,
    blocked: gate.missingAcks.length > 0 || gate.blockRepair === true,
    prompt: gate.prompt || null,
    blockRepair: gate.blockRepair === true,
    reason: gate.reason || null
  };
}

/* =========================================================
   Session shape helpers
========================================================= */

function ensurePhase4Fields(session) {
  session.repairFlow = session.repairFlow || {};
  session.repairFlow.validation = session.repairFlow.validation || {
    status: "not_validated",
    checkedAt: null,
    userObservations: [],
    resultNotes: [],
    recoverySuggested: [],
    recoveryPlan: null,
    recoveryStartedAt: null
  };

  const v = session.repairFlow.validation;

  if (!v.status) v.status = "not_validated";
  if (typeof v.checkedAt === "undefined") v.checkedAt = null;
  if (!Array.isArray(v.userObservations)) v.userObservations = [];
  if (!Array.isArray(v.resultNotes)) v.resultNotes = [];
  if (!Array.isArray(v.recoverySuggested)) v.recoverySuggested = [];
  if (typeof v.recoveryPlan === "undefined") v.recoveryPlan = null;
  if (typeof v.recoveryStartedAt === "undefined") v.recoveryStartedAt = null;
}

function ensureDiagnosisFields(session) {
  session.diagnosis = session.diagnosis || {
    status: "not_started",
    userDescription: null,
    questions: [],
    answers: {},
    likelyCauses: [],
    confidence: 0,
    recommendedPath: "diagnose",

    suggestedComponent: null,
    component: null,

    safetyFlags: [],
    createdAt: null,
    updatedAt: null,

    stage: "intake",
    currentQuestion: null,
    askedKeys: [],
    locked: false
  };

  const dx = session.diagnosis;
  if (!dx.status) dx.status = "not_started";
  if (!Array.isArray(dx.questions)) dx.questions = [];
  if (!dx.answers || typeof dx.answers !== "object") dx.answers = {};
  if (!Array.isArray(dx.likelyCauses)) dx.likelyCauses = [];
  if (typeof dx.confidence !== "number") dx.confidence = 0;
  if (!dx.recommendedPath) dx.recommendedPath = "diagnose";

  if (typeof dx.suggestedComponent === "undefined") dx.suggestedComponent = null;
  if (typeof dx.component === "undefined") dx.component = dx.suggestedComponent ?? null;

  if (!Array.isArray(dx.safetyFlags)) dx.safetyFlags = [];
  if (typeof dx.createdAt === "undefined") dx.createdAt = null;
  if (typeof dx.updatedAt === "undefined") dx.updatedAt = null;

  if (!dx.stage) dx.stage = "intake";
  if (typeof dx.currentQuestion === "undefined") dx.currentQuestion = null;
  if (!Array.isArray(dx.askedKeys)) dx.askedKeys = [];
  if (typeof dx.locked !== "boolean") dx.locked = false;
}

function ensureDiagnosisConversation(session) {
  ensureDiagnosisFields(session);
  session.diagnosis.conversation = session.diagnosis.conversation || {
    turns: [],
    lastTurnAt: null
  };
  const c = session.diagnosis.conversation;
  if (!Array.isArray(c.turns)) c.turns = [];
  if (typeof c.lastTurnAt === "undefined") c.lastTurnAt = null;
}

function pushDiagTurn(session, role, content) {
  ensureDiagnosisConversation(session);
  const c = session.diagnosis.conversation;

  c.turns.push({
    role,
    content: normalizeText(content),
    at: new Date().toISOString()
  });

  if (c.turns.length > 20) c.turns.splice(0, c.turns.length - 20);
  c.lastTurnAt = new Date().toISOString();
}

function buildStatusSnapshot(session) {
  const pl = session?.partLookup || {};
  const rs = pl?.resolution || {};
  const rf = session?.repairFlow || {};
  const val = rf?.validation || {};
  const dx = session?.diagnosis || {};
  const sp = session?.safetyProfile || {};

  const suggested = dx?.suggestedComponent ?? dx?.component ?? null;

  return {
    sessionId: session?.sessionId || null,
    powerState: session?.powerState || "unknown",
    mode: session?.mode || "diagnose",

    safetyStatus: sp?.status || "needs_ack",
    safetyRequiredAcks: Array.isArray(sp?.requiredAcks) ? sp.requiredAcks : [],
    safetyBlockRepair: sp?.blockRepair === true,
    safetyReason: sp?.reason || null,

    diagnosisStatus: dx?.status || "not_started",
    diagnosisStage: dx?.stage || "intake",
    diagnosisPath: dx?.recommendedPath || "diagnose",
    diagnosisConfidence: typeof dx?.confidence === "number" ? dx.confidence : null,
    diagnosisLocked: dx?.locked === true,
    diagnosisSuggestedComponent: suggested,

    partLookupStatus: pl?.status || "not_started",
    resolutionStatus: rs?.status || "not_resolved",

    repairStatus: rf?.status || "not_started",
    repairStepIndex: typeof rf?.currentStepIndex === "number" ? rf.currentStepIndex : null,

    validationStatus: val?.status || "not_validated",
    suspectedComponent: pl?.suspectedComponent || null,
    modelNumber: pl?.modelNumber || null
  };
}

function buildSuccessResponse(session, payload) {
  const safety = payload?.safety || buildSafetySummary(session);
  return {
    ok: true,
    type: payload.type || "ok",
    sessionId: session.sessionId,
    mode: session.mode,
    nextAction: payload.nextAction || "message",
    safety,
    diagnosis: payload.diagnosis || session.diagnosis || null,
    ui: payload.ui || {},
    data: payload.data || {},
    statusSnapshot: buildStatusSnapshot(session)
  };
}

function buildSafetyGateResponse(session, gate) {
  ensureSafetyProfile(session);
  const requiredAcks = Array.isArray(gate?.requiredAcks) ? gate.requiredAcks : safetyGateInfo(session).missingAcks;
  return {
    ok: false,
    code: "SAFETY_GATE",
    type: "safety_gate",
    sessionId: session.sessionId,
    mode: session.mode,
    nextAction: "ack",
    safety: {
      scope: gate?.scope || "diagnosis",
      requiredAcks,
      satisfiedAcks: listSatisfiedAcks(session),
      blocked: true,
      prompt: gate?.prompt || session?.safetyProfile?.prompt || "Safety acknowledgment required.",
      blockRepair: session?.safetyProfile?.blockRepair === true,
      reason: session?.safetyProfile?.reason || null
    },
    statusSnapshot: buildStatusSnapshot(session)
  };
}

function buildSafetyBlockedResponse(session, gate) {
  ensureSafetyProfile(session);
  return {
    ok: false,
    code: "SAFETY_BLOCKED",
    type: "safety_blocked",
    sessionId: session.sessionId,
    mode: session.mode,
    nextAction: "done",
    safety: {
      scope: gate?.scope || "diagnosis",
      requiredAcks: Array.isArray(session?.safetyProfile?.requiredAcks) ? session.safetyProfile.requiredAcks : [],
      satisfiedAcks: listSatisfiedAcks(session),
      blocked: true,
      prompt: gate?.prompt || session?.safetyProfile?.prompt || "Stop and escalate.",
      blockRepair: true,
      reason: gate?.reason || session?.safetyProfile?.reason || "High risk indicators present."
    },
    statusSnapshot: buildStatusSnapshot(session)
  };
}

/* =========================================================
   LLM calls
========================================================= */

async function runDiagnosisRouter({ appliance, issueCategory, userDescription, answers }) {
  const systemPrompt = `
You are FixBuddy Diagnosis Router.
Your job is to classify the situation and choose the safest next path.

Return ONLY valid JSON with this shape:
{
  "recommendedPath": "diagnose" | "repair" | "escalate",
  "confidence": 0-100,
  "suggestedComponent": "",
  "clarifyingQuestions": [
    { "key": "", "prompt": "", "type": "text" | "choice", "choices": [] }
  ],
  "likelyCauses": [
    { "cause": "", "confidence": 0-100, "notes": "" }
  ],
  "safetyFlags": [""]
}

Rules:
If safety risk is high or user mentions burning smell, sparks, gas, refrigerant, water near electrical, choose "escalate".
If confidence is below 70, choose "diagnose".
If confidence is 70 or higher and a component is clear, choose "repair".
Keep questions minimal, max 3.
`.trim();

  const userPayload = {
    appliance: appliance || null,
    issueCategory: issueCategory || null,
    userDescription: userDescription || null,
    answers: answers || {}
  };

  const response = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userPayload) }
    ],
    text: { format: { type: "json_object" } }
  });

  const raw = response?.output_text || "{}";
  return JSON.parse(raw);
}

async function runDiagnosisTurn({ session, userText }) {
  const systemPrompt = `
You are FixBuddy Diagnosis Conversation Driver.

You must ask ONLY questions that directly reduce uncertainty toward a specific component and a concrete next action.
Never ask about food, groceries, lifestyle, or anything unrelated to diagnosis.

Return ONLY valid JSON with this shape:
{
  "mode": "diagnose" | "repair" | "escalate",
  "assistant": "",
  "input": { "type": "text" | "choice" | "none", "key": "", "choices": [] },

  "questionMeta": {
    "goal": "disambiguate" | "confirm" | "safety",
    "reason": "",
    "rulesUsed": [""],
    "eliminates": [""],
    "narrowsTo": [""]
  },

  "confidence": 0-100,
  "likelyCauses": [ { "cause": "", "confidence": 0-100, "notes": "" } ],
  "suggestedComponent": "",
  "safetyFlags": [""]
}

Rules:
If there is any sign of burning smell, smoke, sparks, gas smell, refrigerant leak, shock risk, or water near electrical, set mode to "escalate" and input.type to "none".
If confidence is 70 or higher and a component is clear, set mode to "repair".
Otherwise set mode to "diagnose" and ask ONE question.
The question must be tied to narrowing to a component in questionMeta.narrowsTo.
Keep assistant concise.
If input.type is "choice", provide 2 to 6 choices.
`.trim();

  const dx = session.diagnosis || {};
  const appliance = session.appliance || null;
  const issueCategory = session.issueCategory || null;
  const symptoms = Array.isArray(session.symptoms) ? session.symptoms : [];
  const answers = dx.answers || {};
  const turns = (dx.conversation?.turns || []).slice(-12);

  const userPayload = {
    appliance,
    issueCategory,
    symptoms,
    userText: normalizeText(userText),
    answers,
    priorTurns: turns,
    priorLikelyCauses: dx.likelyCauses || [],
    priorSafetyFlags: dx.safetyFlags || [],
    alreadyAskedKeys: Array.isArray(dx.askedKeys) ? dx.askedKeys : []
  };

  const response = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userPayload) }
    ],
    text: { format: { type: "json_object" } }
  });

  const raw = response?.output_text || "{}";
  return JSON.parse(raw);
}

/* =========================================================
   Session create and persistence
========================================================= */

async function createDiagSession({ appliance = null, issueCategory = null, symptoms = [] } = {}) {
  const sessionId = uuidv4();

  const session = {
    sessionId,
    userId: null,
    appliance,
    issueCategory,
    symptoms: Array.isArray(symptoms) ? symptoms : [],
    powerState: "unknown",
    mode: "diagnose",

    diagnosis: {
      status: "not_started",
      userDescription: null,
      questions: [],
      answers: {},
      likelyCauses: [],
      confidence: 0,
      recommendedPath: "diagnose",

      suggestedComponent: null,
      component: null,

      safetyFlags: [],
      createdAt: null,
      updatedAt: null,

      stage: "intake",
      currentQuestion: null,
      askedKeys: [],
      locked: false,

      conversation: {
        turns: [],
        lastTurnAt: null
      }
    },

    safetyProfile: {
      status: "needs_ack",
      requiredAcks: [],
      acknowledged: {},
      blockRepair: false,
      reason: null,
      prompt: null,
      updatedAt: null
    },

    partLookup: {
      status: "not_started",
      brand: null,
      modelNumber: null,
      serialNumber: null,
      applianceType: null,
      suspectedComponent: null,
      componentIdentifiers: {},
      resolution: {
        status: "not_resolved",
        locked: false,
        resolvedAt: null,
        partName: null,
        oemPartNumber: null,
        confidence: "Low",
        alternatePartNumbers: [],
        searchQueries: [],
        verificationSteps: [],
        notes: [],
        inputsUsed: null,
        replacementReady: false,
        safetyPrereqs: [],
        nextStep: null
      },
      notes: []
    },

    repairFlow: {
      status: "not_started",
      componentKey: null,
      partName: null,
      oemPartNumber: null,
      tools: [],
      steps: [],
      currentStepIndex: 0,
      confirmations: {},
      startedAt: null,
      updatedAt: null,
      completedAt: null,

      lastActionId: null,
      lastActionMeta: null,

      blockedAt: null,
      blockedReason: null,
      blockedDetail: null,

      validation: {
        status: "not_validated",
        checkedAt: null,
        userObservations: [],
        resultNotes: [],
        recoverySuggested: [],
        recoveryPlan: null,
        recoveryStartedAt: null
      }
    },

    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  ensurePhase4Fields(session);
  ensureDiagnosisFields(session);
  ensureDiagnosisConversation(session);
  ensureSafetyProfile(session);

  const safety = computeDynamicSafetyFromText({
    appliance: session.appliance,
    issueCategory: session.issueCategory,
    symptoms: session.symptoms,
    userDescription: session.diagnosis.userDescription,
    safetyFlags: session.diagnosis.safetyFlags
  });
  setSafetyProfile(session, safety);

  await sessionStore.setSession(session);
  return session;
}

async function getSessionById(sessionId) {
  const session = await sessionStore.getSession(sessionId);
  if (!session) return null;
  ensurePhase4Fields(session);
  ensureDiagnosisFields(session);
  ensureDiagnosisConversation(session);
  ensureSafetyProfile(session);
  return session;
}

async function saveSession(session) {
  ensurePhase4Fields(session);
  ensureDiagnosisFields(session);
  ensureDiagnosisConversation(session);
  ensureSafetyProfile(session);

  session.updatedAt = new Date().toISOString();
  if (session.repairFlow) session.repairFlow.updatedAt = new Date().toISOString();

  await sessionStore.setSession(session);
  return session;
}

/* =========================================================
   Part lookup questions and resolver cache
========================================================= */

function buildPartLookupQuestions(session) {
  const pl = session.partLookup || {};
  const questions = [];

  const hasModel = !!pl.modelNumber;
  const hasLabel = !!pl.componentIdentifiers?.partLabelNumber;
  const hasSerial = !!pl.serialNumber;

  if (!hasModel) {
    questions.push({
      key: "modelNumber",
      prompt: "What is the exact model number from the rating label? Example: LFXS26973S",
      required: true
    });
    return questions;
  }

  if (hasSerial || hasLabel) {
    return questions;
  }

  questions.push({
    key: "serialNumber",
    prompt: "What is the serial number from the same label? Optional but useful for revision specific parts.",
    required: false
  });

  if (session.powerState !== "off") {
    questions.push({
      key: "powerState",
      prompt: "For safety, unplug the unit before checking any motor label. Reply with powerState=off once unplugged.",
      required: true
    });
  } else {
    questions.push({
      key: "partLabelNumber",
      prompt: "With power off, what number is on the sticker on the motor? If you cannot access it safely, say cannot access.",
      required: false
    });
  }

  return questions;
}

const partResolveCache = new Map();
const PART_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeKeyPiece(v) {
  return (v || "").toString().trim().toUpperCase();
}
function makePartResolveCacheKey(pl) {
  const keyObj = {
    brand: normalizeKeyPiece(pl.brand),
    modelNumber: normalizeKeyPiece(pl.modelNumber),
    serialNumber: normalizeKeyPiece(pl.serialNumber),
    suspectedComponent: normalizeKeyPiece(pl.suspectedComponent),
    partLabelNumber: normalizeKeyPiece(pl.componentIdentifiers?.partLabelNumber)
  };
  return JSON.stringify(keyObj);
}
function cacheGet(key) {
  const hit = partResolveCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.savedAtMs > PART_CACHE_TTL_MS) {
    partResolveCache.delete(key);
    return null;
  }
  return hit.payload;
}
function cacheSet(key, payload) {
  partResolveCache.set(key, { savedAtMs: Date.now(), payload });
}
function buildInputsUsed(pl, cacheKey) {
  return {
    brand: pl.brand || null,
    modelNumber: pl.modelNumber || null,
    serialNumber: pl.serialNumber || null,
    suspectedComponent: pl.suspectedComponent || null,
    partLabelNumber: pl.componentIdentifiers?.partLabelNumber || null,
    cacheKey
  };
}

/* =========================================================
   Repair templates
========================================================= */

function getRepairTemplate({ appliance, componentKey, partName, oemPartNumber }) {
  const a = (appliance || "").toLowerCase();
  const c = (componentKey || "").toLowerCase();

  if (a.includes("refrigerator") && (c.includes("condenser") || c.includes("fan") || c.includes("motor"))) {
    return {
      tools: [
        "Phillips screwdriver",
        "Quarter inch nut driver or socket",
        "Needle nose pliers",
        "Work gloves",
        "Flashlight",
        "Vacuum or brush for dust"
      ],
      steps: [
        {
          id: "safety_1",
          title: "Safety and prep",
          powerRequired: "off",
          requiresConfirmKey: "confirm_unplugged",
          instructions: [
            "Unplug the refrigerator from the wall outlet.",
            "If you cannot reach the plug, turn off the breaker that feeds the outlet.",
            "Wait five minutes so stored energy can dissipate.",
            "Move the unit out carefully to access the rear lower panel."
          ],
          confirmPrompt: "Confirm the refrigerator is unplugged and you can safely access the rear lower panel."
        },
        {
          id: "access_1",
          title: "Remove the rear lower access panel",
          powerRequired: "off",
          requiresConfirmKey: "confirm_panel_removed",
          instructions: [
            "Use a nut driver or screwdriver to remove screws on the rear lower access panel.",
            "Set screws aside in a small cup.",
            "Remove the panel."
          ],
          confirmPrompt: "Confirm the rear lower access panel is removed."
        },
        {
          id: "inspect_1",
          title: "Inspect and document wiring",
          powerRequired: "off",
          requiresConfirmKey: "confirm_wiring_documented",
          instructions: [
            "Locate the condenser fan motor and fan blade near the compressor area.",
            "Take a clear photo of the connector orientation and wire routing.",
            "Check for damage, debris, and signs of rubbing."
          ],
          confirmPrompt: "Confirm you have a photo of the wiring and you located the condenser fan motor."
        },
        {
          id: "remove_1",
          title: "Remove the fan blade and motor assembly",
          powerRequired: "off",
          requiresConfirmKey: "confirm_motor_removed",
          instructions: [
            "Unplug the motor connector by pulling on the connector, not the wires.",
            "Remove screws or clips holding the motor bracket.",
            "Remove any retaining clip if present, then slide the fan blade off the shaft.",
            "Remove the motor from the bracket."
          ],
          confirmPrompt: "Confirm the old condenser fan motor is fully removed."
        },
        {
          id: "install_1",
          title: "Install the new motor",
          powerRequired: "off",
          requiresConfirmKey: "confirm_motor_installed",
          instructions: [
            `Install the replacement motor: ${partName || "Condenser Fan Motor"} (${oemPartNumber || "OEM part number"}).`,
            "Transfer any mounts or grommets from the old motor if needed.",
            "Secure the motor in the bracket and tighten fasteners.",
            "Reinstall the fan blade and any retaining clip.",
            "Spin the blade by hand to ensure it does not rub."
          ],
          confirmPrompt: "Confirm the new motor is mounted and the fan blade spins freely by hand."
        },
        {
          id: "reassemble_1",
          title: "Reassemble and restore power",
          powerRequired: "off",
          requiresConfirmKey: "confirm_reassembled",
          instructions: [
            "Reinstall the rear lower access panel and screws.",
            "Push the refrigerator back carefully without pinching the cord.",
            "Plug the unit back in."
          ],
          confirmPrompt: "Confirm the panel is reinstalled and the refrigerator is plugged back in."
        },
        {
          id: "test_1",
          title: "Test and verify",
          powerRequired: "on",
          requiresConfirmKey: "confirm_tested",
          instructions: [
            "Listen for the squeak or rubbing sound.",
            "Confirm the condenser fan spins when the compressor runs.",
            "Let it run for ten minutes and check again.",
            "If you hear rubbing, power off again and recheck blade alignment and bracket seating."
          ],
          confirmPrompt: "Confirm the unit is running and the noise is gone or improved."
        }
      ]
    };
  }

  return {
    tools: ["Basic screwdriver set", "Work gloves", "Flashlight"],
    steps: [
      {
        id: "safety_generic",
        title: "Safety first",
        powerRequired: "off",
        requiresConfirmKey: "confirm_unplugged",
        instructions: ["Unplug the appliance before any disassembly.", "If unsure, stop and ask for help."],
        confirmPrompt: "Confirm the appliance is unplugged."
      }
    ]
  };
}

function getCurrentRepairStep(session) {
  const rf = session.repairFlow || {};
  const idx = typeof rf.currentStepIndex === "number" ? rf.currentStepIndex : 0;
  return rf.steps?.[idx] || null;
}

function validateRepairPowerGate(session, step) {
  if (!step) {
    return { blocked: true, message: "No current step found.", expectedPowerState: null };
  }

  const req = step.powerRequired;

  if (req === "off" && session.powerState !== "off") {
    return {
      blocked: true,
      expectedPowerState: "off",
      message: "For safety, turn power off, then tap Continue."
    };
  }

  if (req === "on" && session.powerState !== "on") {
    return {
      blocked: true,
      expectedPowerState: "on",
      message: "Turn power on for this step, then tap Continue."
    };
  }

  return { blocked: false, expectedPowerState: null };
}

function canAdvanceRepair(session, step) {
  if (!step) return { ok: false, reason: "no_step" };
  const key = step.requiresConfirmKey;
  if (!key) return { ok: true };
  const val = session.repairFlow?.confirmations?.[key];
  if (val === true) return { ok: true };
  return {
    ok: false,
    reason: "needs_confirmation",
    confirmKey: key,
    confirmPrompt: step.confirmPrompt || "Confirm to continue."
  };
}

function repairEnvelope({ type, session, step, gate, canAdvance, extra = {} }) {
  return {
    type,
    sessionId: session.sessionId,
    step: step || null,
    gate: gate || { blocked: false },
    canAdvance: canAdvance || { ok: true },
    statusSnapshot: buildStatusSnapshot(session),
    ...extra
  };
}

function requireRepairCompleteForValidation(req, res, next) {
  const session = req.fxSession;
  const rf = session.repairFlow || {};

  if (session.mode === "repair" && rf.status === "active") {
    return res.status(409).json({
      error: "Repair is still active. Complete the repair steps before validating outcome.",
      sessionId: session.sessionId,
      statusSnapshot: buildStatusSnapshot(session)
    });
  }

  if (rf.status !== "complete") {
    return res.status(409).json({
      error: "Repair must be complete before validating outcome.",
      expectedRepairStatus: "complete",
      currentRepairStatus: rf.status || "not_started",
      sessionId: session.sessionId,
      statusSnapshot: buildStatusSnapshot(session)
    });
  }

  next();
}

function buildRecoveryPlan(session, outcome, observations = []) {
  const pl = session.partLookup || {};
  const suspected = (pl.suspectedComponent || "component").toLowerCase();

  const safety = [
    "If anything smells like burning, you see arcing, or wires look damaged, stop and call a technician.",
    "If you need to open panels again, unplug the appliance first."
  ];

  const plans = [];

  plans.push({
    key: "recheck_install",
    title: "Recheck installation basics",
    powerRequired: "off",
    steps: [
      "Unplug the appliance.",
      "Verify the connector is fully seated and locked.",
      "Verify wire routing is not touching any moving parts.",
      "Verify all screws, clips, and brackets are seated and snug.",
      "Spin any fan blade by hand to confirm no rubbing."
    ]
  });

  if (suspected.includes("fan") || suspected.includes("motor") || suspected.includes("condenser")) {
    plans.push({
      key: "alignment_and_rub",
      title: "Check for alignment or rubbing",
      powerRequired: "off",
      steps: [
        "Confirm the fan blade is centered on the shaft and not wobbling.",
        "Confirm the bracket is not bent and the motor is square in its mounts.",
        "Look for scrape marks on the shroud or nearby tubing, then adjust clearance."
      ]
    });
  }

  plans.push({
    key: "alternate_causes",
    title: "Consider alternate causes",
    powerRequired: "on",
    steps: [
      "Restore power and listen closely to locate the sound or symptom source.",
      "If the original symptom remains, the replaced part may not be the root cause.",
      "Capture a short video or description of what you hear or see and continue diagnosis."
    ]
  });

  plans.push({
    key: "escalate",
    title: "Escalate to technician",
    powerRequired: "off",
    steps: [
      "If the symptom is unchanged after recheck, stop and seek professional service.",
      "Share model number, serial number, part replaced, and what changed after replacement."
    ]
  });

  const suggestedKeys =
    outcome === "passed"
      ? ["none"]
      : outcome === "partial"
        ? ["recheck_install", "alignment_and_rub", "alternate_causes"]
        : ["recheck_install", "alignment_and_rub", "alternate_causes", "escalate"];

  const notes = [];
  if (Array.isArray(observations) && observations.length) {
    notes.push("User observations recorded. Use them to choose the safest next action.");
  }

  return { safety, suggestedKeys, plans, notes };
}

/* =========================================================
   Middleware: require session
========================================================= */

async function requireSession(req, res, next) {
  const { sessionId } = req.body || {};
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" });
  }

  const session = await getSessionById(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found. Start a new session." });
  }

  req.fxSession = session;

  req.saveFxSession = async () => {
    await saveSession(session);
    return session;
  };

  next();
}

function requirePartLookupReady(req, res, next) {
  const session = req.fxSession;
  const pl = session.partLookup || {};

  if (pl.status !== "ready" && pl.status !== "resolved") {
    return res.status(409).json({
      error: "partLookup must be ready before resolving",
      expectedStatus: "ready",
      currentStatus: pl.status,
      sessionId: session.sessionId,
      statusSnapshot: buildStatusSnapshot(session)
    });
  }

  if (!pl.modelNumber || looksLikePlaceholder(pl.modelNumber)) {
    return res.status(400).json({
      error: "modelNumber is required before resolving a part number",
      sessionId: session.sessionId,
      statusSnapshot: buildStatusSnapshot(session)
    });
  }

  next();
}

function requireResolvedPartForRepair(req, res, next) {
  const session = req.fxSession;
  const pl = session.partLookup || {};
  const rs = pl.resolution || {};

  if (pl.status !== "resolved" || rs.status !== "resolved") {
    return res.status(409).json({
      error: "Part must be resolved before starting repair",
      expectedPartStatus: "resolved",
      currentPartStatus: pl.status,
      sessionId: session.sessionId,
      statusSnapshot: buildStatusSnapshot(session)
    });
  }

  if (rs.replacementReady !== true) {
    return res.status(409).json({
      error: "Resolved part is not marked replacementReady",
      sessionId: session.sessionId,
      statusSnapshot: buildStatusSnapshot(session)
    });
  }

  next();
}

/* =========================================================
   Routes
========================================================= */

app.get("/healthz", (req, res) => {
  res.json({ ok: true, env: config.nodeEnv, uptimeSec: Math.round(process.uptime()) });
});

app.get("/health/redis", async (req, res) => {
  const status = getRedisStatus();

  if (status.mode !== "redis") {
    return res.json({ ...status, ping: null });
  }

  try {
    const redis = getRedis();
    const pong = await redis.ping();
    return res.json({ ...status, ping: pong });
  } catch (err) {
    return res.status(503).json({
      ...status,
      ping: null,
      error: err?.message || String(err)
    });
  }
});

app.get("/health", async (req, res) => {
  const status = getRedisStatus();

  if (status.mode !== "redis") {
    return res.json({ ok: true, redisOk: false, redisMode: status.mode, env: config.nodeEnv });
  }

  try {
    const redis = getRedis();
    const pong = await redis.ping();
    const redisOk = pong === "PONG";
    res.json({ ok: true, redisOk, redisMode: status.mode, env: config.nodeEnv });
  } catch {
    res.json({ ok: true, redisOk: false, redisMode: status.mode, env: config.nodeEnv });
  }
});

app.get("/version", (req, res) => {
  res.json({
    ok: true,
    service: "FixBuddy API",
    env: config.nodeEnv,
    uptimeSec: Math.round(process.uptime())
  });
});

app.get("/__routes", (req, res) => {
  const routes = [];
  app._router.stack.forEach((m) => {
    if (m.route && m.route.path) {
      const methods = Object.keys(m.route.methods).map((x) => x.toUpperCase());
      routes.push({ path: m.route.path, methods });
    }
  });
  res.json({ routes });
});

app.post("/session/start", async (req, res) => {
  const { appliance, issueCategory, symptoms, userText, userId, deviceId } = req.body || {};

  const seededText = typeof userText === "string" ? userText.trim() : "";
  const seededSymptoms =
    Array.isArray(symptoms) && symptoms.length
      ? symptoms
      : seededText
        ? [seededText]
        : [];

  const session = await createDiagSession({
    appliance: typeof appliance === "string" && appliance.trim() ? appliance.trim() : null,
    issueCategory: typeof issueCategory === "string" && issueCategory.trim() ? issueCategory.trim() : null,
    symptoms: seededSymptoms
  });

  if (typeof userId === "string" && userId.trim()) session.userId = userId.trim();
  if (typeof deviceId === "string" && deviceId.trim() && !session.userId) session.userId = deviceId.trim();

  if (seededText) {
    ensureDiagnosisConversation(session);
    session.diagnosis.userDescription = seededText;
    if (!session.diagnosis.createdAt) session.diagnosis.createdAt = new Date().toISOString();
    session.diagnosis.updatedAt = new Date().toISOString();
    session.diagnosis.status = "running";
    session.diagnosis.stage = "intake";
    pushDiagTurn(session, "user", seededText);

    const safety = computeDynamicSafetyFromText({
      appliance: session.appliance,
      issueCategory: session.issueCategory,
      symptoms: session.symptoms,
      userDescription: session.diagnosis.userDescription,
      safetyFlags: session.diagnosis.safetyFlags
    });
    setSafetyProfile(session, safety);
  }

  await saveSession(session);

  const assistantMessage = seededText
    ? "Got it. Tap Continue and I will ask one quick question to narrow it down."
    : "Describe the problem in one sentence. Include when it happens.";

  return res.json({
    ok: true,
    type: "session_started",
    sessionId: session.sessionId,
    mode: session.mode,
    nextAction: "message",
    safety: buildSafetySummary(session),
    diagnosis: session.diagnosis,
    ui: { assistantMessage },
    data: {},
    session,
    statusSnapshot: buildStatusSnapshot(session)
  });
});

app.get("/session/:id", async (req, res) => {
  const session = await getSessionById(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({ ok: true, session, statusSnapshot: buildStatusSnapshot(session) });
});

app.post("/session/safety/ack", requireSession, async (req, res) => {
  const session = req.fxSession;
  const { ackKey, acks } = req.body || {};

  ensureSafetyProfile(session);

  const list = [];
  if (typeof ackKey === "string") list.push(ackKey);
  if (Array.isArray(acks)) list.push(...acks);

  if (!list.length) {
    return res.status(400).json({
      error: "ackKey or acks[] is required",
      statusSnapshot: buildStatusSnapshot(session)
    });
  }

  for (const k of list) {
    session.safetyProfile.acknowledged[k] = true;
  }

  const allMet = (session.safetyProfile.requiredAcks || []).every(
    (k) => session.safetyProfile.acknowledged?.[k] === true
  );

  session.safetyProfile.status = allMet ? "acked" : "needs_ack";
  session.safetyProfile.updatedAt = new Date().toISOString();

  await req.saveFxSession();

  return res.json({
    ok: true,
    sessionId: session.sessionId,
    safetyProfile: session.safetyProfile,
    safetyGate: safetyGateInfo(session),
    statusSnapshot: buildStatusSnapshot(session)
  });
});

app.post("/session/diagnose", requireSession, async (req, res) => {
  try {
    const session = req.fxSession;
    const { userDescription, answers } = req.body || {};

    if (typeof userDescription === "string" && userDescription.trim()) {
      session.diagnosis.userDescription = userDescription.trim();
      pushDiagTurn(session, "user", userDescription.trim());
    }

    if (answers && typeof answers === "object") {
      session.diagnosis.answers = { ...(session.diagnosis.answers || {}), ...answers };
    }

    if (!session.diagnosis.createdAt) session.diagnosis.createdAt = new Date().toISOString();
    session.diagnosis.updatedAt = new Date().toISOString();
    session.diagnosis.status = "running";
    session.mode = "diagnose";

    const safety = computeDynamicSafetyFromText({
      appliance: session.appliance,
      issueCategory: session.issueCategory,
      symptoms: session.symptoms,
      userDescription: session.diagnosis.userDescription,
      safetyFlags: session.diagnosis.safetyFlags
    });
    setSafetyProfile(session, safety);

    await req.saveFxSession();

    const routed = await runDiagnosisRouter({
      appliance: session.appliance,
      issueCategory: session.issueCategory,
      userDescription: session.diagnosis.userDescription,
      answers: session.diagnosis.answers
    });

    session.diagnosis.recommendedPath = routed.recommendedPath || "diagnose";
    session.diagnosis.confidence = normalizeConfidence(routed.confidence ?? 0);

    session.diagnosis.suggestedComponent = str(routed.suggestedComponent) || null;
    session.diagnosis.component = session.diagnosis.suggestedComponent;

    session.diagnosis.questions = Array.isArray(routed.clarifyingQuestions) ? routed.clarifyingQuestions : [];
    session.diagnosis.likelyCauses = Array.isArray(routed.likelyCauses) ? routed.likelyCauses : [];
    session.diagnosis.safetyFlags = Array.isArray(routed.safetyFlags) ? routed.safetyFlags : [];
    session.diagnosis.status = "complete";
    session.diagnosis.updatedAt = new Date().toISOString();

    const safety2 = computeDynamicSafetyFromText({
      appliance: session.appliance,
      issueCategory: session.issueCategory,
      symptoms: session.symptoms,
      userDescription: session.diagnosis.userDescription,
      safetyFlags: session.diagnosis.safetyFlags
    });
    setSafetyProfile(session, safety2);

    if (
      session.diagnosis.recommendedPath === "repair" &&
      session.diagnosis.suggestedComponent &&
      session.diagnosis.confidence >= 70
    ) {
      session.diagnosis.locked = true;
      session.diagnosis.stage = "locked";

      session.partLookup = session.partLookup || {};
      if (!session.partLookup.suspectedComponent) {
        session.partLookup.suspectedComponent = session.diagnosis.suggestedComponent;
      }
      if (!session.partLookup.applianceType && session.appliance) {
        session.partLookup.applianceType = session.appliance;
      }
    } else {
      session.diagnosis.locked = false;
      session.diagnosis.stage = session.diagnosis.recommendedPath === "escalate" ? "escalate" : "questions";
    }

    await req.saveFxSession();

    return res.json({
      type: "diagnosis_router",
      sessionId: session.sessionId,
      diagnosis: session.diagnosis,
      safetyProfile: session.safetyProfile,
      safetyGate: safetyGateInfo(session),
      statusSnapshot: buildStatusSnapshot(session)
    });
  } catch (err) {
    console.error("diagnose error:", err);
    return res.status(500).json({ error: "Internal error", detail: err?.message || "unknown" });
  }
});

app.post("/session/diagnose/next", requireSession, async (req, res) => {
  try {
    const session = req.fxSession;

    const actionId = typeof req.body?.actionId === "string" ? req.body.actionId.trim() : "";
    if (!actionId) {
      return res.status(400).json({ error: "actionId is required", sessionId: session.sessionId });
    }

    const replay = await sessionStore.getIdempotency(session.sessionId, actionId);
    if (replay) return res.json(replay);

    const input = req.body?.input && typeof req.body.input === "object" ? req.body.input : null;
    const inputKey = typeof input?.key === "string" ? input.key.trim() : null;
    const inputValue = input?.value;

    const message = typeof req.body?.message === "string" ? req.body.message : "";
    const answers = req.body?.answers && typeof req.body.answers === "object" ? req.body.answers : null;
    const acks = req.body?.acks;

    const keyTop = typeof req.body?.key === "string" ? req.body.key : null;
    const valueTop = req.body?.value;

    let key = inputKey || keyTop;
    let value = inputKey ? inputValue : valueTop;

    if ((!key || typeof value === "undefined") && normalizeText(message)) {
      const bound = bindMessageToPendingQuestion(session, message);
      if (bound?.key) {
        key = bound.key;
        value = bound.value;
      }
    }

    const effectiveMessage =
      inputKey === "userDescription" && typeof inputValue === "string" && inputValue.trim()
        ? inputValue.trim()
        : message;

    const normalizeAnswerKey = (k) => {
      if (!k) return k;
      const s = String(k).trim();
      if (s === "appliance_type") return "applianceType";
      if (s === "symptom_description") return "symptomDescription";
      return s;
    };

    let mergedAnswers = answers ? { ...answers } : {};

    if (key && value !== undefined) {
      const nk = normalizeAnswerKey(key);
      mergedAnswers[nk] = value;

      if (nk) markAsked(session, nk);

      if (
        session?.diagnosis?.currentQuestion &&
        normalizeText(session.diagnosis.currentQuestion.key) === normalizeText(nk)
      ) {
        session.diagnosis.currentQuestion = null;
      }
    }

    if (!session.diagnosis.createdAt) session.diagnosis.createdAt = new Date().toISOString();
    session.diagnosis.updatedAt = new Date().toISOString();
    session.diagnosis.status = "running";
    session.mode = "diagnose";

    applySafetyAcks(session, acks);

    if (mergedAnswers && Object.keys(mergedAnswers).length > 0) {
      session.diagnosis.answers = { ...(session.diagnosis.answers || {}), ...mergedAnswers };

      if (typeof mergedAnswers.applianceType === "string" && mergedAnswers.applianceType) {
        session.appliance = mergedAnswers.applianceType;
        session.partLookup = session.partLookup || {};
        session.partLookup.applianceType = session.partLookup.applianceType || mergedAnswers.applianceType;
      }

      if (typeof mergedAnswers.issueDescription === "string" && mergedAnswers.issueDescription) {
        session.diagnosis.userDescription = mergedAnswers.issueDescription;
      }

      if (typeof mergedAnswers.description === "string" && mergedAnswers.description) {
        const prev = session.diagnosis.userDescription ? String(session.diagnosis.userDescription) : "";
        session.diagnosis.userDescription = prev ? `${prev}\n${mergedAnswers.description}` : mergedAnswers.description;
      }

      if (typeof mergedAnswers.symptomDescription === "string" && mergedAnswers.symptomDescription) {
        const prev = session.diagnosis.userDescription ? String(session.diagnosis.userDescription) : "";
        session.diagnosis.userDescription = prev
          ? `${prev}\n${mergedAnswers.symptomDescription}`
          : mergedAnswers.symptomDescription;
      }
    }

    if (normalizeText(effectiveMessage)) {
      const prev = session.diagnosis.userDescription ? String(session.diagnosis.userDescription) : "";
      session.diagnosis.userDescription = prev
        ? `${prev}\n${normalizeText(effectiveMessage)}`
        : normalizeText(effectiveMessage);
      pushDiagTurn(session, "user", effectiveMessage);
    }

    const safety0 = computeDynamicSafetyFromText({
      appliance: session.appliance,
      issueCategory: session.issueCategory,
      symptoms: session.symptoms,
      userDescription: session.diagnosis.userDescription,
      safetyFlags: session.diagnosis.safetyFlags
    });
    setSafetyProfile(session, safety0);

    const gate0 = safetyGateInfo(session);
    if (gate0.missingAcks.length > 0) {
      await req.saveFxSession();
      const responseObj = buildSafetyGateResponse(session, {
        scope: "diagnosis",
        requiredAcks: gate0.missingAcks,
        prompt: gate0.prompt || "Confirm required safety acknowledgments to continue."
      });
      await sessionStore.setIdempotency(session.sessionId, actionId, responseObj);
      return res.status(409).json(responseObj);
    }

    if (gate0.blockRepair) {
      session.diagnosis.recommendedPath = "escalate";
      session.diagnosis.status = "complete";
      session.diagnosis.stage = "escalate";
      session.diagnosis.locked = false;

      const assistantText =
        session.safetyProfile.prompt ||
        session.safetyProfile.reason ||
        "Stop now and escalate to a professional. Shut off power only if it is safe.";

      pushDiagTurn(session, "assistant", assistantText);

      session.mode = "escalate";
      await req.saveFxSession();

      const responseObj = buildSafetyBlockedResponse(session, {
        scope: "diagnosis",
        reason: session.safetyProfile.reason,
        prompt: assistantText
      });
      await sessionStore.setIdempotency(session.sessionId, actionId, responseObj);
      return res.status(409).json(responseObj);
    }

    const scoredNow = tryApplyScriptedScoring(session);

    if (scoredNow?.locked) {
      session.diagnosis.recommendedPath = "repair";
      session.diagnosis.status = "complete";
      session.diagnosis.stage = "locked";
      session.diagnosis.locked = true;

      if (scoredNow?.confidence != null) session.diagnosis.confidence = scoredNow.confidence;
      if (scoredNow?.suggestedComponent) {
        session.diagnosis.suggestedComponent = scoredNow.suggestedComponent;
        session.diagnosis.component = scoredNow.suggestedComponent;
      } else {
        session.diagnosis.component = session.diagnosis.suggestedComponent;
      }

      session.partLookup = session.partLookup || {};
      session.partLookup.applianceType = session.partLookup.applianceType || session.appliance || null;
      session.partLookup.suspectedComponent = session.diagnosis.suggestedComponent || scoredNow.suggestedComponent || null;

      session.mode = "part_lookup";

      await req.saveFxSession();

      const msg = "Most likely cause identified. Next we will confirm the part number.";

      const responseObj = buildSuccessResponse(session, {
        type: "diagnose_locked",
        nextAction: "part_lookup",
        safety: buildSafetySummary(session),
        diagnosis: {
          locked: true,
          confidence: session.diagnosis.confidence,
          suggestedComponent: session.diagnosis.suggestedComponent,
          component: session.diagnosis.suggestedComponent,
          summaryForUser: msg
        },
        ui: {
          assistantMessage: msg,
          input: { type: "none", key: "", choices: [] }
        },
        data: { suggestedComponent: session.diagnosis.suggestedComponent }
      });

      await sessionStore.setIdempotency(session.sessionId, actionId, responseObj);
      return res.status(200).json(responseObj);
    }

    const scriptedQ = getScriptedNextQuestion(session);
    if (scriptedQ) {
      session.diagnosis.currentQuestion = scriptedQ;
      session.diagnosis.status = "running";
      session.diagnosis.stage = "questions";
      session.diagnosis.locked = false;

      markAsked(session, scriptedQ.key);

      await req.saveFxSession();

      const responseObj = buildSuccessResponse(session, {
        type: "diagnose_turn",
        nextAction: "answers",
        safety: buildSafetySummary(session),
        diagnosis: {
          locked: false,
          confidence: session.diagnosis.confidence,
          suggestedComponent: session.diagnosis.suggestedComponent || null,
          component: session.diagnosis.suggestedComponent || null,
          summaryForUser: null
        },
        ui: {
          assistantMessage: scriptedQ.prompt,
          input: { type: scriptedQ.type, key: scriptedQ.key, choices: scriptedQ.choices }
        },
        data: {}
      });

      await sessionStore.setIdempotency(session.sessionId, actionId, responseObj);
      return res.status(200).json(responseObj);
    }

    await req.saveFxSession();

    const turnRaw = await runDiagnosisTurn({ session, userText: effectiveMessage });

    const rawMode = normalizeText(turnRaw?.mode).toLowerCase();
    let assistant = normalizeText(turnRaw?.assistant);

    const input2 = normalizeTurnInput(turnRaw);

    if (input2.type !== "none") {
      session.diagnosis.currentQuestion = {
        key: input2.key,
        type: input2.type,
        choices: Array.isArray(input2.choices) ? input2.choices : []
      };
    } else {
      session.diagnosis.currentQuestion = null;
    }

    session.diagnosis.confidence = normalizeConfidence(turnRaw?.confidence ?? 0);
    session.diagnosis.likelyCauses = Array.isArray(turnRaw?.likelyCauses) ? turnRaw.likelyCauses : [];

    session.diagnosis.suggestedComponent = str(turnRaw?.suggestedComponent) || null;
    session.diagnosis.component = session.diagnosis.suggestedComponent;

    session.diagnosis.safetyFlags = Array.isArray(turnRaw?.safetyFlags) ? turnRaw.safetyFlags : [];
    session.diagnosis.updatedAt = new Date().toISOString();

    if (assistant) pushDiagTurn(session, "assistant", assistant);

    const safety1 = computeDynamicSafetyFromText({
      appliance: session.appliance,
      issueCategory: session.issueCategory,
      symptoms: session.symptoms,
      userDescription: session.diagnosis.userDescription,
      safetyFlags: session.diagnosis.safetyFlags
    });
    setSafetyProfile(session, safety1);

    const gate1 = safetyGateInfo(session);
    if (gate1.missingAcks.length > 0) {
      await req.saveFxSession();
      const responseObj = buildSafetyGateResponse(session, {
        scope: rawMode === "repair" ? "repair" : "diagnosis",
        requiredAcks: gate1.missingAcks,
        prompt: gate1.prompt || "Confirm required safety acknowledgments to continue."
      });
      await sessionStore.setIdempotency(session.sessionId, actionId, responseObj);
      return res.status(409).json(responseObj);
    }

    if (gate1.blockRepair || rawMode === "escalate") {
      session.diagnosis.recommendedPath = "escalate";
      session.diagnosis.status = "complete";
      session.diagnosis.stage = "escalate";
      session.diagnosis.locked = false;

      const assistantText =
        session.safetyProfile.prompt ||
        assistant ||
        "Stop now and escalate to a professional. Shut off power only if it is safe.";

      if (assistantText && (!assistant || assistantText !== assistant)) {
        pushDiagTurn(session, "assistant", assistantText);
      }

      session.mode = "escalate";
      await req.saveFxSession();

      const responseObj = buildSafetyBlockedResponse(session, {
        scope: "diagnosis",
        reason: session.safetyProfile.reason,
        prompt: assistantText
      });
      await sessionStore.setIdempotency(session.sessionId, actionId, responseObj);
      return res.status(409).json(responseObj);
    }

    const proposedKey = input2.type === "none" ? "" : input2.key;

    if (proposedKey && alreadyAsked(session, proposedKey)) {
      const fb = selectHighValueFallbackQuestion(session);
      assistant = fb.assistant;
      session.diagnosis.updatedAt = new Date().toISOString();
      pushDiagTurn(session, "assistant", assistant);

      const responseObj = buildSuccessResponse(session, {
        type: "diagnose_turn",
        nextAction: fb.input.type === "choice" ? "answers" : fb.input.type === "none" ? "done" : "message",
        safety: buildSafetySummary(session),
        diagnosis: {
          locked: false,
          confidence: session.diagnosis.confidence,
          suggestedComponent: session.diagnosis.suggestedComponent || null,
          component: session.diagnosis.suggestedComponent || null,
          summaryForUser: null
        },
        ui: {
          assistantMessage: assistant,
          input: fb.input
        },
        data: {}
      });

      markAsked(session, fb.input.key);
      await req.saveFxSession();
      await sessionStore.setIdempotency(session.sessionId, actionId, responseObj);
      return res.status(200).json(responseObj);
    }

    markAsked(session, proposedKey);

    if (!isUsefulQuestion(turnRaw)) {
      const fb = selectHighValueFallbackQuestion(session);
      assistant = fb.assistant;
      pushDiagTurn(session, "assistant", assistant);
      markAsked(session, fb.input.key);
      await req.saveFxSession();

      const responseObj = buildSuccessResponse(session, {
        type: "diagnose_turn",
        nextAction: fb.input.type === "choice" ? "answers" : fb.input.type === "none" ? "done" : "message",
        safety: buildSafetySummary(session),
        diagnosis: {
          locked: false,
          confidence: session.diagnosis.confidence,
          suggestedComponent: session.diagnosis.suggestedComponent || null,
          component: session.diagnosis.suggestedComponent || null,
          summaryForUser: null
        },
        ui: {
          assistantMessage: assistant,
          input: fb.input
        },
        data: {}
      });

      await sessionStore.setIdempotency(session.sessionId, actionId, responseObj);
      return res.status(200).json(responseObj);
    }

    const wantsRepair = rawMode === "repair" || session.diagnosis.confidence >= 70;
    const confidentEnough = session.diagnosis.confidence >= 70 && !!session.diagnosis.suggestedComponent;

    const dxAnswers = session?.diagnosis?.answers || {};
    const appliance = String(session.appliance || "").toLowerCase();
    const issueCategory = String(session.issueCategory || "").toLowerCase();

    function hasAnswer(ansKey) {
      const v = dxAnswers?.[ansKey];
      if (typeof v === "string") {
        const t = v.trim().toLowerCase();
        return t.length > 0 && t !== "not sure";
      }
      if (typeof v === "number") return Number.isFinite(v);
      if (typeof v === "boolean") return true;
      return v != null;
    }

    let evidenceKeys = [];
    if (appliance === "refrigerator" && issueCategory === "noise") {
      evidenceKeys = ["doorStopsNoise", "location", "soundType", "whenHappens", "frostBuildup"];
    } else {
      evidenceKeys = ["symptomDetails", "whenHappens", "location", "soundType"];
    }

    const evidenceCount = evidenceKeys.reduce((n, k) => n + (hasAnswer(k) ? 1 : 0), 0);
    const hasEnoughEvidence = evidenceCount >= 3;

    const lockReady = wantsRepair && confidentEnough && hasEnoughEvidence;

    if (lockReady) {
      session.diagnosis.recommendedPath = "repair";
      session.diagnosis.status = "complete";
      session.diagnosis.stage = "locked";
      session.diagnosis.locked = true;

      session.diagnosis.component = session.diagnosis.suggestedComponent;

      session.partLookup = session.partLookup || {};
      session.partLookup.applianceType = session.partLookup.applianceType || session.appliance || null;
      session.partLookup.suspectedComponent = session.diagnosis.suggestedComponent;

      session.mode = "part_lookup";

      await req.saveFxSession();

      const responseObj = buildSuccessResponse(session, {
        type: "diagnose_locked",
        nextAction: "part_lookup",
        safety: buildSafetySummary(session),
        diagnosis: {
          locked: true,
          confidence: session.diagnosis.confidence,
          suggestedComponent: session.diagnosis.suggestedComponent,
          component: session.diagnosis.suggestedComponent,
          summaryForUser: "Most likely component found. Next we will confirm the part number."
        },
        ui: {
          assistantMessage: assistant || "I am confident enough to proceed. Next we will confirm the part number.",
          input: { type: "none", key: "", choices: [] }
        },
        data: { suggestedComponent: session.diagnosis.suggestedComponent }
      });

      await sessionStore.setIdempotency(session.sessionId, actionId, responseObj);
      return res.status(200).json(responseObj);
    }

    session.diagnosis.recommendedPath = "diagnose";
    session.diagnosis.status = "running";
    session.diagnosis.stage = "questions";
    session.diagnosis.locked = false;

    session.mode = "diagnose";
    await req.saveFxSession();

    const nextAction = input2.type === "choice" ? "answers" : input2.type === "none" ? "done" : "message";

    const responseObj = buildSuccessResponse(session, {
      type: "diagnose_turn",
      nextAction,
      safety: buildSafetySummary(session),
      diagnosis: {
        locked: false,
        confidence: session.diagnosis.confidence,
        suggestedComponent: session.diagnosis.suggestedComponent || null,
        component: session.diagnosis.suggestedComponent || null,
        summaryForUser: null
      },
      ui: {
        assistantMessage: assistant || "Tell me a bit more about what you are seeing or hearing.",
        input: {
          type: input2.type || "text",
          key: input2.key || "details",
          choices: Array.isArray(input2.choices) ? input2.choices : []
        }
      },
      data: {}
    });

    await sessionStore.setIdempotency(session.sessionId, actionId, responseObj);
    return res.status(200).json(responseObj);
  } catch (err) {
    console.error("diagnose/next error:", err);
    return res.status(500).json({ error: "Internal error", detail: err?.message || "unknown" });
  }
});

app.post("/session/power", requireSession, async (req, res) => {
  const session = req.fxSession;
  const { powerState } = req.body || {};

  if (powerState !== "on" && powerState !== "off") {
    return res.status(400).json({ error: 'powerState must be "on" or "off"' });
  }

  session.powerState = powerState;
  await req.saveFxSession();

  res.json({ ok: true, session, statusSnapshot: buildStatusSnapshot(session) });
});

app.post("/session/part-lookup", requireSession, async (req, res) => {
  const session = req.fxSession;
  const { answers } = req.body || {};

  if (session?.diagnosis?.locked !== true) {
    return res.status(409).json({
      ok: false,
      code: "DIAGNOSIS_NOT_LOCKED",
      type: "diagnosis_not_locked",
      sessionId: session.sessionId,
      message: "Finish diagnosis before part lookup.",
      nextAction: "diagnose",
      statusSnapshot: buildStatusSnapshot(session)
    });
  }

  session.partLookup = session.partLookup || {};
  session.partLookup.status = "collecting";

  if (answers && typeof answers === "object") {
    if (typeof answers.powerState === "string") {
      const ps = answers.powerState.trim().toLowerCase();
      if (ps === "on" || ps === "off") session.powerState = ps;
    }

    if (typeof answers.brand === "string" && answers.brand.trim()) {
      session.partLookup.brand = answers.brand.trim();
    }

    if (typeof answers.modelNumber === "string") {
      const mn = normalizeId(answers.modelNumber);
      if (mn && !looksLikePlaceholder(mn)) session.partLookup.modelNumber = mn;
    }

    if (typeof answers.serialNumber === "string") {
      const sn = normalizeId(answers.serialNumber);
      if (sn && !looksLikePlaceholder(sn) && !looksLikeNoAccess(sn)) session.partLookup.serialNumber = sn;
    }

    if (typeof answers.partLabelNumber === "string") {
      const pn = normalizeId(answers.partLabelNumber);
      if (pn && !looksLikePlaceholder(pn) && !looksLikeNoAccess(pn)) {
        session.partLookup.componentIdentifiers = session.partLookup.componentIdentifiers || {};
        session.partLookup.componentIdentifiers.partLabelNumber = pn;
      }
    }

    const dxLocked = session?.diagnosis?.locked === true;
    if (typeof answers.suspectedComponent === "string" && answers.suspectedComponent.trim()) {
      if (dxLocked) session.partLookup.suspectedComponent = answers.suspectedComponent.trim();
    }
  }

  const questions = buildPartLookupQuestions(session);
  const hasModel = !!session.partLookup.modelNumber;

  if (hasModel) {
    session.partLookup.status = "ready";
    await req.saveFxSession();

    return res.json({
      type: "part_lookup_ready",
      sessionId: session.sessionId,
      partLookup: session.partLookup,
      statusSnapshot: buildStatusSnapshot(session),
      message: questions.length
        ? "Model number captured. You can resolve now. Optional: add serial or motor label to improve accuracy."
        : "Got it. Next step is to confirm the compatible part number.",
      optionalQuestions: questions
    });
  }

  await req.saveFxSession();

  return res.json({
    type: "part_lookup_questions",
    sessionId: session.sessionId,
    suspectedComponent: session.partLookup.suspectedComponent,
    questions,
    partLookup: session.partLookup,
    statusSnapshot: buildStatusSnapshot(session)
  });
});

app.post("/session/part-resolve", requireSession, requirePartLookupReady, async (req, res) => {
  try {
    const { force } = req.body || {};
    const session = req.fxSession;

    session.partLookup = session.partLookup || {};
    const pl = session.partLookup;

    const needsOff = componentRequiresPowerOff(pl.suspectedComponent);
    if (needsOff && session.powerState !== "off") {
      return res.status(409).json({
        error: "For safety, powerState must be off before resolving this component flow",
        expectedPowerState: "off",
        currentPowerState: session.powerState,
        sessionId: session.sessionId,
        statusSnapshot: buildStatusSnapshot(session)
      });
    }

    const cacheKey = makePartResolveCacheKey(pl);
    const inputsUsed = buildInputsUsed(pl, cacheKey);

    if (
      pl.status === "resolved" &&
      pl.resolution?.status === "resolved" &&
      pl.resolution?.locked === true &&
      force !== true
    ) {
      return res.json({
        type: "part_resolve_cached",
        sessionId: session.sessionId,
        cacheHit: true,
        partLookup: pl,
        result: pl.resolution,
        statusSnapshot: buildStatusSnapshot(session)
      });
    }

    const cached = force === true ? null : cacheGet(cacheKey);
    if (cached) {
      pl.resolution = { ...cached, status: "resolved", locked: true, inputsUsed: cached.inputsUsed || inputsUsed };
      pl.status = "resolved";
      await req.saveFxSession();

      return res.json({
        type: "part_resolve_cached",
        sessionId: session.sessionId,
        cacheHit: true,
        partLookup: pl,
        result: pl.resolution,
        statusSnapshot: buildStatusSnapshot(session)
      });
    }

    pl.status = "resolving";
    await req.saveFxSession();

    const brand = pl.brand || "Unknown";
    const modelNumber = pl.modelNumber;
    const serialNumber = pl.serialNumber || "not provided";
    const suspectedComponent = pl.suspectedComponent || "unknown_component";
    const partLabelNumber = pl.componentIdentifiers?.partLabelNumber || "not provided";

    const systemPrompt = `
You are FixBuddy Part Resolver.
Goal: Suggest the most likely OEM part number and name for the suspected component for the given appliance model.
Be conservative. Part numbers vary by revision.
Respond ONLY with valid JSON.

Return format:
{
  "part_name": "",
  "oem_part_number": "",
  "confidence": "Low" | "Medium" | "High",
  "alternate_part_numbers": [],
  "search_queries": [],
  "verification_steps": [],
  "notes": []
}
`.trim();

    const userPayload = `
Brand: ${brand}
Model number: ${modelNumber}
Serial number: ${serialNumber}
Suspected component: ${suspectedComponent}
Part label number: ${partLabelNumber}

Task: Provide the most likely OEM part and how to verify it.
`.trim();

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPayload }
      ],
      text: { format: { type: "json_object" } }
    });

    const rawText = response?.output_text || "";
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      pl.status = "error";
      await req.saveFxSession();
      return res.status(500).json({
        error: "Invalid JSON returned from OpenAI",
        raw: rawText,
        sessionId: session.sessionId,
        statusSnapshot: buildStatusSnapshot(session)
      });
    }

    const resolved = {
      status: "resolved",
      locked: true,
      resolvedAt: new Date().toISOString(),
      partName: str(parsed.part_name),
      oemPartNumber: str(parsed.oem_part_number),
      confidence: str(parsed.confidence) || "Low",
      alternatePartNumbers: arr(parsed.alternate_part_numbers),
      searchQueries: arr(parsed.search_queries),
      verificationSteps: arr(parsed.verification_steps),
      notes: arr(parsed.notes),
      inputsUsed,
      replacementReady: true,
      safetyPrereqs: needsOff
        ? ["Unplug the appliance before any disassembly."]
        : ["Follow safety guidance before disassembly."],
      nextStep: "phase3_repair_start"
    };

    pl.resolution = resolved;
    pl.status = "resolved";
    await req.saveFxSession();

    cacheSet(cacheKey, resolved);

    return res.json({
      type: "part_resolve_result",
      sessionId: session.sessionId,
      cacheHit: false,
      partLookup: pl,
      result: resolved,
      statusSnapshot: buildStatusSnapshot(session)
    });
  } catch (err) {
    console.error("Error in /session/part-resolve:", err);
    res.status(500).json({ error: "Internal server error", detail: err?.message || "unknown" });
  }
});

/* =========================================================
   Repair flow
========================================================= */

function resetRepairFlowForStart(session) {
  session.repairFlow = session.repairFlow || {};
  const rf = session.repairFlow;

  rf.status = "active";
  rf.componentKey = session.partLookup?.suspectedComponent || null;
  rf.partName = session.partLookup?.resolution?.partName || null;
  rf.oemPartNumber = session.partLookup?.resolution?.oemPartNumber || null;

  rf.tools = Array.isArray(rf.tools) ? rf.tools : [];
  rf.steps = Array.isArray(rf.steps) ? rf.steps : [];
  rf.currentStepIndex = 0;
  rf.confirmations = rf.confirmations && typeof rf.confirmations === "object" ? rf.confirmations : {};

  rf.startedAt = rf.startedAt || new Date().toISOString();
  rf.updatedAt = new Date().toISOString();
  rf.completedAt = null;

  rf.lastActionId = null;
  rf.lastActionMeta = null;

  rf.blockedAt = null;
  rf.blockedReason = null;
  rf.blockedDetail = null;

  ensurePhase4Fields(session);
}

async function handleRepairNext(req, res) {
  const session = req.fxSession;
  const rf = session.repairFlow || {};

  const actionId = typeof req.body?.actionId === "string" ? req.body.actionId.trim() : "";
  const useIdempotency =
    !!actionId &&
    typeof sessionStore?.getIdempotency === "function" &&
    typeof sessionStore?.setIdempotency === "function";

  if (useIdempotency) {
    const replay = await sessionStore.getIdempotency(session.sessionId, actionId);
    if (replay) return res.json(replay);
  }

  const persistAndRespond = async (statusCode, payload) => {
    if (useIdempotency) {
      try {
        await sessionStore.setIdempotency(session.sessionId, actionId, payload);
      } catch {}
    }
    if (typeof statusCode === "number" && statusCode >= 400) return res.status(statusCode).json(payload);
    return res.json(payload);
  };

  if (rf.status !== "active") {
    const payload = {
      error: "Repair is not active.",
      currentRepairStatus: rf.status || "not_started",
      sessionId: session.sessionId,
      statusSnapshot: buildStatusSnapshot(session)
    };
    return persistAndRespond(409, payload);
  }

  const step = getCurrentRepairStep(session);
  if (!step) {
    const payload = {
      error: "No current step found.",
      sessionId: session.sessionId,
      statusSnapshot: buildStatusSnapshot(session)
    };
    return persistAndRespond(409, payload);
  }

  const powerGate = validateRepairPowerGate(session, step);
  if (powerGate.blocked) {
    rf.blockedAt = new Date().toISOString();
    rf.blockedReason = "power_gate";
    rf.blockedDetail = powerGate.message;
    session.repairFlow = rf;
    await req.saveFxSession();

    const payload = repairEnvelope({
      type: "power_gate",
      session,
      step,
      gate: powerGate,
      canAdvance: canAdvanceRepair(session, step),
      extra: { expectedPowerState: powerGate.expectedPowerState }
    });

    return persistAndRespond(409, payload);
  }

  const confirmKey = typeof req.body?.confirmKey === "string" ? req.body.confirmKey.trim() : "";

  if (step.requiresConfirmKey) {
    const requiredKey = step.requiresConfirmKey;

    if (confirmKey && confirmKey === requiredKey) {
      rf.confirmations = rf.confirmations || {};
      rf.confirmations[requiredKey] = true;
      rf.updatedAt = new Date().toISOString();
      session.repairFlow = rf;
      await req.saveFxSession();
    }

    const adv0 = canAdvanceRepair(session, step);
    if (!adv0.ok) {
      rf.blockedAt = new Date().toISOString();
      rf.blockedReason = "needs_confirmation";
      rf.blockedDetail = adv0.confirmPrompt || "Confirm to continue.";
      session.repairFlow = rf;
      await req.saveFxSession();

      const payload = {
        type: "confirm_required",
        sessionId: session.sessionId,
        requiredConfirmKey: adv0.confirmKey,
        confirmPrompt: adv0.confirmPrompt,
        step,
        statusSnapshot: buildStatusSnapshot(session)
      };

      return persistAndRespond(409, payload);
    }
  }

  rf.blockedAt = null;
  rf.blockedReason = null;
  rf.blockedDetail = null;

  const idx = typeof rf.currentStepIndex === "number" ? rf.currentStepIndex : 0;
  const nextIndex = idx + 1;

  if (nextIndex >= (rf.steps || []).length) {
    rf.status = "complete";
    rf.completedAt = new Date().toISOString();
    rf.updatedAt = new Date().toISOString();
    session.repairFlow = rf;

    ensurePhase4Fields(session);
    session.repairFlow.validation.status = "needs_validation";
    session.mode = "outcome";

    await req.saveFxSession();

    const payload = {
      type: "repair_complete",
      sessionId: session.sessionId,
      repairFlow: session.repairFlow,
      validation: session.repairFlow.validation,
      statusSnapshot: buildStatusSnapshot(session)
    };

    return persistAndRespond(200, payload);
  }

  rf.currentStepIndex = nextIndex;
  rf.updatedAt = new Date().toISOString();
  session.repairFlow = rf;
  await req.saveFxSession();

  const step2 = getCurrentRepairStep(session);
  const powerGate2 = validateRepairPowerGate(session, step2);
  const adv2 = canAdvanceRepair(session, step2);

  const payload = repairEnvelope({
    type: "repair_step",
    session,
    step: step2,
    gate: powerGate2,
    canAdvance: adv2,
    extra: { repairFlow: session.repairFlow }
  });

  return persistAndRespond(200, payload);
}

app.post("/session/repair/start", requireSession, requireResolvedPartForRepair, async (req, res) => {
  const session = req.fxSession;

  const gate = safetyGateInfo(session);
  if (gate.missingAcks.length > 0) {
    const payload = buildSafetyGateResponse(session, {
      scope: "repair",
      requiredAcks: gate.missingAcks,
      prompt: gate.prompt || "Confirm required safety acknowledgments to start repair."
    });
    return res.status(409).json(payload);
  }
  if (gate.blockRepair) {
    session.mode = "repair";
    await req.saveFxSession();
    const payload = buildSafetyBlockedResponse(session, {
      scope: "repair",
      reason: gate.reason,
      prompt: gate.prompt || gate.reason || "Repair is blocked due to safety risk."
    });
    return res.status(409).json(payload);
  }

  const pl = session.partLookup || {};
  const rs = pl.resolution || {};

  const template = getRepairTemplate({
    appliance: session.appliance || pl.applianceType,
    componentKey: pl.suspectedComponent,
    partName: rs.partName,
    oemPartNumber: rs.oemPartNumber
  });

  resetRepairFlowForStart(session);

  session.repairFlow.tools = template.tools || [];
  session.repairFlow.steps = template.steps || [];
  session.repairFlow.currentStepIndex = 0;

  session.mode = "repair";
  await req.saveFxSession();

  const step = getCurrentRepairStep(session);
  const powerGate = validateRepairPowerGate(session, step);
  const adv = canAdvanceRepair(session, step);

  return res.json(
    repairEnvelope({
      type: "repair_started",
      session,
      step,
      gate: powerGate,
      canAdvance: adv,
      extra: { tools: session.repairFlow.tools, repairFlow: session.repairFlow }
    })
  );
});

app.post("/session/repair/start-generic", requireSession, async (req, res) => {
  const session = req.fxSession;

  const gate = safetyGateInfo(session);
  if (gate.missingAcks.length > 0) {
    const payload = buildSafetyGateResponse(session, {
      scope: "repair",
      requiredAcks: gate.missingAcks,
      prompt: gate.prompt || "Confirm required safety acknowledgments to start repair."
    });
    return res.status(409).json(payload);
  }
  if (gate.blockRepair) {
    session.mode = "repair";
    await req.saveFxSession();
    const payload = buildSafetyBlockedResponse(session, {
      scope: "repair",
      reason: gate.reason,
      prompt: gate.prompt || gate.reason || "Repair is blocked due to safety risk."
    });
    return res.status(409).json(payload);
  }

  if (session?.diagnosis?.locked !== true || !session?.diagnosis?.suggestedComponent) {
    return res.status(409).json({
      error: "Diagnosis must be locked with a suggested component before starting generic repair.",
      sessionId: session.sessionId,
      statusSnapshot: buildStatusSnapshot(session)
    });
  }

  const componentKey = session.diagnosis.suggestedComponent;

  const template = getRepairTemplate({
    appliance: session.appliance,
    componentKey,
    partName: null,
    oemPartNumber: null
  });

  resetRepairFlowForStart(session);
  session.repairFlow.componentKey = componentKey;
  session.repairFlow.partName = null;
  session.repairFlow.oemPartNumber = null;

  session.repairFlow.tools = template.tools || [];
  session.repairFlow.steps = template.steps || [];
  session.repairFlow.currentStepIndex = 0;

  session.mode = "repair";
  await req.saveFxSession();

  const step = getCurrentRepairStep(session);
  const powerGate = validateRepairPowerGate(session, step);
  const adv = canAdvanceRepair(session, step);

  return res.json(
    repairEnvelope({
      type: "repair_started_generic",
      session,
      step,
      gate: powerGate,
      canAdvance: adv,
      extra: { tools: session.repairFlow.tools, repairFlow: session.repairFlow }
    })
  );
});

app.get("/session/repair/:id", async (req, res) => {
  const session = await getSessionById(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const rf = session.repairFlow || {};
  const pl = session.partLookup || {};
  const rs = pl.resolution || {};

  if (rf.status !== "active" && rf.status !== "complete") {
    let nextAction = "repair_start";
    let reason = null;

    if (session?.diagnosis?.locked !== true) {
      nextAction = "diagnose";
      reason = "diagnosis_not_locked";
    } else if (pl.status !== "resolved" || rs.status !== "resolved" || rs.replacementReady !== true) {
      nextAction = "part_lookup";
      reason = "part_not_resolved";
    }

    return res.json({
      type: "repair_state",
      sessionId: session.sessionId,
      step: null,
      gate: {
        blocked: true,
        message:
          nextAction === "part_lookup"
            ? "Repair steps are not available yet. Confirm model number and resolve the part first. You can also call /session/repair/start-generic for a generic plan."
            : nextAction === "diagnose"
              ? "Repair steps are not available yet. Finish diagnosis first."
              : "Repair is not started. Call /session/repair/start to generate steps.",
        expectedPowerState: null
      },
      canAdvance: { ok: false, reason: "repair_not_started" },
      nextAction,
      reason,
      statusSnapshot: buildStatusSnapshot(session),
      tools: rf.tools || [],
      repairFlow: rf
    });
  }

  const step = getCurrentRepairStep(session);
  const powerGate = validateRepairPowerGate(session, step);
  const adv = canAdvanceRepair(session, step);

  return res.json(
    repairEnvelope({
      type: "repair_state",
      session,
      step,
      gate: powerGate,
      canAdvance: adv,
      extra: { tools: session.repairFlow?.tools || [], repairFlow: session.repairFlow || {} }
    })
  );
});

app.post("/session/repair/next", requireSession, async (req, res) => {
  return handleRepairNext(req, res);
});

app.post("/session/repair/advance", requireSession, async (req, res) => {
  return handleRepairNext(req, res);
});

app.post("/session/repair/back", requireSession, async (req, res) => {
  const session = req.fxSession;
  const rf = session.repairFlow || {};
  const idx = typeof rf.currentStepIndex === "number" ? rf.currentStepIndex : 0;

  if (rf.status !== "active") {
    return res.status(409).json({ error: "Repair is not active.", sessionId: session.sessionId });
  }

  rf.currentStepIndex = Math.max(0, idx - 1);
  rf.updatedAt = new Date().toISOString();
  await req.saveFxSession();

  const step = getCurrentRepairStep(session);
  const powerGate = validateRepairPowerGate(session, step);
  const adv = canAdvanceRepair(session, step);

  return res.json(
    repairEnvelope({
      type: "repair_back",
      session,
      step,
      gate: powerGate,
      canAdvance: adv,
      extra: { repairFlow: session.repairFlow }
    })
  );
});

app.post("/session/repair/cancel", requireSession, async (req, res) => {
  const session = req.fxSession;
  session.repairFlow = session.repairFlow || {};
  ensurePhase4Fields(session);

  const rf = session.repairFlow;
  rf.status = "cancelled";
  rf.updatedAt = new Date().toISOString();

  if (session.mode === "repair") session.mode = "diagnose";

  await req.saveFxSession();

  return res.json({
    ok: true,
    type: "repair_cancelled",
    sessionId: session.sessionId,
    repairFlow: session.repairFlow,
    statusSnapshot: buildStatusSnapshot(session)
  });
});

app.post("/session/repair/fail", requireSession, async (req, res) => {
  const session = req.fxSession;
  session.repairFlow = session.repairFlow || {};
  ensurePhase4Fields(session);

  const rf = session.repairFlow;
  rf.status = "failed";
  rf.updatedAt = new Date().toISOString();
  rf.completedAt = rf.completedAt || new Date().toISOString();

  session.mode = "outcome";
  session.repairFlow.validation.status = "needs_validation";

  await req.saveFxSession();

  return res.json({
    ok: true,
    type: "repair_failed",
    sessionId: session.sessionId,
    repairFlow: session.repairFlow,
    validation: session.repairFlow.validation,
    statusSnapshot: buildStatusSnapshot(session)
  });
});

app.get("/session/repair/summary/:id", async (req, res) => {
  const session = await getSessionById(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const rf = session.repairFlow || {};
  const pl = session.partLookup || {};
  const rs = pl.resolution || {};

  return res.json({
    ok: true,
    type: "repair_summary",
    sessionId: session.sessionId,
    component: pl.suspectedComponent || rf.componentKey,
    suggestedComponent: pl.suspectedComponent || rf.componentKey,
    partName: rs.partName || rf.partName,
    oemPartNumber: rs.oemPartNumber || rf.oemPartNumber,
    tools: rf.tools || [],
    stepsTotal: Array.isArray(rf.steps) ? rf.steps.length : 0,
    confirmations: rf.confirmations || {},
    status: rf.status || "not_started",
    startedAt: rf.startedAt || null,
    completedAt: rf.completedAt || null,
    statusSnapshot: buildStatusSnapshot(session)
  });
});

app.post("/session/repair/validate", requireSession, requireRepairCompleteForValidation, async (req, res) => {
  const session = req.fxSession;

  const outcome = typeof req.body?.outcome === "string" ? req.body.outcome.trim().toLowerCase() : "";
  const observations = Array.isArray(req.body?.observations) ? req.body.observations : [];
  const notes = Array.isArray(req.body?.notes) ? req.body.notes : [];

  if (!["passed", "partial", "failed"].includes(outcome)) {
    return res.status(400).json({ error: "outcome must be passed, partial, or failed" });
  }

  ensurePhase4Fields(session);

  session.repairFlow.validation.status = "validated";
  session.repairFlow.validation.checkedAt = new Date().toISOString();
  session.repairFlow.validation.userObservations = observations.map((x) => normalizeText(x)).filter(Boolean);
  session.repairFlow.validation.resultNotes = notes.map((x) => normalizeText(x)).filter(Boolean);

  const plan = buildRecoveryPlan(session, outcome, session.repairFlow.validation.userObservations);
  session.repairFlow.validation.recoverySuggested = plan.suggestedKeys;
  session.repairFlow.validation.recoveryPlan = plan;
  session.mode = "outcome";

  await req.saveFxSession();

  return res.json({
    ok: true,
    type: "outcome_validated",
    sessionId: session.sessionId,
    outcome,
    validation: session.repairFlow.validation,
    statusSnapshot: buildStatusSnapshot(session)
  });
});

app.post("/session/repair/recover", requireSession, async (req, res) => {
  const session = req.fxSession;
  ensurePhase4Fields(session);

  const planKey = typeof req.body?.planKey === "string" ? req.body.planKey.trim() : "";

  const plan = session.repairFlow?.validation?.recoveryPlan;
  if (!plan || !Array.isArray(plan.plans)) {
    return res.status(409).json({
      error: "No recovery plan exists. Validate outcome first.",
      sessionId: session.sessionId,
      statusSnapshot: buildStatusSnapshot(session)
    });
  }

  const chosen = plan.plans.find((p) => p.key === planKey);
  if (!chosen) {
    return res.status(400).json({
      error: "Invalid planKey",
      available: plan.plans.map((p) => p.key),
      sessionId: session.sessionId
    });
  }

  session.repairFlow.validation.status = "recovery";
  session.repairFlow.validation.recoveryStartedAt = new Date().toISOString();
  session.repairFlow.validation.recoveryPlan = {
    ...plan,
    chosenKey: chosen.key,
    chosenTitle: chosen.title,
    chosen
  };

  await req.saveFxSession();

  return res.json({
    ok: true,
    type: "recovery_started",
    sessionId: session.sessionId,
    chosen,
    validation: session.repairFlow.validation,
    statusSnapshot: buildStatusSnapshot(session)
  });
});

app.get("/session/outcome/:id", async (req, res) => {
  const session = await getSessionById(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const val = session.repairFlow?.validation || {};
  const value = buildValueSummaryForSession(session, {});

  return res.json({
    ok: true,
    type: "outcome_summary",
    sessionId: session.sessionId,
    mode: session.mode || "outcome",
    validation: val,
    value,
    statusSnapshot: buildStatusSnapshot(session)
  });
});

app.post("/session/value/complete", requireSession, async (req, res) => {
  const session = req.fxSession;

  const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : session.userId || "anon";
  session.userId = userId;

  const actualPartCost = money(req.body?.actualPartCost ?? 0);
  const actualToolCost = money(req.body?.actualToolCost ?? 0);
  const laborHours = req.body?.laborHours;

  const summary = buildValueSummaryForSession(session, { actualPartCost, actualToolCost, laborHours });

  const jobId = uuidv4();
  const record = {
    jobId,
    sessionId: session.sessionId,
    userId,
    at: new Date().toISOString(),
    applianceType: summary.applianceType,
    netSavings: summary.netSavings,
    totalAvoidedCost: summary.totalAvoidedCost,
    outOfPocket: summary.outOfPocket,
    timeSavedMinutes: summary.estimatedTimeSavedMinutes,
    actualPartCost: summary.actualPartCost,
    actualToolCost: summary.actualToolCost
  };

  jobValueStore.set(jobId, record);

  const u = getOrCreateUserValue(userId);
  u.jobs.unshift(record);
  u.totals.totalJobsCompleted += 1;
  u.totals.totalNetSavings = money(u.totals.totalNetSavings + record.netSavings);
  u.totals.totalAvoidedCost = money(u.totals.totalAvoidedCost + record.totalAvoidedCost);
  u.totals.totalOutOfPocket = money(u.totals.totalOutOfPocket + record.outOfPocket);
  u.totals.totalTimeSavedMinutes = minutes(u.totals.totalTimeSavedMinutes + record.timeSavedMinutes);

  await req.saveFxSession();

  return res.json({
    ok: true,
    type: "value_recorded",
    sessionId: session.sessionId,
    job: record,
    userTotals: u.totals,
    statusSnapshot: buildStatusSnapshot(session)
  });
});

app.get("/session/value/user/:userId", (req, res) => {
  const userId = (req.params.userId || "anon").trim();
  const u = getOrCreateUserValue(userId);
  return res.json({ ok: true, userId, totals: u.totals, jobs: u.jobs.slice(0, 50) });
});

app.post("/session/chat", async (req, res) => {
  try {
    const { sessionId, message } = req.body || {};
    if (!sessionId || typeof sessionId !== "string") return res.status(400).json({ error: "sessionId is required" });

    const text = normalizeText(message);
    if (!text) return res.status(400).json({ error: "message is required" });

    const history = await sessionStore.getChatHistory(sessionId);
    history.push({ role: "user", content: text });
    const trimmed = trimHistory(history, 12);

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: "You are FixBuddy. Be brief, safe, and helpful." },
        ...trimmed.map((m) => ({ role: m.role, content: m.content }))
      ]
    });

    const out = normalizeText(response?.output_text || "");
    trimmed.push({ role: "assistant", content: out });

    const finalHistory = trimHistory(trimmed, 12);
    await sessionStore.setChatHistory(sessionId, finalHistory);

    return res.json({ ok: true, sessionId, assistant: out });
  } catch (err) {
    console.error("chat error:", err);
    return res.status(500).json({ error: "Internal error", detail: err?.message || "unknown" });
  }
});

/* =========================================================
   Start and shutdown
========================================================= */

let server = null;

async function start() {
  const HOST = "0.0.0.0";

  await initRedis();

  server = app.listen(PORT, HOST, () => {
    console.log(`FixBuddy backend listening on http://${HOST}:${PORT}`);
    console.log("Redis status:", getRedisStatus());
  });
}

async function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down...`);

  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }

    await closeRedis();
    process.exit(0);
  } catch (err) {
    console.error("Shutdown error:", err);
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

start().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});