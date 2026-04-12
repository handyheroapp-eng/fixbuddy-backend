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

function isControlIntent(message = "") {
  const text = normalizeText(message).toLowerCase();

  return (
    text.includes("don't want") ||
    text.includes("do not want") ||
    text.includes("not ready") ||
    text.includes("troubleshoot") ||
    text.includes("not yet") ||
    text.includes("keep going") ||
    text.includes("continue") ||
    text.includes("figure it out first")
  );
}

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

/* =========================================================
   REASONING ENGINE (NEW)
========================================================= */

function ensureReasoning(session) {
  ensureDiagnosisFields(session);

  const dx = session.diagnosis;

  dx.reasoning = dx.reasoning || {
    symptomFamily: null,
    symptomFamilyConfidence: 0,
    ontologyCandidates: [],
    evidence: [],
    hypotheses: [],
    lastAction: null,
    lockDecision: {
      ready: false,
      reason: null,
      missingEvidence: [],
      conflictingEvidence: [],
      supportingEvidence: []
    }
  };

  if (!Array.isArray(dx.reasoning.ontologyCandidates)) dx.reasoning.ontologyCandidates = [];
  if (!Array.isArray(dx.reasoning.evidence)) dx.reasoning.evidence = [];
  if (!Array.isArray(dx.reasoning.hypotheses)) dx.reasoning.hypotheses = [];

  dx.reasoning.lockDecision = dx.reasoning.lockDecision || {
    ready: false,
    reason: null,
    missingEvidence: [],
    conflictingEvidence: [],
    supportingEvidence: []
  };

  if (!Array.isArray(dx.reasoning.lockDecision.missingEvidence)) {
    dx.reasoning.lockDecision.missingEvidence = [];
  }

  if (!Array.isArray(dx.reasoning.lockDecision.conflictingEvidence)) {
    dx.reasoning.lockDecision.conflictingEvidence = [];
  }

  if (!Array.isArray(dx.reasoning.lockDecision.supportingEvidence)) {
    dx.reasoning.lockDecision.supportingEvidence = [];
  }
}
const DIAGNOSTIC_ONTOLOGY = {
  refrigerator: {
    noise: {
      subsystemCandidates: ["airflow", "compressor_system", "ice_system"],
      components: [
        {
          component: "condenser fan motor",
          subsystem: "airflow",
          evidenceKeys: ["location", "sound_type", "when_happens", "door_stops_noise"],
          evidencePatterns: {
            location: ["back bottom"],
            sound_type: ["squeal", "grinding", "buzzing", "rattle"],
            when_happens: ["during cooling", "always", "constant"],
            door_stops_noise: ["no", "not sure"]
          }
        },
        {
          component: "evaporator fan motor",
          subsystem: "airflow",
          evidenceKeys: ["location", "door_stops_noise", "frost_buildup", "when_happens"],
          evidencePatterns: {
            location: ["inside freezer", "inside fridge"],
            door_stops_noise: ["yes"],
            frost_buildup: ["yes"],
            when_happens: ["after door closes", "during cooling"]
          }
        },
        {
          component: "compressor or mounts",
          subsystem: "compressor_system",
          evidenceKeys: ["location", "sound_type", "when_happens"],
          evidencePatterns: {
            location: ["back bottom", "back top"],
            sound_type: ["rattle", "clicking", "humming"],
            when_happens: ["during cooling", "always", "constant"]
          }
        },
        {
          component: "ice maker or auger",
          subsystem: "ice_system",
          evidenceKeys: ["when_happens", "location", "sound_type"],
          evidencePatterns: {
            when_happens: ["during ice maker"],
            location: ["inside freezer"],
            sound_type: ["grinding", "clicking", "buzzing"]
          }
        },
        {
          component: "defrost or airflow issue",
          subsystem: "airflow",
          evidenceKeys: ["frost_buildup", "location", "when_happens"],
          evidencePatterns: {
            frost_buildup: ["yes"],
            location: ["inside freezer", "inside fridge"],
            when_happens: ["during cooling"]
          }
        }
      ]
    },

    not_cooling: {
      subsystemCandidates: ["airflow", "sealed_system", "defrost"],
      components: [
        {
          component: "evaporator fan motor",
          subsystem: "airflow",
          evidenceKeys: ["freezer_temp", "fridge_temp", "airflow_present", "frost_buildup"],
          evidencePatterns: {
            freezer_temp: ["cold", "very cold"],
            fridge_temp: ["warm", "not cold"],
            airflow_present: ["no", "weak"],
            frost_buildup: ["yes", "not sure"]
          }
        },
        {
          component: "condenser fan motor",
          subsystem: "airflow",
          evidenceKeys: ["compressor_running", "airflow_present", "rear_heat_level"],
          evidencePatterns: {
            compressor_running: ["yes"],
            airflow_present: ["no", "weak"],
            rear_heat_level: ["hot", "very warm"]
          }
        },
        {
          component: "defrost system issue",
          subsystem: "defrost",
          evidenceKeys: ["frost_buildup", "cooling_pattern", "freezer_temp"],
          evidencePatterns: {
            frost_buildup: ["yes"],
            cooling_pattern: ["gets warm over time", "starts cold then warms"],
            freezer_temp: ["warming", "not cold enough"]
          }
        },
        {
          component: "compressor start device",
          subsystem: "sealed_system",
          evidenceKeys: ["clicking", "compressor_running", "rear_heat_level"],
          evidencePatterns: {
            clicking: ["yes"],
            compressor_running: ["no", "intermittent"],
            rear_heat_level: ["warm", "hot"]
          }
        }
      ]
    },

    water_leak: {
      subsystemCandidates: ["drain", "water_supply"],
      components: [
        {
          component: "defrost drain blockage",
          subsystem: "drain",
          evidenceKeys: ["leak_location", "freezer_temp", "frost_buildup"],
          evidencePatterns: {
            leak_location: ["under crisper", "inside fridge floor", "inside freezer floor"],
            freezer_temp: ["cold"],
            frost_buildup: ["yes", "not sure"]
          }
        },
        {
          component: "water inlet valve",
          subsystem: "water_supply",
          evidenceKeys: ["leak_location", "when_happens", "ice_maker_involved"],
          evidencePatterns: {
            leak_location: ["back bottom", "behind fridge"],
            when_happens: ["during fill", "intermittent"],
            ice_maker_involved: ["yes"]
          }
        }
      ]
    },

    ice_maker_issue: {
      subsystemCandidates: ["ice_system", "water_supply", "controls"],
      components: [
        {
          component: "ice maker assembly",
          subsystem: "ice_system",
          evidenceKeys: ["main_symptom", "when_happens", "sound_type"],
          evidencePatterns: {
            main_symptom: ["ice maker not working", "no ice", "ice maker jammed"],
            when_happens: ["always"],
            sound_type: ["clicking", "grinding", "none"]
          }
        },
        {
          component: "water inlet valve",
          subsystem: "water_supply",
          evidenceKeys: ["main_symptom", "when_happens", "ice_maker_involved"],
          evidencePatterns: {
            main_symptom: ["no ice", "small ice", "slow ice production"],
            when_happens: ["during fill"],
            ice_maker_involved: ["yes"]
          }
        },
        {
          component: "ice maker fill tube freeze",
          subsystem: "ice_system",
          evidenceKeys: ["main_symptom", "frost_buildup"],
          evidencePatterns: {
            main_symptom: ["no ice", "ice maker not filling"],
            frost_buildup: ["yes", "not sure"]
          }
        }
      ]
    },

    default: {
      subsystemCandidates: ["general"],
      components: [
        {
          component: "fan motor",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "timing", "location"],
          evidencePatterns: {
            main_symptom: ["noise", "not cooling"],
            timing: ["intermittent", "during cooling"],
            location: ["back bottom", "inside freezer", "inside fridge"]
          }
        },
        {
          component: "control board",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "error_codes", "timing"],
          evidencePatterns: {
            main_symptom: ["not starting", "erratic behavior"],
            error_codes: ["yes"],
            timing: ["intermittent", "always"]
          }
        },
        {
          component: "sensor or switch",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "timing", "location"],
          evidencePatterns: {
            main_symptom: ["light issue", "inconsistent behavior"],
            timing: ["intermittent"],
            location: ["inside fridge", "inside freezer"]
          }
        }
      ]
    }
  },

  dryer: {
    no_start: {
      subsystemCandidates: ["start_circuit", "drive_system", "controls", "heat_circuit"],
      components: [
        {
          component: "drive motor",
          subsystem: "drive_system",
          evidenceKeys: ["sound_type", "drum_moves_by_hand", "door_switch_held_effect", "main_symptom", "drum_spin_status"],
          evidencePatterns: {
            sound_type: ["hum or buzz", "humming", "buzzing", "hum"],
            drum_moves_by_hand: ["moves freely"],
            door_switch_held_effect: ["heater comes on", "drum tries to move"],
            main_symptom: ["dryer does not start", "nothing happens", "won't start"],
            drum_spin_status: ["does not spin", "won't spin"]
          }
        },
        {
          component: "door switch",
          subsystem: "start_circuit",
          evidenceKeys: ["door_switch_response", "door_switch_held_effect", "sound_type", "main_symptom"],
          evidencePatterns: {
            door_switch_response: ["no click", "no response"],
            door_switch_held_effect: ["nothing changes"],
            sound_type: ["no sound"],
            main_symptom: ["dryer does not start", "nothing happens", "won't start"]
          }
        },
        {
          component: "belt switch or idler path",
          subsystem: "drive_system",
          evidenceKeys: ["drum_moves_by_hand", "drum_spin_status", "sound_type", "main_symptom"],
          evidencePatterns: {
            drum_moves_by_hand: ["feels stuck"],
            drum_spin_status: ["does not spin", "won't spin"],
            sound_type: ["hum or buzz", "humming", "buzzing"],
            main_symptom: ["dryer does not start", "nothing happens", "won't start"]
          }
        },
        {
          component: "control board",
          subsystem: "controls",
          evidenceKeys: ["sound_type", "error_codes", "timing", "main_symptom"],
          evidencePatterns: {
            sound_type: ["no sound"],
            error_codes: ["yes"],
            timing: ["always", "intermittent"],
            main_symptom: ["dryer does not start", "nothing happens", "won't start"]
          }
        },
        {
          component: "heater relay stuck or control fault",
          subsystem: "heat_circuit",
          evidenceKeys: ["door_switch_held_effect", "main_symptom", "sound_type"],
          evidencePatterns: {
            door_switch_held_effect: ["heater comes on"],
            main_symptom: ["dryer does not start", "nothing happens"],
            sound_type: ["hum or buzz", "no sound"]
          }
        }
      ]
    },

    no_heat: {
      subsystemCandidates: ["heat_circuit", "airflow", "controls"],
      components: [
        {
          component: "heating element",
          subsystem: "heat_circuit",
          evidenceKeys: ["main_symptom", "timing", "airflow_present"],
          evidencePatterns: {
            main_symptom: ["runs but no heat", "not heating", "cold air"],
            timing: ["always"],
            airflow_present: ["yes", "strong"]
          }
        },
        {
          component: "thermal fuse or thermal cut off",
          subsystem: "heat_circuit",
          evidenceKeys: ["main_symptom", "timing", "sound_type"],
          evidencePatterns: {
            main_symptom: ["runs but no heat", "not heating"],
            timing: ["sudden failure"],
            sound_type: ["normal"]
          }
        },
        {
          component: "cycling thermostat",
          subsystem: "heat_circuit",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["weak heat", "intermittent heat"],
            timing: ["intermittent"]
          }
        },
        {
          component: "restricted vent or airflow issue",
          subsystem: "airflow",
          evidenceKeys: ["main_symptom", "airflow_present", "timing"],
          evidencePatterns: {
            main_symptom: ["takes too long to dry", "overheats", "weak heat"],
            airflow_present: ["weak", "low"],
            timing: ["always"]
          }
        }
      ]
    },

    noise: {
      subsystemCandidates: ["drive_system", "airflow"],
      components: [
        {
          component: "idler pulley",
          subsystem: "drive_system",
          evidenceKeys: ["sound_type", "timing", "main_symptom"],
          evidencePatterns: {
            sound_type: ["squeal", "squeaking"],
            timing: ["during start", "while running"],
            main_symptom: ["noise"]
          }
        },
        {
          component: "drum support roller",
          subsystem: "drive_system",
          evidenceKeys: ["sound_type", "timing", "main_symptom"],
          evidencePatterns: {
            sound_type: ["thump", "rumble", "thumping"],
            timing: ["while running"],
            main_symptom: ["noise"]
          }
        },
        {
          component: "blower wheel",
          subsystem: "airflow",
          evidenceKeys: ["sound_type", "location", "timing"],
          evidencePatterns: {
            sound_type: ["rattle", "scraping", "buzzing"],
            location: ["front", "blower area"],
            timing: ["while running"]
          }
        },
        {
          component: "drive motor",
          subsystem: "drive_system",
          evidenceKeys: ["sound_type", "timing"],
          evidencePatterns: {
            sound_type: ["hum or buzz", "grinding"],
            timing: ["during start", "while running"]
          }
        }
      ]
    },

    not_spinning: {
      subsystemCandidates: ["drive_system"],
      components: [
        {
          component: "belt switch or idler path",
          subsystem: "drive_system",
          evidenceKeys: ["drum_spin_status", "drum_moves_by_hand", "sound_type"],
          evidencePatterns: {
            drum_spin_status: ["does not spin", "won't spin"],
            drum_moves_by_hand: ["moves freely"],
            sound_type: ["motor runs", "hum or buzz"]
          }
        },
        {
          component: "drive motor",
          subsystem: "drive_system",
          evidenceKeys: ["drum_spin_status", "sound_type", "door_switch_held_effect"],
          evidencePatterns: {
            drum_spin_status: ["does not spin", "won't spin"],
            sound_type: ["hum or buzz", "humming"],
            door_switch_held_effect: ["heater comes on", "drum tries to move"]
          }
        }
      ]
    },

    default: {
      subsystemCandidates: ["general"],
      components: [
        {
          component: "drive motor",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["won't start", "does not start"],
            timing: ["always", "intermittent"]
          }
        },
        {
          component: "door switch",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["won't start", "stops when door opens"],
            timing: ["always"]
          }
        },
        {
          component: "control board",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "error_codes"],
          evidencePatterns: {
            main_symptom: ["erratic behavior", "won't start"],
            error_codes: ["yes"]
          }
        }
      ]
    }
  },

  washer: {
    not_draining: {
      subsystemCandidates: ["drain_system", "controls"],
      components: [
        {
          component: "drain pump",
          subsystem: "drain_system",
          evidenceKeys: ["main_symptom", "sound_type", "timing"],
          evidencePatterns: {
            main_symptom: ["not draining", "standing water", "water remains"],
            sound_type: ["humming", "buzzing", "grinding"],
            timing: ["drain cycle", "spin cycle"]
          }
        },
        {
          component: "drain hose blockage",
          subsystem: "drain_system",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["not draining", "slow drain"],
            timing: ["drain cycle"]
          }
        },
        {
          component: "lid switch",
          subsystem: "controls",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["won't spin", "won't drain"],
            timing: ["spin cycle"]
          }
        }
      ]
    },

    not_spinning: {
      subsystemCandidates: ["drive_system", "controls"],
      components: [
        {
          component: "lid switch",
          subsystem: "controls",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["won't spin", "stops before spin"],
            timing: ["spin cycle"]
          }
        },
        {
          component: "drive belt or coupler",
          subsystem: "drive_system",
          evidenceKeys: ["main_symptom", "sound_type"],
          evidencePatterns: {
            main_symptom: ["agitates but won't spin", "won't spin"],
            sound_type: ["motor runs", "humming"]
          }
        },
        {
          component: "drive motor",
          subsystem: "drive_system",
          evidenceKeys: ["main_symptom", "sound_type"],
          evidencePatterns: {
            main_symptom: ["won't spin", "won't agitate"],
            sound_type: ["hum or buzz", "humming"]
          }
        }
      ]
    },

    water_leak: {
      subsystemCandidates: ["water_system", "drain_system"],
      components: [
        {
          component: "door boot or tub seal",
          subsystem: "water_system",
          evidenceKeys: ["leak_location", "when_happens"],
          evidencePatterns: {
            leak_location: ["front", "door area"],
            when_happens: ["during wash", "during fill"]
          }
        },
        {
          component: "drain hose",
          subsystem: "drain_system",
          evidenceKeys: ["leak_location", "when_happens"],
          evidencePatterns: {
            leak_location: ["back", "floor behind washer"],
            when_happens: ["during drain", "during spin"]
          }
        },
        {
          component: "water inlet valve",
          subsystem: "water_system",
          evidenceKeys: ["leak_location", "when_happens"],
          evidencePatterns: {
            leak_location: ["back top", "inlet area"],
            when_happens: ["during fill"]
          }
        }
      ]
    },

    noise: {
      subsystemCandidates: ["drive_system", "drain_system"],
      components: [
        {
          component: "drain pump",
          subsystem: "drain_system",
          evidenceKeys: ["sound_type", "timing"],
          evidencePatterns: {
            sound_type: ["grinding", "buzzing", "rattle"],
            timing: ["during drain"]
          }
        },
        {
          component: "bearing or tub support",
          subsystem: "drive_system",
          evidenceKeys: ["sound_type", "timing"],
          evidencePatterns: {
            sound_type: ["roaring", "rumbling", "grinding"],
            timing: ["during spin"]
          }
        },
        {
          component: "drive belt or pulley",
          subsystem: "drive_system",
          evidenceKeys: ["sound_type", "timing"],
          evidencePatterns: {
            sound_type: ["squeal", "squeaking"],
            timing: ["during spin", "during agitation"]
          }
        }
      ]
    },

    default: {
      subsystemCandidates: ["general"],
      components: [
        {
          component: "drain pump",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "timing", "sound_type"],
          evidencePatterns: {
            main_symptom: ["not draining", "noise"],
            timing: ["drain cycle"],
            sound_type: ["buzzing", "grinding"]
          }
        },
        {
          component: "lid switch",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["won't spin"],
            timing: ["spin cycle"]
          }
        },
        {
          component: "drive motor",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "sound_type"],
          evidencePatterns: {
            main_symptom: ["won't spin", "won't agitate"],
            sound_type: ["hum or buzz", "humming"]
          }
        }
      ]
    }
  },

  dishwasher: {
    not_draining: {
      subsystemCandidates: ["drain_system", "controls"],
      components: [
        {
          component: "drain pump",
          subsystem: "drain_system",
          evidenceKeys: ["main_symptom", "sound_type", "timing"],
          evidencePatterns: {
            main_symptom: ["not draining", "standing water"],
            sound_type: ["humming", "buzzing", "grinding"],
            timing: ["end of cycle", "drain cycle"]
          }
        },
        {
          component: "drain hose blockage",
          subsystem: "drain_system",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["not draining", "slow drain"],
            timing: ["end of cycle", "drain cycle"]
          }
        },
        {
          component: "control board",
          subsystem: "controls",
          evidenceKeys: ["error_codes", "main_symptom"],
          evidencePatterns: {
            error_codes: ["yes"],
            main_symptom: ["not draining"]
          }
        }
      ]
    },

    water_leak: {
      subsystemCandidates: ["water_system", "door_system"],
      components: [
        {
          component: "door gasket",
          subsystem: "door_system",
          evidenceKeys: ["leak_location", "when_happens"],
          evidencePatterns: {
            leak_location: ["front", "door area"],
            when_happens: ["during wash"]
          }
        },
        {
          component: "water inlet valve",
          subsystem: "water_system",
          evidenceKeys: ["leak_location", "when_happens"],
          evidencePatterns: {
            leak_location: ["left front", "bottom front", "under unit"],
            when_happens: ["during fill"]
          }
        },
        {
          component: "circulation pump seal",
          subsystem: "water_system",
          evidenceKeys: ["leak_location", "when_happens"],
          evidencePatterns: {
            leak_location: ["under unit", "center bottom"],
            when_happens: ["during wash"]
          }
        }
      ]
    },

    not_cleaning: {
      subsystemCandidates: ["wash_system", "water_supply"],
      components: [
        {
          component: "circulation pump",
          subsystem: "wash_system",
          evidenceKeys: ["main_symptom", "sound_type", "timing"],
          evidencePatterns: {
            main_symptom: ["not cleaning", "spray arms not spinning"],
            sound_type: ["humming", "weak spray noise"],
            timing: ["wash cycle"]
          }
        },
        {
          component: "spray arm blockage",
          subsystem: "wash_system",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["not cleaning", "top rack dirty", "bottom rack dirty"],
            timing: ["every cycle"]
          }
        },
        {
          component: "water inlet valve",
          subsystem: "water_supply",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["not cleaning", "low fill"],
            timing: ["start of cycle"]
          }
        }
      ]
    },

    noise: {
      subsystemCandidates: ["wash_system", "drain_system"],
      components: [
        {
          component: "circulation pump",
          subsystem: "wash_system",
          evidenceKeys: ["sound_type", "timing"],
          evidencePatterns: {
            sound_type: ["grinding", "buzzing", "loud hum"],
            timing: ["wash cycle"]
          }
        },
        {
          component: "drain pump",
          subsystem: "drain_system",
          evidenceKeys: ["sound_type", "timing"],
          evidencePatterns: {
            sound_type: ["grinding", "buzzing"],
            timing: ["drain cycle"]
          }
        },
        {
          component: "spray arm hitting item",
          subsystem: "wash_system",
          evidenceKeys: ["sound_type", "timing"],
          evidencePatterns: {
            sound_type: ["clicking", "tapping"],
            timing: ["wash cycle"]
          }
        }
      ]
    },

    default: {
      subsystemCandidates: ["general"],
      components: [
        {
          component: "drain pump",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "timing", "sound_type"],
          evidencePatterns: {
            main_symptom: ["not draining", "noise"],
            timing: ["drain cycle"],
            sound_type: ["buzzing", "grinding"]
          }
        },
        {
          component: "circulation pump",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "sound_type"],
          evidencePatterns: {
            main_symptom: ["not cleaning", "noise"],
            sound_type: ["buzzing", "grinding"]
          }
        },
        {
          component: "door latch",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["won't start", "door error"],
            timing: ["start of cycle"]
          }
        }
      ]
    }
  },

  oven: {
    no_heat: {
      subsystemCandidates: ["heat_circuit", "ignition", "controls"],
      components: [
        {
          component: "bake igniter",
          subsystem: "ignition",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["gas oven won't heat", "glows but no flame", "no heat"],
            timing: ["bake cycle"]
          }
        },
        {
          component: "heating element",
          subsystem: "heat_circuit",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["electric oven won't heat", "no heat", "weak heat"],
            timing: ["bake cycle"]
          }
        },
        {
          component: "temperature sensor",
          subsystem: "controls",
          evidenceKeys: ["main_symptom", "error_codes"],
          evidencePatterns: {
            main_symptom: ["wrong temperature", "overheats", "underheats"],
            error_codes: ["yes", "not sure"]
          }
        },
        {
          component: "control board",
          subsystem: "controls",
          evidenceKeys: ["main_symptom", "error_codes"],
          evidencePatterns: {
            main_symptom: ["no heat", "erratic heating"],
            error_codes: ["yes"]
          }
        }
      ]
    },

    default: {
      subsystemCandidates: ["general"],
      components: [
        {
          component: "bake igniter",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["no heat"],
            timing: ["bake cycle"]
          }
        },
        {
          component: "heating element",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["no heat"],
            timing: ["bake cycle"]
          }
        },
        {
          component: "control board",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "error_codes"],
          evidencePatterns: {
            main_symptom: ["erratic heating"],
            error_codes: ["yes"]
          }
        }
      ]
    }
  },

  microwave: {
    no_heat: {
      subsystemCandidates: ["door_system", "controls", "high_voltage"],
      components: [
        {
          component: "door switch",
          subsystem: "door_system",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["runs but no heat", "won't start", "stops when door moves"],
            timing: ["start", "intermittent"]
          }
        },
        {
          component: "control board",
          subsystem: "controls",
          evidenceKeys: ["main_symptom", "error_codes"],
          evidencePatterns: {
            main_symptom: ["won't start", "runs but no heat"],
            error_codes: ["yes"]
          }
        },
        {
          component: "high voltage system fault",
          subsystem: "high_voltage",
          evidenceKeys: ["main_symptom", "sound_type"],
          evidencePatterns: {
            main_symptom: ["runs but no heat"],
            sound_type: ["loud hum", "buzzing", "burning smell"]
          }
        }
      ]
    },

    default: {
      subsystemCandidates: ["general"],
      components: [
        {
          component: "door switch",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["won't start", "door issue"],
            timing: ["intermittent", "start"]
          }
        },
        {
          component: "turntable motor",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "location"],
          evidencePatterns: {
            main_symptom: ["turntable not spinning", "noise"],
            location: ["bottom", "inside cavity"]
          }
        },
        {
          component: "control board",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "error_codes"],
          evidencePatterns: {
            main_symptom: ["won't start", "erratic behavior"],
            error_codes: ["yes"]
          }
        }
      ]
    }
  },

  hvac: {
    no_start: {
      subsystemCandidates: ["start_circuit", "fan_system", "controls"],
      components: [
        {
          component: "capacitor",
          subsystem: "start_circuit",
          evidenceKeys: ["main_symptom", "humming", "fan_spins_by_hand"],
          evidencePatterns: {
            main_symptom: ["won't start", "outside unit hums"],
            humming: ["yes"],
            fan_spins_by_hand: ["yes", "starts when pushed"]
          }
        },
        {
          component: "contactor",
          subsystem: "controls",
          evidenceKeys: ["main_symptom", "clicking", "timing"],
          evidencePatterns: {
            main_symptom: ["won't start"],
            clicking: ["yes"],
            timing: ["call for cooling"]
          }
        },
        {
          component: "blower motor",
          subsystem: "fan_system",
          evidenceKeys: ["main_symptom", "airflow_present", "sound_type"],
          evidencePatterns: {
            main_symptom: ["indoor unit won't blow", "no airflow"],
            airflow_present: ["no"],
            sound_type: ["hum or buzz", "no sound"]
          }
        }
      ]
    },

    no_cooling: {
      subsystemCandidates: ["start_circuit", "fan_system", "controls"],
      components: [
        {
          component: "capacitor",
          subsystem: "start_circuit",
          evidenceKeys: ["main_symptom", "humming", "fan_spins_by_hand"],
          evidencePatterns: {
            main_symptom: ["not cooling", "outside unit not running"],
            humming: ["yes"],
            fan_spins_by_hand: ["yes", "starts when pushed"]
          }
        },
        {
          component: "contactor",
          subsystem: "controls",
          evidenceKeys: ["main_symptom", "clicking", "timing"],
          evidencePatterns: {
            main_symptom: ["not cooling"],
            clicking: ["yes"],
            timing: ["call for cooling"]
          }
        },
        {
          component: "blower motor",
          subsystem: "fan_system",
          evidenceKeys: ["main_symptom", "airflow_present"],
          evidencePatterns: {
            main_symptom: ["not cooling", "weak airflow"],
            airflow_present: ["no", "weak"]
          }
        }
      ]
    },

    no_heat: {
      subsystemCandidates: ["controls", "ignition", "fan_system"],
      components: [
        {
          component: "thermostat or control signal issue",
          subsystem: "controls",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["no heat", "furnace won't start"],
            timing: ["call for heat"]
          }
        },
        {
          component: "igniter or flame sensing fault",
          subsystem: "ignition",
          evidenceKeys: ["main_symptom", "sound_type", "timing"],
          evidencePatterns: {
            main_symptom: ["no heat", "furnace starts then stops"],
            sound_type: ["clicking", "igniter glow"],
            timing: ["call for heat"]
          }
        },
        {
          component: "blower motor",
          subsystem: "fan_system",
          evidenceKeys: ["main_symptom", "airflow_present"],
          evidencePatterns: {
            main_symptom: ["no heat", "weak heat"],
            airflow_present: ["no", "weak"]
          }
        }
      ]
    },

    water_leak: {
      subsystemCandidates: ["drain_system", "coil_system"],
      components: [
        {
          component: "condensate drain blockage",
          subsystem: "drain_system",
          evidenceKeys: ["main_symptom", "leak_location", "when_happens"],
          evidencePatterns: {
            main_symptom: ["hvac water leak", "water near air handler"],
            leak_location: ["air handler", "indoor unit", "drain pan"],
            when_happens: ["during cooling"]
          }
        },
        {
          component: "frozen evaporator coil",
          subsystem: "coil_system",
          evidenceKeys: ["main_symptom", "airflow_present", "when_happens"],
          evidencePatterns: {
            main_symptom: ["hvac water leak", "not cooling"],
            airflow_present: ["weak"],
            when_happens: ["during cooling"]
          }
        }
      ]
    },

    default: {
      subsystemCandidates: ["general"],
      components: [
        {
          component: "blower motor",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "sound_type", "airflow_present"],
          evidencePatterns: {
            main_symptom: ["no airflow", "weak airflow"],
            sound_type: ["hum or buzz"],
            airflow_present: ["no", "weak"]
          }
        },
        {
          component: "contactor",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "clicking", "timing"],
          evidencePatterns: {
            main_symptom: ["won't start", "not cooling"],
            clicking: ["yes"],
            timing: ["call for cooling"]
          }
        },
        {
          component: "capacitor",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "humming", "fan_spins_by_hand"],
          evidencePatterns: {
            main_symptom: ["won't start", "not cooling"],
            humming: ["yes"],
            fan_spins_by_hand: ["yes"]
          }
        }
      ]
    }
  },

  plumbing: {
    faucet_leak: {
      subsystemCandidates: ["spout_path", "handle_path", "drain_path", "supply_path"],
      components: [
        {
          component: "cartridge",
          subsystem: "handle_path",
          evidenceKeys: ["leak_location", "when_happens", "main_symptom"],
          evidencePatterns: {
            leak_location: ["spout", "handle base"],
            when_happens: ["when off", "always", "intermittent drip"],
            main_symptom: ["faucet leaks", "dripping faucet", "water drips from spout"]
          }
        },
        {
          component: "valve seat or washer",
          subsystem: "spout_path",
          evidenceKeys: ["leak_location", "when_happens", "sound_type"],
          evidencePatterns: {
            leak_location: ["spout"],
            when_happens: ["when off", "always", "intermittent drip"],
            sound_type: ["drip", "dripping"]
          }
        },
        {
          component: "o ring or handle seal",
          subsystem: "handle_path",
          evidenceKeys: ["leak_location", "when_happens", "main_symptom"],
          evidencePatterns: {
            leak_location: ["handle", "handle base"],
            when_happens: ["when on", "when moving handle"],
            main_symptom: ["water around handle", "leak near handle"]
          }
        },
        {
          component: "supply line connection",
          subsystem: "supply_path",
          evidenceKeys: ["leak_location", "when_happens", "main_symptom"],
          evidencePatterns: {
            leak_location: ["under sink", "supply line", "cabinet bottom"],
            when_happens: ["when on", "during use"],
            main_symptom: ["leak under sink", "water in cabinet"]
          }
        },
        {
          component: "drain flange or p trap connection",
          subsystem: "drain_path",
          evidenceKeys: ["leak_location", "when_happens", "main_symptom"],
          evidencePatterns: {
            leak_location: ["drain", "p trap", "under sink"],
            when_happens: ["during drain", "after running water"],
            main_symptom: ["leak under sink", "drain leaks"]
          }
        }
      ]
    },

    faucet_no_water: {
      subsystemCandidates: ["aerator_path", "cartridge_path", "supply_path"],
      components: [
        {
          component: "clogged aerator",
          subsystem: "aerator_path",
          evidenceKeys: ["main_symptom", "airflow_present", "timing"],
          evidencePatterns: {
            main_symptom: ["low water flow", "weak stream", "faucet barely runs"],
            airflow_present: ["weak"],
            timing: ["always"]
          }
        },
        {
          component: "blocked cartridge",
          subsystem: "cartridge_path",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["low water flow", "handle turns but little water"],
            timing: ["always", "worse over time"]
          }
        },
        {
          component: "partially closed supply valve",
          subsystem: "supply_path",
          evidenceKeys: ["main_symptom", "leak_location"],
          evidencePatterns: {
            main_symptom: ["low water flow", "no water"],
            leak_location: ["under sink", "supply line"]
          }
        }
      ]
    },

    clogged_drain: {
      subsystemCandidates: ["drain_path", "trap_path", "vent_path"],
      components: [
        {
          component: "drain blockage",
          subsystem: "drain_path",
          evidenceKeys: ["main_symptom", "timing", "leak_location"],
          evidencePatterns: {
            main_symptom: ["drain clogged", "slow drain", "sink backs up"],
            timing: ["during drain", "always"],
            leak_location: ["sink", "tub", "shower"]
          }
        },
        {
          component: "p trap blockage",
          subsystem: "trap_path",
          evidenceKeys: ["main_symptom", "leak_location"],
          evidencePatterns: {
            main_symptom: ["slow drain", "sink backs up"],
            leak_location: ["under sink", "sink"]
          }
        },
        {
          component: "venting issue",
          subsystem: "vent_path",
          evidenceKeys: ["main_symptom", "sound_type"],
          evidencePatterns: {
            main_symptom: ["slow drain"],
            sound_type: ["gurgling", "glugging"]
          }
        }
      ]
    },

    running_toilet: {
      subsystemCandidates: ["tank_path", "fill_path", "flush_path"],
      components: [
        {
          component: "flapper",
          subsystem: "flush_path",
          evidenceKeys: ["main_symptom", "timing", "sound_type"],
          evidencePatterns: {
            main_symptom: ["toilet keeps running", "toilet runs constantly"],
            timing: ["always", "after flush"],
            sound_type: ["running water"]
          }
        },
        {
          component: "fill valve",
          subsystem: "fill_path",
          evidenceKeys: ["main_symptom", "timing", "sound_type"],
          evidencePatterns: {
            main_symptom: ["toilet keeps running", "tank overfills"],
            timing: ["always", "after refill"],
            sound_type: ["hissing", "running water"]
          }
        },
        {
          component: "chain adjustment issue",
          subsystem: "flush_path",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["toilet runs after flush"],
            timing: ["after flush"]
          }
        }
      ]
    },

    toilet_leak: {
      subsystemCandidates: ["tank_path", "base_path", "supply_path"],
      components: [
        {
          component: "wax ring or base seal",
          subsystem: "base_path",
          evidenceKeys: ["main_symptom", "leak_location", "when_happens"],
          evidencePatterns: {
            main_symptom: ["toilet leaks", "water around toilet base"],
            leak_location: ["base", "floor around toilet"],
            when_happens: ["after flush"]
          }
        },
        {
          component: "tank to bowl gasket",
          subsystem: "tank_path",
          evidenceKeys: ["main_symptom", "leak_location", "when_happens"],
          evidencePatterns: {
            main_symptom: ["toilet leaks"],
            leak_location: ["between tank and bowl", "back of toilet"],
            when_happens: ["after flush", "always"]
          }
        },
        {
          component: "supply line connection",
          subsystem: "supply_path",
          evidenceKeys: ["main_symptom", "leak_location"],
          evidencePatterns: {
            main_symptom: ["toilet leaks"],
            leak_location: ["supply line", "shutoff valve"]
          }
        }
      ]
    },

    water_heater_no_hot_water: {
      subsystemCandidates: ["heat_path", "gas_path", "controls"],
      components: [
        {
          component: "heating element",
          subsystem: "heat_path",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["no hot water", "not enough hot water"],
            timing: ["always"]
          }
        },
        {
          component: "thermostat",
          subsystem: "controls",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["no hot water", "water not hot enough"],
            timing: ["always", "intermittent"]
          }
        },
        {
          component: "pilot or burner issue",
          subsystem: "gas_path",
          evidenceKeys: ["main_symptom", "sound_type"],
          evidencePatterns: {
            main_symptom: ["no hot water"],
            sound_type: ["no flame", "clicking", "pilot out"]
          }
        }
      ]
    },

    water_heater_leak: {
      subsystemCandidates: ["tank_path", "connection_path", "relief_path"],
      components: [
        {
          component: "water connection leak",
          subsystem: "connection_path",
          evidenceKeys: ["main_symptom", "leak_location"],
          evidencePatterns: {
            main_symptom: ["water heater leaks"],
            leak_location: ["top connection", "pipe connection"]
          }
        },
        {
          component: "temperature and pressure relief valve",
          subsystem: "relief_path",
          evidenceKeys: ["main_symptom", "leak_location", "when_happens"],
          evidencePatterns: {
            main_symptom: ["water heater leaks"],
            leak_location: ["relief valve", "side valve"],
            when_happens: ["during heating", "intermittent"]
          }
        },
        {
          component: "tank failure",
          subsystem: "tank_path",
          evidenceKeys: ["main_symptom", "leak_location"],
          evidencePatterns: {
            main_symptom: ["water heater leaks"],
            leak_location: ["bottom", "tank base"]
          }
        }
      ]
    },

    default: {
      subsystemCandidates: ["general"],
      components: [
        {
          component: "cartridge",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "leak_location", "when_happens"],
          evidencePatterns: {
            main_symptom: ["faucet leaks", "dripping faucet"],
            leak_location: ["spout", "handle base"],
            when_happens: ["when off", "always"]
          }
        },
        {
          component: "supply connection",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "leak_location"],
          evidencePatterns: {
            main_symptom: ["leak under sink"],
            leak_location: ["under sink", "supply line"]
          }
        },
        {
          component: "drain blockage",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["slow drain", "drain clogged"],
            timing: ["during drain", "always"]
          }
        }
      ]
    }
  },

  electrical: {
    light_not_working: {
      subsystemCandidates: ["lamp_path", "switch_path", "fixture_path", "circuit_path"],
      components: [
        {
          component: "burned out bulb",
          subsystem: "lamp_path",
          evidenceKeys: ["main_symptom", "timing", "error_codes"],
          evidencePatterns: {
            main_symptom: ["light not working", "light out", "won't turn on"],
            timing: ["sudden failure"],
            error_codes: ["no", "not sure"]
          }
        },
        {
          component: "wall switch",
          subsystem: "switch_path",
          evidenceKeys: ["main_symptom", "timing", "sound_type"],
          evidencePatterns: {
            main_symptom: ["light not working", "switch does nothing"],
            timing: ["always"],
            sound_type: ["no click", "loose switch"]
          }
        },
        {
          component: "fixture socket or internal connection",
          subsystem: "fixture_path",
          evidenceKeys: ["main_symptom", "timing", "location"],
          evidencePatterns: {
            main_symptom: ["light not working", "intermittent light"],
            timing: ["intermittent", "after bulb change"],
            location: ["fixture", "ceiling", "lamp socket"]
          }
        },
        {
          component: "tripped breaker or open circuit",
          subsystem: "circuit_path",
          evidenceKeys: ["main_symptom", "timing", "location"],
          evidencePatterns: {
            main_symptom: ["multiple lights out", "no power to room"],
            timing: ["sudden failure"],
            location: ["room", "circuit", "breaker"]
          }
        }
      ]
    },

    light_flickering: {
      subsystemCandidates: ["lamp_path", "switch_path", "fixture_path", "circuit_path"],
      components: [
        {
          component: "loose bulb",
          subsystem: "lamp_path",
          evidenceKeys: ["main_symptom", "timing", "location"],
          evidencePatterns: {
            main_symptom: ["flickering light", "light flickers"],
            timing: ["intermittent", "when touched"],
            location: ["bulb", "fixture"]
          }
        },
        {
          component: "dimmer incompatibility or failing dimmer",
          subsystem: "switch_path",
          evidenceKeys: ["main_symptom", "timing", "location"],
          evidencePatterns: {
            main_symptom: ["flickering light"],
            timing: ["when dimmed", "intermittent"],
            location: ["switch", "dimmer"]
          }
        },
        {
          component: "loose switch or connection",
          subsystem: "switch_path",
          evidenceKeys: ["main_symptom", "timing", "sound_type"],
          evidencePatterns: {
            main_symptom: ["flickering light"],
            timing: ["when switch touched", "intermittent"],
            sound_type: ["buzzing", "crackle"]
          }
        },
        {
          component: "fixture connection issue",
          subsystem: "fixture_path",
          evidenceKeys: ["main_symptom", "timing", "location"],
          evidencePatterns: {
            main_symptom: ["flickering light"],
            timing: ["always", "intermittent"],
            location: ["fixture", "ceiling"]
          }
        }
      ]
    },

    outlet_not_working: {
      subsystemCandidates: ["receptacle_path", "gfci_path", "circuit_path"],
      components: [
        {
          component: "tripped gfci",
          subsystem: "gfci_path",
          evidenceKeys: ["main_symptom", "location", "timing"],
          evidencePatterns: {
            main_symptom: ["outlet not working", "no power"],
            location: ["bathroom", "kitchen", "garage", "outdoor"],
            timing: ["sudden failure"]
          }
        },
        {
          component: "worn outlet",
          subsystem: "receptacle_path",
          evidenceKeys: ["main_symptom", "timing", "sound_type"],
          evidencePatterns: {
            main_symptom: ["outlet not working", "plug falls out"],
            timing: ["always", "intermittent"],
            sound_type: ["buzzing", "warm outlet"]
          }
        },
        {
          component: "tripped breaker or circuit issue",
          subsystem: "circuit_path",
          evidenceKeys: ["main_symptom", "location", "timing"],
          evidencePatterns: {
            main_symptom: ["multiple outlets dead", "no power"],
            location: ["room", "circuit"],
            timing: ["sudden failure"]
          }
        }
      ]
    },

    breaker_trips: {
      subsystemCandidates: ["circuit_path", "load_path"],
      components: [
        {
          component: "overloaded circuit",
          subsystem: "load_path",
          evidenceKeys: ["main_symptom", "timing", "location"],
          evidencePatterns: {
            main_symptom: ["breaker trips", "power trips"],
            timing: ["when appliance starts", "during heavy use"],
            location: ["room", "circuit"]
          }
        },
        {
          component: "short or fault on circuit",
          subsystem: "circuit_path",
          evidenceKeys: ["main_symptom", "timing", "sound_type"],
          evidencePatterns: {
            main_symptom: ["breaker trips immediately", "breaker won't reset"],
            timing: ["immediate", "always"],
            sound_type: ["spark", "burning smell", "buzzing"]
          }
        }
      ]
    },

    default: {
      subsystemCandidates: ["general"],
      components: [
        {
          component: "burned out bulb",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["light not working"],
            timing: ["sudden failure"]
          }
        },
        {
          component: "wall switch",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "location"],
          evidencePatterns: {
            main_symptom: ["switch does nothing", "light not working"],
            location: ["switch"]
          }
        },
        {
          component: "fixture connection issue",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["flickering light", "intermittent light"],
            timing: ["intermittent"]
          }
        }
      ]
    }
  },

  fans: {
    ceiling_fan_not_spinning: {
      subsystemCandidates: ["motor_path", "capacitor_path", "switch_path", "mount_path"],
      components: [
        {
          component: "run capacitor",
          subsystem: "capacitor_path",
          evidenceKeys: ["main_symptom", "sound_type", "fan_spins_by_hand"],
          evidencePatterns: {
            main_symptom: ["fan not spinning", "ceiling fan won't spin"],
            sound_type: ["hum or buzz", "humming"],
            fan_spins_by_hand: ["yes", "starts when pushed"]
          }
        },
        {
          component: "fan motor",
          subsystem: "motor_path",
          evidenceKeys: ["main_symptom", "sound_type", "timing"],
          evidencePatterns: {
            main_symptom: ["fan not spinning", "ceiling fan won't spin"],
            sound_type: ["hum or buzz", "burning smell"],
            timing: ["always"]
          }
        },
        {
          component: "wall switch or pull chain switch",
          subsystem: "switch_path",
          evidenceKeys: ["main_symptom", "timing", "location"],
          evidencePatterns: {
            main_symptom: ["fan does nothing", "fan not spinning"],
            timing: ["always"],
            location: ["switch", "pull chain"]
          }
        },
        {
          component: "receiver or remote module",
          subsystem: "switch_path",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["fan does nothing", "remote does not work"],
            timing: ["always", "intermittent"]
          }
        }
      ]
    },

    ceiling_fan_noise: {
      subsystemCandidates: ["mount_path", "blade_path", "motor_path"],
      components: [
        {
          component: "loose blade screws or blade imbalance",
          subsystem: "blade_path",
          evidenceKeys: ["main_symptom", "sound_type", "timing"],
          evidencePatterns: {
            main_symptom: ["fan noise", "wobble", "shaking"],
            sound_type: ["clicking", "tapping", "wobble"],
            timing: ["while running"]
          }
        },
        {
          component: "loose mounting bracket or canopy",
          subsystem: "mount_path",
          evidenceKeys: ["main_symptom", "sound_type", "timing"],
          evidencePatterns: {
            main_symptom: ["fan noise", "wobble", "shaking"],
            sound_type: ["rattle", "clunk"],
            timing: ["while running"]
          }
        },
        {
          component: "fan motor bearings",
          subsystem: "motor_path",
          evidenceKeys: ["main_symptom", "sound_type", "timing"],
          evidencePatterns: {
            main_symptom: ["fan noise"],
            sound_type: ["grinding", "humming", "buzzing"],
            timing: ["while running", "always"]
          }
        }
      ]
    },

    exhaust_fan_issue: {
      subsystemCandidates: ["motor_path", "switch_path", "airflow_path"],
      components: [
        {
          component: "fan motor",
          subsystem: "motor_path",
          evidenceKeys: ["main_symptom", "sound_type", "timing"],
          evidencePatterns: {
            main_symptom: ["bathroom fan not working", "fan hums but won't spin", "fan weak"],
            sound_type: ["hum or buzz", "grinding"],
            timing: ["always"]
          }
        },
        {
          component: "fan blade obstruction or dust buildup",
          subsystem: "airflow_path",
          evidenceKeys: ["main_symptom", "sound_type", "airflow_present"],
          evidencePatterns: {
            main_symptom: ["fan weak", "fan noisy"],
            sound_type: ["rattle", "scraping"],
            airflow_present: ["weak", "low"]
          }
        },
        {
          component: "wall switch",
          subsystem: "switch_path",
          evidenceKeys: ["main_symptom", "timing", "location"],
          evidencePatterns: {
            main_symptom: ["fan does nothing", "won't turn on"],
            timing: ["always"],
            location: ["switch"]
          }
        }
      ]
    },

    default: {
      subsystemCandidates: ["general"],
      components: [
        {
          component: "run capacitor",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "fan_spins_by_hand", "sound_type"],
          evidencePatterns: {
            main_symptom: ["fan not spinning"],
            fan_spins_by_hand: ["yes"],
            sound_type: ["hum or buzz"]
          }
        },
        {
          component: "fan motor",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "sound_type"],
          evidencePatterns: {
            main_symptom: ["fan not spinning", "fan noisy"],
            sound_type: ["grinding", "buzzing", "hum or buzz"]
          }
        },
        {
          component: "mounting or blade issue",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "sound_type"],
          evidencePatterns: {
            main_symptom: ["fan wobble", "fan noise"],
            sound_type: ["rattle", "clicking", "tapping"]
          }
        }
      ]
    }
  },

  garage_door: {
    no_start: {
      subsystemCandidates: ["opener_path", "safety_path", "door_path"],
      components: [
        {
          component: "remote or wall button issue",
          subsystem: "opener_path",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["garage door won't open", "garage door won't close"],
            timing: ["always", "intermittent"]
          }
        },
        {
          component: "safety sensor alignment issue",
          subsystem: "safety_path",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["garage door won't close", "garage door reverses"],
            timing: ["during closing"]
          }
        },
        {
          component: "door track or roller binding",
          subsystem: "door_path",
          evidenceKeys: ["main_symptom", "sound_type", "timing"],
          evidencePatterns: {
            main_symptom: ["garage door stuck", "garage door won't move smoothly"],
            sound_type: ["grinding", "rattle", "binding"],
            timing: ["during opening", "during closing"]
          }
        }
      ]
    },

    noise: {
      subsystemCandidates: ["door_path", "opener_path"],
      components: [
        {
          component: "track or roller issue",
          subsystem: "door_path",
          evidenceKeys: ["main_symptom", "sound_type", "timing"],
          evidencePatterns: {
            main_symptom: ["garage door noise"],
            sound_type: ["grinding", "squeal", "rattle"],
            timing: ["during opening", "during closing"]
          }
        },
        {
          component: "opener drive issue",
          subsystem: "opener_path",
          evidenceKeys: ["main_symptom", "sound_type"],
          evidencePatterns: {
            main_symptom: ["garage door noise"],
            sound_type: ["buzzing", "clicking", "humming"]
          }
        }
      ]
    },

    default: {
      subsystemCandidates: ["general"],
      components: [
        {
          component: "safety sensor alignment issue",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["garage door won't close", "garage door reverses"],
            timing: ["during closing"]
          }
        },
        {
          component: "remote or wall button issue",
          subsystem: "general",
          evidenceKeys: ["main_symptom"],
          evidencePatterns: {
            main_symptom: ["garage door won't open", "garage door won't close"]
          }
        },
        {
          component: "track or roller issue",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "sound_type"],
          evidencePatterns: {
            main_symptom: ["garage door stuck", "garage door noise"],
            sound_type: ["grinding", "rattle", "squeal"]
          }
        }
      ]
    }
  },

  doors_windows: {
    door_not_latching: {
      subsystemCandidates: ["latch_path", "alignment_path", "hinge_path"],
      components: [
        {
          component: "strike plate alignment",
          subsystem: "alignment_path",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["door won't latch", "door won't close"],
            timing: ["always"]
          }
        },
        {
          component: "hinge sag",
          subsystem: "hinge_path",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["door sagging", "door rubs frame", "door won't latch"],
            timing: ["always"]
          }
        },
        {
          component: "latch mechanism",
          subsystem: "latch_path",
          evidenceKeys: ["main_symptom", "sound_type"],
          evidencePatterns: {
            main_symptom: ["door won't latch", "handle issue"],
            sound_type: ["loose handle", "no click"]
          }
        }
      ]
    },

    window_not_opening: {
      subsystemCandidates: ["track_path", "lock_path", "sash_path"],
      components: [
        {
          component: "track binding",
          subsystem: "track_path",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["window won't open", "window hard to move"],
            timing: ["always"]
          }
        },
        {
          component: "lock or latch issue",
          subsystem: "lock_path",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["window won't open", "window won't lock"],
            timing: ["always"]
          }
        },
        {
          component: "paint or swelling bind",
          subsystem: "sash_path",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["window stuck", "window hard to open"],
            timing: ["seasonal", "always"]
          }
        }
      ]
    },

    default: {
      subsystemCandidates: ["general"],
      components: [
        {
          component: "alignment issue",
          subsystem: "general",
          evidenceKeys: ["main_symptom"],
          evidencePatterns: {
            main_symptom: ["door won't latch", "door rubs frame", "window stuck"]
          }
        },
        {
          component: "latch or lock issue",
          subsystem: "general",
          evidenceKeys: ["main_symptom"],
          evidencePatterns: {
            main_symptom: ["window won't lock", "door won't latch"]
          }
        },
        {
          component: "hinge or track issue",
          subsystem: "general",
          evidenceKeys: ["main_symptom"],
          evidencePatterns: {
            main_symptom: ["door sagging", "window hard to open"]
          }
        }
      ]
    }
  },

  default: {
    default: {
      subsystemCandidates: ["general"],
      components: [
        {
          component: "motor",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "timing", "sound_type"],
          evidencePatterns: {
            main_symptom: ["won't start", "noise"],
            timing: ["always", "intermittent"],
            sound_type: ["hum or buzz", "buzzing", "grinding"]
          }
        },
        {
          component: "switch or sensor",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "timing"],
          evidencePatterns: {
            main_symptom: ["won't start", "intermittent issue"],
            timing: ["intermittent", "always"]
          }
        },
        {
          component: "control board",
          subsystem: "general",
          evidenceKeys: ["main_symptom", "error_codes"],
          evidencePatterns: {
            main_symptom: ["won't start", "erratic behavior"],
            error_codes: ["yes"]
          }
        }
      ]
    }
  }
};

