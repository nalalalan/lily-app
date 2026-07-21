const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const weightForecast = require("./public/weight-forecast.js");

const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, "public");
const dataDir = process.env.DATA_DIR || path.join(__dirname, ".data");
const mediaDir = path.join(dataDir, "media");
const storePath = path.join(dataDir, "store.json");
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 110 * 1024 * 1024);
const pin = process.env.LILY_PIN || "local-dev-pin-required";
const sessionSecret = process.env.SESSION_SECRET || "local-dev-lily-session-secret";
const openaiApiKey = process.env.OPENAI_API_KEY || "";
const chatModel = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
const visionModel = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
const privateCoachGoal = Number(process.env.LILY_INTERNAL_GOAL_LB);
const coachGenerationTimeoutMs = Math.max(500, Number(process.env.LILY_COACH_TIMEOUT_MS || 8000));
const trackerTimeZone = process.env.LILY_TRACKER_TIME_ZONE || "America/New_York";
const defaultPeriodCycleDays = 28;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000,https://lily.aolabs.io")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".png": "image/png",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm"
};

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const videoExtensions = new Set([".mp4", ".m4v", ".mov", ".webm"]);

let writeQueue = Promise.resolve();

const COACH_GENERATION_VERSION = "coach-pipeline-v1";
const COACH_PROMPT_VERSION = "coach-prompt-v1";
const COACH_SAFETY_VERSION = "coach-safety-v1";
const COACH_MIN_WORDS = 35;
const COACH_MAX_WORDS = 55;
const KG_TO_LB = 2.2046226218;

async function ensureDataDir() {
  await fsp.mkdir(mediaDir, { recursive: true });
  try {
    await fsp.access(storePath);
  } catch (error) {
    await fsp.writeFile(storePath, JSON.stringify({ memories: [], weights: [], chats: [], trackerEvents: [], coachMessages: [] }, null, 2));
  }
}

function send(res, status, data, headers = {}) {
  const isText = typeof data === "string" || Buffer.isBuffer(data);
  const body = isText ? data : JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": isText ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.includes(origin) || allowedOrigins.includes("*"))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function readStore() {
  await ensureDataDir();
  const raw = await fsp.readFile(storePath, "utf8");
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, "") || "{}");
  return {
    ...parsed,
    memories: Array.isArray(parsed.memories) ? parsed.memories : [],
    weights: Array.isArray(parsed.weights) ? parsed.weights : [],
    chats: Array.isArray(parsed.chats) ? parsed.chats : [],
    trackerEvents: Array.isArray(parsed.trackerEvents) ? parsed.trackerEvents : [],
    coachMessages: Array.isArray(parsed.coachMessages) ? parsed.coachMessages : []
  };
}