function normalizeEvidenceKey(key) {
  const k = normalizeText(key).toLowerCase();

  const map = {
    symptomdetails: "main_symptom",
    symptomdescription: "main_symptom",
    issuedescription: "main_symptom",
    description: "main_symptom",
    details: "details",
    whenhappens: "when_happens",
    timing: "timing",
    whenoccurs: "when_happens",
    location: "location",
    noiselocation: "location",
    symptomlocation: "location",
    soundtype: "sound_type",
    noisetype: "sound_type",
    soundkind: "sound_type",
    errorcodes: "error_codes",
    indicatorlights: "error_codes",
    codesshown: "error_codes",
    codespresent: "error_codes",
    doorstopsnoise: "door_stops_noise",
    doorlatchcheck: "door_switch_response",
    doorswitchresponse: "door_switch_response",
    doorclick: "door_switch_response",
    doorlatchclick: "door_switch_response",
    drumspins: "drum_spin_status",
    drumspinstatus: "drum_spin_status",
    drumdoesspin: "drum_spin_status",
    drummovesbyhand: "drum_moves_by_hand",
    drumturnsbyhand: "drum_moves_by_hand",
    manualdrummovement: "drum_moves_by_hand",
    doorswitchheldeffect: "door_switch_held_effect",
    doorswitchchange: "door_switch_held_effect",
    manualdoorswitcheffect: "door_switch_held_effect",
    frostbuildup: "frost_buildup",
    powerstate: "power_state"
  };

  const normalized = k.replace(/[\s_\-]/g, "");
  return map[normalized] || k.replace(/\s+/g, "_");
}

function normalizeEvidenceValue(value) {
  const v = normalizeText(value).toLowerCase();

  const map = {
    "back lower": "back bottom",
    "rear lower": "back bottom",
    "bottom rear": "back bottom",
    "rear bottom": "back bottom",
    "back upper": "back top",
    "rear upper": "back top",
    "inside the freezer": "inside freezer",
    "in the freezer": "inside freezer",
    "inside the fridge": "inside fridge",
    "in the fridge": "inside fridge",
    "only during cooling": "during cooling",
    "while cooling": "during cooling",
    "all the time": "always",
    "constantly": "constant",
    "stops when door opens": "yes",
    "goes away when i open the door": "yes",
    "does not stop when i open the door": "no",

    "hum": "humming",
    "buzz": "buzzing",
    "grind": "grinding",
    "squeak": "squeal",

    "dont know": "not sure",
    "don't know": "not sure",
    "idk": "not sure",

    "moves easy": "moves freely",
    "moves freely by hand": "moves freely",
    "turns freely": "moves freely",
    "spins freely": "moves freely",
    "hard to turn": "feels stuck",
    "stiff": "feels stuck",
    "stuck": "feels stuck",

    "heater turns on": "heater comes on",
    "heating element turns on": "heater comes on",
    "heating element glows": "heater comes on",
    "glows": "heater comes on",
    "drum tries": "drum tries to move",

    "no sound at all": "no sound",
    "nothing happens": "does not start",
    "wont start": "does not start",
    "won't start": "does not start",
    "doesnt start": "does not start",
    "doesn't start": "does not start",

    "doesnt spin": "does not spin",
    "doesn't spin": "does not spin",
    "wont spin": "does not spin",
    "won't spin": "does not spin",

    "hum or buzz": "hum or buzz",
    "low hum": "hum or buzz",
    "low buzz": "hum or buzz",
    "hums": "hum or buzz",
    "buzzes": "hum or buzz",
    "humming": "hum or buzz",
    "buzzing": "hum or buzz",

    "it starts when pushed": "starts when pushed",
    "starts if i push it": "starts when pushed"
  };

  return map[v] || v;
}