function writeStore(mutator) {
  const operation = writeQueue.catch(() => undefined).then(async () => {
    const store = await readStore();
    const nextStore = await mutator(store);
    const tmpPath = `${storePath}.tmp`;
    await fsp.writeFile(tmpPath, JSON.stringify(nextStore, null, 2));
    await fsp.rename(tmpPath, storePath);
    return nextStore;
  });
  writeQueue = operation.catch(() => undefined);
  return operation;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        reject(Object.assign(new Error("Request too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

function createSession(remember) {
  const ttl = remember ? 7 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
  const payload = {
    exp: Date.now() + ttl,
    nonce: crypto.randomBytes(10).toString("base64url")
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret).update(encoded).digest("base64url");
  return { token: `${encoded}.${sig}`, expiresAt: payload.exp };
}

function verifySession(token) {
  if (!token || !token.includes(".")) return false;
  const [encoded, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", sessionSecret).update(encoded).digest("base64url");
  if (Buffer.byteLength(sig) !== Buffer.byteLength(expected)) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return Number(payload.exp) > Date.now();
  } catch (error) {
    return false;
  }
}

function authToken(req) {
  const header = req.headers.authorization || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return "";
}

function requireAuth(req, res) {
  if (verifySession(authToken(req))) return true;
  send(res, 401, { error: "Unauthorized" });
  return false;
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
}

function classifyText(text) {
  const lower = text.toLowerCase();
  const phonePattern = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
  const datePattern = /\b(?:bday|birthday|anniversary|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/i;
  const addressPattern = /\b\d{1,6}\s+([a-z0-9'.-]+\s+){1,7}(street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|place|pl|way|blvd|boulevard|apt|unit|circle|cir)\b/i;
  if (phonePattern.test(text) || lower.includes("phone") || lower.includes("number")) return "contact";
  if (addressPattern.test(text) || lower.includes("address")) return "address";
  if (datePattern.test(text) && (text.length < 140 || /bday|birthday|anniversary/i.test(text))) return "date";
  if (/^["']|["']$/.test(text) || text.length > 220) return "quote";
  return "note";
}

function isSupportedMediaType(type) {
  return String(type || "").startsWith("image/") || String(type || "").startsWith("video/");
}

function sanitizeFileName(name, type = "") {
  const ext = path.extname(name || "").toLowerCase().replace(/[^a-z0-9.]/g, "");
  const isVideo = String(type).startsWith("video/");
  const allowed = isVideo ? videoExtensions : imageExtensions;
  const safeExt = allowed.has(ext) ? ext : (isVideo ? ".mp4" : ".jpg");
  return `${createId("media")}${safeExt}`;
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(dataUrl || "");
  if (!match) throw Object.assign(new Error("Invalid file data"), { status: 400 });
  return { type: match[1], buffer: Buffer.from(match[2], "base64") };
}

function responseText(json) {
  if (json.output_text) return json.output_text;
  const parts = [];
  for (const output of json.output || []) {
    for (const content of output.content || []) {
      if ((content.type === "output_text" || content.type === "text") && content.text) {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

async function saveFile(file) {
  const { type, buffer } = parseDataUrl(file.dataUrl);
  if (!isSupportedMediaType(type)) throw Object.assign(new Error("Only images and videos are supported"), { status: 400 });
  const filename = sanitizeFileName(file.name || "upload", type);
  await fsp.writeFile(path.join(mediaDir, filename), buffer);
  return {
    filename,
    originalName: file.name || "upload",
    type,
    size: buffer.length,
    url: `/media/${filename}`
  };
}

async function analyzeImage(dataUrl, noteText) {
  if (!openaiApiKey) return { summary: "", extractedText: "", facts: [] };
  const prompt = [
    "Extract useful memory-bank information from this image for a private personal assistant.",
    "If it is a screenshot, transcribe important visible text.",
    "Return concise JSON with keys: summary, extractedText, facts.",
    "Facts should be short strings about preferences, dates, places, contact details, plans, likes, dislikes, or context.",
    noteText ? `User note/caption: ${noteText}` : ""
  ].filter(Boolean).join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiApiKey}`
      },
      body: JSON.stringify({
        model: visionModel,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", image_url: dataUrl }
            ]
          }
        ],
        max_output_tokens: 700
      })
    });
    if (!response.ok) throw new Error(await response.text());
    const json = await response.json();
    const text = responseText(json);
    const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, "").trim());
    return {
      summary: String(parsed.summary || "").slice(0, 1600),
      extractedText: String(parsed.extractedText || "").slice(0, 4000),
      facts: Array.isArray(parsed.facts) ? parsed.facts.map(String).slice(0, 20) : []
    };
  } catch (error) {
    return { summary: "", extractedText: "", facts: [], analysisError: "Image analysis failed." };
  }
}

function publicMemory(memory) {
  return {
    id: memory.id,
    kind: memory.kind,
    text: memory.text,
    caption: memory.caption,
    file: memory.file,
    summary: memory.summary,
    extractedText: memory.extractedText,
    facts: memory.facts,
    sourceId: memory.sourceId,
    factIndex: memory.factIndex,
    derivedFact: memory.derivedFact,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt
  };
}

function publicMemories(memories) {
  return memories.map(publicMemory);
}

function publicWeight(record) {
  return {
    id: record.id,
    weight: record.weight,
    unit: record.unit || "lb",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function publicWeights(weights) {
  return weights.map(publicWeight);
}

function weightInPounds(record) {
  const value = Number(record && record.weight);
  if (!Number.isFinite(value)) return NaN;
  return String(record.unit || "lb").trim().toLowerCase() === "kg" ? value * KG_TO_LB : value;
}

function trimCoachNumber(value) {
  if (!Number.isFinite(Number(value))) return "--";
  return Number(Number(value).toFixed(1)).toString();
}

function coachWordCount(text) {
  return String(text || "").trim().match(/[A-Za-z0-9]+(?:[’'][A-Za-z0-9]+)*/g)?.length || 0;
}

function normalizeCoachParagraph(text) {
  return String(text || "")
    .replace(/^```(?:text)?\s*|\s*```$/gi, "")
    .replace(/^(["'])|(["'])$/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function causalWeightRows(store, weightId) {
  const rows = Array.isArray(store && store.weights) ? store.weights : [];
  const current = rows.find((record) => record.id === weightId) || null;
  if (!current) return { current: null, rows: [], points: [] };
  const cutoff = Date.parse(current.createdAt);
  const causalRows = rows
    .filter((record) => Number.isFinite(Date.parse(record.createdAt)) && Date.parse(record.createdAt) <= cutoff)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || String(left.id).localeCompare(String(right.id)));
  const points = weightForecast.normalizePoints(causalRows.map((record) => ({
    time: Date.parse(record.createdAt),
    weight: weightInPounds(record)
  })));
  return { current, rows: causalRows, points };
}

function robustWindowMovement(points, windowDays) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const latestDay = points[points.length - 1].day;
  const rows = points.filter((point) => point.day >= latestDay - windowDays);
  if (rows.length < 2) return null;
  const clusterSize = Math.max(1, Math.floor(rows.length / 3));
  const start = median(rows.slice(0, clusterSize).map((point) => point.weight));
  const end = median(rows.slice(-clusterSize).map((point) => point.weight));
  return Number.isFinite(start) && Number.isFinite(end) ? end - start : null;
}

function recentWeightStreak(points) {
  if (!Array.isArray(points) || points.length < 2) return { direction: "flat", count: 1, movement: 0, reversal: false };
  const changes = [];
  for (let index = 1; index < points.length; index += 1) {
    const change = points[index].weight - points[index - 1].weight;
    changes.push(Math.abs(change) < 0.05 ? 0 : Math.sign(change));
  }
  const latestDirection = changes[changes.length - 1];
  let count = 1;
  if (latestDirection) {
    for (let index = changes.length - 1; index >= 0 && changes[index] === latestDirection; index -= 1) count += 1;
  }
  let previousDirection = 0;
  for (let index = changes.length - count; index >= 0; index -= 1) {
    if (changes[index]) {
      previousDirection = changes[index];
      break;
    }
  }
  const startIndex = Math.max(0, points.length - count);
  return {
    direction: latestDirection < 0 ? "down" : latestDirection > 0 ? "up" : "flat",
    count,
    movement: points[points.length - 1].weight - points[startIndex].weight,
    reversal: Boolean(latestDirection && previousDirection && latestDirection !== previousDirection)
  };
}

function isWeightOutlier(points) {
  if (!Array.isArray(points) || points.length < 2) return false;
  const changes = [];
  for (let index = 1; index < points.length; index += 1) changes.push(points[index].weight - points[index - 1].weight);
  const latest = Math.abs(changes[changes.length - 1]);
  if (latest >= 3.5) return true;
  const historical = changes.slice(0, -1).map(Math.abs);
  if (historical.length < 4) return latest >= 2.5;
  const typical = median(historical);
  const deviations = historical.map((value) => Math.abs(value - typical));
  const mad = median(deviations);
  return latest > Math.max(2.5, typical + Math.max(0.35, mad * 4));
}

function foodPreferenceSignal(text, topicPattern) {
  const clauses = String(text || "").split(/\bbut\b|[.;!?]/i);
  let signal = 0;
  let topicSeen = false;
  for (const clause of clauses) {
    const topicHere = topicPattern.test(clause);
    const pronounReference = topicSeen && /\b(?:it|them)\b/i.test(clause);
    if (!topicHere && !pronounReference) continue;
    if (topicHere) topicSeen = true;
    const negative = /\b(?:hate|hates|hated|dislike|dislikes|disliked|does\s+not\s+like|doesn't\s+like|do\s+not\s+like|don't\s+like|avoid|avoids|allergic\w*)\b/i.test(clause);
    const positive = /\b(?:love|loves|loved|like|likes|liked|enjoy|enjoys|enjoyed|want|wants|wanted|prefer|prefers|preferred|favorite|favourite)\b/i.test(clause);
    if (negative) signal = -1;
    else if (positive) signal = 1;
  }
  return signal;
}

function selectSavedPreference(memories, cutoff) {
  const blocked = /\b(?:sex|horn|ovulat|conflict|address|phone|diagnos|depress|body image|appearance|relationship)\b/i;
  const rows = (Array.isArray(memories) ? memories : [])
    .filter((memory) => memory && memory.kind === "note")
    .filter((memory) => !memory.sourceId && !memory.derivedFact && !memory.factIndex)
    .filter((memory) => !Number.isFinite(cutoff) || !Number.isFinite(Date.parse(memory.createdAt)) || Date.parse(memory.createdAt) <= cutoff)
    .map((memory) => ({ memory, text: String(memory.text || "").trim() }))
    .filter((item) => item.text && !blocked.test(item.text))
    .sort((left, right) => String(right.memory.updatedAt || right.memory.createdAt || "").localeCompare(String(left.memory.updatedAt || left.memory.createdAt || "")));

  for (const item of rows) {
    const korean = foodPreferenceSignal(item.text, /\b(?:korean|spicy)\b/i) > 0;
    const vegetables = foodPreferenceSignal(item.text, /\b(?:vegetable|veggie)\w*\b/i) > 0;
    const fruit = foodPreferenceSignal(item.text, /\b(?:peach|fruit|berries|apple)\w*\b/i) > 0;
    if (korean && vegetables) {
      return {
        id: item.memory.id,
        kind: "food-preference",
        action: "Make the next meal work harder: keep the Korean flavor and add the vegetables you said you want."
      };
    }
    if (vegetables) {
      return {
        id: item.memory.id,
        kind: "food-preference",
        action: "Make the next meal count by adding the vegetables you said you want."
      };
    }
    if (korean) {
      return {
        id: item.memory.id,
        kind: "food-preference",
        action: "Build the next balanced meal around the Korean flavors you already like."
      };
    }
    if (fruit) {
      return {
        id: item.memory.id,
        kind: "food-preference",
        action: "Choose the fruit you already enjoy for the next planned snack."
      };
    }
  }
  return null;
}

function selectTrackerModifier(events, dateKey) {
  const rows = Array.isArray(events) ? events : [];
  const activePeriod = rows.find((event) => {
    if (!event || event.type !== "period") return false;
    const start = validTrackerDateKey(event.dateKey || trackerDateKey(event.createdAt));
    const end = validTrackerDateKey(event.periodEndDateKey);
    return Boolean(start && start <= dateKey && (end ? dateKey <= end : start === dateKey));
  });
  if (activePeriod) {
    return {
      id: activePeriod.id,
      type: "active-logged-period",
      text: "Logged-period noise is possible; the verdict stays unchanged."
    };
  }
  return null;
}

function selectRecentConflict(events, dateKey) {
  return (Array.isArray(events) ? events : []).find((event) => {
    if (!event || event.type !== "conflict") return false;
    const conflictKey = validTrackerDateKey(event.dateKey || trackerDateKey(event.createdAt));
    const days = daysBetweenDateKeys(conflictKey, dateKey);
    return Number.isFinite(days) && days >= 0 && days <= 2;
  });
}

function hiddenStrategyState(goal, currentWeight) {
  if (!Number.isFinite(goal) || goal <= 0 || !Number.isFinite(currentWeight)) return "steady-safe";
  if (goal <= 108) return "safety-held";
  return currentWeight - goal >= 20 ? "high-safe-urgency" : "steady-safe";
}

function buildCoachContext(store, weightId, options = {}) {
  const { current, rows, points } = causalWeightRows(store, weightId);
  if (!current || !points.length) return null;
  const latestPoint = points[points.length - 1];
  const previousPoint = points.length > 1 ? points[points.length - 2] : null;
  const currentTime = Date.parse(current.createdAt);
  const forecast = weightForecast.calculateForecast(points, { asOfDay: latestPoint.day });
  const history = weightForecast.buildOneYearHistory(points, forecast, currentTime);
  const outlookPoint = history[history.length - 1] || null;
  const previousOutlookPoint = history.length > 1 ? history[history.length - 2] : null;
  const outlook = Number(outlookPoint && outlookPoint.weight);
  const previousOutlook = previousOutlookPoint ? Number(previousOutlookPoint.weight) : NaN;
  const outlookChange = Number.isFinite(outlook) && Number.isFinite(previousOutlook) ? outlook - previousOutlook : 0;
  const latestDailyChange = previousPoint ? latestPoint.weight - previousPoint.weight : 0;
  const dateKey = trackerDateKey(currentTime);
  const includePersonalContext = options.includePersonalContext !== false;
  const trackerModifier = includePersonalContext ? selectTrackerModifier(store.trackerEvents, dateKey) : null;
  const recentConflict = includePersonalContext ? selectRecentConflict(store.trackerEvents, dateKey) : null;
  const preference = includePersonalContext ? selectSavedPreference(store.memories, currentTime) : null;
  const outlier = isWeightOutlier(points);
  const streak = recentWeightStreak(points);
  const outlookDirection = outlookChange > 0.05 ? "worsened" : outlookChange < -0.05 ? "improved" : "held";
  const changeDirection = latestDailyChange > 0.05 ? "up" : latestDailyChange < -0.05 ? "down" : "unchanged";
  let verdict = "not-good-enough";
  if (points.length === 1) verdict = "baseline";
  else if (outlier) verdict = "verify";
  else if (changeDirection === "down" && outlookDirection !== "worsened") verdict = "good-progress";

  const action = preference?.action || (outlier
    ? "Use the same scale conditions for the next confirming weigh-in."
    : recentConflict
      ? "Make the next meal a simple balanced plate with protein, vegetables, and a satisfying portion."
      : "Build the next meal around protein, vegetables, and a satisfying portion.");
  const evidenceReferences = [
    { type: "weight", id: current.id, role: "current" },
    ...(rows.length > 1 ? [{ type: "weight", id: rows[rows.length - 2].id, role: "comparison" }] : []),
    ...(trackerModifier ? [{ type: "tracker", id: trackerModifier.id, role: trackerModifier.type }] : []),
    ...(recentConflict ? [{ type: "tracker", id: recentConflict.id, role: "recent-conflict" }] : []),
    ...(preference ? [{ type: "memory", id: preference.id, role: preference.kind }] : [])
  ];
  const privateGoal = Object.prototype.hasOwnProperty.call(options, "privateGoal") ? Number(options.privateGoal) : privateCoachGoal;
  const context = {
    weightId: current.id,
    currentWeight: weightInPounds(current),
    latestDailyWeight: latestPoint.weight,
    previousDailyWeight: previousPoint ? previousPoint.weight : null,
    latestDailyChange,
    changeDirection,
    streak,
    reversal: streak.reversal,
    outlier,
    movements: {
      days3: robustWindowMovement(points, 3),
      days7: robustWindowMovement(points, 7),
      days14: robustWindowMovement(points, 14),
      days28: robustWindowMovement(points, 28)
    },
    outlook,
    previousOutlook: Number.isFinite(previousOutlook) ? previousOutlook : outlook,
    outlookChange,
    outlookDirection,
    verdict,
    trackerModifier,
    preference: preference ? { id: preference.id, kind: preference.kind } : null,
    action,
    evidenceReferences,
    hiddenStrategy: hiddenStrategyState(privateGoal, weightInPounds(current)),
    forecastFingerprint: history.map((point) => ({ day: point.day, weight: point.weight, outlookTargetWeight: point.outlookTargetWeight }))
  };
  context.contextHash = crypto.createHash("sha256").update(JSON.stringify(context)).digest("hex");
  return context;
}

function changePhrase(context) {
  if (context.changeDirection === "unchanged") return "is unchanged";
  return `is ${context.changeDirection} ${trimCoachNumber(Math.abs(context.latestDailyChange))} lb`;
}

function outlookPhrase(context) {
  const rounded = Math.round(context.outlook);
  if (context.outlookDirection === "improved") return `improved to about ${rounded} lb`;
  if (context.outlookDirection === "worsened") return `turned the wrong way to about ${rounded} lb`;
  return `is holding at about ${rounded} lb`;
}

function buildContextualFallback(context) {
  if (!context) return "WEIGH-IN SAVED—THE DATA IS HERE, AND THE NEXT CONSISTENT CHECK WILL MAKE THE DIRECTION CLEARER. Build the next meal around protein, vegetables, and a satisfying portion. KEEP SHOWING UP FOR THE TREND—LET’S GO!!!";
  const current = trimCoachNumber(context.currentWeight);
  const modifier = context.trackerModifier ? ` ${context.trackerModifier.text}` : "";
  let opening = "NOT GOOD ENOUGH YET";
  let close = "TURN THIS LINE AROUND—LET’S GO!!!";
  if (context.verdict === "good-progress") {
    opening = "YES—THIS IS REAL PROGRESS";
    close = "KEEP STACKING PROOF—LET’S GO!!!";
  } else if (context.verdict === "verify") {
    opening = "PAUSE—THIS READING NEEDS CONFIRMATION";
    close = "CONFIRM THE SIGNAL, THEN WE ATTACK THE REAL TREND!!!";
  } else if (context.verdict === "baseline") {
    opening = "BASELINE LOGGED—THIS IS THE STARTING LINE";
    close = "THE TREND STARTS HERE—LET’S GO!!!";
  }
  const paragraph = `${opening}—${current} lb ${changePhrase(context)}, and the 1-year trend outlook ${outlookPhrase(context)}.${modifier} ${context.action} ${close}`;
  return normalizeCoachParagraph(paragraph);
}

function similarityScore(left, right) {
  const tokens = (value) => new Set(String(value || "").toLowerCase().match(/[a-z0-9]+/g) || []);
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

function numericTokens(text) {
  return (String(text || "").match(/[-+]?\d+(?:\.\d+)?/g) || []).map(Number).filter(Number.isFinite);
}

function validateCoachParagraph(text, context, previousMessages = [], options = {}) {
  const paragraph = normalizeCoachParagraph(text);
  const errors = [];
  const words = coachWordCount(paragraph);
  if (/[\r\n]/.test(String(text || ""))) errors.push("multiline");
  if (words < COACH_MIN_WORDS || words > COACH_MAX_WORDS) errors.push("word-count");
  const unsafe = /\b(?:obese|fat|body|lazy|disgusting|failure|worthless|worth|bmi|jyp|korean idol|fast|fasting|starve|starving|skip(?:ping)? meals?|purge|purging|compensat\w*|punish\w*|restrict\w*|under-?eat\w*|overexercis\w*|excessive exercise|depriv\w*|guilt|shame|diagnos\w*|depress\w*)\b/i;
  if (unsafe.test(paragraph)) errors.push("unsafe-language");
  if (/\b(?:horn\w*|sex(?:ual)?|ovulat\w*|conflict|phone|address|relationship|appearance)\b/i.test(paragraph)) errors.push("private-context-leak");
  if (/[\u00e2\u00c3\u00c2\ufffd]/.test(paragraph)) errors.push("mojibake");
  if (/\b(?:safety-held|high-safe-urgency|steady-safe)\b/i.test(paragraph)) errors.push("private-strategy-leak");
  if (/\b(?:goal|goal weight|internal target|target weight)\b/i.test(paragraph)) errors.push("goal-reference");
  if (/\b(?:period|cycle|menstrual)\b.{0,35}\b(?:caused?|made|explains?)\b|\b(?:caused?|made|explains?)\b.{0,35}\b(?:period|cycle|menstrual)\b/i.test(paragraph)) errors.push("period-causality");
  if (!context || !paragraph.includes(`${trimCoachNumber(context.currentWeight)} lb`)) errors.push("current-weight");
  if (context && !paragraph.includes(`about ${Math.round(context.outlook)} lb`)) errors.push("outlook-weight");
  if (context && !paragraph.includes(context.action)) errors.push("required-action");
  if (context) {
    const withoutSelectedAction = paragraph
      .replace(context.action, "")
      .replace(context.trackerModifier?.text || "", "");
    if (/\b(?:plan|choose|build|make|add|eat|walk|exercise|repeat|use|weigh|track|log)\b/i.test(withoutSelectedAction)) errors.push("extra-action");
  }
  if (context && context.changeDirection === "unchanged" && !/\b(?:unchanged|same|flat)\b/i.test(paragraph)) errors.push("change-direction");
  if (context && context.changeDirection === "up" && !new RegExp(`\\bup\\s+${trimCoachNumber(Math.abs(context.latestDailyChange)).replace(".", "\\.")}\\s+lb`, "i").test(paragraph)) errors.push("change-direction");
  if (context && context.changeDirection === "down" && !new RegExp(`\\bdown\\s+${trimCoachNumber(Math.abs(context.latestDailyChange)).replace(".", "\\.")}\\s+lb`, "i").test(paragraph)) errors.push("change-direction");
  if (context && context.outlookDirection === "worsened" && !/\b(?:wrong way|worsen\w*)\b/i.test(paragraph)) errors.push("outlook-direction");
  if (context && context.outlookDirection === "improved" && !/\b(?:improv\w*|better)\b/i.test(paragraph)) errors.push("outlook-direction");
  const verdictPattern = context && {
    "not-good-enough": /^(?:not good enough|today needs? a response|this needs? a response|not approved|wrong way)/i,
    "good-progress": /^(?:yes|that['’]s real movement|real progress|good progress|this is a win|strong work|right way)/i,
    verify: /^(?:pause|verify|confirm|this reading needs? confirmation)/i,
    baseline: /^(?:baseline|first number|starting point|starting line)/i
  }[context.verdict];
  if (verdictPattern && !verdictPattern.test(paragraph)) errors.push("verdict");
  if (context?.verdict === "not-good-enough" && /\b(?:amazing|awesome|great job|a win|approved)\b/i.test(paragraph)) errors.push("verdict-conflict");
  if (context?.verdict === "good-progress" && /\b(?:not good enough|not approved|failure|bad result)\b/i.test(paragraph)) errors.push("verdict-conflict");
  const allowedNumbers = context ? [
    1,
    3,
    7,
    14,
    28,
    Number(trimCoachNumber(context.currentWeight)),
    Math.round(context.outlook),
    Number(trimCoachNumber(Math.abs(context.latestDailyChange))),
    Number(context.streak?.count),
    ...Object.values(context.movements || {}).map((movement) => Number(trimCoachNumber(Math.abs(movement))))
  ] : [];
  for (const number of numericTokens(paragraph)) {
    if (!allowedNumbers.some((allowed) => Math.abs(allowed - number) < 0.001)) {
      errors.push("unsupported-number");
      break;
    }
  }
  const hiddenGoal = Number(options.privateGoal);
  if (Number.isFinite(hiddenGoal) && numericTokens(paragraph).some((number) => Math.abs(number - hiddenGoal) < 0.001)) errors.push("goal-leak");
  if ((previousMessages || []).slice(0, 10).some((previous) => similarityScore(paragraph, previous.text || previous) >= 0.78)) errors.push("repetition");
  return { ok: errors.length === 0, errors: Array.from(new Set(errors)), text: paragraph, wordCount: words };
}

function parseCriticResult(text) {
  try {
    const parsed = JSON.parse(String(text || "").replace(/^```json\s*|\s*```$/gi, "").trim());
    return { approved: parsed.approved === true, reason: String(parsed.reason || "") };
  } catch (error) {
    return { approved: false, reason: "invalid critic response" };
  }
}

async function requestCoachResponse(input, options = {}) {
  const apiKey = Object.prototype.hasOwnProperty.call(options, "apiKey") ? options.apiKey : openaiApiKey;
  if (!apiKey) throw new Error("coach model unavailable");
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeoutMs = Math.max(25, Number(options.timeoutMs || coachGenerationTimeoutMs));
  let timeoutId;
  try {
    const timeout = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error("coach model timeout"));
      }, timeoutMs);
    });
    const request = fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: options.model || chatModel,
        input,
        max_output_tokens: 260
      })
    });
    const response = await Promise.race([request, timeout]);
    if (!response.ok) throw new Error("coach model request failed");
    return responseText(await response.json());
  } finally {
    clearTimeout(timeoutId);
  }
}

function publicCoachFacts(context) {
  return {
    currentWeight: trimCoachNumber(context.currentWeight),
    change: context.changeDirection === "unchanged" ? "unchanged" : `${context.changeDirection} ${trimCoachNumber(Math.abs(context.latestDailyChange))} lb`,
    streak: context.streak,
    reversal: context.reversal,
    outlier: context.outlier,
    movements: context.movements,
    outlook: Math.round(context.outlook),
    outlookDirection: context.outlookDirection,
    verdict: context.verdict,
    trackerModifier: context.trackerModifier ? context.trackerModifier.text : null,
    savedPreferenceUsed: Boolean(context.preference),
    action: context.action,
    hiddenStrategy: context.hiddenStrategy
  };
}

async function generateCoachParagraph(context, previousMessages, options = {}) {
  const fallback = buildContextualFallback(context);
  if (!(Object.prototype.hasOwnProperty.call(options, "apiKey") ? options.apiKey : openaiApiKey)) {
    return { text: fallback, status: "fallback-no-model" };
  }
  let rejection = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const facts = publicCoachFacts(context);
      const system = [
        "Write one energetic, human fitness-coach paragraph for Lily.",
        "Use only the supplied facts; do not invent causes, numbers, health claims, or promises.",
        `Return ${COACH_MIN_WORDS}-${COACH_MAX_WORDS} words in one paragraph with an unmistakable verdict.`,
        "Include the current weight, exact change, rounded 1-year trend outlook and its direction.",
        "Include the supplied action sentence verbatim and no other instruction or action.",
        "Never mention a goal, target weight, private strategy, BMI, diagnosis, appearance, worth, fasting, skipped meals, restriction, compensation, punishment, JYP, or idol training.",
        "A period modifier can caution about one noisy point but cannot alter the verdict, outlook, or claim causation.",
        "Do not reuse stock phrasing from recent messages. Output only the paragraph."
      ].join(" ");
      const draft = await requestCoachResponse([
        { role: "system", content: system },
        { role: "user", content: `FACTS: ${JSON.stringify(facts)}\nRECENT OPENINGS TO AVOID: ${JSON.stringify((previousMessages || []).slice(0, 10).map((message) => String(message.text || message).split(/[.!?]/)[0]))}\n${rejection ? `FIX THESE REJECTION REASONS: ${rejection}` : ""}` }
      ], options);
      const validation = validateCoachParagraph(draft, context, previousMessages, {
        privateGoal: Object.prototype.hasOwnProperty.call(options, "privateGoal") ? options.privateGoal : privateCoachGoal
      });
      if (!validation.ok) {
        rejection = validation.errors.join(", ");
        continue;
      }
      const criticText = await requestCoachResponse([
        {
          role: "system",
          content: "Audit the proposed coach paragraph for numerical accuracy, usefulness, one-action compliance, privacy, safety, period causality, and originality. Approve only if every requirement passes. Return JSON only: {\"approved\":true|false,\"reason\":\"short reason\"}."
        },
        { role: "user", content: `FACTS: ${JSON.stringify(publicCoachFacts(context))}\nPROPOSED: ${validation.text}\nRECENT: ${JSON.stringify((previousMessages || []).slice(0, 10).map((message) => message.text || message))}` }
      ], options);
      const critic = parseCriticResult(criticText);
      if (!critic.approved) {
        rejection = critic.reason || "critic rejected";
        continue;
      }
      return { text: validation.text, status: "generated-and-critic-approved" };
    } catch (error) {
      rejection = error.message || "generation failed";
      if (/timeout/.test(rejection)) break;
    }
  }
  return { text: fallback, status: rejection && /timeout/.test(rejection) ? "fallback-timeout" : "fallback-validation" };
}

function createCoachMessageRecord(context, text, status, now = new Date().toISOString(), existing = null) {
  return {
    id: existing?.id || createId("coach"),
    weightId: context.weightId,
    text: normalizeCoachParagraph(text),
    verdict: context.verdict,
    evidenceReferences: context.evidenceReferences,
    contextHash: context.contextHash,
    generationVersion: COACH_GENERATION_VERSION,
    modelVersion: chatModel,
    promptVersion: COACH_PROMPT_VERSION,
    safetyVersion: COACH_SAFETY_VERSION,
    status,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

function coachForWeight(store, weightId) {
  return (Array.isArray(store.coachMessages) ? store.coachMessages : [])
    .filter((message) => message.weightId === weightId)
    .sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)))[0] || null;
}

function publicCoach(message) {
  if (!message) return null;
  return { weightId: message.weightId, text: message.text, createdAt: message.createdAt };
}

function latestCoachPayload(store) {
  const latestWeight = (Array.isArray(store.weights) ? store.weights : [])
    .slice()
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
  return latestWeight ? publicCoach(coachForWeight(store, latestWeight.id)) : null;
}

function addFallbackCoachForWeight(store, weightId, status = "fallback-contextual", options = {}) {
  if (coachForWeight(store, weightId)) return store;
  const context = buildCoachContext(store, weightId, options);
  if (!context) return store;
  const record = createCoachMessageRecord(context, buildContextualFallback(context), status);
  return { ...store, coachMessages: [record, ...(Array.isArray(store.coachMessages) ? store.coachMessages : [])] };
}

function refreshLatestWeightOnlyCoach(store, status) {
  const latestWeight = (Array.isArray(store.weights) ? store.weights : [])
    .slice()
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
  if (!latestWeight) return store;
  const context = buildCoachContext(store, latestWeight.id, { includePersonalContext: false, privateGoal: privateCoachGoal });
  if (!context) return store;
  const existing = coachForWeight(store, latestWeight.id);
  const replacement = createCoachMessageRecord(context, buildContextualFallback(context), status, new Date().toISOString(), existing);
  return {
    ...store,
    coachMessages: [replacement, ...(Array.isArray(store.coachMessages) ? store.coachMessages : []).filter((message) => message.id !== existing?.id)]
  };
}

function refreshIfLatestCoachReferences(store, referenceType, referenceId, status = "fallback-weight-only-context-removed") {
  const latest = latestCoachPayload(store);
  const latestRecord = latest ? coachForWeight(store, latest.weightId) : null;
  const wasReferenced = latestRecord?.evidenceReferences?.some((reference) => reference.type === referenceType && reference.id === referenceId);
  return wasReferenced ? refreshLatestWeightOnlyCoach(store, status) : store;
}

function removeWeightAndCoach(store, weightId) {
  let next = {
    ...store,
    weights: (Array.isArray(store.weights) ? store.weights : []).filter((record) => record.id !== weightId),
    coachMessages: (Array.isArray(store.coachMessages) ? store.coachMessages : []).filter((message) => message.weightId !== weightId)
  };
  next = refreshLatestWeightOnlyCoach(next, "fallback-weight-only-weight-history-changed");
  return next;
}

async function backfillCoachMessages() {
  await writeStore((store) => {
    let next = store;
    const weights = (Array.isArray(store.weights) ? store.weights : [])
      .slice()
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    for (const record of weights) next = addFallbackCoachForWeight(next, record.id, "fallback-migrated");
    return next;
  });
}

async function generateAndReplaceCoach(weightId, options = {}) {
  const snapshot = await readStore();
  const context = buildCoachContext(snapshot, weightId, {
    privateGoal: Object.prototype.hasOwnProperty.call(options, "privateGoal") ? options.privateGoal : privateCoachGoal
  });
  const fallbackRecord = coachForWeight(snapshot, weightId);
  if (!context || !fallbackRecord) return publicCoach(fallbackRecord);
  const previousMessages = (snapshot.coachMessages || []).filter((message) => message.weightId !== weightId).slice(0, 10);
  const result = await generateCoachParagraph(context, previousMessages, options);
  if (result.status.startsWith("fallback-")) {
    let savedFallback = fallbackRecord;
    await writeStore((store) => {
      const existing = coachForWeight(store, weightId);
      const weightStillExists = (store.weights || []).some((weight) => weight.id === weightId);
      if (!existing || !weightStillExists || existing.contextHash !== context.contextHash) return store;
      savedFallback = createCoachMessageRecord(context, existing.text, result.status, new Date().toISOString(), existing);
      return {
        ...store,
        coachMessages: [savedFallback, ...(store.coachMessages || []).filter((message) => message.id !== existing.id)]
      };
    });
    return publicCoach(savedFallback);
  }
  let saved = fallbackRecord;
  await writeStore((store) => {
    const existing = coachForWeight(store, weightId);
    const weightStillExists = (store.weights || []).some((weight) => weight.id === weightId);
    if (!existing || !weightStillExists || existing.contextHash !== context.contextHash) return store;
    saved = createCoachMessageRecord(context, result.text, result.status, new Date().toISOString(), existing);
    return {
      ...store,
      coachMessages: [saved, ...(store.coachMessages || []).filter((message) => message.id !== existing.id)]
    };
  });
  return publicCoach(saved);
}

function trackerDateKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: trackerTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : "";
}

function dateKeyUtcNoon(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!match) return NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
}

function validTrackerDateKey(value) {
  const key = String(value || "").trim();
  const timestamp = dateKeyUtcNoon(key);
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toISOString().slice(0, 10) === key ? key : "";
}

function daysBetweenDateKeys(fromKey, toKey) {
  const from = dateKeyUtcNoon(fromKey);
  const to = dateKeyUtcNoon(toKey);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return NaN;
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

function addDaysToDateKey(key, days) {
  const start = dateKeyUtcNoon(key);
  if (!Number.isFinite(start) || !Number.isFinite(days)) return "";
  const next = new Date(start);
  next.setUTCDate(next.getUTCDate() + Math.round(days));
  const year = next.getUTCFullYear();
  const month = String(next.getUTCMonth() + 1).padStart(2, "0");
  const day = String(next.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function publicTrackerEvent(event) {
  const createdAt = event.createdAt || event.updatedAt || "";
  return {
    id: event.id,
    type: event.type,
    dateKey: event.dateKey || trackerDateKey(createdAt),
    periodEndDateKey: validTrackerDateKey(event.periodEndDateKey),
    reportedHighDesireDateKey: validTrackerDateKey(event.reportedHighDesireDateKey),
    reportedPossibleOvulationStartDateKey: validTrackerDateKey(event.reportedPossibleOvulationStartDateKey),
    reportedPossibleOvulationEndDateKey: validTrackerDateKey(event.reportedPossibleOvulationEndDateKey),
    createdAt,
    updatedAt: event.updatedAt || createdAt
  };
}

function normalizePeriodDetails(details, periodStartDateKey) {
  const fields = [
    "periodEndDateKey",
    "reportedHighDesireDateKey",
    "reportedPossibleOvulationStartDateKey",
    "reportedPossibleOvulationEndDateKey"
  ];
  const normalized = {};
  for (const field of fields) {
    const value = String(details[field] || "").trim();
    if (value && !validTrackerDateKey(value)) {
      return { error: "Enter valid calendar dates for the period record." };
    }
    normalized[field] = value;
  }
  if (normalized.periodEndDateKey && normalized.periodEndDateKey < periodStartDateKey) {
    return { error: "The period end cannot be before the period start." };
  }
  if (
    normalized.reportedPossibleOvulationStartDateKey
    && normalized.reportedPossibleOvulationEndDateKey
    && normalized.reportedPossibleOvulationEndDateKey < normalized.reportedPossibleOvulationStartDateKey
  ) {
    return { error: "The possible ovulation window ends before it starts." };
  }
  return { details: normalized };
}

function trackerEvents(events) {
  return (Array.isArray(events) ? events : [])
    .map(publicTrackerEvent)
    .filter((event) => (event.type === "conflict" || event.type === "period") && event.dateKey)
    .sort((a, b) => String(b.dateKey).localeCompare(String(a.dateKey)) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

function estimatePeriodCycle(periodEvents) {
  const keys = Array.from(new Set(periodEvents.map((event) => event.dateKey)))
    .filter(Boolean)
    .sort();
  const intervals = [];
  for (let index = 1; index < keys.length; index += 1) {
    const days = daysBetweenDateKeys(keys[index - 1], keys[index]);
    if (Number.isFinite(days) && days >= 15 && days <= 60) intervals.push(days);
  }
  const medianInterval = median(intervals);
  if (Number.isFinite(medianInterval)) {
    return {
      days: Math.round(medianInterval),
      basis: `${keys.length} period starts, median interval`,
      sampleCount: keys.length,
      intervalCount: intervals.length
    };
  }
  return {
    days: defaultPeriodCycleDays,
    basis: keys.length ? "28-day starter estimate until another period start is saved" : "period start needed",
    sampleCount: keys.length,
    intervalCount: 0
  };
}

function longestConflictStreak(conflictEvents, todayKey) {
  const keys = Array.from(new Set(conflictEvents.map((event) => event.dateKey)))
    .filter(Boolean)
    .sort();
  if (!keys.length) return null;

  const streaks = [];
  for (let index = 1; index < keys.length; index += 1) {
    const days = daysBetweenDateKeys(keys[index - 1], keys[index]);
    if (Number.isFinite(days)) streaks.push(Math.max(0, days));
  }

  const currentStreak = daysBetweenDateKeys(keys[keys.length - 1], todayKey);
  if (Number.isFinite(currentStreak)) streaks.push(Math.max(0, currentStreak));
  return streaks.length ? Math.max(...streaks) : null;
}

function nextPredictedHighDesireDateKey(periodStartDateKey, reportedHighDesireDateKey, cycleDays, todayKey) {
  const offsetDays = daysBetweenDateKeys(periodStartDateKey, reportedHighDesireDateKey);
  if (!Number.isFinite(offsetDays) || offsetDays < 0 || !Number.isFinite(cycleDays) || cycleDays < 1) {
    return "";
  }
  let predictedDateKey = addDaysToDateKey(periodStartDateKey, offsetDays);
  while (predictedDateKey && daysBetweenDateKeys(predictedDateKey, todayKey) > 0) {
    predictedDateKey = addDaysToDateKey(predictedDateKey, cycleDays);
  }
  return predictedDateKey;
}

function publicTrackerSummary(events, now = Date.now()) {
  const rows = trackerEvents(events);
  const todayKey = trackerDateKey(now);
  const conflicts = rows.filter((event) => event.type === "conflict");
  const periods = rows.filter((event) => event.type === "period");
  const latestConflict = conflicts[0] || null;
  const latestPeriod = periods[0] || null;
  const daysSinceLastConflict = latestConflict ? Math.max(0, daysBetweenDateKeys(latestConflict.dateKey, todayKey)) : null;
  const longestConflictStreakDays = longestConflictStreak(conflicts, todayKey);
  const cycle = estimatePeriodCycle(periods);
  const nextPeriodDateKey = latestPeriod ? addDaysToDateKey(latestPeriod.dateKey, cycle.days) : "";
  const rawDaysUntilNextPeriod = nextPeriodDateKey ? daysBetweenDateKeys(todayKey, nextPeriodDateKey) : null;
  const periodOverdueDays = Number.isFinite(rawDaysUntilNextPeriod) && rawDaysUntilNextPeriod < 0 ? Math.abs(rawDaysUntilNextPeriod) : 0;
  const highDesireOffsetDays = latestPeriod && latestPeriod.reportedHighDesireDateKey
    ? daysBetweenDateKeys(latestPeriod.dateKey, latestPeriod.reportedHighDesireDateKey)
    : null;
  const nextHighDesireDateKey = latestPeriod
    ? nextPredictedHighDesireDateKey(latestPeriod.dateKey, latestPeriod.reportedHighDesireDateKey, cycle.days, todayKey)
    : "";
  const rawDaysUntilNextHighDesire = nextHighDesireDateKey
    ? daysBetweenDateKeys(todayKey, nextHighDesireDateKey)
    : null;

  return {
    timeZone: trackerTimeZone,
    todayDateKey: todayKey,
    conflictCount: conflicts.length,
    periodCount: periods.length,
    latestConflictAt: latestConflict ? latestConflict.createdAt : "",
    latestConflictDateKey: latestConflict ? latestConflict.dateKey : "",
    daysSinceLastConflict: Number.isFinite(daysSinceLastConflict) ? daysSinceLastConflict : null,
    longestConflictStreakDays: Number.isFinite(longestConflictStreakDays) ? longestConflictStreakDays : null,
    latestPeriodAt: latestPeriod ? latestPeriod.createdAt : "",
    latestPeriodDateKey: latestPeriod ? latestPeriod.dateKey : "",
    latestPeriodEndDateKey: latestPeriod ? latestPeriod.periodEndDateKey : "",
    reportedHighDesireDateKey: latestPeriod ? latestPeriod.reportedHighDesireDateKey : "",
    highDesireOffsetDays: Number.isFinite(highDesireOffsetDays) && highDesireOffsetDays >= 0 ? highDesireOffsetDays : null,
    nextHighDesireDateKey,
    daysUntilNextHighDesire: Number.isFinite(rawDaysUntilNextHighDesire) ? Math.max(0, rawDaysUntilNextHighDesire) : null,
    reportedPossibleOvulationStartDateKey: latestPeriod ? latestPeriod.reportedPossibleOvulationStartDateKey : "",
    reportedPossibleOvulationEndDateKey: latestPeriod ? latestPeriod.reportedPossibleOvulationEndDateKey : "",
    periodCycleDays: cycle.days,
    periodCycleBasis: cycle.basis,
    periodCycleSampleCount: cycle.sampleCount,
    nextPeriodDateKey,
    daysUntilNextPeriod: Number.isFinite(rawDaysUntilNextPeriod) ? Math.max(0, rawDaysUntilNextPeriod) : null,
    periodOverdueDays,
    events: rows.slice(0, 100)
  };
}

function searchableText(memory) {
  return [
    memory.text,
    memory.caption,
    memory.summary,
    memory.extractedText,
    Array.isArray(memory.facts) ? memory.facts.join("; ") : ""
  ].filter(Boolean).join("\n");
}

function tokenize(text) {
  return new Set(String(text).toLowerCase().match(/[a-z0-9']{3,}/g) || []);
}

function memoryTimestamp(memory) {
  const timestamp = Date.parse(memory.updatedAt || memory.createdAt || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function selectContext(question, memories) {
  const questionTokens = tokenize(question);
  const scored = memories
    .map((memory) => {
      const text = searchableText(memory);
      const tokens = tokenize(text);
      let score = 0;
      for (const token of questionTokens) {
        if (tokens.has(token)) score += 3;
        else if (text.toLowerCase().includes(token)) score += 1;
      }
      if (memory.kind === "date" && /birthday|bday|when|date|anniversary/i.test(question)) score += 4;
      if (memory.kind === "address" && /where|address|live|place/i.test(question)) score += 4;
      if (memory.kind === "contact" && /phone|number|contact|call|text/i.test(question)) score += 4;
      if (/eat|food|restaurant|want|like|preference/i.test(question) && /eat|food|restaurant|like|favorite|want|crave|sushi|ramen|korean|cafe/i.test(text)) score += 4;
      return { memory, score, text, timestamp: memoryTimestamp(memory) };
    })
    .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp);

  const selected = new Map();
  const relevant = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.timestamp - a.timestamp || b.score - a.score)
    .slice(0, 30);
  const recent = scored
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp || b.score - a.score)
    .slice(0, 8);

  for (const item of relevant) selected.set(item.memory.id, item);
  for (const item of recent) selected.set(item.memory.id, item);

  return Array.from(selected.values())
    .sort((a, b) => {
      const relevanceDelta = Number(b.score > 0) - Number(a.score > 0);
      return relevanceDelta || b.timestamp - a.timestamp || b.score - a.score;
    })
    .slice(0, 36);
}

function fallbackAnswer(question, context) {
  const hits = context.filter((item) => item.score > 0).slice(0, 6);
  if (!hits.length) return "I do not have enough saved Lily memory to answer that yet. Add notes, screenshots, or photos first.";
  const lines = hits.map((item) => `- ${item.text.slice(0, 240).replace(/\s+/g, " ")}`);
  return `Closest saved details I found:\n${lines.join("\n")}`;
}

async function answerQuestion(question, memories) {
  const context = selectContext(question, memories);
  if (!openaiApiKey) {
    return { answer: fallbackAnswer(question, context), sources: context.slice(0, 6).map((item) => publicMemory(item.memory)) };
  }

  const compactContext = context
    .map((item, index) => {
      const savedAt = item.memory.updatedAt || item.memory.createdAt;
      const created = savedAt ? `saved ${savedAt}` : "saved memory";
      return `[${index + 1}] ${item.memory.kind} (${created})\n${item.text.slice(0, 1300)}`;
    })
    .join("\n\n");

  const system = [
    "You are the private Lily memory assistant.",
    "Answer only from the saved context. If the context is not enough, say what is missing.",
    "Be practical, concise, and warm. Do not invent facts.",
    "When saved entries conflict, treat the newest saved entry as the current truth because details can change.",
    "For preference questions, synthesize patterns and clearly state uncertainty."
  ].join(" ");

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiApiKey}`
      },
      body: JSON.stringify({
        model: chatModel,
        input: [
          { role: "system", content: system },
          {
            role: "user",
            content: `Question: ${question}\n\nSaved Lily context, newest relevant memories first. Newer entries override older conflicting entries:\n${compactContext || "(none)"}`
          }
        ],
        max_output_tokens: 650
      })
    });
    if (!response.ok) throw new Error(await response.text());
    const json = await response.json();
    const text = responseText(json);
    return {
      answer: text || fallbackAnswer(question, context),
      sources: context.filter((item) => item.score > 0).slice(0, 6).map((item) => publicMemory(item.memory))
    };
  } catch (error) {
    return {
      answer: fallbackAnswer(question, context),
      sources: context.filter((item) => item.score > 0).slice(0, 6).map((item) => publicMemory(item.memory)),
      warning: "AI answer failed, so I used local search."
    };
  }
}

async function handleApi(req, res, pathname) {
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/api/health") {
    send(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/auth" && req.method === "POST") {
    const body = await readJson(req);
    if (String(body.pin || "") !== pin) {
      send(res, 401, { error: "Wrong PIN" });
      return;
    }
    const session = createSession(Boolean(body.remember));
    send(res, 200, session);
    return;
  }

  if (pathname === "/api/session" && req.method === "GET") {
    send(res, 200, { authenticated: verifySession(authToken(req)) });
    return;
  }

  if (!requireAuth(req, res)) return;

  if (pathname === "/api/memories" && req.method === "GET") {
    const store = await readStore();
    send(res, 200, { memories: publicMemories(store.memories).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) });
    return;
  }

  if (pathname === "/api/weights" && req.method === "GET") {
    const store = await readStore();
    send(res, 200, {
      weights: publicWeights(store.weights).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      latestCoach: latestCoachPayload(store)
    });
    return;
  }

  if (pathname === "/api/tracker" && req.method === "GET") {
    const store = await readStore();
    send(res, 200, { tracker: publicTrackerSummary(store.trackerEvents) });
    return;
  }

  const trackerCreateMatch = /^\/api\/tracker\/(conflict|period)$/.exec(pathname);
  if (trackerCreateMatch && req.method === "POST") {
    const type = trackerCreateMatch[1];
    const body = await readJson(req);
    const now = new Date();
    const todayDateKey = trackerDateKey(now);
    const requestedDateKey = validTrackerDateKey(body.dateKey);
    if (body.dateKey && !requestedDateKey) {
      send(res, 400, { error: "Enter a valid tracker date." });
      return;
    }
    if (requestedDateKey && requestedDateKey > todayDateKey) {
      send(res, 400, { error: "Tracker entries cannot be dated in the future." });
      return;
    }
    const dateKey = requestedDateKey || todayDateKey;
    const nowIso = now.toISOString();
    const created = {
      id: createId(`tracker_${type}`),
      type,
      dateKey,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    let saved = created;
    await writeStore((store) => {
      const existingEvents = Array.isArray(store.trackerEvents) ? store.trackerEvents : [];
      const sameDayPeriod = type === "period"
        ? existingEvents.find((event) => event.type === "period" && (event.dateKey || trackerDateKey(event.createdAt)) === dateKey)
        : null;
      if (sameDayPeriod) {
        saved = sameDayPeriod;
        return store;
      }
      return { ...store, trackerEvents: [created, ...existingEvents] };
    });
    const nextStore = await readStore();
    send(res, saved === created ? 201 : 200, { event: publicTrackerEvent(saved), tracker: publicTrackerSummary(nextStore.trackerEvents) });
    return;
  }

  const updateTrackerEventMatch = /^\/api\/tracker\/([^/]+)$/.exec(pathname);
  if (updateTrackerEventMatch && req.method === "PATCH") {
    const id = decodeURIComponent(updateTrackerEventMatch[1]);
    const body = await readJson(req);
    const detailFields = [
      "periodEndDateKey",
      "reportedHighDesireDateKey",
      "reportedPossibleOvulationStartDateKey",
      "reportedPossibleOvulationEndDateKey"
    ];
    if (!detailFields.some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
      send(res, 400, { error: "Add a period detail to update." });
      return;
    }
    let updated = null;
    let validationError = "";
    await writeStore((store) => {
      const events = Array.isArray(store.trackerEvents) ? store.trackerEvents : [];
      return {
        ...store,
        trackerEvents: events.map((event) => {
          if (event.id !== id) return event;
          if (event.type !== "period") {
            validationError = "Only a period entry can carry period details.";
            return event;
          }
          const nextDetails = { ...event };
          detailFields.forEach((field) => {
            if (Object.prototype.hasOwnProperty.call(body, field)) nextDetails[field] = body[field];
          });
          const normalized = normalizePeriodDetails(nextDetails, event.dateKey || trackerDateKey(event.createdAt));
          if (normalized.error) {
            validationError = normalized.error;
            return event;
          }
          updated = { ...event, ...normalized.details, updatedAt: new Date().toISOString() };
          return updated;
        })
      };
    });
    if (validationError) {
      send(res, 400, { error: validationError });
      return;
    }
    if (!updated) {
      send(res, 404, { error: "Period entry not found." });
      return;
    }
    const nextStore = await readStore();
    send(res, 200, { event: publicTrackerEvent(updated), tracker: publicTrackerSummary(nextStore.trackerEvents) });
    return;
  }

  if (pathname === "/api/weights" && req.method === "POST") {
    const body = await readJson(req);
    const weight = Number(body.weight);
    const unit = String(body.unit || "lb").trim().toLowerCase() === "kg" ? "kg" : "lb";
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1000) {
      send(res, 400, { error: "Enter a valid weight." });
      return;
    }
    const now = new Date().toISOString();
    const created = {
      id: createId("weight"),
      weight: Math.round(weight * 100) / 100,
      unit,
      createdAt: now,
      updatedAt: now
    };
    const savedStore = await writeStore((store) => {
      const withWeight = { ...store, weights: [created, ...(Array.isArray(store.weights) ? store.weights : [])] };
      return addFallbackCoachForWeight(withWeight, created.id, "fallback-contextual");
    });
    send(res, 201, { weight: publicWeight(created), latestCoach: publicCoach(coachForWeight(savedStore, created.id)) });
    setImmediate(() => {
      generateAndReplaceCoach(created.id).catch(() => {});
    });
    return;
  }

  if (pathname === "/api/memories" && req.method === "POST") {
    const body = await readJson(req);
    const text = String(body.text || "").trim();
    const files = Array.isArray(body.files) ? body.files.slice(0, 20) : [];
    const now = new Date().toISOString();
    const created = [];

    if (text) {
      created.push({
        id: createId("mem"),
        kind: classifyText(text),
        text,
        createdAt: now,
        updatedAt: now
      });
    }

    for (const file of files) {
      const saved = await saveFile(file);
      const isVideo = saved.type.startsWith("video/");
      const analysis = isVideo ? { summary: "", extractedText: "", facts: [] } : await analyzeImage(file.dataUrl, text);
      created.push({
        id: createId(isVideo ? "video" : "photo"),
        kind: isVideo ? "video" : "photo",
        caption: text || file.name || (isVideo ? "saved video" : "saved image"),
        file: saved,
        summary: analysis.summary || "",
        extractedText: analysis.extractedText || "",
        facts: analysis.facts || [],
        analysisError: analysis.analysisError || "",
        createdAt: now,
        updatedAt: now
      });
    }

    if (!created.length) {
      send(res, 400, { error: "Add a note, image, or video first." });
      return;
    }

    await writeStore((store) => ({ ...store, memories: [...created, ...store.memories] }));
    send(res, 201, { memories: created.map(publicMemory) });
    return;
  }

  const deleteMatch = /^\/api\/memories\/([^/]+)$/.exec(pathname);
  if (deleteMatch && req.method === "DELETE") {
    const id = decodeURIComponent(deleteMatch[1]);
    let deleted = null;
    await writeStore((store) => {
      deleted = store.memories.find((memory) => memory.id === id) || null;
      let next = { ...store, memories: store.memories.filter((memory) => memory.id !== id) };
      return refreshIfLatestCoachReferences(next, "memory", id);
    });
    if (deleted && deleted.file && deleted.file.filename) {
      fsp.unlink(path.join(mediaDir, deleted.file.filename)).catch(() => {});
    }
    send(res, 200, { ok: true });
    return;
  }

  const deleteWeightMatch = /^\/api\/weights\/([^/]+)$/.exec(pathname);
  if (deleteWeightMatch && req.method === "DELETE") {
    const id = decodeURIComponent(deleteWeightMatch[1]);
    await writeStore((store) => removeWeightAndCoach(store, id));
    send(res, 200, { ok: true });
    return;
  }

  const deleteTrackerEventMatch = /^\/api\/tracker\/([^/]+)$/.exec(pathname);
  if (deleteTrackerEventMatch && req.method === "DELETE") {
    const id = decodeURIComponent(deleteTrackerEventMatch[1]);
    let deleted = null;
    await writeStore((store) => {
      const events = Array.isArray(store.trackerEvents) ? store.trackerEvents : [];
      deleted = events.find((event) => event.id === id) || null;
      let next = { ...store, trackerEvents: events.filter((event) => event.id !== id) };
      return refreshIfLatestCoachReferences(next, "tracker", id);
    });
    if (!deleted) {
      send(res, 404, { error: "Tracker entry not found." });
      return;
    }
    send(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/chat" && req.method === "POST") {
    const body = await readJson(req);
    const question = String(body.message || "").trim();
    if (!question) {
      send(res, 400, { error: "Ask a question first." });
      return;
    }
    const store = await readStore();
    const result = await answerQuestion(question, store.memories);
    await writeStore((current) => ({
      ...current,
      chats: [
        { id: createId("chat"), question, answer: result.answer, createdAt: new Date().toISOString() },
        ...current.chats.slice(0, 80)
      ]
    }));
    send(res, 200, result);
    return;
  }

  send(res, 404, { error: "Not found" });
}

function sendFile(req, res, filePath) {
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      send(res, 404, "Not found");
      return;
    }

    const contentType = mimeTypes[path.extname(filePath)] || "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        res.writeHead(416, {
          "Content-Range": `bytes */${stat.size}`,
          "Cache-Control": "no-store"
        });
        res.end();
        return;
      }

      const suffixLength = !match[1] && match[2] ? Number(match[2]) : NaN;
      const start = Number.isFinite(suffixLength) ? Math.max(stat.size - suffixLength, 0) : (match[1] ? Number(match[1]) : 0);
      const end = Number.isFinite(suffixLength) ? stat.size - 1 : (match[2] ? Number(match[2]) : stat.size - 1);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
        res.writeHead(416, {
          "Content-Range": `bytes */${stat.size}`,
          "Cache-Control": "no-store"
        });
        res.end();
        return;
      }

      const safeEnd = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        "Content-Type": contentType,
        "Content-Length": safeEnd - start + 1,
        "Content-Range": `bytes ${start}-${safeEnd}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store"
      });
      fs.createReadStream(filePath, { start, end: safeEnd }).pipe(res);
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    setCors(req, res);
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(requestUrl.pathname);

    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }

    if (pathname.startsWith("/media/")) {
      const mediaToken = authToken(req) || requestUrl.searchParams.get("token") || "";
      if (!verifySession(mediaToken)) {
        send(res, 401, { error: "Unauthorized" });
        return;
      }
      const filename = path.basename(pathname);
      sendFile(req, res, path.join(mediaDir, filename));
      return;
    }

    let staticPath = pathname === "/" ? "/index.html" : pathname;
    const normalizedPath = path.normalize(staticPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(publicDir, normalizedPath);

    if (!filePath.startsWith(publicDir)) {
      send(res, 403, "Forbidden");
      return;
    }

    sendFile(req, res, filePath);
  } catch (error) {
    send(res, error.status || 500, { error: error.message || "Server error" });
  }
});

if (require.main === module) {
  ensureDataDir()
    .then(backfillCoachMessages)
    .then(() => {
      server.listen(port, () => {
        console.log(`Lily memory bank running at http://localhost:${port}`);
      });
    });
}

if (process.env.NODE_ENV === "test") {
  module.exports = {
    COACH_MAX_WORDS,
    COACH_MIN_WORDS,
    addFallbackCoachForWeight,
    backfillCoachMessages,
    buildCoachContext,
    buildContextualFallback,
    coachForWeight,
    coachWordCount,
    createCoachMessageRecord,
    ensureDataDir,
    generateAndReplaceCoach,
    generateCoachParagraph,
    hiddenStrategyState,
    latestCoachPayload,
    normalizeCoachParagraph,
    publicCoach,
    readStore,
    refreshLatestWeightOnlyCoach,
    refreshIfLatestCoachReferences,
    removeWeightAndCoach,
    similarityScore,
    validateCoachParagraph,
    writeStore
  };
}