function makeEvidenceFact({ key, value, source = "unknown", confidence = 70, raw = null }) {
  const normalizedKey = normalizeEvidenceKey(key);
  const normalizedValue = typeof value === "string" ? normalizeEvidenceValue(value) : value;

  return {
    key: normalizedKey,
    value: normalizedValue,
    normalizedValue,
    source,
    confidence: normalizeConfidence(confidence),
    raw: raw ?? value
  };
}
function extractDeterministicEvidenceFacts(userText = "") {
  const text = normalizeText(userText).toLowerCase();
  if (!text) return [];

  const facts = [];

  const add = (key, value, confidence = 92) => {
    facts.push(
      makeEvidenceFact({
        key,
        value,
        source: "deterministic_extract",
        confidence,
        raw: value
      })
    );
  };

  if (
    text.includes("won't start") ||
    text.includes("wont start") ||
    text.includes("doesn't start") ||
    text.includes("doesnt start") ||
    text.includes("nothing happens") ||
    text.includes("not starting")
  ) {
    add("main_symptom", "does not start", 96);
  }

  if (
    text.includes("drum doesn't spin") ||
    text.includes("drum doesnt spin") ||
    text.includes("drum won't spin") ||
    text.includes("drum wont spin") ||
    text.includes("drum does not spin")
  ) {
    add("drum_spin_status", "does not spin", 97);
  }

  if (
    text.includes("moves freely") ||
    text.includes("turns freely") ||
    text.includes("spins freely")
  ) {
    add("drum_moves_by_hand", "moves freely", 96);
  }

  if (
    text.includes("feels stuck") ||
    text.includes("hard to turn") ||
    text.includes("stiff") ||
    text.includes("stuck")
  ) {
    add("drum_moves_by_hand", "feels stuck", 96);
  }

  if (
    text.includes("heater comes on") ||
    text.includes("heater turns on") ||
    text.includes("heating element glows") ||
    text.includes("heating element turns on") ||
    text.includes("the element glows") ||
    text.includes("glows orange")
  ) {
    add("door_switch_held_effect", "heater comes on", 96);
  }

  if (
    text.includes("drum tries to move") ||
    text.includes("tries to move")
  ) {
    add("door_switch_held_effect", "drum tries to move", 94);
  }

  if (
    text.includes("nothing changes")
  ) {
    add("door_switch_held_effect", "nothing changes", 94);
  }

  if (
    text.includes("low hum") ||
    text.includes("hum or buzz") ||
    text.includes("hums") ||
    text.includes("buzzes") ||
    text.includes("humming") ||
    text.includes("buzzing")
  ) {
    add("sound_type", "hum or buzz", 95);
  }

  if (text.includes("no sound")) {
    add("sound_type", "no sound", 95);
  }

  if (text.includes("click")) {
    add("sound_type", "click", 90);
  }

  if (text.includes("error code") || text.includes("blinking light")) {
    add("error_codes", "yes", 90);
  }

  if (
    text.includes("no error code") ||
    text.includes("no blinking light") ||
    text === "no"
  ) {
    add("error_codes", "no", 88);
  }

  return facts;
}
function upsertEvidenceFact(evidence, fact) {
  if (!fact?.key) return evidence;

  const list = Array.isArray(evidence) ? evidence : [];
  const idx = list.findIndex(
    (x) =>
      x?.key === fact.key &&
      normalizeText(String(x?.normalizedValue ?? x?.value ?? "")).toLowerCase() ===
        normalizeText(String(fact.normalizedValue ?? fact.value ?? "")).toLowerCase()
  );

  if (idx >= 0) {
    const existing = list[idx];
    list[idx] = {
      ...existing,
      ...fact,
      confidence: Math.max(existing?.confidence || 0, fact?.confidence || 0)
    };
    return list;
  }

  list.push(fact);
  return list;
}

function getEvidenceValue(session, key) {
  ensureReasoning(session);
  const nk = normalizeEvidenceKey(key);
  const facts = session.diagnosis.reasoning.evidence || [];
  const hit = [...facts].reverse().find((e) => e?.key === nk);
  return hit ? hit.normalizedValue ?? hit.value : null;
}

function summarizeEvidenceProfile(session) {
  ensureReasoning(session);

  const facts = session.diagnosis.reasoning.evidence || [];
  const byKey = {};

  for (const fact of facts) {
    if (!fact?.key) continue;
    byKey[fact.key] = fact.normalizedValue ?? fact.value;
  }

  return byKey;
}

function getOntologyBranch(appliance, symptomFamily) {
  const a = normalizeApplianceType(appliance);
  const applianceBranch = DIAGNOSTIC_ONTOLOGY[a] || DIAGNOSTIC_ONTOLOGY.default;
  return applianceBranch[symptomFamily] || applianceBranch.default || DIAGNOSTIC_ONTOLOGY.default.default;
}

function buildOntologyCandidateList({ appliance, symptomFamily }) {
  const branch = getOntologyBranch(appliance, symptomFamily);
  return Array.isArray(branch?.components) ? branch.components.map((c) => ({ ...c })) : [];
}

function deriveMissingEvidenceForCandidates(session, candidates) {
  const profile = summarizeEvidenceProfile(session);
  const list = Array.isArray(candidates) ? candidates : [];
  const counts = new Map();

  for (const candidate of list) {
    const keys = Array.isArray(candidate?.evidenceKeys) ? candidate.evidenceKeys : [];
    for (const key of keys) {
      if (profile[key] == null || profile[key] === "" || profile[key] === "not sure") {
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }));
}

function buildCandidateContrastMap(candidates) {
  const map = {};
  const list = Array.isArray(candidates) ? candidates : [];

  for (const candidate of list) {
    const name = candidate?.component;
    if (!name) continue;

    map[name] = {
      subsystem: candidate?.subsystem || "general",
      evidenceKeys: Array.isArray(candidate?.evidenceKeys) ? candidate.evidenceKeys : [],
      evidencePatterns: candidate?.evidencePatterns || {}
    };
  }

  return map;
}

function scoreEvidenceSupportForCandidate(candidate, evidenceProfile) {
  const patterns = candidate?.evidencePatterns || {};
  const keys = Object.keys(patterns);
  let support = 0;
  let contradictions = 0;
  const supportingEvidence = [];
  const conflictingEvidence = [];
  const missingEvidence = [];

  for (const key of keys) {
    const actual = evidenceProfile[key];
    const expected = Array.isArray(patterns[key]) ? patterns[key] : [];

    if (actual == null || actual === "" || actual === "not sure") {
      missingEvidence.push(key);
      continue;
    }

    if (expected.includes(actual)) {
      support += 1;
      supportingEvidence.push(`${key}:${actual}`);
    } else {
      contradictions += 1;
      conflictingEvidence.push(`${key}:${actual}`);
    }
  }

  return { support, contradictions, supportingEvidence, conflictingEvidence, missingEvidence };
}
async function extractEvidenceFromMessage({ session, userText, boundAnswer }) {
  ensureReasoning(session);

  let evidence = session.diagnosis.reasoning.evidence || [];

  if (boundAnswer?.key) {
    evidence = upsertEvidenceFact(
      evidence,
      makeEvidenceFact({
        key: boundAnswer.key,
        value: boundAnswer.value,
        source: "answer",
        confidence: 95,
        raw: boundAnswer.value
      })
    );
  }

  const answersByIntent = session.diagnosis?.answersByIntent || {};
  for (const [key, value] of Object.entries(answersByIntent)) {
    if (value == null || value === "") continue;
    evidence = upsertEvidenceFact(
      evidence,
      makeEvidenceFact({
        key,
        value,
        source: "answersByIntent",
        confidence: 90,
        raw: value
      })
    );
  }
  const deterministicFacts = extractDeterministicEvidenceFacts(userText);
  for (const fact of deterministicFacts) {
    evidence = upsertEvidenceFact(evidence, fact);
  }
  if (!normalizeText(userText)) {
    session.diagnosis.reasoning.evidence = evidence;
    return evidence;
  }

  const response = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content: `
You extract structured diagnostic evidence from user text for an appliance diagnosis engine.

Return only valid JSON:
{
  "evidence": [
    { "key": "", "value": "", "confidence": 0 }
  ]
}

Allowed keys:
main_symptom
timing
when_happens
location
sound_type
error_codes
door_stops_noise
door_switch_response
drum_spin_status
drum_moves_by_hand
door_switch_held_effect
frost_buildup
airflow_present
compressor_running
leak_location
freezer_temp
fridge_temp
cooling_pattern
ice_maker_involved
rear_heat_level
fan_spins_by_hand
clicking
humming
power_state
details

Rules:
Only extract concrete observable facts.
Do not infer a failed component.
Use short normalized values.
`.trim()
      },
      {
        role: "user",
        content: JSON.stringify({
          appliance: session.appliance,
          issueCategory: session.issueCategory,
          userText
        })
      }
    ],
    text: { format: { type: "json_object" } }
  });

  try {
    const parsed = JSON.parse(response.output_text || "{}");
    if (Array.isArray(parsed?.evidence)) {
      for (const item of parsed.evidence) {
        if (!item?.key) continue;
        evidence = upsertEvidenceFact(
          evidence,
          makeEvidenceFact({
            key: item.key,
            value: item.value,
            source: "llm_extract",
            confidence: item.confidence ?? 70,
            raw: item.value
          })
        );
      }
    }
  } catch {}

  session.diagnosis.reasoning.evidence = evidence;
  return evidence;
}
async function classifySymptomFamily({ session }) {
  ensureReasoning(session);

  const appliance = normalizeApplianceType(session.appliance);
  const issueCategory = normalizeText(session.issueCategory).toLowerCase();
  const symptoms = Array.isArray(session.symptoms) ? session.symptoms.join(" ") : "";
  const userDescription = normalizeText(session.diagnosis?.userDescription || "");
  const answersByIntent = session.diagnosis?.answersByIntent || {};
  const evidenceProfile = summarizeEvidenceProfile(session);

  const combined = `${issueCategory} ${symptoms} ${userDescription}`.toLowerCase();

  const ruleSignals = {
    noise: ["noise", "loud", "grinding", "buzzing", "clicking", "rattle", "squeal", "humming", "sound", "thump", "scraping"],
    no_start: ["won't start", "wont start", "doesn't start", "doesnt start", "not starting", "press start", "no start", "does not start", "nothing happens"],
    not_cooling: ["not cooling", "warm", "not cold", "temperature", "freezer thawing", "fridge warm"],
    water_leak: ["leak", "leaking", "water on floor", "puddle", "dripping", "water around"],
    no_heat: ["no heat", "not heating", "cold air", "won't heat", "wont heat"],
    not_draining: ["not draining", "standing water", "won't drain", "wont drain", "slow drain", "backs up"],
    vibration: ["vibration", "vibrating", "shaking", "wobble"],
    ice_maker_issue: ["ice maker", "no ice", "ice not making", "ice maker jammed"],
    faucet_leak: ["faucet leaks", "dripping faucet", "water drips from spout", "spout drips"],
    faucet_no_water: ["low water flow", "weak stream", "no water from faucet", "barely runs"],
    running_toilet: ["running toilet", "toilet keeps running", "toilet runs constantly"],
    toilet_leak: ["toilet leaks", "water around toilet base", "toilet leaking"],
    water_heater_no_hot_water: ["no hot water", "not enough hot water", "water heater not heating"],
    water_heater_leak: ["water heater leaks", "water around water heater"],
    light_not_working: ["light not working", "light out", "no light", "won't turn on"],
    light_flickering: ["flicker", "flickering", "blinking light"],
    outlet_not_working: ["outlet not working", "dead outlet", "no power at outlet"],
    breaker_trips: ["breaker trips", "breaker keeps tripping", "trip the breaker"],
    ceiling_fan_not_spinning: ["fan not spinning", "ceiling fan won't spin", "ceiling fan hums"],
    ceiling_fan_noise: ["fan wobble", "fan shaking", "ceiling fan noise"],
    exhaust_fan_issue: ["bathroom fan", "exhaust fan", "range hood"],
    not_cleaning: ["not cleaning", "dirty dishes", "spray arms not spinning"],
    not_spinning: ["won't spin", "wont spin", "not spinning", "does not spin"],
    door_not_latching: ["door won't latch", "door wont latch", "door won't close", "door rubs frame"],
    window_not_opening: ["window won't open", "window wont open", "window stuck"],
    no_cooling: ["ac not cooling", "not cooling", "outside unit not running"]
  };

  for (const [family, signals] of Object.entries(ruleSignals)) {
    if (signals.some((s) => combined.includes(s))) {
      session.diagnosis.reasoning.symptomFamily = family;
      session.diagnosis.reasoning.symptomFamilyConfidence = 90;
      return {
        symptomFamily: family,
        confidence: 90,
        source: "rules"
      };
    }
  }

  if (issueCategory) {
    session.diagnosis.reasoning.symptomFamily = issueCategory.replace(/\s+/g, "_");
    session.diagnosis.reasoning.symptomFamilyConfidence = 70;
    return {
      symptomFamily: session.diagnosis.reasoning.symptomFamily,
      confidence: 70,
      source: "issueCategory"
    };
  }

  const response = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content: `
You are classifying appliance and home repair symptom families for a constrained diagnosis engine.

Return only valid JSON:
{
  "symptomFamily": "",
  "confidence": 0,
  "signals": []
}

Allowed families:
noise
no_start
not_cooling
no_cooling
water_leak
not_draining
no_heat
vibration
ice_maker_issue
faucet_leak
faucet_no_water
running_toilet
toilet_leak
water_heater_no_hot_water
water_heater_leak
light_not_working
light_flickering
outlet_not_working
breaker_trips
ceiling_fan_not_spinning
ceiling_fan_noise
exhaust_fan_issue
not_cleaning
not_spinning
door_not_latching
window_not_opening
default

Choose the single best family. Be conservative.
`.trim()
      },
      {
        role: "user",
        content: JSON.stringify({
          appliance,
          issueCategory,
          userDescription,
          symptoms,
          answersByIntent,
          evidenceProfile
        })
      }
    ],
    text: { format: { type: "json_object" } }
  });

  let parsed = {};
  try {
    parsed = JSON.parse(response.output_text || "{}");
  } catch {}

  const symptomFamily = normalizeText(parsed?.symptomFamily || "default").toLowerCase() || "default";
  const confidence = normalizeConfidence(parsed?.confidence ?? 50);

  session.diagnosis.reasoning.symptomFamily = symptomFamily;
  session.diagnosis.reasoning.symptomFamilyConfidence = confidence;

  return {
    symptomFamily,
    confidence,
    source: "llm"
  };
}
async function rankHypotheses({ session }) {
  ensureReasoning(session);

  const symptomFamilyResult = await classifySymptomFamily({ session });
  const symptomFamily = symptomFamilyResult?.symptomFamily || "default";

  const ontologyCandidates = buildOntologyCandidateList({
    appliance: session.appliance,
    symptomFamily
  });

  session.diagnosis.reasoning.ontologyCandidates = ontologyCandidates;

  const evidenceProfile = summarizeEvidenceProfile(session);
  const preScored = ontologyCandidates.map((candidate) => {
    const supportInfo = scoreEvidenceSupportForCandidate(candidate, evidenceProfile);

    const heuristicConfidence = clampNumber(
      35 + supportInfo.support * 18 - supportInfo.contradictions * 12,
      5,
      92
    );

    return {
      component: candidate.component,
      cause: candidate.component,
      subsystem: candidate.subsystem || "general",
      confidence: heuristicConfidence,
      support: supportInfo.support,
      contradictions: supportInfo.contradictions,
      supportingEvidence: supportInfo.supportingEvidence,
      conflictingEvidence: supportInfo.conflictingEvidence,
      missingEvidence: supportInfo.missingEvidence,
      notes: supportInfo.supportingEvidence.join(", ")
    };
  });
  const isDryerNoStart =
    normalizeApplianceType(session.appliance) === "dryer" &&
    symptomFamily === "no_start";

  if (isDryerNoStart) {
    const soundType = normalizeText(String(evidenceProfile.sound_type || "")).toLowerCase();
    const drumMoves = normalizeText(String(evidenceProfile.drum_moves_by_hand || "")).toLowerCase();
    const doorEffect = normalizeText(String(evidenceProfile.door_switch_held_effect || "")).toLowerCase();
    const drumSpin = normalizeText(String(evidenceProfile.drum_spin_status || "")).toLowerCase();
    const mainSymptom = normalizeText(String(evidenceProfile.main_symptom || "")).toLowerCase();

    for (const item of preScored) {
      const name = normalizeText(item.component).toLowerCase();

      if (
        (soundType === "hum or buzz" || soundType === "humming" || soundType === "buzzing") &&
        drumMoves === "moves freely" &&
        (doorEffect === "heater comes on" || doorEffect === "drum tries to move") &&
        (drumSpin === "does not spin" || mainSymptom.includes("does not start"))
      ) {
        if (name === "drive motor") {
          item.confidence = clampNumber(item.confidence + 22, 0, 98);
          item.supportingEvidence = [...new Set([...(item.supportingEvidence || []), "dryer_pattern:drive_motor"])];
        }

        if (name === "belt switch or idler path") {
          item.confidence = clampNumber(item.confidence + 14, 0, 96);
          item.supportingEvidence = [...new Set([...(item.supportingEvidence || []), "dryer_pattern:belt_or_idler"])];
        }

        if (name === "heater relay stuck or control fault") {
          item.confidence = clampNumber(item.confidence + 8, 0, 90);
          item.supportingEvidence = [...new Set([...(item.supportingEvidence || []), "dryer_pattern:heater_relay_or_control"])];
        }

        if (name === "door switch") {
          item.confidence = clampNumber(item.confidence - 18, 0, 100);
          item.conflictingEvidence = [...new Set([...(item.conflictingEvidence || []), "dryer_pattern:door_switch_less_likely"])];
        }
      }

      if (doorEffect === "nothing changes" && name === "door switch") {
        item.confidence = clampNumber(item.confidence + 15, 0, 95);
      }

      if (soundType === "no sound" && name === "control board") {
        item.confidence = clampNumber(item.confidence + 10, 0, 92);
      }
    }
  }
  const response = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content: `
You are ranking appliance fault hypotheses inside a constrained diagnosis engine.

Return only valid JSON:
{
  "hypotheses": [
    {
      "component": "",
      "confidence": 0,
      "reason": "",
      "missingEvidence": [],
      "conflictingEvidence": [],
      "supportingEvidence": []
    }
  ]
}

Rules:
Only rank candidates from the provided allowedCandidates list.
Do not introduce any new component names.
Confidence must reflect actual evidence strength, not guesswork.
Be conservative.
`.trim()
      },
      {
        role: "user",
        content: JSON.stringify({
          appliance: session.appliance,
          issueCategory: session.issueCategory,
          symptomFamily,
          evidenceProfile,
          allowedCandidates: preScored.map((x) => ({
            component: x.component,
            subsystem: x.subsystem,
            support: x.support,
            contradictions: x.contradictions,
            supportingEvidence: x.supportingEvidence,
            conflictingEvidence: x.conflictingEvidence,
            missingEvidence: x.missingEvidence,
            heuristicConfidence: x.confidence
          }))
        })
      }
    ],
    text: { format: { type: "json_object" } }
  });

  let parsed = {};
  try {
    parsed = JSON.parse(response.output_text || "{}");
  } catch {}

  const allowedNames = new Set(preScored.map((x) => x.component.toLowerCase()));

  const llmHypotheses = Array.isArray(parsed?.hypotheses)
    ? parsed.hypotheses
        .filter((x) => allowedNames.has(normalizeText(x?.component).toLowerCase()))
        .map((x) => ({
          component: x.component,
          cause: x.component,
          confidence: normalizeConfidence(x.confidence ?? 0),
          reason: str(x.reason),
          missingEvidence: arr(x.missingEvidence),
          conflictingEvidence: arr(x.conflictingEvidence),
          supportingEvidence: arr(x.supportingEvidence)
        }))
    : [];

  const merged = preScored.map((base) => {
    const llm = llmHypotheses.find(
      (x) => normalizeText(x.component).toLowerCase() === normalizeText(base.component).toLowerCase()
    );

    const confidence = llm
      ? clampNumber(Math.round((base.confidence * 0.45) + (normalizeConfidence(llm.confidence) * 0.55)), 0, 100)
      : base.confidence;

    return {
      component: base.component,
      cause: base.cause,
      subsystem: base.subsystem,
      confidence,
      reason: llm?.reason || base.notes || "",
      support: base.support,
      contradictions: base.contradictions,
      supportingEvidence: llm?.supportingEvidence?.length ? llm.supportingEvidence : base.supportingEvidence,
      conflictingEvidence: llm?.conflictingEvidence?.length ? llm.conflictingEvidence : base.conflictingEvidence,
      missingEvidence: llm?.missingEvidence?.length ? llm.missingEvidence : base.missingEvidence,
      notes: llm?.reason || base.notes || ""
    };
  });

  const hypotheses = merged.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  session.diagnosis.reasoning.hypotheses = hypotheses;

  const top = hypotheses[0];
  if (top) {
    session.diagnosis.confidence = top.confidence || 0;
    session.diagnosis.suggestedComponent = top.component || top.cause;
    session.diagnosis.component = session.diagnosis.suggestedComponent;
  }

  return hypotheses;
}

async function chooseNextDiagnosticAction({ session }) {
  ensureReasoning(session);

  const hypotheses = Array.isArray(session.diagnosis.reasoning.hypotheses)
    ? session.diagnosis.reasoning.hypotheses
    : [];

  const candidates = Array.isArray(session.diagnosis.reasoning.ontologyCandidates)
    ? session.diagnosis.reasoning.ontologyCandidates
    : [];

  const evidenceProfile = summarizeEvidenceProfile(session);
  const missingEvidenceRank = deriveMissingEvidenceForCandidates(session, candidates);
  const contrastMap = buildCandidateContrastMap(candidates);

  const top = hypotheses[0] || null;
  const second = hypotheses[1] || null;

  const questionLibrary = {
    location: {
      assistant: "Where is the issue most noticeable?",
      input: {
        type: "choice",
        key: "location",
        choices: ["back bottom", "back top", "inside freezer", "inside fridge", "cannot tell"]
      }
    },
    sound_type: {
      assistant: "Which best describes the sound?",
      input: {
        type: "choice",
        key: "soundType",
        choices: ["squeal", "grinding", "rattle", "humming", "clicking", "buzzing", "other", "not sure"]
      }
    },
    when_happens: {
      assistant: "When does it happen most?",
      input: {
        type: "choice",
        key: "whenHappens",
        choices: ["always", "intermittent", "during cooling", "after door closes", "during ice maker", "not sure"]
      }
    },
    timing: {
      assistant: "When exactly does the problem happen?",
      input: {
        type: "text",
        key: "timing",
        choices: []
      }
    },
    door_stops_noise: {
      assistant: "Does the noise stop when you open the door?",
      input: {
        type: "choice",
        key: "doorStopsNoise",
        choices: ["yes", "no", "not sure"]
      }
    },
    frost_buildup: {
      assistant: "Do you see frost buildup where the issue is happening?",
      input: {
        type: "choice",
        key: "frostBuildup",
        choices: ["yes", "no", "not sure"]
      }
    },
    error_codes: {
      assistant: "Are there any error codes or blinking lights showing?",
      input: {
        type: "choice",
        key: "errorCodes",
        choices: ["yes", "no", "not sure"]
      }
    },
    drum_moves_by_hand: {
      assistant: "With power off, does the drum move freely by hand or feel stuck?",
      input: {
        type: "choice",
        key: "drumMovesByHand",
        choices: ["moves freely", "feels stuck", "not sure"]
      }
    },
    door_switch_held_effect: {
      assistant: "When you press and hold the door switch, what changes do you notice?",
      input: {
        type: "choice",
        key: "doorSwitchHeldEffect",
        choices: ["nothing changes", "drum tries to move", "heater comes on", "not sure"]
      }
    },
    main_symptom: {
      assistant: "What is the single main symptom right now, and when does it happen?",
      input: {
        type: "text",
        key: "symptomDetails",
        choices: []
      }
    },
    details: {
      assistant: "Tell me the next most noticeable thing you observe when the issue happens.",
      input: {
        type: "text",
        key: "details",
        choices: []
      }
    }
  };
function hasMeaningfulDetailsAnswer() {
  return hasMeaningfulAnswerInFamily("details") || hasMeaningfulAnswerInFamily("symptomDetails");
}

function wasDetailsAlreadyAsked() {
  return alreadyAskedQuestion(session, "details") || alreadyAskedQuestion(session, "symptomDetails");
}

function shouldAvoidGenericDetails() {
  return hasMeaningfulDetailsAnswer() || wasDetailsAlreadyAsked();
}
  function mapEvidenceKeyToIntentKey(evidenceKey) {
  const map = {
    when_happens: "whenHappens",
    timing: "timing",
    location: "location",
    sound_type: "soundType",
    door_stops_noise: "doorStopsNoise",
    frost_buildup: "frostBuildup",
    error_codes: "errorCodes",
    drum_moves_by_hand: "drumMovesByHand",
    door_switch_held_effect: "doorSwitchHeldEffect",
    door_switch_response: "doorSwitchResponse",
    main_symptom: "symptomDetails",
    details: "details"
  };
  return map[evidenceKey] || evidenceKey;
}

  function getIntentFamily(intentKey) {
    const k = normalizeText(intentKey);

    if (["whenHappens", "timing"].includes(k)) return "timing_family";
    if (["symptomDetails", "issueDescription", "description", "symptomDescription", "main_symptom"].includes(k)) {
      return "main_symptom_family";
    }
    if (["location"].includes(k)) return "location_family";
    if (["soundType"].includes(k)) return "sound_family";
    if (["doorStopsNoise"].includes(k)) return "door_noise_family";
    if (["frostBuildup"].includes(k)) return "frost_family";
    if (["errorCodes"].includes(k)) return "error_code_family";
    if (["drumMovesByHand"].includes(k)) return "drum_hand_family";
    if (["doorSwitchHeldEffect"].includes(k)) return "door_switch_effect_family";

    return k;
  }

  function hasMeaningfulAnswerInFamily(intentKey) {
    const family = getIntentFamily(intentKey);

    const familyMembers = {
      timing_family: ["whenHappens", "timing"],
      main_symptom_family: ["symptomDetails", "issueDescription", "description", "symptomDescription"],
      location_family: ["location"],
      sound_family: ["soundType"],
      door_noise_family: ["doorStopsNoise"],
      frost_family: ["frostBuildup"],
      error_code_family: ["errorCodes"],
      drum_hand_family: ["drumMovesByHand"],
      door_switch_effect_family: ["doorSwitchHeldEffect"]
    };

    const members = familyMembers[family] || [intentKey];
    return members.some((member) => hasMeaningfulAnswerByIntent(session, member));
  }

  function wasQuestionAlreadyAskedInFamily(intentKey) {
    const family = getIntentFamily(intentKey);

    const familyMembers = {
      timing_family: ["whenHappens", "timing"],
      main_symptom_family: ["symptomDetails", "issueDescription", "description", "symptomDescription"],
      location_family: ["location"],
      sound_family: ["soundType"],
      door_noise_family: ["doorStopsNoise"],
      frost_family: ["frostBuildup"],
      error_code_family: ["errorCodes"],
      drum_hand_family: ["drumMovesByHand"],
      door_switch_effect_family: ["doorSwitchHeldEffect"]
    };

    const members = familyMembers[family] || [intentKey];
    return members.some((member) => alreadyAskedQuestion(session, member));
  }

  function isQuestionStillUseful(evidenceKey) {
    const currentValue = evidenceProfile[evidenceKey];
    if (currentValue != null && currentValue !== "" && currentValue !== "not sure") {
      return false;
    }

    const intentKey = mapEvidenceKeyToIntentKey(evidenceKey);

    if (hasMeaningfulAnswerInFamily(intentKey)) {
      return false;
    }

    if (wasQuestionAlreadyAskedInFamily(intentKey) && !hasMeaningfulAnswerInFamily(intentKey)) {
      return false;
    }

    return true;
  }
  function hasDryerNoStartCoreEvidence() {
  const appliance = normalizeApplianceType(session.appliance);
  const family = normalizeText(session.diagnosis.reasoning?.symptomFamily || "").toLowerCase();

  if (!(appliance === "dryer" && family === "no_start")) return false;

  const soundType = normalizeText(String(evidenceProfile.sound_type || "")).toLowerCase();
  const drumMoves = normalizeText(String(evidenceProfile.drum_moves_by_hand || "")).toLowerCase();
  const doorEffect = normalizeText(String(evidenceProfile.door_switch_held_effect || "")).toLowerCase();
  const drumSpin = normalizeText(String(evidenceProfile.drum_spin_status || "")).toLowerCase();

  const soundOk =
    soundType.includes("hum") ||
    soundType.includes("buzz") ||
    soundType.includes("no sound") ||
    soundType === "none" ||
    soundType.includes("none");

  const drumMovesOk = drumMoves.includes("free");

  const doorOk =
    doorEffect.includes("heater") ||
    doorEffect.includes("tries") ||
    doorEffect.includes("nothing changes");

  const spinOk =
    drumSpin.includes("not") ||
    drumSpin.includes("no");

  return soundOk && drumMovesOk && doorOk && spinOk;
}
  let targetEvidenceKey = null;

  if (top && second) {
    const topContrastKeys = contrastMap[top.component]?.evidenceKeys || [];
    const secondContrastKeys = contrastMap[second.component]?.evidenceKeys || [];
    const union = [...new Set([...topContrastKeys, ...secondContrastKeys])];

    const unresolvedContrast = union.find((key) => isQuestionStillUseful(key));
    if (unresolvedContrast) {
      targetEvidenceKey = unresolvedContrast;
    }
  }

  if (!targetEvidenceKey && missingEvidenceRank.length > 0) {
    const nextMissing = missingEvidenceRank.find((x) => isQuestionStillUseful(x.key));
    if (nextMissing) targetEvidenceKey = nextMissing.key;
  }

   if (!targetEvidenceKey) {
  if (hasDryerNoStartCoreEvidence()) {
    targetEvidenceKey = "details_locked_guard";
  } else if (!hasMeaningfulAnswerInFamily("symptomDetails")) {
    targetEvidenceKey = "main_symptom";
  } else if (!shouldAvoidGenericDetails()) {
    targetEvidenceKey = "details";
  } else {
    targetEvidenceKey = null;
  }
}

  const rawFallback = selectHighValueFallbackQuestion(session);
const fallbackInput = normalizeTurnInput({ input: rawFallback?.input });
const fallbackIntentKey = normalizeText(fallbackInput?.key || "");

const fallbackWouldDuplicateFamily =
  fallbackIntentKey && hasMeaningfulAnswerInFamily(fallbackIntentKey);

const safeFallback =
  fallbackWouldDuplicateFamily || shouldAvoidGenericDetails()
    ? {
        assistant: "",
        input: { type: "none", key: "", choices: [] },
        questionMeta: {
          goal: "hold",
          reason: "No safe fallback question remains without repeating already captured evidence.",
          rulesUsed: ["safe_fallback_guard"],
          eliminates: [],
          narrowsTo: hypotheses.slice(0, 3).map((h) => h.component).filter(Boolean)
        }
      }
    : rawFallback;

    const baseQuestion =
  targetEvidenceKey === "details_locked_guard"
    ? {
        assistant: "I have enough to identify the most likely cause. Next we’ll confirm the part.",
        input: { type: "none", key: "", choices: [] }
      }
    : targetEvidenceKey
      ? questionLibrary[targetEvidenceKey] || {
          assistant: safeFallback.assistant,
          input: safeFallback.input
        }
      : {
          assistant: "",
          input: { type: "none", key: "", choices: [] }
        };

  const topName = top?.component || "top candidate";
  const secondName = second?.component || null;

  const goal = top && second ? "disambiguate" : "confirm";
    const reason =
    targetEvidenceKey === "details_locked_guard"
      ? "Core dryer no-start evidence is already present, so the flow should lock instead of asking another generic observation."
      : targetEvidenceKey === "details"
        ? "A fresh direct observation is needed because current evidence is still too broad."
        : secondName
          ? `This helps separate ${topName} from ${secondName}.`
          : `This helps verify whether ${topName} is actually the best fit.`;
  const normalizedInput = normalizeTurnInput({ input: baseQuestion.input });
  const assistant =
    normalizeText(baseQuestion.assistant) ||
    normalizeText(safeFallback.assistant) ||
    "Tell me the next most noticeable thing you observe when the issue happens.";

  const normalizedIntentKey = normalizeText(normalizedInput?.key || "");
  if (normalizedIntentKey && hasMeaningfulAnswerInFamily(normalizedIntentKey)) {
    return {
      question: {
        assistant: safeFallback.assistant,
        input: normalizeTurnInput({ input: safeFallback.input })
      },
      questionMeta: safeFallback.questionMeta || {
        goal: "disambiguate",
        reason: "Fallback high value question selected because generated question duplicated already answered evidence.",
        rulesUsed: ["fallback_question"],
        eliminates: [],
        narrowsTo: hypotheses.slice(0, 3).map((h) => h.component).filter(Boolean)
      }
    };
  }
if (!targetEvidenceKey && (!safeFallback || normalizeText(safeFallback?.input?.type) === "none")) {
  return {
    question: {
      assistant: "I have enough information collected that I should stop asking repeated questions and move to review or lock the diagnosis.",
      input: { type: "none", key: "", choices: [] }
    },
    questionMeta: {
      goal: "stop_repeat_loop",
      reason: "No useful unanswered diagnostic question remains.",
      rulesUsed: ["terminal_no_repeat_guard"],
      eliminates: [],
      narrowsTo: hypotheses.slice(0, 3).map((h) => h.component).filter(Boolean)
    }
  };
}
  const questionMeta = {
    goal,
    reason,
    rulesUsed: ["reasoning_missing_evidence"],
    eliminates: [],
    narrowsTo: hypotheses.slice(0, 3).map((h) => h.component).filter(Boolean)
  };

  const candidateTurn = {
    assistant,
    input: normalizedInput,
    questionMeta
  };

  if (!isUsefulQuestion(candidateTurn)) {
    return {
      question: {
        assistant: safeFallback.assistant,
        input: normalizeTurnInput({ input: safeFallback.input })
      },
      questionMeta: safeFallback.questionMeta || {
        goal: "disambiguate",
        reason: "Fallback high value question selected because generated question was not useful.",
        rulesUsed: ["fallback_question"],
        eliminates: [],
        narrowsTo: hypotheses.slice(0, 3).map((h) => h.component).filter(Boolean)
      }
    };
  }

  return {
    question: {
      assistant,
      input: normalizedInput
    },
    questionMeta
  };
}
  function hasDryerNoStartCoreEvidence() {
    const appliance = normalizeApplianceType(session.appliance);
    const family = normalizeText(session.diagnosis.reasoning?.symptomFamily || "").toLowerCase();

    if (!(appliance === "dryer" && family === "no_start")) return false;

    const soundType = normalizeText(String(evidenceProfile.sound_type || "")).toLowerCase();
    const drumMoves = normalizeText(String(evidenceProfile.drum_moves_by_hand || "")).toLowerCase();
    const doorEffect = normalizeText(String(evidenceProfile.door_switch_held_effect || "")).toLowerCase();
    const drumSpin = normalizeText(String(evidenceProfile.drum_spin_status || "")).toLowerCase();

    return (
      (soundType === "hum or buzz" || soundType === "humming" || soundType === "buzzing") &&
      drumMoves === "moves freely" &&
      (doorEffect === "heater comes on" || doorEffect === "drum tries to move") &&
      drumSpin === "does not spin"
    );
  }
function evaluateLockReadiness(session) {
  ensureReasoning(session);

  const hypotheses = Array.isArray(session.diagnosis.reasoning.hypotheses)
    ? session.diagnosis.reasoning.hypotheses
    : [];

  const evidenceProfile = summarizeEvidenceProfile(session);
  const top = hypotheses[0] || null;
  const second = hypotheses[1] || null;

  const result = {
    ready: false,
    reason: null,
    missingEvidence: [],
    conflictingEvidence: [],
    supportingEvidence: []
  };

  if (!top) {
    result.reason = "no_hypotheses";
    session.diagnosis.reasoning.lockDecision = result;
    return false;
  }

  const meaningfulEvidenceCount = Object.entries(evidenceProfile).filter(([, value]) => {
    return value != null && value !== "" && value !== "not sure";
  }).length;

  const topConfidence = normalizeConfidence(top.confidence ?? 0);
  const secondConfidence = normalizeConfidence(second?.confidence ?? 0);
  const leadGap = topConfidence - secondConfidence;

  const supportingEvidence = Array.isArray(top.supportingEvidence) ? top.supportingEvidence : [];
  const conflictingEvidence = Array.isArray(top.conflictingEvidence) ? top.conflictingEvidence : [];
  const missingEvidence = Array.isArray(top.missingEvidence) ? top.missingEvidence : [];

  const rejectedHypotheses = Array.isArray(session.diagnosis.rejectedHypotheses)
    ? session.diagnosis.rejectedHypotheses
    : [];

  const notRejected = !rejectedHypotheses.includes(top.component);

  const appliance = normalizeApplianceType(session.appliance);
  const family = normalizeText(session.diagnosis.reasoning?.symptomFamily || "").toLowerCase();

  if (appliance === "dryer" && family === "no_start") {
    const soundType = normalizeText(String(evidenceProfile.sound_type || "")).toLowerCase();
    const drumMoves = normalizeText(String(evidenceProfile.drum_moves_by_hand || "")).toLowerCase();
    const doorEffect = normalizeText(String(evidenceProfile.door_switch_held_effect || "")).toLowerCase();
    const drumSpin = normalizeText(String(evidenceProfile.drum_spin_status || "")).toLowerCase();

    const soundSuggestsStartCircuitOrMotor =
      soundType === "hum or buzz" ||
      soundType === "humming" ||
      soundType === "buzzing" ||
      soundType === "no sound" ||
      soundType === "none" ||
      soundType === "silent";

    const drumMovesFreely =
      drumMoves === "moves freely" ||
      drumMoves.includes("free");

    const doorEffectSupportsNoStart =
      doorEffect === "heater comes on" ||
      doorEffect === "drum tries to move" ||
      doorEffect === "nothing changes" ||
      doorEffect.includes("heater") ||
      doorEffect.includes("tries") ||
      doorEffect.includes("nothing");

    const drumNotSpinning =
      drumSpin === "does not spin" ||
      drumSpin.includes("does not spin") ||
      drumSpin.includes("not spin") ||
      drumSpin.includes("no spin");

    const hasCoreDryerEvidence =
      soundSuggestsStartCircuitOrMotor &&
      drumMovesFreely &&
      doorEffectSupportsNoStart &&
      drumNotSpinning;

    if (hasCoreDryerEvidence && topConfidence >= 68 && leadGap >= 6 && notRejected) {
      result.ready = true;
      result.reason = "dryer_fast_lock";
      result.missingEvidence = missingEvidence;
      result.conflictingEvidence = conflictingEvidence;
      result.supportingEvidence = supportingEvidence;
      session.diagnosis.reasoning.lockDecision = result;
      return true;
    }
  }

  const hasStrongLead = topConfidence >= 76 && leadGap >= 12;
  const hasEnoughEvidence = meaningfulEvidenceCount >= 3;
  const hasDirectSupport = supportingEvidence.length >= 1;
  const hasLowConflict = conflictingEvidence.length <= 1;

  if (!hasStrongLead) {
    result.reason = "confidence_not_strong_enough";
  } else if (!hasEnoughEvidence) {
    result.reason = "not_enough_evidence";
  } else if (!hasDirectSupport) {
    result.reason = "not_enough_supporting_evidence";
  } else if (!hasLowConflict) {
    result.reason = "too_much_conflicting_evidence";
  } else if (!notRejected) {
    result.reason = "top_hypothesis_previously_rejected";
  } else {
    result.ready = true;
    result.reason = "ready_to_lock";
  }

  result.missingEvidence = missingEvidence;
  result.conflictingEvidence = conflictingEvidence;
  result.supportingEvidence = supportingEvidence;

  session.diagnosis.reasoning.lockDecision = result;
  return result.ready;
}

async function buildDynamicRepairPlan({ session }) {
  ensureReasoning(session);

  const appliance = normalizeApplianceType(session.appliance);
  const component =
    session.partLookup?.suspectedComponent ||
    session.diagnosis?.suggestedComponent ||
    session.diagnosis?.component ||
    "unknown_component";

  const evidenceProfile = summarizeEvidenceProfile(session);
  const topHypotheses = Array.isArray(session.diagnosis?.reasoning?.hypotheses)
    ? session.diagnosis.reasoning.hypotheses.slice(0, 3).map((h) => ({
        component: h.component,
        confidence: h.confidence,
        supportingEvidence: h.supportingEvidence,
        conflictingEvidence: h.conflictingEvidence
      }))
    : [];

  const systemPrompt = `
You are generating a structured appliance repair plan for FixBuddy.

Return only valid JSON:
{
  "tools": [""],
  "steps": [
    {
      "id": "",
      "title": "",
      "powerRequired": "off" | "on",
      "requiresConfirmKey": "",
      "confirmPrompt": "",
      "instructions": [""]
    }
  ]
}

Rules:
Generate a safe, practical repair plan for the specific appliance and component.
Use 5 to 8 steps when possible.
The first step must be a safety and preparation step with powerRequired set to "off".
Any disassembly, wiring, connector, or component removal step must have powerRequired set to "off".
Only the final live verification step may require powerRequired set to "on".
Each step must have:
- short stable id
- concise title
- 2 to 5 instruction lines
- a confirmPrompt if requiresConfirmKey is present
Do not return paragraphs.
Do not include warnings outside the step structure.
Do not invent impossible actions.
If certainty is low, prefer a cautious inspection and replacement workflow rather than over-specific claims.
`.trim();

  const userPayload = {
    appliance,
    component,
    modelNumber: session.partLookup?.modelNumber || null,
    partName: session.partLookup?.resolution?.partName || null,
    oemPartNumber: session.partLookup?.resolution?.oemPartNumber || null,
    symptomFamily: session.diagnosis?.reasoning?.symptomFamily || null,
    evidenceProfile,
    topHypotheses
  };

  const response = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userPayload) }
    ],
    text: { format: { type: "json_object" } }
  });

  let parsed = null;
  try {
    parsed = JSON.parse(response.output_text || "{}");
  } catch {
    return null;
  }

  if (!parsed || !Array.isArray(parsed.steps) || !parsed.steps.length) {
    return null;
  }

  const rawTools = Array.isArray(parsed.tools) ? parsed.tools : [];
  const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];

  const tools = rawTools
    .map((x) => normalizeText(x))
    .filter(Boolean)
    .slice(0, 12);

  const steps = rawSteps
    .map((step, index) => {
      const instructions = Array.isArray(step?.instructions)
        ? step.instructions.map((x) => normalizeText(x)).filter(Boolean).slice(0, 5)
        : [];

      const title = normalizeText(step?.title) || `Step ${index + 1}`;
      const id =
        normalizeText(step?.id)
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, "_")
          .replace(/^_+|_+$/g, "") || `step_${index + 1}`;

      let powerRequired = normalizeText(step?.powerRequired).toLowerCase();
      if (powerRequired !== "on" && powerRequired !== "off") {
        powerRequired = index === rawSteps.length - 1 ? "on" : "off";
      }

      let requiresConfirmKey = normalizeText(step?.requiresConfirmKey);
      if (!requiresConfirmKey) {
        requiresConfirmKey = `confirm_${id}`;
      }

      const confirmPrompt =
        normalizeText(step?.confirmPrompt) ||
        `Confirm you completed: ${title}.`;

      return {
        id,
        title,
        powerRequired,
        requiresConfirmKey,
        confirmPrompt,
        instructions
      };
    })
    .filter((step) => step.instructions.length > 0);

  if (!steps.length) return null;

  const firstStep = steps[0];
  if (firstStep.powerRequired !== "off") {
    firstStep.powerRequired = "off";
  }

  if (!/safety|prep|prepare/i.test(firstStep.title)) {
    firstStep.title = "Safety and prep";
  }

  const liveSteps = steps.filter((x) => x.powerRequired === "on");
  if (liveSteps.length > 1) {
    for (let i = 0; i < steps.length - 1; i += 1) {
      steps[i].powerRequired = "off";
    }
    steps[steps.length - 1].powerRequired = "on";
  }

  return { tools, steps };
}
function normalizeRepairSteps(steps) {
  if (!Array.isArray(steps)) return [];

  const normalized = steps
    .map((step, index) => {
      const safeTitle = normalizeText(step?.title) || `Step ${index + 1}`;

      const safeId =
        normalizeText(step?.id)
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, "_")
          .replace(/^_+|_+$/g, "") || `step_${index + 1}`;

      let confirmKey = step?.requiresConfirmKey;

      if (confirmKey === false || confirmKey == null) {
        confirmKey = null;
      } else if (confirmKey === true) {
        confirmKey = `confirm_${safeId}`;
      } else if (
        typeof confirmKey === "string" &&
        ["yes", "true", "ok", "confirm"].includes(confirmKey.trim().toLowerCase())
      ) {
        confirmKey = `confirm_${safeId}`;
      } else if (typeof confirmKey === "string") {
        confirmKey = normalizeText(confirmKey);
        if (!confirmKey) confirmKey = null;
      } else {
        confirmKey = null;
      }

      let powerRequired = normalizeText(step?.powerRequired).toLowerCase();
      if (powerRequired !== "on" && powerRequired !== "off") {
        powerRequired = index === steps.length - 1 ? "on" : "off";
      }

      const instructions = Array.isArray(step?.instructions)
        ? step.instructions.map((x) => normalizeText(x)).filter(Boolean).slice(0, 5)
        : [];

      const confirmPrompt =
        normalizeText(step?.confirmPrompt) ||
        `Confirm you completed: ${safeTitle}.`;

      return {
        id: safeId,
        title: safeTitle,
        powerRequired,
        requiresConfirmKey: confirmKey,
        instructions,
        confirmPrompt
      };
    })
    .filter((step) => step.instructions.length > 0);

  if (!normalized.length) return [];

  normalized[0].powerRequired = "off";

  const liveSteps = normalized.filter((x) => x.powerRequired === "on");
  if (liveSteps.length > 1) {
    for (let i = 0; i < normalized.length - 1; i += 1) {
      normalized[i].powerRequired = "off";
    }
    normalized[normalized.length - 1].powerRequired = "on";
  }

  return normalized;
}
/* =========================================================
   Diagnosis memory and intent tracking
========================================================= */

function normalizeQuestionIntent(key) {
  if (key == null) return "";

  const raw = String(key).trim();
  if (!raw) return "";

  const normalized = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s\-]+/g, "_")
    .replace(/[^\w]/g, "_")
    .toLowerCase()
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!normalized) return "";

  const compact = normalized.replace(/_/g, "");
  const tokens = normalized.split("_").filter(Boolean);

  const aliasGroups = {
    main_symptom: [
      "main_symptom",
      "mainsymptom",
      "symptom",
      "symptom_details",
      "symptomdetails",
      "symptom_detail",
      "symptomdetail",
      "issue_description",
      "issuedescription",
      "problem_description",
      "problemdescription",
      "description",
      "details_of_problem",
      "detailsofproblem",
      "symptom_description",
      "symptomdescription",
      "problem",
      "issue",
      "primary_symptom",
      "primarysymptom",
      "observed_issue",
      "observedissue"
    ],

    details: [
      "details",
      "detail",
      "extra_details",
      "extradetails",
      "more_details",
      "moredetails",
      "additional_details",
      "additionaldetails",
      "followup_details",
      "followupdetails",
      "observation_details",
      "observationdetails",
      "user_notes",
      "usernotes",
      "additional_notes",
      "additionalnotes",
      "followup_notes",
      "followupnotes"
    ],

    when_happens: [
      "when_happens",
      "whenhappens",
      "when_occurs",
      "whenoccurs",
      "when_does_it_happen",
      "whendoesithappen",
      "when_it_happens",
      "whenithappens",
      "occurs_when",
      "occurswhen",
      "happens_when",
      "happenswhen",
      "timing_of_issue",
      "timingofissue"
    ],

    timing: [
      "timing",
      "time_pattern",
      "timepattern",
      "frequency",
      "intermittent_or_constant",
      "intermittentorconstant",
      "timing_pattern",
      "timingpattern"
    ],

    location: [
      "location",
      "where",
      "noise_location",
      "noiselocation",
      "symptom_location",
      "symptomlocation",
      "issue_location",
      "issuelocation",
      "problem_location",
      "problemlocation",
      "source_location",
      "sourcelocation",
      "where_is_it",
      "whereisit",
      "where_seen",
      "whereseen",
      "where_heard",
      "whereheard"
    ],

    sound_type: [
      "sound_type",
      "soundtype",
      "noise_type",
      "noisetype",
      "noise_kind",
      "noisekind",
      "sound_kind",
      "soundkind",
      "sound_description",
      "sounddescription",
      "noise_description",
      "noisedescription",
      "what_sound",
      "whatsound",
      "what_noise",
      "whatnoise"
    ],

    error_codes: [
      "error_codes",
      "errorcodes",
      "error_code",
      "errorcode",
      "codes_shown",
      "codesshown",
      "codes_present",
      "codespresent",
      "indicator_lights",
      "indicatorlights",
      "blink_codes",
      "blinkcodes",
      "fault_codes",
      "faultcodes",
      "display_codes",
      "displaycodes"
    ],

    door_stops_noise: [
      "door_stops_noise",
      "doorstopsnoise",
      "noise_stops_when_door_opens",
      "noisestopswhendooropens",
      "stops_when_door_opens",
      "stopswhendooropens",
      "door_open_changes_noise",
      "dooropenchangesnoise",
      "noise_changes_when_door_opens",
      "noisechangeswhendooropens",
      "open_door_changes_noise",
      "opendoorchangesnoise"
    ],

    door_switch_response: [
      "door_switch_response",
      "doorswitchresponse",
      "door_latch_check",
      "doorlatchcheck",
      "door_click",
      "doorclick",
      "door_latch_click",
      "doorlatchclick",
      "switch_click",
      "switchclick",
      "latch_response",
      "latchresponse",
      "door_response",
      "doorresponse"
    ],

    drum_spin_status: [
      "drum_spin_status",
      "drumspinstatus",
      "drum_spins",
      "drumspins",
      "drum_does_spin",
      "drumdoesspin",
      "drum_turning",
      "drumturning",
      "drum_rotates",
      "drumrotates",
      "drum_motion",
      "drummotion"
    ],

    drum_moves_by_hand: [
      "drum_moves_by_hand",
      "drummovesbyhand",
      "drum_turns_by_hand",
      "drumturnsbyhand",
      "manual_drum_movement",
      "manualdrummovement",
      "turns_by_hand",
      "turnsbyhand",
      "moves_by_hand",
      "movesbyhand",
      "drum_free_movement",
      "drumfreemovement"
    ],

    door_switch_held_effect: [
      "door_switch_held_effect",
      "doorswitchheldeffect",
      "door_switch_change",
      "doorswitchchange",
      "manual_door_switch_effect",
      "manualdoorswitcheffect",
      "holding_door_switch_effect",
      "holdingdoorswitcheffect",
      "door_switch_effect",
      "doorswitcheffect"
    ],

    frost_buildup: [
      "frost_buildup",
      "frostbuildup",
      "ice_buildup",
      "icebuildup",
      "freezer_frost",
      "freezerfrost",
      "coil_frost",
      "coilfrost",
      "back_wall_frost",
      "backwallfrost"
    ],

    airflow_present: [
      "airflow_present",
      "airflowpresent",
      "air_flow",
      "airflow_ok",
      "airflowok",
      "air_moving",
      "airmoving",
      "vent_airflow",
      "ventairflow",
      "fan_airflow",
      "fanairflow"
    ],

    compressor_running: [
      "compressor_running",
      "compressorrunning",
      "compressor_on",
      "compressoron",
      "compressor_status",
      "compressorstatus",
      "is_compressor_running",
      "iscompressorrunning"
    ],

    leak_location: [
      "leak_location",
      "leaklocation",
      "water_leak_location",
      "waterleaklocation",
      "where_is_the_leak",
      "whereistheleak",
      "leak_source_location",
      "leaksourcelocation"
    ],

    freezer_temp: [
      "freezer_temp",
      "freezertemp",
      "freezer_temperature",
      "freezertemperature",
      "temp_freezer",
      "tempfreezer",
      "freezer_coldness",
      "freezercoldness"
    ],

    fridge_temp: [
      "fridge_temp",
      "fridgetemp",
      "fridge_temperature",
      "fridgetemperature",
      "refrigerator_temp",
      "refrigeratortemp",
      "refrigerator_temperature",
      "refrigeratortemperature",
      "temp_fridge",
      "tempfridge"
    ],

    cooling_pattern: [
      "cooling_pattern",
      "coolingpattern",
      "cooling_behavior",
      "coolingbehavior",
      "cooling_issue_pattern",
      "coolingissuepattern",
      "temperature_pattern",
      "temperaturepattern"
    ],

    ice_maker_involved: [
      "ice_maker_involved",
      "icemakerinvolved",
      "ice_maker",
      "icemaker",
      "ice_system_involved",
      "icesysteminvolved",
      "during_ice_maker",
      "duringicemaker"
    ],

    rear_heat_level: [
      "rear_heat_level",
      "rearheatlevel",
      "back_heat_level",
      "backheatlevel",
      "rear_heat",
      "rearheat",
      "back_heat",
      "backheat",
      "compressor_area_heat",
      "compressorareaheat"
    ],

    fan_spins_by_hand: [
      "fan_spins_by_hand",
      "fanspinsbyhand",
      "fan_turns_by_hand",
      "fanturnsbyhand",
      "manual_fan_spin",
      "manualfanspin",
      "fan_moves_by_hand",
      "fanmovesbyhand"
    ],

    clicking: [
      "clicking",
      "click_sound",
      "clicksound",
      "rapid_clicking",
      "rapidclicking"
    ],

    humming: [
      "humming",
      "buzzing_hum",
      "buzzinghum",
      "low_hum",
      "lowhum"
    ],

    power_state: [
      "power_state",
      "powerstate",
      "on_off_state",
      "onoffstate",
      "plugged_in_state",
      "pluggedinstate"
    ],

    appliance_type: [
      "appliance_type",
      "appliancetype",
      "device_type",
      "devicetype",
      "machine_type",
      "machinetype"
    ],

    brand: [
      "brand",
      "manufacturer",
      "make"
    ],

    model_number: [
      "model_number",
      "modelnumber",
      "unit_model",
      "unitmodel"
    ],

    serial_number: [
      "serial_number",
      "serialnumber",
      "unit_serial",
      "unitserial"
    ],

    part_label_number: [
      "part_label_number",
      "partlabelnumber",
      "motor_label_number",
      "motorlabelnumber",
      "sticker_number",
      "stickernumber",
      "label_number",
      "labelnumber",
      "part_number_on_label",
      "partnumberonlabel"
    ]
  };

  const aliasMap = {};
  for (const [canonical, aliases] of Object.entries(aliasGroups)) {
    aliasMap[canonical] = canonical;
    aliasMap[canonical.replace(/_/g, "")] = canonical;

    for (const alias of aliases) {
      aliasMap[alias] = canonical;
      aliasMap[alias.replace(/_/g, "")] = canonical;
    }
  }

  if (aliasMap[normalized]) return aliasMap[normalized];
  if (aliasMap[compact]) return aliasMap[compact];

  const has = (word) => tokens.includes(word);
  const hasAny = (...words) => words.some((w) => tokens.includes(w));

  if ((hasAny("symptom", "issue", "problem") && hasAny("description", "details", "detail")) ||
      (has("description") && hasAny("symptom", "issue", "problem"))) {
    return "main_symptom";
  }

  if ((hasAny("extra", "more", "additional", "followup") && hasAny("detail", "details", "note", "notes", "observation")) ||
      (has("user") && hasAny("note", "notes"))) {
    return "details";
  }

  if (has("when") && hasAny("happens", "happen", "occurs", "occur")) {
    return "when_happens";
  }

  if (hasAny("timing", "frequency") || (has("intermittent") && has("constant"))) {
    return "timing";
  }

  if (hasAny("location", "where") || (has("source") && hasAny("location", "where"))) {
    return "location";
  }

  if ((hasAny("sound", "noise") && hasAny("type", "kind", "description")) ||
      (has("what") && hasAny("sound", "noise"))) {
    return "sound_type";
  }

  if ((hasAny("error", "fault", "blink", "display", "indicator") && hasAny("code", "codes", "light", "lights")) ||
      (has("error") && hasAny("code", "codes"))) {
    return "error_codes";
  }

  if (has("door") && hasAny("stops", "stop", "opens", "open") && has("noise")) {
    return "door_stops_noise";
  }

  if ((has("door") && hasAny("switch", "latch")) ||
      (has("latch") && has("click")) ||
      (has("switch") && has("click"))) {
    return "door_switch_response";
  }

  if (has("drum") && hasAny("spin", "spins", "turning", "rotates", "rotation", "motion")) {
    return "drum_spin_status";
  }

  if (has("drum") && has("hand")) {
    return "drum_moves_by_hand";
  }

  if (has("door") && has("switch") && hasAny("held", "hold", "effect", "change")) {
    return "door_switch_held_effect";
  }

  if (hasAny("frost", "ice") && hasAny("buildup", "build", "build_up")) {
    return "frost_buildup";
  }

  if (has("airflow") || (has("air") && hasAny("moving", "flow")) || (has("vent") && has("airflow"))) {
    return "airflow_present";
  }

  if (has("compressor") && hasAny("running", "on", "status")) {
    return "compressor_running";
  }

  if (has("leak") && hasAny("location", "source", "where")) {
    return "leak_location";
  }

  if ((has("freezer") && hasAny("temp", "temperature", "coldness")) ||
      (has("temp") && has("freezer"))) {
    return "freezer_temp";
  }

  if ((hasAny("fridge", "refrigerator") && hasAny("temp", "temperature")) ||
      (has("temp") && hasAny("fridge", "refrigerator"))) {
    return "fridge_temp";
  }

  if (has("cooling") && hasAny("pattern", "behavior")) {
    return "cooling_pattern";
  }

  if (has("ice") && has("maker")) {
    return "ice_maker_involved";
  }

  if ((hasAny("rear", "back") && has("heat")) ||
      (has("compressor") && has("heat"))) {
    return "rear_heat_level";
  }

  if (has("fan") && has("hand")) {
    return "fan_spins_by_hand";
  }

  if (has("clicking") || (has("rapid") && has("clicking"))) {
    return "clicking";
  }

  if (has("humming") || (has("buzzing") && has("hum"))) {
    return "humming";
  }

  if ((has("power") && hasAny("state", "status")) ||
      (has("plugged") && has("state")) ||
      (has("on") && has("off") && has("state"))) {
    return "power_state";
  }

  if ((has("appliance") && has("type")) ||
      (has("device") && has("type")) ||
      (has("machine") && has("type"))) {
    return "appliance_type";
  }

  if (normalized === "brand" || normalized === "manufacturer" || normalized === "make") {
    return "brand";
  }

  if (normalized === "model" || normalized === "model_number" || normalized === "unit_model") {
    return "model_number";
  }

  if (normalized === "serial" || normalized === "serial_number" || normalized === "unit_serial") {
    return "serial_number";
  }

  if ((hasAny("label", "sticker") && has("number")) ||
      (has("part") && has("label")) ||
      (has("motor") && has("label"))) {
    return "part_label_number";
  }

  return normalized;
}

function markQuestionAsked(session, key) {
  ensureDiagnosisFields(session);
  const intent = normalizeQuestionIntent(key);
  if (!intent) return;

  if (!Array.isArray(session.diagnosis.askedQuestionKeys)) {
    session.diagnosis.askedQuestionKeys = [];
  }

  if (!session.diagnosis.askedQuestionKeys.includes(intent)) {
    session.diagnosis.askedQuestionKeys.push(intent);
  }
}

function alreadyAskedQuestion(session, key) {
  ensureDiagnosisFields(session);
  const intent = normalizeQuestionIntent(key);
  if (!intent) return false;

  const list = Array.isArray(session?.diagnosis?.askedQuestionKeys)
    ? session.diagnosis.askedQuestionKeys
    : [];

  return list.includes(intent);
}

function markAnswerCaptured(session, key, value) {
  ensureDiagnosisFields(session);
  const intent = normalizeQuestionIntent(key);
  if (!intent) return;

  if (!Array.isArray(session.diagnosis.answeredKeys)) session.diagnosis.answeredKeys = [];
  if (!session.diagnosis.answeredKeys.includes(intent)) {
    session.diagnosis.answeredKeys.push(intent);
  }

  if (!session.diagnosis.answersByIntent || typeof session.diagnosis.answersByIntent !== "object") {
    session.diagnosis.answersByIntent = {};
  }

  session.diagnosis.answersByIntent[intent] = value;
}

function hasMeaningfulAnswerByIntent(session, keyOrIntent) {
  ensureDiagnosisFields(session);
  const intent = normalizeQuestionIntent(keyOrIntent);
  const v = session?.diagnosis?.answersByIntent?.[intent];

  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    return t.length > 0 && t !== "not sure";
  }
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "boolean") return true;
  return v != null;
}

function setCurrentQuestion(session, inputObj) {
  ensureDiagnosisFields(session);

  if (!inputObj || inputObj.type === "none") {
    session.diagnosis.currentQuestion = null;
    return;
  }

  session.diagnosis.currentQuestion = {
    key: normalizeText(inputObj.key || "details") || "details",
    type: normalizeText(inputObj.type || "text") || "text",
    choices: Array.isArray(inputObj.choices) ? inputObj.choices : []
  };
}

function detectHypothesisRejection(message) {
  const t = normalizeText(message).toLowerCase();
  if (!t) return false;

  return (
    t.includes("troubleshoot further") ||
    t.includes("keep troubleshooting") ||
    t.includes("want to troubleshoot") ||
    t.includes("not ready to replace") ||
    t.includes("do not want to proceed") ||
    t.includes("don't want to proceed") ||
    t.includes("that doesn't sound right") ||
    t.includes("that does not sound right") ||
    t.includes("i don't think that's it") ||
    t.includes("i dont think that's it") ||
    t.includes("i dont think thats it") ||
    t.includes("i don't think thats it") ||
    t.includes("that is not the issue") ||
    t.includes("not yet")
  );
}
function isExplicitDiagnosisProposalContext(session) {
  const dx = session?.diagnosis || {};
  const currentQuestion = dx.currentQuestion;

  if (dx.stage === "locked") return true;
  if (session?.mode === "part_lookup") return true;
  if (session?.mode === "repair") return true;

  if (!currentQuestion && dx.proposedHypothesis && normalizeConfidence(dx.confidence ?? 0) >= 70) {
    return true;
  }

  return false;
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
  const choices = Array.isArray(q.choices)
    ? q.choices
    : Array.isArray(q.input?.choices)
      ? q.input.choices
      : [];

  if (type === "choice") {
    const coerced = coerceChoiceAnswer(msg, choices);
    return { key, value: coerced ?? msg, usedCoercion: coerced != null };
  }

  if (type === "text") {
    return { key, value: msg, usedCoercion: false };
  }

  return { key, value: msg, usedCoercion: false };
}/* =========================================================
   Diagnosis question quality enforcement
========================================================= */

function selectHighValueFallbackQuestion(session) {
  const a = String(session.appliance || "").toLowerCase();
  const cat = String(session.issueCategory || "").toLowerCase();

  if (a === "refrigerator" && cat === "noise") {
    if (!hasMeaningfulAnswerByIntent(session, "whenHappens")) {
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
      assistant: "Where is the noise loudest: back bottom, back top, inside freezer, inside fridge, or cannot tell?",
      input: {
        type: "choice",
        key: "location",
        choices: ["back bottom", "back top", "inside freezer", "inside fridge", "cannot tell"]
      },
      questionMeta: {
        goal: "disambiguate",
        reason: "Location helps separate compressor area noise from evaporator area noise.",
        rulesUsed: ["fridge_noise_location_split"],
        eliminates: ["some unrelated causes"],
        narrowsTo: ["condenser fan motor", "evaporator fan motor", "compressor or mounts"]
      }
    };
  }

  if (a === "dryer") {
    if (!hasMeaningfulAnswerByIntent(session, "drumMovesByHand")) {
      return {
        assistant: "With the dryer unplugged, can you turn the drum by hand, and does it move freely or feel stuck?",
        input: { type: "choice", key: "drumMovesByHand", choices: ["moves freely", "feels stuck", "not sure"] },
        questionMeta: {
          goal: "disambiguate",
          reason: "This helps separate a motor issue from a seized drum, idler, or belt path issue.",
          rulesUsed: ["dryer_no_start_motor_belt_split"],
          eliminates: ["some control and switch causes"],
          narrowsTo: ["drive motor", "belt path", "idler or drum jam"]
        }
      };
    }

    if (!hasMeaningfulAnswerByIntent(session, "doorSwitchHeldEffect")) {
      return {
        assistant: "When you press and hold the door switch, what changes do you notice?",
        input: {
          type: "choice",
          key: "doorSwitchHeldEffect",
          choices: ["nothing changes", "heater comes on", "drum tries to move", "not sure"]
        },
        questionMeta: {
          goal: "disambiguate",
          reason: "This checks what parts of the start circuit respond without pushing a specific component too early.",
          rulesUsed: ["dryer_switch_effect_split"],
          eliminates: ["some unrelated causes"],
          narrowsTo: ["door switch path", "motor start path", "control path"]
        }
      };
    }

    if (!hasMeaningfulAnswerByIntent(session, "soundType")) {
      return {
        assistant: "What sound do you hear when you press start: a click, a hum or buzz, no sound, or something else?",
        input: { type: "choice", key: "soundType", choices: ["click", "hum or buzz", "no sound", "other", "not sure"] },
        questionMeta: {
          goal: "disambiguate",
          reason: "The sound pattern helps separate a motor start issue from a switch or control issue.",
          rulesUsed: ["dryer_no_start_sound_split"],
          eliminates: ["some unrelated causes"],
          narrowsTo: ["drive motor", "start circuit", "door switch", "control board"]
        }
      };
    }

    if (!hasMeaningfulAnswerByIntent(session, "main_symptom")) {
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

    return {
      assistant: "What is the next most noticeable thing you observe when you press Start?",
      input: { type: "text", key: "details", choices: [] },
      questionMeta: {
        goal: "disambiguate",
        reason: "A fresh observation is better than repeating intake once symptom details are captured.",
        rulesUsed: ["general_followup"],
        eliminates: [],
        narrowsTo: ["top_likely_components"]
      }
    };
  }

  if (!hasMeaningfulAnswerByIntent(session, "main_symptom")) {
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

  return {
    assistant: "Tell me the next most noticeable thing you observe when the issue happens.",
    input: { type: "text", key: "details", choices: [] },
    questionMeta: {
      goal: "disambiguate",
      reason: "A fresh observation is better than repeating intake once core symptom details are captured.",
      rulesUsed: ["general_followup"],
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

  const leadingPhrases = ["would you like to proceed with replacing", "proceed with replacing", "faulty door switch"];
  const tooLeading = leadingPhrases.some((p) => assistant.includes(p));

  const inputOk =
    input.type === "text" ||
    (input.type === "choice" && Array.isArray(input.choices) && input.choices.length >= 2 && input.choices.length <= 6) ||
    input.type === "none";

  return goalOk && reasonOk && narrowsOk && !banned && !tooLeading && inputOk;
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
}function safetyGateInfo(session) {
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
    locked: false,

    askedQuestionKeys: [],
    answeredKeys: [],
    answersByIntent: {},
    rejectedHypotheses: [],
    proposedHypothesis: null,
    currentBranch: null,
    narrowedBranch: null,

    conversation: {
      turns: [],
      lastTurnAt: null
    }
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
  if (typeof dx.locked !== "boolean") dx.locked = false;

  if (!Array.isArray(dx.askedQuestionKeys)) dx.askedQuestionKeys = [];
  if (!Array.isArray(dx.answeredKeys)) dx.answeredKeys = [];
  if (!dx.answersByIntent || typeof dx.answersByIntent !== "object") dx.answersByIntent = {};
  if (!Array.isArray(dx.rejectedHypotheses)) dx.rejectedHypotheses = [];
  if (typeof dx.proposedHypothesis === "undefined") dx.proposedHypothesis = null;
  if (typeof dx.currentBranch === "undefined") dx.currentBranch = null;
  if (typeof dx.narrowedBranch === "undefined") dx.narrowedBranch = null;

  dx.conversation = dx.conversation || { turns: [], lastTurnAt: null };
  if (!Array.isArray(dx.conversation.turns)) dx.conversation.turns = [];
  if (typeof dx.conversation.lastTurnAt === "undefined") dx.conversation.lastTurnAt = null;
}

function ensureDiagnosisConversation(session) {
  ensureDiagnosisFields(session);
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

Critical constraints:
Do not ask a question that is semantically equivalent to a previously asked question.
If the user has already described the main symptom, do not ask for the main symptom again.
Do not ask leading questions that suggest a faulty component by name unless confidence is high and competing causes are clearly weaker.
If the user declined a proposed repair or said they want to troubleshoot further, do not repeat that same repair proposal. Ask the next best discriminating question from a different branch.
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
    answersByIntent: dx.answersByIntent || {},
    priorTurns: turns,
    priorLikelyCauses: dx.likelyCauses || [],
    priorSafetyFlags: dx.safetyFlags || [],
    alreadyAskedIntents: Array.isArray(dx.askedQuestionKeys) ? dx.askedQuestionKeys : [],
    answeredIntents: Array.isArray(dx.answeredKeys) ? dx.answeredKeys : [],
    rejectedHypotheses: Array.isArray(dx.rejectedHypotheses) ? dx.rejectedHypotheses : [],
    proposedHypothesis: dx.proposedHypothesis || null,
    currentBranch: dx.currentBranch || null,
    narrowedBranch: dx.narrowedBranch || null
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
      locked: false,

      askedQuestionKeys: [],
      answeredKeys: [],
      answersByIntent: {},
      rejectedHypotheses: [],
      proposedHypothesis: null,
      currentBranch: null,
      narrowedBranch: null,

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
}/* =========================================================
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
    markAnswerCaptured(session, "symptomDetails", seededText);

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
      markAnswerCaptured(session, "symptomDetails", userDescription.trim());
    }

    if (answers && typeof answers === "object") {
      session.diagnosis.answers = { ...(session.diagnosis.answers || {}), ...answers };
      for (const [k, v] of Object.entries(answers)) {
        markAnswerCaptured(session, k, v);
      }
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
function syncReasoningEvidenceFromAnswers(session) {
  ensureReasoning(session);
  ensureDiagnosisFields(session);

  const answersByIntent =
    session?.diagnosis?.answersByIntent && typeof session.diagnosis.answersByIntent === "object"
      ? session.diagnosis.answersByIntent
      : {};

  const directAnswers =
    session?.diagnosis?.answers && typeof session.diagnosis.answers === "object"
      ? session.diagnosis.answers
      : {};

  let evidence = Array.isArray(session.diagnosis.reasoning.evidence)
    ? session.diagnosis.reasoning.evidence
    : [];

  function normalizeEvidenceKey(key) {
    const k = normalizeText(String(key || ""));

    const map = {
      applianceType: "appliance_type",
      symptomDescription: "main_symptom",
      symptomDetails: "main_symptom",
      issueDescription: "main_symptom",
      description: "details",

      location: "location",
      soundType: "sound_type",
      whenHappens: "when_happens",
      timing: "timing",
      doorStopsNoise: "door_stops_noise",
      frostBuildup: "frost_buildup",
      errorCodes: "error_codes",

      drumMovesByHand: "drum_moves_by_hand",
      doorSwitchHeldEffect: "door_switch_held_effect",
      drumSpinStatus: "drum_spin_status",
      drumSpin: "drum_spin_status",
      heatPresent: "heat_present",
      heater: "heat_present"
    };

    return map[k] || k;
  }

  function normalizeEvidenceValue(key, value) {
    if (value == null) return value;

    if (typeof value !== "string") return value;

    const raw = normalizeText(value).toLowerCase();
    const normalizedKey = normalizeEvidenceKey(key);

    if (normalizedKey === "sound_type") {
      if (["hum", "buzz", "humming", "buzzing", "hum or buzz"].includes(raw)) return "hum or buzz";
      if (["no sound", "none", "silent"].includes(raw)) return "no sound";
      if (["click", "clicking"].includes(raw)) return "clicking";
    }

    if (normalizedKey === "drum_moves_by_hand") {
      if (["moves freely", "free", "spins freely"].includes(raw)) return "moves freely";
      if (["feels stuck", "stuck", "hard to turn"].includes(raw)) return "feels stuck";
    }

    if (normalizedKey === "door_switch_held_effect") {
      if (raw.includes("heater")) return "heater comes on";
      if (raw.includes("tries")) return "drum tries to move";
      if (raw.includes("nothing")) return "nothing changes";
    }

    if (normalizedKey === "drum_spin_status") {
      if (
        raw.includes("does not spin") ||
        raw.includes("not spinning") ||
        raw.includes("doesn't spin") ||
        raw.includes("no spin")
      ) {
        return "does not spin";
      }
      if (raw.includes("spins")) return "spins";
    }

    if (normalizedKey === "door_stops_noise") {
      if (["yes", "no", "not sure"].includes(raw)) return raw;
    }

    if (normalizedKey === "frost_buildup") {
      if (["yes", "no", "not sure"].includes(raw)) return raw;
    }

    if (normalizedKey === "error_codes") {
      if (["yes", "no", "not sure"].includes(raw)) return raw;
    }

    if (normalizedKey === "heat_present") {
      if (["yes", "no", "not sure"].includes(raw)) return raw;
      if (raw.includes("heater comes on")) return "yes";
    }

    return value;
  }

  function upsertFromRecord(record, source) {
    for (const [rawKey, rawValue] of Object.entries(record || {})) {
      if (rawValue == null) continue;
      if (typeof rawValue === "string" && !normalizeText(rawValue)) continue;

      const evidenceKey = normalizeEvidenceKey(rawKey);
      const evidenceValue = normalizeEvidenceValue(rawKey, rawValue);

      evidence = upsertEvidenceFact(
        evidence,
        makeEvidenceFact({
          key: evidenceKey,
          value: evidenceValue,
          source,
          confidence: 95,
          raw: rawValue
        })
      );
    }
  }

  upsertFromRecord(answersByIntent, "answers_sync");
  upsertFromRecord(directAnswers, "answers_sync");

  session.diagnosis.reasoning.evidence = evidence;
}
app.post("/session/diagnose/next", requireSession, async (req, res) => {
  try {
    const session = req.fxSession;
    ensureReasoning(session);

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
      markAnswerCaptured(session, nk, value);

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

      for (const [k, v] of Object.entries(mergedAnswers)) {
        markAnswerCaptured(session, k, v);
      }

      if (typeof mergedAnswers.applianceType === "string" && mergedAnswers.applianceType) {
        session.appliance = mergedAnswers.applianceType;
        session.partLookup = session.partLookup || {};
        session.partLookup.applianceType = session.partLookup.applianceType || mergedAnswers.applianceType;
      }

      if (typeof mergedAnswers.issueDescription === "string" && mergedAnswers.issueDescription) {
        session.diagnosis.userDescription = mergedAnswers.issueDescription;
        markAnswerCaptured(session, "issueDescription", mergedAnswers.issueDescription);
      }

      if (typeof mergedAnswers.description === "string" && mergedAnswers.description) {
        const prev = session.diagnosis.userDescription ? String(session.diagnosis.userDescription) : "";
        session.diagnosis.userDescription = prev ? `${prev}\n${mergedAnswers.description}` : mergedAnswers.description;
        markAnswerCaptured(session, "description", mergedAnswers.description);
      }

      if (typeof mergedAnswers.symptomDescription === "string" && mergedAnswers.symptomDescription) {
        const prev = session.diagnosis.userDescription ? String(session.diagnosis.userDescription) : "";
        session.diagnosis.userDescription = prev
          ? `${prev}\n${mergedAnswers.symptomDescription}`
          : mergedAnswers.symptomDescription;
        markAnswerCaptured(session, "symptomDescription", mergedAnswers.symptomDescription);
      }
    }

    syncReasoningEvidenceFromAnswers(session);

    if (normalizeText(effectiveMessage)) {
  const prev = session.diagnosis.userDescription ? String(session.diagnosis.userDescription) : "";
  session.diagnosis.userDescription = prev
    ? `${prev}\n${normalizeText(effectiveMessage)}`
    : normalizeText(effectiveMessage);

  pushDiagTurn(session, "user", effectiveMessage);

  const proposalContext = isExplicitDiagnosisProposalContext(session);

  if (
    proposalContext &&
    detectHypothesisRejection(effectiveMessage) &&
    session.diagnosis.proposedHypothesis
  ) {
    const rejected = session.diagnosis.proposedHypothesis;

    if (!session.diagnosis.rejectedHypotheses.includes(rejected)) {
      session.diagnosis.rejectedHypotheses.push(rejected);
    }

    session.diagnosis.proposedHypothesis = null;
    session.diagnosis.narrowedBranch = "continue_narrowing";
    session.diagnosis.locked = false;
    session.diagnosis.stage = "questions";
    session.mode = "diagnose";
  }
}

    session.diagnosis.reasoning.lastAction = {
      type: "diagnose_next_input_processed",
      at: new Date().toISOString(),
      hadMessage: !!normalizeText(effectiveMessage),
      hadBoundAnswer: !!key,
      answerKey: key || null
    };

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
      session.partLookup.suspectedComponent =
        session.diagnosis.suggestedComponent || scoredNow.suggestedComponent || null;

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

    

    await extractEvidenceFromMessage({
  session,
  userText: effectiveMessage,
  boundAnswer: key ? { key, value } : null
});

syncReasoningEvidenceFromAnswers(session);

await rankHypotheses({ session });

const topHypothesis = session.diagnosis.reasoning.hypotheses?.[0] || null;
const secondHypothesis = session.diagnosis.reasoning.hypotheses?.[1] || null;
const topConfidence = normalizeConfidence(topHypothesis?.confidence ?? 0);

session.diagnosis.proposedHypothesis =
  topConfidence >= 70 ? (topHypothesis?.component || null) : null;

session.diagnosis.currentBranch = session.diagnosis.reasoning.symptomFamily || null;
session.diagnosis.narrowedBranch =
  topHypothesis?.component && secondHypothesis?.component
    ? `${topHypothesis.component}__vs__${secondHypothesis.component}`
    : topHypothesis?.component || null;

session.diagnosis.likelyCauses = (session.diagnosis.reasoning.hypotheses || []).slice(0, 5).map((h) => ({
  cause: h.component || h.cause || "unknown",
  confidence: normalizeConfidence(h.confidence ?? 0),
  notes: h.reason || h.notes || ""
}));

session.diagnosis.reasoning.lastAction = {
  type: "hypotheses_ranked",
  at: new Date().toISOString(),
  symptomFamily: session.diagnosis.reasoning.symptomFamily || null,
  topComponent: topHypothesis?.component || null,
  topConfidence: topHypothesis?.confidence ?? null
};

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
    scope: "diagnosis",
    requiredAcks: gate1.missingAcks,
    prompt: gate1.prompt || "Confirm required safety acknowledgments to continue."
  });

  await sessionStore.setIdempotency(session.sessionId, actionId, responseObj);
  return res.status(409).json(responseObj);
}

if (gate1.blockRepair) {
  session.diagnosis.recommendedPath = "escalate";
  session.diagnosis.status = "complete";
  session.diagnosis.stage = "escalate";
  session.diagnosis.locked = false;
  session.mode = "escalate";

  const assistantText =
    session.safetyProfile.prompt ||
    session.safetyProfile.reason ||
    "Stop now and escalate to a professional. Shut off power only if it is safe.";

  pushDiagTurn(session, "assistant", assistantText);

  await req.saveFxSession();

  const responseObj = buildSafetyBlockedResponse(session, {
    scope: "diagnosis",
    reason: session.safetyProfile.reason,
    prompt: assistantText
  });

  await sessionStore.setIdempotency(session.sessionId, actionId, responseObj);
  return res.status(409).json(responseObj);
}

const shouldLock = evaluateLockReadiness(session);

if (shouldLock) {
  session.diagnosis.locked = true;
  session.diagnosis.recommendedPath = "repair";
  session.diagnosis.status = "complete";
  session.diagnosis.stage = "locked";
  session.diagnosis.component = session.diagnosis.suggestedComponent || session.diagnosis.component || null;

  session.partLookup = session.partLookup || {};
  session.partLookup.applianceType = session.partLookup.applianceType || session.appliance || null;
  session.partLookup.suspectedComponent =
    session.partLookup.suspectedComponent || session.diagnosis.suggestedComponent || null;

  session.mode = "part_lookup";

  await req.saveFxSession();
  session.diagnosis.proposedHypothesis = session.diagnosis.suggestedComponent || session.diagnosis.component || null;

  const responseObj = buildSuccessResponse(session, {
    type: "diagnose_locked",
    nextAction: "part_lookup",
    ui: {
      assistantMessage: "I’m confident in the issue. Let’s confirm the part.",
      input: { type: "none", key: "", choices: [] }
    }
  });

  await sessionStore.setIdempotency(session.sessionId, actionId, responseObj);
  return res.status(200).json(responseObj);
}

const next = await chooseNextDiagnosticAction({ session });

if (next?.question?.input?.type === "none") {
  session.diagnosis.locked = true;
  session.diagnosis.recommendedPath = "repair";
  session.diagnosis.status = "complete";
  session.diagnosis.stage = "locked";
  session.diagnosis.component = session.diagnosis.suggestedComponent || session.diagnosis.component || null;

  session.partLookup = session.partLookup || {};
  session.partLookup.applianceType = session.partLookup.applianceType || session.appliance || null;
  session.partLookup.suspectedComponent =
    session.partLookup.suspectedComponent || session.diagnosis.suggestedComponent || null;

  session.mode = "part_lookup";

  await req.saveFxSession();

  const responseObj = buildSuccessResponse(session, {
    type: "diagnose_locked",
    nextAction: "part_lookup",
    ui: {
      assistantMessage: "I’m confident in the issue. Let’s confirm the part.",
      input: { type: "none", key: "", choices: [] }
    }
  });

  await sessionStore.setIdempotency(session.sessionId, actionId, responseObj);
  return res.status(200).json(responseObj);
}

let question = next?.question || null;

if (!question || !question.input || question.input.type === "none") {
  const scriptedQ = getScriptedNextQuestion(session);

  if (scriptedQ) {
    question = {
      assistant: scriptedQ.prompt,
      input: {
        type: scriptedQ.type,
        key: scriptedQ.key,
        choices: scriptedQ.choices
      }
    };
  }
}

if (!question) {
  question = {
    assistant: "",
    input: { type: "none", key: "", choices: [] }
  };
}
    const normalizedInput = normalizeTurnInput({ input: question.input });

    setCurrentQuestion(session, normalizedInput);

    if (normalizedInput.type !== "none" && normalizedInput.key) {
      markQuestionAsked(session, normalizedInput.key);
    }

    if (question.assistant) {
      pushDiagTurn(session, "assistant", question.assistant);
    }

    session.diagnosis.status = "running";
    session.diagnosis.stage = "questions";
    session.diagnosis.locked = false;
    session.mode = "diagnose";

    await req.saveFxSession();

    const responseObj = buildSuccessResponse(session, {
      type: "diagnose_turn",
      nextAction:
        normalizedInput.type === "choice"
          ? "answers"
          : normalizedInput.type === "none"
            ? "done"
            : "message",
      diagnosis: {
        locked: false,
        confidence: session.diagnosis.confidence,
        suggestedComponent: session.diagnosis.suggestedComponent || null,
        component: session.diagnosis.component || null,
        summaryForUser: null,
        symptomFamily: session.diagnosis.reasoning?.symptomFamily || null,
        topHypotheses: (session.diagnosis.reasoning?.hypotheses || []).slice(0, 3).map((h) => ({
          component: h.component,
          confidence: h.confidence,
          reason: h.reason || "",
          missingEvidence: Array.isArray(h.missingEvidence) ? h.missingEvidence : [],
          conflictingEvidence: Array.isArray(h.conflictingEvidence) ? h.conflictingEvidence : []
        }))
      },
      ui: {
        assistantMessage: question.assistant || "",
        input: normalizedInput,
        questionMeta: next?.questionMeta || null
      }
    });

    await sessionStore.setIdempotency(session.sessionId, actionId, responseObj);
    return res.status(200).json(responseObj);
  } 
  catch (err) {
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

let template = await buildDynamicRepairPlan({ session });

if (Array.isArray(template?.steps) && template.steps.length > 0) {
  template.steps = normalizeRepairSteps(template.steps);
} else {
  template = getRepairTemplate({
    appliance: session.appliance,
    componentKey: session.diagnosis.suggestedComponent
  });
}

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
    if (!sessionId || typeof sessionId !== "string") {
      return res.status(400).json({ error: "sessionId is required" });
    }

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