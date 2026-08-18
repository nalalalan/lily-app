const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const weightForecast = require("./public/weight-forecast.js");
const weightUnits = require("./public/weight-unit.js");
const {
  calculateBobaRewardState,
  createBobaRewardBaseline,
  normalizeBobaRewardState,
  publicBobaReward
} = require("./boba-reward.js");

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
const privateCoachBlockedTerms = String(process.env.LILY_PRIVATE_COACH_BLOCKED_TERMS || "")
  .split("|")
  .map((term) => term.trim().toLowerCase())
  .filter(Boolean);
const coachGenerationTimeoutMs = Math.max(500, Number(process.env.LILY_COACH_TIMEOUT_MS || 8000));
const coachBackgroundGenerationTimeoutMs = Math.max(coachGenerationTimeoutMs, Number(process.env.LILY_COACH_BACKGROUND_TIMEOUT_MS || 20000));
const brainApiBase = String(process.env.BRAIN_API_BASE || "").trim().replace(/\/+$/, "");
const brainRequestTimeoutMs = Math.max(250, Number(process.env.LILY_BRAIN_TIMEOUT_MS || 2000));
const trackerTimeZone = process.env.LILY_TRACKER_TIME_ZONE || "America/New_York";
const bobaBaselineDateKey = process.env.LILY_BOBA_BASELINE_DATE_KEY || "2026-08-08";
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
const brainContextLastCheckedAtByWeight = new Map();
const coachGenerationLastAttemptAtByWeight = new Map();

function containsPrivateCoachBlockedTerm(text) {
  const normalized = String(text || "").toLowerCase();
  return privateCoachBlockedTerms.some((term) => normalized.includes(term));
}

function publicApiErrorMessage(error, status = Number(error?.status) || 500) {
  return status >= 500 ? "Something went wrong. Please try again." : (error?.message || "Request failed.");
}

const COACH_GENERATION_VERSION = "coach-deterministic-v1";
const COACH_ANALYSIS_VERSION = "coach-analysis-essential-v1";
const COACH_VALIDATOR_VERSION = "coach-validator-essential-v1";
const COACH_FALLBACK_VERSION = "coach-deterministic-v1";
const COACH_ACTION_VERSION = "coach-action-v7";
const COACH_SAFETY_VERSION = "coach-safety-v7";
const COACH_STYLE_VERSION = "coach-style-essential-v1";
const COACH_PENDING_STATUS = "pending-contextual-repair";
const COACH_MIN_WORDS = 1;
const COACH_MAX_WORDS = 42;
const COACH_RELATIONSHIP_MIN_WORDS = 1;
const COACH_RELATIONSHIP_MAX_WORDS = 42;
const COACH_COOLDOWN_COUNT = 3;
const COACH_PERSONAL_ANCHOR_COOLDOWN_COUNT = 3;
const COACH_REACTION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const COACH_REACTION_REFRESH_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const BRAIN_RELATIONSHIP_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const BRAIN_WEIGHT_INDEX_GRACE_MS = 5 * 60 * 1000;
const BRAIN_WEIGHT_CONTEXT_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const BRAIN_CONTEXT_RECHECK_COOLDOWN_MS = 12 * 1000;
const BRAIN_CONTEXT_RECHECK_MS = Object.freeze([15 * 1000, 65 * 1000, 150 * 1000, 310 * 1000]);
async function ensureDataDir() {
  await fsp.mkdir(mediaDir, { recursive: true });
  try {
    await fsp.access(storePath);
  } catch (error) {
    await fsp.writeFile(storePath, JSON.stringify({ memories: [], weights: [], chats: [], trackerEvents: [], coachMessages: [], bobaReward: null }, null, 2));
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
    coachMessages: Array.isArray(parsed.coachMessages) ? parsed.coachMessages : [],
    bobaReward: normalizeBobaRewardState(parsed.bobaReward)
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
    weight: weightUnits.roundPounds(weightUnits.weightInPounds(record)),
    unit: "lb",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function publicWeights(weights) {
  return weights.map(publicWeight);
}

function calculateStoreBobaReward(store, options = {}) {
  const weights = Array.isArray(store?.weights) ? store.weights : [];
  let rewardState = normalizeBobaRewardState(store?.bobaReward);
  if (!rewardState) {
    rewardState = createBobaRewardBaseline(weights, {
      baselineDateKey: options.baselineDateKey || bobaBaselineDateKey,
      recordedAt: options.recordedAt || new Date().toISOString(),
      timeZone: trackerTimeZone
    });
  }
  if (!rewardState) return null;
  return calculateBobaRewardState(weights, rewardState, {
    asOf: options.asOf === undefined ? Date.now() : options.asOf,
    asOfDateKey: options.asOfDateKey,
    allowAwards: options.allowAwards === true,
    earnedAt: options.earnedAt,
    weightId: options.weightId,
    timeZone: trackerTimeZone
  });
}

function reconcileBobaRewardInStore(store, options = {}) {
  const reward = calculateStoreBobaReward(store, options);
  if (!reward) return store;
  return { ...store, bobaReward: reward.state };
}

async function backfillBobaRewardState(options = {}) {
  const currentStore = await readStore();
  const candidate = calculateStoreBobaReward(currentStore, {
    baselineDateKey: options.baselineDateKey || bobaBaselineDateKey,
    recordedAt: options.recordedAt || new Date().toISOString(),
    asOf: options.asOf === undefined ? Date.now() : options.asOf
  });
  if (!candidate) return currentStore;
  return writeStore((store) => reconcileBobaRewardInStore(store, {
    baselineDateKey: options.baselineDateKey || bobaBaselineDateKey,
    recordedAt: options.recordedAt || new Date().toISOString(),
    asOf: options.asOf === undefined ? Date.now() : options.asOf
  }));
}

function weightInPounds(record) {
  return weightUnits.weightInPounds(record);
}

function trimCoachNumber(value) {
  if (!Number.isFinite(Number(value))) return "--";
  return Number(Number(value).toFixed(1)).toString();
}

function coachWordCount(text) {
  return String(text || "").trim().match(/[A-Za-z0-9]+(?:[’'][A-Za-z0-9]+)*/g)?.length || 0;
}

function coachWordBounds(context) {
  return context?.relationshipSupport
    ? { min: context.verdict === "baseline" ? 30 : COACH_RELATIONSHIP_MIN_WORDS, max: COACH_RELATIONSHIP_MAX_WORDS }
    : { min: COACH_MIN_WORDS, max: COACH_MAX_WORDS };
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
  const currentIndex = rows.findIndex((record) => record.id === weightId);
  const current = currentIndex >= 0 ? rows[currentIndex] : null;
  if (!current) return { current: null, rows: [], points: [] };
  const cutoff = Date.parse(current.createdAt);
  const causalRows = rows
    .map((record, sourceIndex) => ({ record, sourceIndex, time: Date.parse(record.createdAt) }))
    .filter((entry) => Number.isFinite(entry.time) && (entry.time < cutoff || (entry.time === cutoff && entry.sourceIndex <= currentIndex)))
    .sort((left, right) => left.time - right.time || left.sourceIndex - right.sourceIndex)
    .map((entry) => entry.record);
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

function reportedCoachEffort(text) {
  const source = String(text || "").trim();
  const attributed = /\b(?:she|lily)\s+(?:says?|said|mentioned|replied|responded|told\s+me)\b/i.test(source);
  const effort = /\b(?:try(?:ing|ies|ied)?|work(?:ing)?\s+on|start(?:ed|ing)?|plan(?:s|ned|ning)?\s+to|keep(?:s|ing)?\s+up|has\s+been|is\s+(?:drinking|eating|walking)\s+more)\b/i.test(source);
  const negatedEffort = /\b(?:not|never|stopp?ed|stops?|quit|gave\s+up|cannot|can(?:'|\u2019)?t|cant|couldn(?:'|\u2019)?t|w(?:ill\s+not|on(?:'|\u2019)?t)|does\s+not|doesn(?:'|\u2019)?t|is\s+not|isn(?:'|\u2019)?t)\b.{0,40}\b(?:try\w*|work\w*|start\w*|plan\w*|keep\w*|drink\w*|eat\w*|walk\w*)\b|\b(?:try\w*|work\w*|start\w*|plan\w*|keep\w*)\b.{0,24}\b(?:not|never|stopp?ed|quit|cannot|can(?:'|\u2019)?t|cant|w(?:ill\s+not|on(?:'|\u2019)?t))\b/i.test(source);
  const unsafe = /\b(?:alcohol|beer|wine|liquor|doctor|medical|prescri\w*|medicat\w*|dose|dosage|kidney|heart|blood pressure|sodium|fast\w*|starv\w*|purg\w*|vomit\w*|skip\w*\s+meals?|restrict\w*)\b/i.test(source);
  if (!attributed || !effort || negatedEffort || unsafe) return null;

  if (/\b(?:water|electrolyte\w*|hydrat\w*)\b/i.test(source)) {
    return {
      kind: "reported-hydration-effort",
      actionId: "reaction-hydration-effort",
      actionSemantic: "acknowledged-hydration-effort"
    };
  }
  if (/\b(?:vegetable|veggie)\w*\b/i.test(source)) {
    return {
      kind: "reported-vegetable-effort",
      actionId: "reaction-vegetable-effort",
      actionSemantic: "acknowledged-vegetable-effort"
    };
  }
  if (/\bprotein\w*\b/i.test(source)) {
    return {
      kind: "reported-protein-effort",
      actionId: "reaction-protein-effort",
      actionSemantic: "acknowledged-protein-effort"
    };
  }
  if (/\b(?:walk\w*|steps?|movement)\b/i.test(source)) {
    return {
      kind: "reported-movement-effort",
      actionId: "reaction-movement-effort",
      actionSemantic: "acknowledged-movement-effort"
    };
  }
  return null;
}

function observerCareSignal(text) {
  const source = String(text || "").trim();
  const observer = /\b(?:alan|i)\b/i.test(source);
  const lily = /\b(?:lily|she|her)\b/i.test(source);
  const noticed = /\b(?:notice[ds]?|feel(?:s|ing)?\s+like|seem(?:s|ed)?\s+(?:a\s+little\s+)?off|mood\s+(?:is|seems|feels)\s+off)\b/i.test(source);
  const mood = /\b(?:mood\s+(?:is|seems|feels)\s+off|seem(?:s|ed)?\s+(?:a\s+little\s+)?off|not\s+(?:quite\s+)?herself|quieter\s+than\s+usual|having\s+a\s+rough\s+day)\b/i.test(source);
  const withdrawn = /\b(?:not|never|no\s+longer|don(?:'|\u2019)?t|do\s+not)\b.{0,28}\b(?:notice|think|feel|seem)\b/i.test(source);
  const unsafe = /\b(?:suicid\w*|self[- ]?harm\w*|diagnos\w*|clinical\w*|disorder\w*|medicat\w*|doctor|therap\w*|abuse\w*|violent|danger\w*|threat\w*|fast\w*|starv\w*|purg\w*|vomit\w*|skip\w*\s+meals?|restrict\w*|sex|horn\w*|ovulat\w*)\b/i.test(source)
    || containsPrivateCoachBlockedTerm(source);
  if (!observer || !lily || !noticed || !mood || withdrawn || unsafe) return null;
  return {
    kind: "observer-mood-support",
    actionId: "observer-mood-support",
    actionSemantic: "noticed-mood-support"
  };
}

const BRAIN_RELATIONSHIP_COPY = Object.freeze({
  "boyfriend-yap-phd-league": "The PhD work and League both belong in the real unedited version of me",
  "boyfriend-yap-phd": "The PhD work is still tangled, and you get the real unedited version of me",
  "boyfriend-yap": "You get the honest, slightly all-over-the-place version of me",
  "boyfriend-authentic-game-yap": Object.freeze([
    "League can turn one small decision into a whole tangent, and you are the person I want to tell",
    "Another game angle is still unfolding, and you get the unpolished version of me",
    "One game detail can become a whole yap, and you are still the person I want to tell"
  ]),
  "boyfriend-authentic-yap": Object.freeze([
    "One random detail can become a whole yap, and you get my real slightly all-over-the-place self",
    "The honest version comes before the polished one, and you are the person I trust with it",
    "One unfinished idea can become a full yap, and you are the person I want to share it with"
  ])
});

function brainConnectionCopy(kind, sourceHash = "") {
  const value = BRAIN_RELATIONSHIP_COPY[kind];
  if (!Array.isArray(value)) return String(value || "");
  const seed = parseInt(String(sourceHash || "0").slice(0, 8), 16);
  return value[Number.isFinite(seed) ? seed % value.length : 0];
}

const LILY_PERSONAL_ANCHOR_COPY = Object.freeze({
  "lily-league": Object.freeze([
    "That League night should feel supportive, not managed by a graph",
    "That League night belongs beside the number because you are more than a set of instructions"
  ]),
  "lily-music": Object.freeze([
    "Music is part of the real life around this graph",
    "One scale reading is never the whole person I see"
  ]),
  "lily-travel": Object.freeze([
    "That future trip is part of the much bigger life around this weigh-in",
    "The larger life around you stays in view beside this one number"
  ]),
  "lily-korean-food": Object.freeze([
    "The Korean flavors you like still have to fit naturally into the plan",
    "Korean food can belong in progress that fits your real life"
  ]),
  "lily-korean-food-neutral": Object.freeze([
    "That Korean food detail belongs in a plan built for your real life",
    "Progress still has to fit the Korean food detail you shared"
  ]),
  "lily-korean-food-dislike": Object.freeze([
    "Korean food is not really your thing, so the plan has to fit your actual taste",
    "Progress has to work without leaning on Korean food you do not enjoy"
  ]),
  "lily-fruit": Object.freeze([
    "The fruit you enjoy is one of the real details that matters beside the number",
    "The fruit you like belongs in a plan that pays attention to your actual life"
  ]),
  "lily-fruit-neutral": Object.freeze([
    "That fruit detail matters beside the number",
    "The fruit detail you shared belongs in the real-life plan around this graph"
  ]),
  "lily-fruit-dislike": Object.freeze([
    "The fruit you do not enjoy should not be forced into the plan",
    "Progress has to fit your actual taste instead of leaning on fruit you dislike"
  ]),
  "lily-cooking": Object.freeze([
    "That cooking detail belongs in the actual life around this chart",
    "Cooking is part of the larger picture; you are never a collection of measurements"
  ]),
  "lily-cats": Object.freeze([
    "That cat detail belongs in the larger picture around this chart",
    "The cats are part of the real life that one graph cannot capture"
  ]),
  "lily-french": Object.freeze([
    "That French detail belongs in the real life beyond this one number",
    "French is part of the whole person around this graph"
  ]),
  "lily-heavy-day": Object.freeze([
    "Some days feel heavier, and the person carrying the day matters more than one number",
    "The heavier part of the day deserves steadiness beside an honest read of the number"
  ]),
  "lily-mood-care": Object.freeze([
    "Things felt a little off, and this should feel steady rather than judgmental",
    "Being seen matters alongside reading the number honestly"
  ]),
  "lily-rough-patch": Object.freeze([
    "That rough patch calls for support beside you, not another demand",
    "The rough patch should be met with steadiness instead of a grade"
  ]),
  "lily-hydration": Object.freeze([
    "The hydration effort you mentioned counts alongside the result",
    "The drinking effort you shared is real work around the number"
  ]),
  "lily-hydration-detail": Object.freeze([
    "That hydration detail belongs in the real life around this number",
    "That drinking detail matters beside the scale"
  ]),
  "lily-protein": Object.freeze([
    "The protein effort you mentioned counts alongside the result",
    "The protein habit you shared is real work around the scale"
  ]),
  "lily-protein-detail": Object.freeze([
    "That protein detail belongs among the real choices around this number",
    "That protein detail matters beside the scale"
  ]),
  "lily-cycle": Object.freeze([
    "The cycle detail stays as context without pretending it explains this result",
    "The cycle context belongs beside the number without explaining it away or judging it"
  ]),
  "lily-authentic-voice": Object.freeze([
    "The longer unfiltered version belongs beside this analysis",
    "You get the honest version before everything is polished"
  ]),
  "lily-input-detour": Object.freeze([
    "The earlier tangent is part of the real-life context around this number",
    "That unfinished tangent belongs in the honest version of this message"
  ]),
  "lily-mood-detail": Object.freeze([
    "That mood detail stays as context without inventing a story around it",
    "The mood detail matters without pretending it says more than it does"
  ])
});

const LILY_PERSONAL_ANCHOR_RULES = Object.freeze([
  { kind: "lily-league", pattern: /\bleague\b|\b(?:game|gaming)\w*\b/i },
  { kind: "lily-mood-care", pattern: /\b(?:things?|mood)\s+(?:felt|feel|seem\w*)\s+off\b|\b(?:seem\w*\s+off|quiet(?:er)?\s+than\s+usual|criticiz\w*|rough\s+day|not\s+(?:quite\s+)?herself)\b/i },
  { kind: "lily-music", pattern: /\b(?:music|song|sing|violin|instrument)\w*\b/i },
  { kind: "lily-travel", pattern: /\b(?:travel|trip|vacation)\w*\b/i },
  { kind: "lily-korean-food", pattern: /\bkorean\b/i },
  { kind: "lily-fruit", pattern: /\b(?:fruit|peach|berries|apple)\w*\b/i },
  { kind: "lily-cooking", pattern: /\b(?:cook|recipe)\w*\b/i },
  { kind: "lily-cats", pattern: /\b(?:cat|cats|kitten)\b/i },
  { kind: "lily-french", pattern: /\bfrench\b/i },
  { kind: "lily-hydration", pattern: /\b(?:water|drink|hydrat|electrolyte)\w*\b/i },
  { kind: "lily-protein", pattern: /\bprotein\w*\b/i },
  { kind: "lily-cycle", pattern: /\b(?:period|cycle|menstr)\w*\b/i },
  { kind: "lily-rough-patch", pattern: /\b(?:conflict|fight|argument|repair|rough\s+patch)\w*\b/i },
  { kind: "lily-heavy-day", pattern: /\b(?:mood|heavy\s+day|rough\s+day|seem\w*\s+off|depress\w*|anxi\w*)\b/i },
  { kind: "lily-authentic-voice", pattern: /\b(?:letter|yap\w*|rambl\w*|unfiltered|trust\w*)\b/i }
]);

function personalAnchorCopy(rows, sourceHash = "", seed = "") {
  const copies = Array.isArray(rows) ? rows : [];
  if (!copies.length) return "";
  return copies[stableIndex(`${sourceHash}|${seed}`, copies.length)];
}

function memoryTopicAttribution(text, topicPattern) {
  const source = String(text || "");
  const thirdPartyFraming = /\b(?:pasted?|copied|transcript|speaker|interviewer|coworker|colleague|neighbor|manager|boss|client|patient|therapist|doctor|ex(?:es)?|wife|husband|girlfriend|mother|father|mom|dad|sister|brother)\b/i.test(source);
  let sender = false;
  let lily = false;
  let thirdParty = false;
  for (const clause of source.split(/[.;!?]/)) {
    if (!topicPattern.test(clause)) continue;
    const namedThirdParty = /\b(?!Lily\b)[A-Z][a-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\s+(?:likes?|loves?|hates?|dislikes?|prefers?|enjoys?|wants?)\b/.test(clause);
    const framedThirdParty = /\b(?:speaker|coworker|colleague|neighbor|manager|boss|client|patient|therapist|doctor|friend|ex(?:es)?|wife|husband|girlfriend|mother|father|mom|dad|sister|brother)\b/i.test(clause);
    if (/\bLily\b/i.test(clause) || (!thirdPartyFraming && /\b(?:you|your|she|her|hers)\b/i.test(clause))) lily = true;
    if (namedThirdParty || framedThirdParty) thirdParty = true;
    const reportedOther = /\b(?:heard|quoted?|copied|pasted|read\s+that|was\s+told|told\s+me|transcript|speaker)\b/i.test(clause);
    const directSenderRelation = /\b(?:i|we)\s+(?:really\s+)?(?:like|love|hate|dislike|enjoy|prefer|want|keep\s+thinking\s+(?:about|of)|think\s+(?:about|of)|am\s+thinking\s+(?:about|of)|was\s+thinking\s+(?:about|of)|wonder\s+(?:about|whether)|remember)\b|\b(?:my|mine|our|ours)\b/i.test(clause);
    if (directSenderRelation && !reportedOther && !namedThirdParty && !framedThirdParty) sender = true;
  }
  if (lily) return "lily";
  if (thirdPartyFraming || thirdParty) return "third-party";
  if (sender) return "sender";
  return "ambiguous";
}

function senderFoodPreferenceSignal(text, topicPattern) {
  let signal = 0;
  for (const clause of String(text || "").split(/[.;!?]/)) {
    if (!topicPattern.test(clause)) continue;
    if (/\b(?:speaker|coworker|colleague|neighbor|manager|boss|client|patient|therapist|doctor|friend|ex(?:es)?|wife|husband|girlfriend|mother|father|mom|dad|sister|brother)\b/i.test(clause)) continue;
    const negative = /\b(?:i|we)\s+(?:really\s+)?(?:hate|dislike|do\s+not\s+like|don['’]?t\s+like|do\s+not\s+enjoy|don['’]?t\s+enjoy)\b/i.test(clause);
    const positive = /\b(?:i|we)\s+(?:really\s+)?(?:like|love|enjoy|prefer)\b/i.test(clause);
    if (negative) signal = -1;
    else if (positive) signal = 1;
  }
  return signal;
}

const SENDER_MEMORY_COPY = Object.freeze({
  "sender-league": Object.freeze(["League can turn one decision into a whole tangent", "League keeps producing another angle to work through"]),
  "sender-violins": Object.freeze(["Violins are cool", "Violins deserve a proper place in the day"]),
  "sender-music": Object.freeze(["Music belongs in the day", "Music is part of the larger picture around this number"]),
  "sender-travel": Object.freeze(["Travel is still on the horizon", "The future trip is still worth building toward"]),
  "sender-korean-food": Object.freeze(["The Korean food I like still belongs in real life", "Korean flavor should fit naturally into the plan"]),
  "sender-korean-food-neutral": Object.freeze(["Korean food is part of the real-life context", "The Korean food detail still belongs in the picture"]),
  "sender-korean-food-dislike": Object.freeze(["Korean food is not really my thing", "The plan should not lean on Korean food I do not enjoy"]),
  "sender-fruit": Object.freeze(["The fruit I like is an easy real-life detail", "Fruit I actually enjoy can fit naturally into the day"]),
  "sender-fruit-neutral": Object.freeze(["Fruit is part of the real-life context", "The fruit detail still belongs in the picture"]),
  "sender-fruit-dislike": Object.freeze(["Fruit is not really my thing", "The plan should not lean on fruit I do not enjoy"]),
  "sender-cooking": Object.freeze(["Cooking is part of the day", "The cooking detail belongs in the larger picture"]),
  "sender-cats": Object.freeze(["The cats are part of the day", "The cats belong in the larger picture around this number"]),
  "sender-french": Object.freeze(["French is part of the day", "That French detail belongs in the larger picture"]),
  "sender-hydration": Object.freeze(["Hydration matters beside the number", "The drinking effort belongs in the real-life context"]),
  "sender-protein": Object.freeze(["Protein matters beside the number", "The protein habit belongs in the real-life context"]),
  "sender-cycle": Object.freeze(["The cycle context belongs beside the number without explaining it away", "The cycle detail stays as context, not a verdict"]),
  "sender-repair": Object.freeze(["That rough patch calls for steadiness, not another demand", "The rough patch deserves support instead of a grade"]),
  "sender-mood": Object.freeze(["That mood detail matters without inventing a story around it", "Things felt a little off, and steadiness matters here"]),
  "sender-authentic-voice": Object.freeze(["The unfinished version is part of the honest message", "The unpolished version belongs here too"])
});

function senderMemoryAnchorKind(anchorKind, text, options = {}) {
  const base = String(anchorKind || "").replace(/^lily-/, "");
  if (base === "music" && /\bviolins?\b/i.test(text)) return "sender-violins";
  if (base === "korean-food") {
    if (options.neutral) return "sender-korean-food-neutral";
    const preference = senderFoodPreferenceSignal(text, /\bkorean\b/i);
    return preference < 0 ? "sender-korean-food-dislike" : preference > 0 ? "sender-korean-food" : "sender-korean-food-neutral";
  }
  if (base === "fruit") {
    if (options.neutral) return "sender-fruit-neutral";
    const preference = senderFoodPreferenceSignal(text, /\b(?:fruit|peach|berries|apple)\w*\b/i);
    return preference < 0 ? "sender-fruit-dislike" : preference > 0 ? "sender-fruit" : "sender-fruit-neutral";
  }
  const aliases = {
    "heavy-day": "mood",
    "mood-care": "mood",
    "mood-detail": "mood",
    "input-detour": "authentic-voice"
  };
  return `sender-${aliases[base] || base}`;
}

function senderMemoryAnchorCopy(kind, sourceHash = "", seed = "") {
  return personalAnchorCopy(senderMemoryAnchorRows(kind), sourceHash, seed);
}

function senderMemoryAnchorRows(kind) {
  return SENDER_MEMORY_COPY[kind] || SENDER_MEMORY_COPY["sender-authentic-voice"];
}

function memoryPersonalAnchor(memory, options = {}) {
  if (!memory?.id) return null;
  const memoryKind = String(memory.kind || "").toLowerCase();
  const sourceText = String(memory.text || memory.title || "").trim();
  if (containsPrivateCoachBlockedTerm(sourceText)) return null;
  const unsafeClause = /\b(?:fast\w*|starv\w*|purg\w*|vomit\w*|skip\w*(?:\s+(?:a|the))?\s+meals?|restrict\w*|under-?eat\w*|overexercis\w*|suicid\w*|self[- ]?harm\w*|diagnos\w*|medicat\w*|sexual|horn\w*|dysphoria|adhd|autis\w*)\b/i;
  const text = sourceText
    .split(/[.!?;\n]+|\b(?:but|however|whereas)\b/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause && !unsafeClause.test(clause) && !containsPrivateCoachBlockedTerm(clause))
    .join(". ");
  if (!sourceText || !text) return null;
  const createdAt = String(memory.createdAt || "");
  const createdTime = Date.parse(createdAt);
  const cutoff = Number(options.cutoff);
  if (!Number.isFinite(createdTime) || (Number.isFinite(cutoff) && createdTime > cutoff)) return null;
  const rule = LILY_PERSONAL_ANCHOR_RULES.find((candidate) => candidate.pattern.test(text));
  let anchorKind = rule?.kind || (sourceText.length >= 500 ? "lily-authentic-voice" : "");
  const attribution = memoryTopicAttribution(text, rule?.pattern || /[\s\S]/);
  if (anchorKind && attribution === "third-party") anchorKind = "lily-input-detour";
  else if (anchorKind && attribution === "sender") anchorKind = senderMemoryAnchorKind(anchorKind, text);
  else if (anchorKind && attribution === "ambiguous") anchorKind = senderMemoryAnchorKind(anchorKind, text, { neutral: true });
  const negatedMood = /\b(?:not|never|no\s+longer|isn['’]?t|wasn['’]?t|doesn['’]?t|didn['’]?t)\b.{0,28}\b(?:off|rough|heavy|sad|anxi\w*|depress\w*|conflict|fight|argument)\b/i.test(text);
  if (["lily-mood-care", "lily-heavy-day", "lily-rough-patch"].includes(anchorKind) && negatedMood) anchorKind = "lily-mood-detail";
  if (anchorKind === "lily-fruit") {
    const preference = foodPreferenceSignal(text, /\b(?:fruit|peach|berries|apple)\w*\b/i);
    if (preference < 0) anchorKind = "lily-fruit-dislike";
    else if (preference === 0) anchorKind = "lily-fruit-neutral";
  } else if (anchorKind === "lily-korean-food") {
    const preference = foodPreferenceSignal(text, /\bkorean\b/i);
    if (preference < 0) anchorKind = "lily-korean-food-dislike";
    else if (preference === 0) anchorKind = "lily-korean-food-neutral";
  } else if (anchorKind === "lily-hydration") {
    const effort = reportedCoachEffort(text);
    if (effort?.kind !== "reported-hydration-effort") anchorKind = "lily-hydration-detail";
  } else if (anchorKind === "lily-protein") {
    const effort = reportedCoachEffort(text);
    if (effort?.kind !== "reported-protein-effort") anchorKind = "lily-protein-detail";
  }
  if (!anchorKind) return null;
  const sourceHash = crypto.createHash("sha256").update(JSON.stringify({ id: memory.id, kind: memoryKind, text: sourceText })).digest("hex");
  return {
    id: String(memory.id),
    sourceType: "memory-personal-anchor",
    kind: anchorKind,
    text: anchorKind.startsWith("sender-")
      ? senderMemoryAnchorCopy(anchorKind, sourceHash, options.seed)
      : personalAnchorCopy(LILY_PERSONAL_ANCHOR_COPY[anchorKind], sourceHash, options.seed),
    createdAt: new Date(createdTime).toISOString(),
    sourceHash
  };
}

function personalAnchorReferenceKeys(messages, limit = COACH_PERSONAL_ANCHOR_COOLDOWN_COUNT) {
  return new Set((Array.isArray(messages) ? messages.slice(0, limit) : [])
    .flatMap((message) => Array.isArray(message?.evidenceReferences) ? message.evidenceReferences : [])
    .filter((reference) => ["memory-personal-anchor", "brain-thought-anchor", "brain-letter"].includes(reference?.type) && reference.id)
    .flatMap((reference) => reference.type === "brain-thought-anchor"
      ? [`id:${reference.id}`]
      : [`id:${reference.id}`, `semantic:${personalAnchorSemanticKind(reference.role)}`]));
}

function personalAnchorSemanticKind(kind) {
  const value = String(kind || "").trim().toLowerCase()
    .replace(/^brain-thought-/, "")
    .replace(/^lily-/, "");
  if (/^boyfriend-/.test(value)) return "relationship-connection";
  if (/^sender-/.test(value)) return value
    .replace(/^sender-/, "")
    .replace(/^violins$/, "music")
    .replace(/-(?:neutral|dislike)$/, "");
  if (/^(?:authentic-|letter|yap)/.test(value)) return "authentic-voice";
  if (value === "input-detour") return "authentic-voice";
  if (value === "mood-detail") return "mood-care";
  if (/^korean-food(?:-|$)/.test(value)) return "korean-food";
  if (/^fruit(?:-|$)/.test(value)) return "fruit";
  if (/^hydration(?:-|$)/.test(value)) return "hydration";
  if (/^protein(?:-|$)/.test(value)) return "protein";
  if (value === "mood") return "mood-care";
  return value;
}

function personalAnchorIsAvailable(store, anchor, weightId = "") {
  if (!anchor?.id || !anchor?.kind) return false;
  const weight = (store?.weights || []).find((record) => record.id === weightId) || null;
  const previousMessages = causalPreviousCoachMessages(store, weight, COACH_PERSONAL_ANCHOR_COOLDOWN_COUNT);
  const recentKeys = personalAnchorReferenceKeys(previousMessages);
  if ((recentKeys.has(`id:${anchor.id}`) || recentKeys.has(`semantic:${personalAnchorSemanticKind(anchor.kind)}`))
    && anchor.cooldownFallback !== true) return false;
  return anchor.sourceType !== "brain-letter" || brainRelationshipSupportAvailable(store, anchor, weightId);
}

function newestPersonalAnchor(...anchors) {
  return anchors
    .filter((anchor) => anchor?.id && anchor?.text && Number.isFinite(Date.parse(anchor.createdAt || "")))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
      || String(right.sourceType || "").localeCompare(String(left.sourceType || ""))
      || String(left.id).localeCompare(String(right.id)))[0] || null;
}

function rotateReusedMemoryAnchor(anchor, previousMessages = [], seed = "") {
  if (!anchor || anchor.sourceType !== "memory-personal-anchor") return anchor;
  const rows = anchor.kind.startsWith("sender-")
    ? senderMemoryAnchorRows(anchor.kind)
    : (LILY_PERSONAL_ANCHOR_COPY[anchor.kind] || []);
  const priorText = String(previousMessages?.[0]?.personalAnchor?.approvedText || "");
  const alternatives = (Array.isArray(rows) ? rows : [rows]).filter((text) => text && text !== priorText);
  return alternatives.length
    ? { ...anchor, text: personalAnchorCopy(alternatives, anchor.sourceHash, `${seed}|reuse`), cooldownFallback: true }
    : { ...anchor, cooldownFallback: true };
}

function selectLilyPersonalAnchor(memories, cutoff, previousMessages = [], seed = "") {
  const recentKeys = personalAnchorReferenceKeys(previousMessages);
  const anchors = (Array.isArray(memories) ? memories : [])
    .map((memory) => memoryPersonalAnchor(memory, { cutoff, seed }))
    .filter(Boolean)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || left.id.localeCompare(right.id));
  const fresh = anchors.find((anchor) => !recentKeys.has(`id:${anchor.id}`) && !recentKeys.has(`semantic:${personalAnchorSemanticKind(anchor.kind)}`));
  const newest = anchors[0] || null;
  if (fresh && newest && fresh.id !== newest.id
    && (recentKeys.has(`id:${newest.id}`) || recentKeys.has(`semantic:${personalAnchorSemanticKind(newest.kind)}`))
    && Date.parse(newest.createdAt) - Date.parse(fresh.createdAt) > 24 * 60 * 60 * 1000) {
    return rotateReusedMemoryAnchor(newest, previousMessages, seed);
  }
  if (fresh) return fresh;
  const immediateIds = new Set((previousMessages || []).slice(0, 1)
    .flatMap((message) => Array.isArray(message?.evidenceReferences) ? message.evidenceReferences : [])
    .filter((reference) => reference?.id)
    .map((reference) => String(reference.id)));
  const fallback = anchors.find((anchor) => !immediateIds.has(anchor.id)) || newest;
  return fallback ? rotateReusedMemoryAnchor(fallback, previousMessages, seed) : null;
}

function selectCarriedPersonalAnchor(store, currentWeight, previousMessages = []) {
  for (const message of Array.isArray(previousMessages) ? previousMessages : []) {
    const anchor = personalAnchorFromCoachRecord(message);
    if (!anchor?.id || !anchor?.text || containsPrivateCoachBlockedTerm(anchor.text)) continue;
    if (anchor.sourceType === "memory-personal-anchor"
      && !(store.memories || []).some((memory) => memory.id === anchor.id)) continue;
    return {
      ...anchor,
      cooldownFallback: true,
      carriedFromWeightId: message.weightId || ""
    };
  }
  return null;
}

function brainSpecificFragments(source) {
  return String(source || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, " ")
    .slice(0, 6000)
    .replace(/\bloading\s+and\s+unloading\b/gi, "loading/unloading")
    .replace(/\bbecause\s+it\s+(?:feels?|is)\s+(?=(?:effortless|easy)\b)/gi, "feels ")
    .replace(/(\bif\s+we\s+know\s+where\s+(?:the\s+)?enemy\s+(?:team|positions?)\s+is)\s*,\s*(?=(?:we\s+can\s+)?(?:do|take|call)\s+(?:the\s+)?dragon\b)/gi, "$1 so ")
    .replace(/\b(?:two|2)\s+bottom[-\s]+row\s+plots?\s+or\s+(?:three|3)(?:\s+bottom[-\s]+row\s+plots?)?\b/gi, "two-versus-three bottom-row plots")
    .replace(/\b(?:two|2)\s+or\s+(?:three|3)\s+bottom[-\s]+row\s+plots?\b/gi, "two-versus-three bottom-row plots")
    .replace(/\b(?:two|2)\s+plots?\s+or\s+(?:three|3)\s+plots?\b/gi, "two-versus-three plots")
    .replace(/\band\s+whether\b/gi, "plus whether")
    .replace(/,\s*(especially|specifically|including)\s+/gi, " $1 ")
    .split(/[.!?;,\u2014\u2013:\n]+|\b(?:and|but|or|while|whereas|although|though|because|then)\b/i)
    .map((fragment) => fragment.trim())
    .filter(Boolean)
    .filter((fragment) => !BRAIN_GENERAL_REPORT.test(fragment)
      && !BRAIN_GENERAL_PII.test(fragment)
      && !BRAIN_GENERAL_INJECTION.test(fragment)
      && !BRAIN_GENERAL_SENSITIVE.test(fragment)
      && !containsPrivateCoachBlockedTerm(fragment));
}

const BRAIN_SPECIFIC_NEGATION = /\b(?:not|never|no|hardly|cannot|can[\u2019']?t|couldn[\u2019']?t|don[\u2019']?t|doesn[\u2019']?t|didn[\u2019']?t|isn[\u2019']?t|aren[\u2019']?t|wasn[\u2019']?t|weren[\u2019']?t|shouldn[\u2019']?t|mustn[\u2019']?t|won[\u2019']?t|wouldn[\u2019']?t)\b|\b(?:anything\s+but|far\s+from|hard\s+rather\s+than|difficult\s+rather\s+than)\b/i;
const BRAIN_SPECIFIC_CLAUSE_NEGATION = /\b(?:not|never|no|hardly|cannot|can[\u2019']?t|couldn[\u2019']?t|don[\u2019']?t|doesn[\u2019']?t|didn[\u2019']?t|isn[\u2019']?t|aren[\u2019']?t|wasn[\u2019']?t|weren[\u2019']?t|shouldn[\u2019']?t|mustn[\u2019']?t|won[\u2019']?t|wouldn[\u2019']?t|avoid(?:s|ed|ing)?|without)\b|\b(?:anything\s+but|far\s+from|hard\s+rather\s+than|difficult\s+rather\s+than)\b/i;
const BRAIN_SPECIFIC_CONTRAST = /\b(?:instead\s+of|rather\s+than)\b/i;

function brainSpecificRelationNegated(text, relationPattern) {
  const source = String(text || "");
  const match = relationPattern.exec(source);
  if (!match) return false;
  const directNoNeed = new RegExp(`\\bno\\s+(?:(?:real|actual)\\s+)?(?:need|reason|requirement)\\s+(?:to\\s+)?(?:${relationPattern.source})`, "i");
  if (directNoNeed.test(source)) return true;
  if (/\b(?:need|needs|require|requires)\s+no\b/i.test(source)) return true;
  const directAvoid = new RegExp(`\\bavoid(?:s|ed|ing)?(?:\\s+(?:ever|really|actually|fully|clearly)){0,2}\\s+(?:${relationPattern.source})`, "i");
  if (directAvoid.test(source)) return true;
  const directWithout = new RegExp(`\\bwithout(?:\\s+(?:ever|really|actually|fully|clearly|needing\\s+to|being\\s+able\\s+to)){0,2}\\s+(?:${relationPattern.source})`, "i");
  if (directWithout.test(source)) return true;
  const directContrast = new RegExp(`\\b(?:instead\\s+of|rather\\s+than)(?:\\s+(?:ever|really|actually|fully|clearly)){0,2}\\s+(?:${relationPattern.source})`, "i");
  if (directContrast.test(source)) return true;
  const nearby = source.slice(Math.max(0, match.index - 56), Math.min(source.length, match.index + match[0].length + 56));
  return BRAIN_SPECIFIC_NEGATION.test(nearby);
}

function brainResearchSpecificSubject(source) {
  const normalized = String(source || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, " ")
    .slice(0, 6000);
  const researchFigureContext = /\b(?:bf0[1-9]|figures?|plots?|panels?|arrays?|pressure|research|paper)\b/i.test(normalized);
  const detailClauses = normalized
    .split(/[.!?;\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause
      && !BRAIN_GENERAL_REPORT.test(clause)
      && !BRAIN_GENERAL_PII.test(clause)
      && !BRAIN_GENERAL_INJECTION.test(clause)
      && !BRAIN_GENERAL_SENSITIVE.test(clause)
      && !containsPrivateCoachBlockedTerm(clause));
  const fullArraySetIn = (clause) => ["1x1", "2x2", "3x3"].every((grid) => {
    const [rows, columns] = grid.split("x");
    return new RegExp(`\\b${rows}\\s*[xX×]\\s*${columns}\\b`, "i").test(clause);
  });
  const pressureRelation = /\b(?:need|needs|require|requires|include|includes|show|showing|present|presenting|display|displaying)\b/i;
  const pressureClause = detailClauses.find((clause) => {
    const ids = Array.from(new Set(Array.from(clause.matchAll(/\bbf0[1-9]\b/gi), (match) => match[0].toUpperCase())));
    const fullPressureSet = [10, 50, 80, 120].every((pressure) => new RegExp(`\\b${pressure}\\s*psi\\b`, "i").test(clause));
    return ids.length >= 2 && fullPressureSet && pressureRelation.test(clause)
      && !brainSpecificRelationNegated(clause, pressureRelation);
  });
  const presentationRelation = /\b(?:present|presented|presenting|show|showing|display|displaying|plot|plotting|clear|clearer)\b/i;
  const pressureArrayClause = detailClauses.find((clause) => fullArraySetIn(clause)
    && /\bpressure\b/i.test(clause)
    && /\barrays?\b/i.test(clause)
    && presentationRelation.test(clause)
    && !brainSpecificRelationNegated(clause, presentationRelation));
  const gridFigureRelation = /\b(?:include|includes|included|including|contain|contains|contained|containing|show|shows|showed|showing|present|presents|presented|presenting|display|displays|displayed|displaying)\b/i;
  const gridFigureUncertainty = /\b(?:may|might|could|possibly|perhaps|maybe|whether)\b/i;
  const gridFigureExclusion = /\b(?:exclude|excludes|excluded|excluding|remove|removes|removed|removing|omit|omits|omitted|omitting|lack|lacks|lacked|lacking|absent|missing)\b/i;
  const gridFigureClause = detailClauses.find((clause) => fullArraySetIn(clause)
    && /\bfigures?\b/i.test(clause)
    && gridFigureRelation.test(clause)
    && !brainSpecificRelationNegated(clause, gridFigureRelation)
    && !BRAIN_SPECIFIC_CLAUSE_NEGATION.test(clause)
    && !BRAIN_SPECIFIC_CONTRAST.test(clause)
    && !gridFigureUncertainty.test(clause)
    && !gridFigureExclusion.test(clause));
  const comparisonRelation = /\b(?:compare|compares|comparing|show|showing|present|presenting|plot|plotting|evaluate|evaluating)\b/i;
  const hysteresisClause = detailClauses.find((clause) => fullArraySetIn(clause)
    && /\bloading\b/i.test(clause)
    && /\bunloading\b/i.test(clause)
    && /\bhysteresis\b/i.test(clause)
    && comparisonRelation.test(clause)
    && !brainSpecificRelationNegated(clause, comparisonRelation));
  if (researchFigureContext && pressureClause) {
    const figureIds = Array.from(new Set(Array.from(pressureClause.matchAll(/\bbf0[1-9]\b/gi), (match) => match[0].toUpperCase())));
    return `${figureIds.slice(0, 2).join(" and ")} need panels at 10, 50, 80, and 120 psi`;
  }
  if (researchFigureContext && pressureArrayClause) {
    return "The 1x1, 2x2, and 3x3 pressure arrays need to be presented clearly";
  }
  if (researchFigureContext && hysteresisClause) {
    const figure = hysteresisClause.match(/\bfigure\s*\d+[a-z]?\b/i)?.[0]?.replace(/\s+/g, " ") || "The research figure";
    return `${titleCaseFirst(figure)} should compare the 1x1, 2x2, and 3x3 arrays through loading/unloading hysteresis`;
  }
  if (researchFigureContext && gridFigureClause) {
    return "The research figure includes the 1x1, 2x2, and 3x3 layouts";
  }
  const panelFraming = researchFigureContext
    && /\b(?:fram(?:e|ed|ing)|align(?:ed|ment)?|panels?)\b/i.test(normalized)
    && /\b(?:same\s+framing|framing\s+is\s+off|framed\s+(?:way\s+)?too\s+(?:high|low)|align(?:ed|ment)?|move\s+(?:the\s+)?panels?)\b/i.test(normalized);
  const endpointAngles = researchFigureContext
    && /\b(?:angles?|tangent|perpendicular|proximal|distal|segments?)\b/i.test(normalized)
    && /\b(?:endpoints?|absolute\s+ends?|green\s+lines?|local\s+to\s+the\s+cell)\b/i.test(normalized);
  if (panelFraming && endpointAngles) return "lining up the research-figure panels and measuring the endpoint angles";
  if (panelFraming) return "how to line up the research-figure panels";
  if (endpointAngles) return "how to measure the endpoint angles on the research figure";

  const genericResearchRelation = /\b(?:show|showing|present|presenting|display|displaying|figure|plot|hysteresis|compare|comparing|measure|measuring|align|move)\b/i;
  const genericResearchSource = detailClauses
    .filter((clause) => !(fullArraySetIn(clause) && /\bfigures?\b/i.test(clause)))
    .filter((clause) => !brainSpecificRelationNegated(clause, genericResearchRelation))
    .join(". ");
  const text = brainSpecificFragments(genericResearchSource).find((fragment) =>
    /\b(?:research|science|paper|figure|plot|module|array|hysteresis)\w*\b/i.test(fragment)
      && !brainSpecificRelationNegated(fragment, /\b(?:show|showing|present|presenting|display|displaying|figure|plot|hysteresis)\b/i)
      && !/\b(?:module|array|hysteresis|\d+\s*[x×]\s*\d+|plots?)\b.{0,48}\b(?:instead\s+of|rather\s+than)\b.{0,48}\b(?:module|array|hysteresis|\d+\s*[x×]\s*\d+|plots?)\b/i.test(fragment)) || "";
  if (!text) return "";
  const figure = text.match(/\bfigure\s*\d+[a-z]?\b/i)?.[0]?.replace(/\s+/g, " ") || "";
  const grid = text.match(/\b\d+\s*[x×]\s*\d+\b/i)?.[0]?.replace(/\s*[x×]\s*/i, "x") || "";
  const constrained = /\bconstrain\w*\b/i.test(text);
  const hysteresis = /\bhysteresis\b/i.test(text);
  const loading = /\bloading\b/i.test(text) && /\bunloading\b/i.test(text);
  const bottomRow = /\bbottom[-\s]+row\b/i.test(text);
  const twoOrThree = /\b(?:2|two)\b/i.test(text) && /\b(?:3|three)\b/i.test(text) && /\bplots?\b/i.test(text);
  const object = [constrained ? "constrained" : "", grid, /\bmodule\b/i.test(text) ? "module" : /\barray\b/i.test(text) ? "array" : ""]
    .filter(Boolean)
    .join(" ");
  const phenomenon = hysteresis ? `${loading ? "loading/unloading " : ""}hysteresis` : "";
  if (!figure && !object && !phenomenon) return "";
  const core = [object, phenomenon].filter(Boolean).join(" ").trim();
  if (bottomRow && twoOrThree) {
    const shortCore = [constrained ? "constrained" : "", grid, phenomenon || (/\bplot\b/i.test(text) ? "plot" : "figure")].filter(Boolean).join(" ");
    return `${figure || "the figure"}'s ${shortCore} and a two-versus-three-plot bottom row`;
  }
  if (figure && core) return `how ${figure} should show the ${core}`;
  if (core) return `how to present the ${core}`;
  return figure && /\b(?:clear|clearer|clarify|readable|improve|fix)\b/i.test(text)
    ? `how to make ${figure} clearer`
    : "";
}

function brainGameSpecificSubject(source) {
  const text = brainSpecificFragments(source).find((fragment) =>
    /\bdragon\b/i.test(fragment)
      && /\benemy\s+(?:team|position|positions?)\b|\bwhere\s+(?:the\s+)?enemy\b/i.test(fragment)
      && /\bsafe(?:ly|ty)?\b/i.test(fragment)
      && !brainSpecificRelationNegated(fragment, /\b(?:safe(?:ly|ty)?|call(?:ed|ing)?|dragon)\b/i)
      && !/\bunsafe\b|\benemy\s+positions?\s+(?:are|remain)\s+unknown\b/i.test(fragment)) || "";
  const dragon = /\bdragon\b/i.test(text);
  const enemy = /\benemy\s+(?:team|position|positions?)\b|\bwhere\s+(?:the\s+)?enemy\b/i.test(text);
  const safety = /\bsafe(?:ly|ty)?\b/i.test(text);
  if (dragon && enemy && safety) return "when enemy positions make a dragon call safe in League";
  return "";
}

function brainAppSpecificSubject(source) {
  const text = brainSpecificFragments(source).find((fragment) =>
    /\bvirtual\s+violin\b/i.test(fragment)
      && /\bbow\s+tracking\b/i.test(fragment)
      && /\b(?:played|active)\s+string\b/i.test(fragment)
      && !brainSpecificRelationNegated(fragment, /\b(?:follow(?:s|ed|ing)?|keep(?:s|ing)?|visible|played\s+string|active\s+string)\b/i)
      && !/\b(?:played|active)\s+string\b.{0,48}\b(?:instead\s+of|rather\s+than)\b.{0,48}\b(?:played|active)\s+string\b/i.test(fragment)) || "";
  const virtualViolin = /\bvirtual\s+violin\b/i.test(text);
  const bowTracking = /\bbow\s+tracking\b/i.test(text);
  const playedString = /\bplayed\s+string\b/i.test(text);
  const activeString = /\bactive\s+string\b/i.test(text);
  if (virtualViolin && bowTracking && (playedString || activeString)) {
    return playedString
      ? "how Virtual Violin bow tracking should follow the played string"
      : "how Virtual Violin bow tracking should keep the active string visible";
  }
  return "";
}

function brainMobilitySpecificSubject(source) {
  const text = brainSpecificFragments(source).find((fragment) =>
    /\b(?:jackrabbit|e-?bike|electric\s+bike|little\s+bike)\b/i.test(fragment)
      && /\b(?:effortless|easy|without\s+(?:having\s+)?to\s+pedal|do(?:es)?n['’]?t\s+(?:have\s+)?to\s+pedal|no\s+pedaling)\b/i.test(fragment)
      && !brainSpecificRelationNegated(fragment, /\b(?:effortless|easy)\b/i)
      && !/\bdoes\s+require\b.{0,28}\bpedal|\bneed(?:s|ed)?\s+to\s+pedal\b/i.test(fragment)) || "";
  const smallBike = /\b(?:jackrabbit|e-?bike|electric\s+bike|little\s+bike)\b/i.test(text);
  const effortless = /\b(?:effortless|easy|without\s+(?:having\s+)?to\s+pedal|do(?:es)?n['’]?t\s+(?:have\s+)?to\s+pedal|no\s+pedaling)\b/i.test(text);
  if (smallBike && effortless) return "how effortless the little electric bike feels without needing to pedal";
  return "";
}

const BRAIN_GENERAL_SUBJECTS = Object.freeze([
  { subject: "violins", plural: true, pattern: /\bviolins?\b/i },
  { subject: "dinosaurs", plural: true, pattern: /\bdinosaurs?\b/i },
  { subject: "clouds", plural: true, pattern: /\bclouds?\b/i },
  { subject: "rockets", plural: true, pattern: /\brockets?\b/i },
  { subject: "pottery", plural: false, pattern: /\bpottery\b/i },
  { subject: "origami", plural: false, pattern: /\borigami\b/i },
  { subject: "space", plural: false, pattern: /\b(?:space|astronomy)\b/i },
  { subject: "architecture", plural: false, pattern: /\b(?:architecture|buildings?)\b/i },
  { subject: "dancing", plural: false, pattern: /\b(?:dance|dances|dancing)\b/i },
  { subject: "fashion", plural: false, pattern: /\b(?:fashion|outfits?|clothes|clothing)\b/i },
  { subject: "coffee", plural: false, pattern: /\bcoffee\b/i },
  { subject: "tea", plural: false, pattern: /\btea\b/i },
  { subject: "the dogs", plural: true, pattern: /\b(?:dogs?|puppies|puppy)\b/i },
  { subject: "the weather", plural: false, pattern: /\b(?:weather|rain|snow)\b/i },
  { subject: "the stars", plural: true, pattern: /\bstars?\b/i },
  { subject: "the moon", plural: false, pattern: /\bmoon\b/i },
  { subject: "trains", plural: true, pattern: /\btrains?\b/i },
  { subject: "planes", plural: true, pattern: /\b(?:planes?|airplanes?)\b/i },
  { subject: "cars", plural: true, pattern: /\bcars?\b/i },
  { subject: "robots", plural: true, pattern: /\brobots?\b/i },
  { subject: "electronics", plural: true, pattern: /\b(?:electronics|keyboards?|computers?)\b/i },
  { subject: "physics", plural: false, pattern: /\bphysics\b/i },
  { subject: "biology", plural: false, pattern: /\bbiology\b/i },
  { subject: "chemistry", plural: false, pattern: /\bchemistry\b/i },
  { subject: "crafts", plural: true, pattern: /\b(?:crafts?|knitting|crochet)\b/i },
  { subject: "chess", plural: false, pattern: /\bchess\b/i },
  { subject: "board games", plural: true, pattern: /\bboard\s+games?\b/i },
  { subject: "anime", plural: false, pattern: /\banime\b/i },
  { subject: "the mobile layout", plural: false, pattern: /\bmobile\b.{0,36}\b(?:layout|screen|interface|ui)\b|\b(?:layout|screen|interface|ui)\b.{0,36}\bmobile\b/i },
  { subject: "the research figure", plural: false, pattern: /\b(?:research|science|papers?|figures?|plots?|charts?|experiments?|hysteresis)\b/i },
  { subject: "the app interface", plural: false, pattern: /\b(?:app|website|interface|dashboard|ui|user interface)\b/i },
  { subject: "the code path", plural: false, pattern: /\b(?:code|coding|servers?|apis?|endpoints?|functions?|bugs?|debug|debugging)\b/i },
  { subject: "the game decision", plural: false, pattern: /\b(?:league|games?|gaming|gameplay|dragon|matches?)\b/i },
  { subject: "the photo/video framing", plural: false, pattern: /\b(?:photos?|photographs?|pictures?|videos?|cameras?|frames?|framing|screenshots?)\b/i },
  { subject: "the little electric bike", plural: false, pattern: /\b(?:jackrabbit|e-?bike|electric\s+bike|bicycle|little\s+bike)\b/i },
  { subject: "music", plural: false, pattern: /\b(?:music|songs?|audio|melodies|melody|instruments?)\b/i },
  { subject: "cooking", plural: false, pattern: /\b(?:cook|cooks|cooked|cooking|recipes?|kitchens?)\b/i },
  { subject: "the cats", plural: true, pattern: /\b(?:cats?|kittens?)\b/i },
  { subject: "French", plural: false, pattern: /\bFrench\b/i },
  { subject: "travel", plural: false, pattern: /\b(?:travel|traveling|travelling|trips?|vacations?)\b/i },
  { subject: "the book idea", plural: false, pattern: /\b(?:books?|novels?|reading)\b/i },
  { subject: "the movie idea", plural: false, pattern: /\b(?:movies?|films?|shows?|cinema)\b/i },
  { subject: "the desk setup", plural: false, pattern: /\b(?:desks?|chairs?|workspaces?)\b/i },
  { subject: "the room", plural: false, pattern: /\b(?:rooms?|furniture|shelves|shelf|lighting)\b/i },
  { subject: "the garden", plural: false, pattern: /\b(?:gardens?|plants?|flowers?)\b/i },
  { subject: "the puzzle", plural: false, pattern: /\b(?:puzzles?|riddles?)\b/i },
  { subject: "the drawing", plural: false, pattern: /\b(?:draw|draws|drew|drawing|drawings|sketches|sketch|illustrations?)\b/i }
]);

const BRAIN_GENERAL_SENSITIVE = /\b(?:diagnos\w*|depress\w*|anxi\w*|dysphoria|adhd|suicid\w*|self[- ]?harm\w*|medicat\w*|therap\w*|sex\w*|horn\w*|ovulat\w*|menstr\w*|period|weight|pounds?|lbs?|calori\w*|fast\w*|starv\w*|purg\w*|vomit\w*|conflict|fight|argument|break\s*up|abandon\w*|trauma\w*|abus\w*|password|passcode|pin|ssn|address)\b/i;
const BRAIN_GENERAL_REPORT = /\b(?:according\s+to|said|says|told|asked|texted|posted|quoted?|transcript|speaker|interviewer|copied|pasted)\b/i;
const BRAIN_GENERAL_PII = /(?:https?:\/\/|www\.|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\+?\d[\d(). -]{7,}\d)/i;
const BRAIN_GENERAL_INJECTION = /\b(?:ignore\s+(?:all\s+)?(?:previous|prior)|system\s+prompt|developer\s+message|assistant\s+instruction|reveal\s+(?:the\s+)?prompt)\b/i;
const BRAIN_GENERAL_NEGATION = /\b(?:not|never|no|hardly|cannot|can[\u2019']?t|couldn[\u2019']?t|don[\u2019']?t|doesn[\u2019']?t|didn[\u2019']?t|isn[\u2019']?t|aren[\u2019']?t|wasn[\u2019']?t|weren[\u2019']?t|shouldn[\u2019']?t|mustn[\u2019']?t|avoid(?:s|ed|ing)?|without)\b|\b(?:anything\s+but|far\s+from|hard\s+rather\s+than|difficult\s+rather\s+than)\b/i;
const BRAIN_GENERAL_CONTRAST = /\b(?:instead\s+of|rather\s+than)\b/i;

function brainGeneralRelation(clause, subject) {
  const source = String(clause || "");
  const relationRows = [
    { pattern: /\b(?:cool|interesting|fascinating|fun)\b/i, render: () => `how cool ${subject.subject} ${subject.plural ? "are" : "is"}` },
    { pattern: /\b(?:fix(?:ed|ing)?|debug(?:ged|ging)?|broken|buggy|not\s+working)\b/i, render: () => `how to get ${subject.subject} working properly` },
    { pattern: /\b(?:clip(?:s|ped|ping)?|cut\s+off|overflow(?:s|ed|ing)?)\b/i, render: () => `how to stop ${subject.subject} from clipping` },
    { pattern: /\b(?:clear|clearer|readable|show|showing|present|presenting)\b/i, render: () => `how to make ${subject.subject} clearer` },
    { pattern: /\b(?:decid(?:e|ing)|choos(?:e|ing)|compar(?:e|ing)|whether|trade[- ]?off)\b/i, render: () => `a choice I am still weighing around ${subject.subject}` },
    { pattern: /\b(?:simple|simpler|simplify|easy|easier|effortless|frictionless)\b/i, render: () => `how to make ${subject.subject} feel simpler` },
    { pattern: /\b(?:accurate|reliable|stable)\b/i, render: () => `how to make ${subject.subject} more reliable` }
  ];
  for (const row of relationRows) {
    const match = row.pattern.exec(source);
    if (!match) continue;
    const nearby = source.slice(Math.max(0, match.index - 32), Math.min(source.length, match.index + match[0].length + 32));
    if (BRAIN_GENERAL_NEGATION.test(nearby) && !/^not\s+working$/i.test(match[0])) return subject.subject;
    return row.render();
  }
  return subject.subject;
}

function brainGeneralIntent(clause) {
  const source = String(clause || "");
  const rows = [
    { pattern: /\b(?:cool|interesting|fascinating|fun)\b/i, text: "something unexpectedly cool" },
    { pattern: /\b(?:fix(?:ed|ing)?|debug(?:ged|ging)?|broken|buggy|not\s+working)\b/i, text: "another thing I am trying to get working properly" },
    { pattern: /\b(?:decid(?:e|ing)|choos(?:e|ing)|compar(?:e|ing)|whether|trade[- ]?off)\b/i, text: "a choice I am still weighing" },
    { pattern: /\b(?:build(?:ing)?|creat(?:e|ing)|design(?:ing)?|implement(?:ing)?|add(?:ing)?)\b/i, text: "another thing I want to build" },
    { pattern: /\b(?:understand(?:ing)?|figure\s+out|untangl\w*)\b/i, text: "a problem I am still untangling" }
  ];
  for (const row of rows) {
    const match = row.pattern.exec(source);
    if (!match) continue;
    const nearby = source.slice(Math.max(0, match.index - 32), Math.min(source.length, match.index + match[0].length + 32));
    if (!BRAIN_GENERAL_NEGATION.test(nearby) || /^not\s+working$/i.test(match[0])) return row.text;
  }
  return "";
}

function brainGeneralSpecificSubject(source) {
  const normalized = String(source || "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, " ").slice(0, 6000);
  const clauses = normalized
    .split(/[.!?;\n]+/)
    .flatMap((sentence) => {
      const inherited = {
        sensitive: BRAIN_GENERAL_SENSITIVE.test(sentence) || containsPrivateCoachBlockedTerm(sentence),
        reporting: BRAIN_GENERAL_REPORT.test(sentence),
        privateOrAdversarial: BRAIN_GENERAL_PII.test(sentence) || BRAIN_GENERAL_INJECTION.test(sentence)
      };
      return sentence
        .split(/[,:\u2014\u2013]+|\b(?:and|but|or|while|whereas|although|though|because|then)\b/i)
        .map((text) => ({ text, ...inherited }));
    });
  for (const rawClause of clauses) {
    const clause = rawClause.text.trim();
    if (!clause) continue;
    const sensitive = rawClause.sensitive || BRAIN_GENERAL_SENSITIVE.test(clause) || containsPrivateCoachBlockedTerm(clause);
    const reporting = rawClause.reporting || BRAIN_GENERAL_REPORT.test(clause);
    const privateOrAdversarial = rawClause.privateOrAdversarial || BRAIN_GENERAL_PII.test(clause) || BRAIN_GENERAL_INJECTION.test(clause);
    const subject = BRAIN_GENERAL_SUBJECTS.find((candidate) => candidate.pattern.test(clause));
    if (subject) return sensitive || reporting || privateOrAdversarial || BRAIN_GENERAL_CONTRAST.test(clause)
      ? subject.subject
      : brainGeneralRelation(clause, subject);
    if (!sensitive && !reporting && !privateOrAdversarial) {
      const intent = brainGeneralIntent(clause);
      if (intent) return intent;
    }
  }
  return "";
}

function brainSpecificSubjectFromFile(file, source, topics = []) {
  const research = brainResearchSpecificSubject(source);
  if (research) return research;
  const game = brainGameSpecificSubject(source);
  if (game) return game;
  const app = brainAppSpecificSubject(source);
  if (app) return app;
  const mobility = brainMobilitySpecificSubject(source);
  if (mobility) return mobility;
  const generalSource = [file?.lifeLeverageHighlightText, source].filter(Boolean).join("\n");
  return brainGeneralSpecificSubject(generalSource);
}

function brainSpecificCareRows(subject) {
  const value = String(subject || "").trim();
  if (!value) return [];
  const direct = brainSpecificDirectStatement(value);
  return direct ? [direct] : [];
}

function titleCaseFirst(value) {
  const text = String(value || "").trim();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "";
}

function brainSpecificDirectStatement(subject) {
  const value = String(subject || "").trim().replace(/[.!?]+$/g, "");
  if (!value) return "";
  const exact = new Map([
    ["lining up the research-figure panels and measuring the endpoint angles", "The research-figure panels need to line up, and the endpoint angles need to be measured locally"],
    ["how to line up the research-figure panels", "The research-figure panels need to line up"],
    ["how to measure the endpoint angles on the research figure", "The research-figure endpoint angles need to be measured locally"],
    ["when enemy positions make a dragon call safe in League", "Enemy positions determine whether the dragon call is safe in League"],
    ["how Virtual Violin bow tracking should follow the played string", "Virtual Violin bow tracking should follow the played string"],
    ["how Virtual Violin bow tracking should keep the active string visible", "Virtual Violin bow tracking should keep the active string visible"],
    ["how effortless the little electric bike feels without needing to pedal", "The little electric bike feels effortless without needing to pedal"]
  ]);
  if (exact.has(value)) return exact.get(value);
  let match = /^how cool (.+) (are|is)$/i.exec(value);
  if (match) return `${titleCaseFirst(match[1])} ${match[2].toLowerCase()} cool`;
  match = /^how to get (.+) working properly$/i.exec(value);
  if (match) return `${titleCaseFirst(match[1])} needs to work properly`;
  match = /^how to stop (.+) from clipping$/i.exec(value);
  if (match) return `${titleCaseFirst(match[1])} needs to stop clipping`;
  match = /^how to make (.+) clearer$/i.exec(value);
  if (match) return `${titleCaseFirst(match[1])} needs to be clearer`;
  match = /^how to make (.+) feel simpler$/i.exec(value);
  if (match) return `${titleCaseFirst(match[1])} needs to feel simpler`;
  match = /^how to make (.+) more reliable$/i.exec(value);
  if (match) return `${titleCaseFirst(match[1])} needs to be more reliable`;
  match = /^a choice I am still weighing around (.+)$/i.exec(value);
  if (match) return `${titleCaseFirst(match[1])} still needs a decision`;
  match = /^how (figure\s*\d+[a-z]?) should show (.+)$/i.exec(value);
  if (match) return `${titleCaseFirst(match[1])} should show ${match[2]}`;
  match = /^how to present (.+)$/i.exec(value);
  if (match) return `${titleCaseFirst(match[1])} needs to be presented clearly`;
  return titleCaseFirst(value);
}

function brainSpecificCareText(subject, sourceHash = "") {
  const value = String(subject || "").trim();
  const copies = brainSpecificCareRows(value);
  if (!copies.length) return "";
  return copies[stableIndex(`${sourceHash}|${value}`, copies.length)];
}

function subjectFromBrainSpecificCareText(value) {
  const text = String(value || "").trim();
  return text.match(/^oh, I got distracted thinking about (.+) again$/i)?.[1]
    || text.match(/^my mind just wandered back to (.+)$/i)?.[1]
    || text.match(/^somehow I am thinking about (.+) again$/i)?.[1]
    || "";
}

function migrateSourceSpecificBrainCareText(value, sourceHash = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const wrappedSubject = subjectFromBrainSpecificCareText(text);
  if (wrappedSubject) return brainSpecificCareText(wrappedSubject, sourceHash);
  if (!/^Alan(?:'s)?\b/i.test(text)) {
    const reducedSubject = brainResearchSpecificSubject(text)
      || brainGameSpecificSubject(text)
      || brainAppSpecificSubject(text)
      || brainMobilitySpecificSubject(text)
      || brainGeneralSpecificSubject(text);
    return reducedSubject ? brainSpecificCareText(reducedSubject, sourceHash) : text;
  }
  const legacySubject = text
    .replace(/^Alan(?:'s)? newest Brain thought covers\s+/i, "")
    .replace(/^Alan weighs\s+/i, "")
    .replace(/\s+in Brain, and the same close attention is here with you$/i, "")
    .replace(/, and the same close attention is here with you$/i, "")
    .replace(/^Alan is in Brain thinking through\s+/i, "")
    .trim();
  const subject = brainResearchSpecificSubject(legacySubject)
    || brainGameSpecificSubject(legacySubject)
    || brainAppSpecificSubject(legacySubject)
    || brainMobilitySpecificSubject(legacySubject);
  return subject ? brainSpecificCareText(subject, sourceHash) : "";
}

const BRAIN_THOUGHT_ANCHOR_COPY = Object.freeze({
  "research-apps": Object.freeze([
    "The research problem and the next app idea are both still moving",
    "The research work and another app build are both still in progress"
  ]),
  "research-games": Object.freeze([
    "The research problem and the next game decision are both still moving",
    "The research work and another game tangent are both still in progress"
  ]),
  "apps-games": Object.freeze([
    "The app idea and the next game decision are both still moving",
    "Another app build and another game tangent are both still in progress"
  ]),
  "research-music": Object.freeze([
    "The research problem and music are both still in the day",
    "The research work and music both belong in the honest version of the day"
  ]),
  research: Object.freeze([
    "The research problem still needs to be untangled",
    "The unfinished research tangent is still moving"
  ]),
  apps: Object.freeze([
    "Another app still needs to be built",
    "The unfinished app idea is still moving"
  ]),
  games: Object.freeze([
    "One game decision has turned into a whole tangent",
    "Another game angle is still being worked through"
  ]),
  music: Object.freeze([
    "Music belongs in the day",
    "One music detail has turned into a whole tangent"
  ]),
  photos: Object.freeze([
    "Another photo-and-video detail needs attention",
    "What belongs inside the frame still needs a decision"
  ]),
  cooking: Object.freeze([
    "Another cooking detail is still in the day",
    "Food and cooking belong in the real-life context"
  ]),
  cats: Object.freeze([
    "The cats are part of the day",
    "The cats belong in the larger picture"
  ]),
  french: Object.freeze([
    "French is part of the day",
    "That French detail belongs in the larger picture"
  ]),
  travel: Object.freeze([
    "Travel is still on the horizon",
    "That future trip is still worth building toward"
  ]),
  hydration: Object.freeze([
    "The drinking effort matters beside this number",
    "The hydration work belongs in the real-life context"
  ]),
  protein: Object.freeze([
    "The protein habit matters beside this number",
    "The protein effort belongs in the real-life context"
  ]),
  cycle: Object.freeze([
    "The cycle context belongs beside this result without explaining it away",
    "The cycle detail stays as context, not a judgment"
  ]),
  repair: Object.freeze([
    "That rough patch calls for steadiness beside you",
    "The rough patch deserves support instead of another demand"
  ]),
  mood: Object.freeze([
    "Things felt a little off",
    "The heavier part of the day matters beside the number"
  ]),
  letter: Object.freeze([
    "The unfiltered version belongs in the honest message",
    "The unfinished version belongs here too"
  ])
});

function rotateReusedBrainAnchor(anchor, previousMessages = [], seed = "") {
  if (!anchor || anchor.sourceType !== "brain-thought-anchor") return anchor;
  const priorText = String(previousMessages?.[0]?.personalAnchor?.approvedText || "");
  const subject = anchor.specificity === "source-specific" ? subjectFromBrainSpecificCareText(anchor.text) : "";
  const key = String(anchor.kind || "").replace(/^brain-thought-/, "");
  const rows = anchor.specificity === "source-specific"
    ? (subject ? brainSpecificCareRows(subject) : [anchor.text])
    : (BRAIN_THOUGHT_ANCHOR_COPY[key] || []);
  const alternatives = rows.filter((text) => text && text !== priorText);
  return {
    ...anchor,
    text: alternatives.length
      ? personalAnchorCopy(alternatives, anchor.sourceHash, `${seed}|reuse`)
      : anchor.text,
    cooldownFallback: true
  };
}

function brainThoughtAnchorFromFile(file, options = {}) {
  if (!file?.id) return null;
  const text = String(file.sourceText || file.title || "").trim();
  const createdAt = String(file.sourceCreatedAt || file.createdAt || "");
  const createdTime = Date.parse(createdAt);
  const cutoff = Number(options.cutoff);
  const metadataShell = /^(?:photo|image|video|screenshot|date|file|upload)(?:\s*[-_#]?\s*\d+)?(?:\.[a-z0-9]{2,5})?$/i.test(text)
    || /^\S+\.(?:jpe?g|png|webp|gif|mp4|mov|m4v|webm|pdf)$/i.test(text);
  if (!text || metadataShell || !Number.isFinite(createdTime)) return null;
  if (Number.isFinite(cutoff) && createdTime > cutoff) return null;
  const topics = [
    ["research", /\b(?:research|science|scientists?|papers?|figures?|ph\.?d\.?)\b/i],
    ["apps", /\b(?:apps?|websites?|aolabs|codex|code|coding|build|building|design|designing)\b/i],
    ["games", /\b(?:games?|gaming|gameplay|league|play(?:ing)?\s+(?:a\s+)?game)\b/i],
    ["music", /\b(?:music|songs?|sing|sings|singing|audio|violins?|instruments?)\b/i],
    ["photos", /\b(?:photos?|pictures?|videos?|cameras?|screenshots?)\b/i],
    ["cooking", /\b(?:cook|cooks|cooked|cooking|food|meals?|recipes?)\b/i],
    ["cats", /\b(?:cat|cats|kitten)\b/i],
    ["french", /\bfrench\b/i],
    ["travel", /\b(?:travel|traveling|travelling|trips?|vacations?)\b/i],
    ["hydration", /\b(?:water|drinks?|drinking|hydrate|hydrating|hydration|electrolytes?)\b/i],
    ["protein", /\bproteins?\b/i],
    ["cycle", /\b(?:periods?|cycles?|menstrual|menstruation)\b/i],
    ["repair", /\b(?:conflicts?|fights?|arguments?|repair|repairing|rough\s+patch)\b/i],
    ["mood", /\b(?:moods?|heavy\s+day|rough\s+day|seem\w*\s+off|depress\w*|anxi\w*)\b/i],
    ["letter", /\b(?:letters?|yap\w*|rambl\w*|unfiltered|trust\w*)\b/i]
  ].filter(([, pattern]) => pattern.test(text)).map(([topic]) => topic);
  const pairs = [["research", "apps"], ["research", "games"], ["apps", "games"], ["research", "music"]];
  const pair = pairs.find(([left, right]) => topics.includes(left) && topics.includes(right));
  const kind = pair ? pair.join("-") : topics[0] || "letter";
  const sourceHash = crypto.createHash("sha256").update(text).digest("hex");
  const specificSubject = brainSpecificSubjectFromFile(file, text, topics);
  const specificText = specificSubject
    ? brainSpecificCareText(specificSubject, sourceHash)
    : "";
  return {
    id: String(file.id),
    sourceType: "brain-thought-anchor",
    kind: `brain-thought-${kind}`,
    text: specificText || personalAnchorCopy(BRAIN_THOUGHT_ANCHOR_COPY[kind], sourceHash, options.seed),
    createdAt: new Date(createdTime).toISOString(),
    sourceHash,
    specificity: specificText ? "source-specific" : "safe-generic"
  };
}

function brainFileIsGeneratedNoteRecord(file) {
  return String(file?.kind || "").trim().toLowerCase() === "generated pdf"
    && String(file?.mime || "").trim().toLowerCase() === "application/pdf"
    && /^brain-text-\d{8}-\d{6}\.pdf$/i.test(String(file?.name || "").trim())
    && Boolean(String(file?.generatedNoteLayoutVersion || "").trim());
}

function genericBrainYapIsSafe(text) {
  const source = String(text || "");
  const firstPersonCount = (source.match(/\b(?:i|me|my|mine)\b/gi) || []).length;
  const thirdPersonCount = (source.match(/\b(?:he|him|his|she|her|hers|they|them|their|theirs)\b/gi) || []).length;
  const authoredYap = /\b(?:i|me|my|mine)\b[\s\S]{0,160}\b(?:yap\w*|rambl\w*|random\s+thoughts?|unfiltered\s+thoughts?|talk(?:ing)?\s+too\s+much)\b|\b(?:yap\w*|rambl\w*|random\s+thoughts?|unfiltered\s+thoughts?|talk(?:ing)?\s+too\s+much)\b[\s\S]{0,160}\b(?:i|me|my|mine)\b/i.test(source);
  const unsafeTopic = /\b(?:diagnos\w*|depress\w*|anxi\w*|suicid\w*|self[- ]?harm\w*|sex\w*|horn\w*|ovulat\w*|menstr\w*|period|break(?:up|ing\s+up)|abandon\w*|trauma\w*|abus\w*|medicat\w*|therap\w*|weight|pounds?|calori\w*|starv\w*|purge\w*|vomit\w*)\b/i.test(source);
  const quotedOrThirdPartySource = /\b(?:transcript|speaker\s*\d*|interviewer|quoted?|cop(?:y|ied|ying)|past(?:e|ed|ing))\b/i.test(source);
  const privateThirdPartyFraming = /\b(?:coworker|colleague|manager|boss|client|patient|therapist|doctor|ex(?:es)?|wife|husband|girlfriend|mother|father|mom|dad|sister|brother)\b/i.test(source);
  const rejectsConnection = /\b(?:(?:do|does|did|can|could|would|will)\s*(?:n['’]t|\s+not)|never)\s+(?:really\s+)?(?:want\s+to\s+)?(?:love|trust|share|tell|talk|yap|open\s+up)\b|\b(?:am|is|are|was|were)\s*(?:n['’]t|\s+not)\s+(?:really\s+)?(?:happy|comfortable|safe|glad)\b/i.test(source);
  const firstPersonDominates = firstPersonCount >= 4 && thirdPersonCount <= Math.max(2, Math.floor(firstPersonCount / 4));
  return firstPersonDominates && authoredYap && !unsafeTopic && !quotedOrThirdPartySource && !privateThirdPartyFraming && !rejectsConnection;
}

function referencedBrainLetterIds(messages, excludedWeightId = "") {
  return new Set((Array.isArray(messages) ? messages : [])
    .filter((message) => !excludedWeightId || message?.weightId !== excludedWeightId)
    .flatMap((message) => Array.isArray(message?.evidenceReferences) ? message.evidenceReferences : [])
    .filter((reference) => reference?.type === "brain-letter" && reference.id)
    .map((reference) => reference.id));
}

function brainRelationshipSupportFromFile(file, options = {}) {
  if (!file || typeof file !== "object" || !file.id) return null;
  if (!brainFileIsGeneratedNoteRecord(file)) return null;
  const text = String(file.sourceText || "").trim();
  const createdAt = String(file.sourceCreatedAt || file.createdAt || "");
  const createdTime = Date.parse(createdAt);
  const cutoff = Number(options.cutoff);
  const earliest = Number(options.earliest);
  const operationalNow = Number(options.operationalNow);
  const maxAgeMs = Math.max(1, Number(options.maxAgeMs || BRAIN_RELATIONSHIP_MAX_AGE_MS));
  if (!text || text.length < 200 || !Number.isFinite(createdTime)) return null;
  if (Number.isFinite(earliest) && createdTime < earliest) return null;
  if (Number.isFinite(cutoff) && createdTime > cutoff) return null;
  if (Number.isFinite(operationalNow) && (createdTime > operationalNow || operationalNow - createdTime > maxAgeMs)) return null;

  const sourceHash = crypto.createHash("sha256").update(text).digest("hex");
  const addressedToLily = /\b(?:lily|leelee)\b/i.test(text);
  const boyfriend = /\bboyfriend\b/i.test(text);
  const affection = /\b(?:i\s+love\s+you|love\s+you|loving\s+you)\b/i.test(text);
  const yapping = /\byap\w*\b/i.test(text);
  const phd = /\bph\.?d\.?\b/i.test(text);
  const league = /\bleague\b/i.test(text);
  const happiness = /\bhapp\w*\b/i.test(text);
  const firstPerson = /\b(?:i|me|my|mine)\b/i.test(text);
  const authenticYap = /\b(?:yap\w*|rambl\w*|random\s+thoughts?|unfiltered\s+thoughts?|talk(?:ing)?\s+too\s+much)\b/i.test(text);
  const gameYap = /\b(?:games?|gaming|gameplay|league|play(?:ing)?\s+(?:a\s+)?game)\b/i.test(text);
  const rejectsConnection = /\b(?:(?:do|does|did|can|could|would|will)\s*(?:n['’]t|\s+not)|never)\s+(?:really\s+)?(?:want\s+to\s+)?(?:love|trust|share|tell|talk|yap|open\s+up)\b|\b(?:am|is|are|was|were)\s*(?:n['’]t|\s+not)\s+(?:really\s+)?(?:happy|comfortable|safe|glad)\b/i.test(text);
  let kind = "";
  if (addressedToLily && boyfriend && affection && yapping && happiness && !rejectsConnection) {
    kind = phd && league ? "boyfriend-yap-phd-league" : phd ? "boyfriend-yap-phd" : "boyfriend-yap";
  } else if (firstPerson && authenticYap && genericBrainYapIsSafe(text)) {
    kind = gameYap ? "boyfriend-authentic-game-yap" : "boyfriend-authentic-yap";
  }
  if (!kind) return null;
  return {
    id: String(file.id),
    sourceType: "brain-letter",
    kind,
    text: brainConnectionCopy(kind, sourceHash),
    createdAt: new Date(createdTime).toISOString(),
    sourceHash
  };
}

function resolveBrainApiBase(override, fallback = brainApiBase) {
  return String(override || fallback || "").trim().replace(/\/+$/, "");
}

async function fetchLatestBrainRelationshipSupport(store, options = {}) {
  const apiBase = resolveBrainApiBase(options.apiBase);
  if (!apiBase) return null;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(1, Number(options.timeoutMs || brainRequestTimeoutMs));
  const controller = new AbortController();
  let timeoutId;
  try {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetchImpl(`${apiBase}/api/files`, {
      method: "GET",
      headers: { "Accept": "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      options.onDiagnostic?.({ status: "http-error", statusCode: Number(response.status) || 0 });
      return null;
    }
    const payload = await response.json();
    const files = Array.isArray(payload?.files) ? payload.files : (Array.isArray(payload) ? payload : []);
    const usedIds = referencedBrainLetterIds(store?.coachMessages, options.excludedWeightId);
    const rows = files.slice().sort((left, right) => String(right?.sourceCreatedAt || right?.createdAt || "").localeCompare(String(left?.sourceCreatedAt || left?.createdAt || "")));
    for (const file of rows) {
      if (usedIds.has(String(file?.id || ""))) continue;
      const support = brainRelationshipSupportFromFile(file, options);
      if (support) {
        options.onDiagnostic?.({ status: "selected", sourceId: support.id, sourceKind: support.kind });
        return support;
      }
    }
    options.onDiagnostic?.({ status: "no-eligible-source" });
    return null;
  } catch (error) {
    options.onDiagnostic?.({ status: error?.name === "AbortError" ? "timeout" : "request-error" });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchLatestBrainThoughtAnchor(store, options = {}) {
  const apiBase = resolveBrainApiBase(options.apiBase);
  if (!apiBase) return null;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(1, Number(options.timeoutMs || brainRequestTimeoutMs));
  const controller = new AbortController();
  let timeoutId;
  try {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetchImpl(`${apiBase}/api/files`, {
      method: "GET",
      headers: { "Accept": "application/json" },
      signal: controller.signal
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const files = Array.isArray(payload?.files) ? payload.files : (Array.isArray(payload) ? payload : []);
    const latestWeight = (store?.weights || []).find((weight) => weight.id === options.weightId) || null;
    const previousMessages = causalPreviousCoachMessages(store, latestWeight, COACH_PERSONAL_ANCHOR_COOLDOWN_COUNT);
    const recentKeys = personalAnchorReferenceKeys(previousMessages);
    const thoughtCutoff = Number.isFinite(Number(options.thoughtCutoff)) ? Number(options.thoughtCutoff) : Number(options.cutoff);
    const anchors = files
      .map((file) => brainThoughtAnchorFromFile(file, { ...options, cutoff: thoughtCutoff }))
      .filter(Boolean)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || left.id.localeCompare(right.id));
    const fresh = anchors.find((anchor) => !recentKeys.has(`id:${anchor.id}`) && !recentKeys.has(`semantic:${personalAnchorSemanticKind(anchor.kind)}`));
    if (fresh) return fresh;
    const usageIndex = (anchor) => previousMessages.findIndex((message) => (message.evidenceReferences || []).some((reference) => reference.id === anchor.id));
    const fallback = anchors.slice().sort((left, right) => usageIndex(right) - usageIndex(left)
      || String(right.createdAt).localeCompare(String(left.createdAt))
      || String(left.id).localeCompare(String(right.id)))[0] || null;
    return fallback ? rotateReusedBrainAnchor(fallback, previousMessages, options.weightId || thoughtCutoff) : null;
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchLatestBrainPersonalAnchor(store, options = {}) {
  const apiBase = resolveBrainApiBase(options.apiBase);
  if (!apiBase) return null;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(1, Number(options.timeoutMs || brainRequestTimeoutMs));
  const controller = new AbortController();
  let timeoutId;
  try {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetchImpl(`${apiBase}/api/files`, {
      method: "GET",
      headers: { "Accept": "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      options.onDiagnostic?.({ status: "http-error", statusCode: Number(response.status) || 0 });
      return null;
    }
    const payload = await response.json();
    const files = Array.isArray(payload?.files) ? payload.files : (Array.isArray(payload) ? payload : []);
    const weight = options.weight || (store?.weights || []).find((record) => record.id === options.weightId) || null;
    const previousMessages = causalPreviousCoachMessages(store, weight, COACH_PERSONAL_ANCHOR_COOLDOWN_COUNT);
    const recentKeys = personalAnchorReferenceKeys(previousMessages);
    const usedLetterIds = referencedBrainLetterIds(store?.coachMessages, options.excludedWeightId || options.weightId);
    const rows = files.slice().sort((left, right) => String(right?.sourceCreatedAt || right?.createdAt || "").localeCompare(String(left?.sourceCreatedAt || left?.createdAt || "")));
    const candidates = [];
    for (const file of rows) {
      const support = brainRelationshipSupportFromFile(file, options);
      if (support
        && !usedLetterIds.has(String(file?.id || ""))
        && !recentKeys.has(`id:${support.id}`)
        && !recentKeys.has(`semantic:${personalAnchorSemanticKind(support.kind)}`)
        && (!weight || brainSourceWithinWeightWindow(weight, support, options.operationalNow))) {
        candidates.push(support);
      }
    }
    const thoughtCutoff = Number.isFinite(Number(options.thoughtCutoff)) ? Number(options.thoughtCutoff) : Number(options.cutoff);
    const thoughtAnchors = rows
      .map((file) => brainThoughtAnchorFromFile(file, { ...options, cutoff: thoughtCutoff }))
      .filter(Boolean);
    const freshThoughts = options.preferNewestCurrentThought === true
      ? thoughtAnchors
      : thoughtAnchors.filter((anchor) => !recentKeys.has(`id:${anchor.id}`)
        && !recentKeys.has(`semantic:${personalAnchorSemanticKind(anchor.kind)}`));
    candidates.push(...freshThoughts);
    if (!freshThoughts.length && thoughtAnchors.length) {
      const usageIndex = (anchor) => previousMessages.findIndex((message) => (message.evidenceReferences || []).some((reference) => reference.id === anchor.id));
      const reusable = thoughtAnchors.slice().sort((left, right) => usageIndex(right) - usageIndex(left)
        || String(right.createdAt).localeCompare(String(left.createdAt))
        || String(left.id).localeCompare(String(right.id)))[0];
      if (reusable) candidates.push(rotateReusedBrainAnchor(reusable, previousMessages, options.weightId || thoughtCutoff));
    }
    const sourcePriority = (anchor) => anchor?.specificity === "source-specific"
      ? 3
      : anchor?.sourceType === "brain-letter"
        ? 2
        : 1;
    const selected = candidates
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))
        || sourcePriority(right) - sourcePriority(left)
        || String(left.id).localeCompare(String(right.id)))[0] || null;
    options.onDiagnostic?.(selected
      ? { status: "selected", sourceType: selected.sourceType, sourceId: selected.id, sourceKind: selected.kind }
      : { status: "no-eligible-source" });
    return selected;
  } catch (error) {
    options.onDiagnostic?.({ status: error?.name === "AbortError" ? "timeout" : "request-error" });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function brainRelationshipSupportAvailable(store, support, weightId = "") {
  if (!support?.id) return false;
  return !referencedBrainLetterIds(store?.coachMessages, weightId).has(support.id);
}

function referencedCoachMemoryIds(messages) {
  return new Set((Array.isArray(messages) ? messages : [])
    .flatMap((message) => Array.isArray(message?.evidenceReferences) ? message.evidenceReferences : [])
    .filter((reference) => String(reference?.type || "").startsWith("memory") && reference.id)
    .map((reference) => reference.id));
}

function selectSavedPreference(memories, cutoff, previousMessages = []) {
  const blocked = /\b(?:sex|horn|ovulat|conflict|address|phone|diagnos|clinical|body image|appearance|relationship|fast\w*|starv\w*|purg\w*|vomit\w*|skip\w*\s+meals?|restrict\w*)\b/i;
  const usedMemoryIds = referencedCoachMemoryIds(previousMessages);
  const rows = (Array.isArray(memories) ? memories : [])
    .filter((memory) => memory && memory.kind === "note")
    .filter((memory) => !memory.sourceId && !memory.derivedFact && !memory.factIndex)
    .filter((memory) => !Number.isFinite(cutoff) || !Number.isFinite(Date.parse(memory.createdAt)) || Date.parse(memory.createdAt) <= cutoff)
    .map((memory) => ({ memory, text: String(memory.text || "").trim() }))
    .filter((item) => item.text)
    .sort((left, right) => String(right.memory.updatedAt || right.memory.createdAt || "").localeCompare(String(left.memory.updatedAt || left.memory.createdAt || "")));

  for (const item of rows) {
    const reportedEffort = reportedCoachEffort(item.text);
    const observedCare = observerCareSignal(item.text);
    const createdAt = Date.parse(item.memory.createdAt);
    const ageMs = Number.isFinite(cutoff) && Number.isFinite(createdAt) ? cutoff - createdAt : NaN;
    const transientContext = reportedEffort || observedCare;
    if (transientContext && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= COACH_REACTION_MAX_AGE_MS && !usedMemoryIds.has(item.memory.id)) {
      return {
        id: item.memory.id,
        kind: transientContext.kind,
        transient: true,
        actionId: transientContext.actionId,
        actionSemantic: transientContext.actionSemantic
      };
    }
    if (transientContext || blocked.test(item.text) || containsPrivateCoachBlockedTerm(item.text)) continue;
    const koreanPattern = /\b(?:korean|spicy)\b/i;
    const vegetablePattern = /\b(?:vegetable|veggie)\w*\b/i;
    const fruitPattern = /\b(?:peach|fruit|berries|apple)\w*\b/i;
    const korean = memoryTopicAttribution(item.text, koreanPattern) === "lily" && foodPreferenceSignal(item.text, koreanPattern) > 0;
    const vegetables = memoryTopicAttribution(item.text, vegetablePattern) === "lily" && foodPreferenceSignal(item.text, vegetablePattern) > 0;
    const fruit = memoryTopicAttribution(item.text, fruitPattern) === "lily" && foodPreferenceSignal(item.text, fruitPattern) > 0;
    if (korean && vegetables) {
      return {
        id: item.memory.id,
        kind: "food-preference",
        actionId: "preference-korean-vegetables",
        actionSemantic: "preferred-balanced-meal",
        action: "Make the next meal work harder: keep the Korean flavor and add the vegetables you said you want."
      };
    }
    if (vegetables) {
      return {
        id: item.memory.id,
        kind: "food-preference",
        actionId: "preference-vegetables",
        actionSemantic: "preferred-vegetable-meal",
        action: "Make the next meal count by adding the vegetables you said you want."
      };
    }
    if (korean) {
      return {
        id: item.memory.id,
        kind: "food-preference",
        actionId: "preference-korean",
        actionSemantic: "preferred-balanced-meal",
        action: "Build the next balanced meal around the Korean flavors you already like."
      };
    }
    if (fruit) {
      return {
        id: item.memory.id,
        kind: "food-preference",
        actionId: "preference-fruit",
        actionSemantic: "preferred-planned-snack",
        action: "Choose the fruit you already enjoy for the next planned snack."
      };
    }
  }
  return null;
}

const COACH_ACTION_CATALOG = Object.freeze([
  { id: "balanced-plate", semantic: "balanced-meal", text: "Build the next meal around protein, vegetables, and a satisfying portion." },
  { id: "balanced-plate-alt", semantic: "balanced-meal", text: "Make the next plate protein, vegetables, and satisfying." },
  { id: "easy-walk", semantic: "gentle-movement", text: "Take one comfortable walk after the next meal." },
  { id: "easy-walk-alt", semantic: "gentle-movement", text: "Give yourself one easy walk after eating next." },
  { id: "protein-anchor", semantic: "protein-meal", text: "Anchor the next meal with a satisfying protein and vegetables." },
  { id: "protein-anchor-alt", semantic: "protein-meal", text: "Let protein and vegetables lead the next satisfying meal." },
  { id: "planned-portion", semantic: "portion-plan", text: "Plate one satisfying portion for the next meal." },
  { id: "planned-portion-alt", semantic: "portion-plan", text: "Set one satisfying portion before the next meal begins." },
  { id: "vegetable-add", semantic: "vegetable-meal", text: "Add one vegetable you enjoy to the next meal." },
  { id: "vegetable-add-alt", semantic: "vegetable-meal", text: "Put one enjoyable vegetable into the next meal." },
  { id: "planned-snack", semantic: "snack-plan", text: "Choose one planned snack before hunger makes the decision." },
  { id: "planned-snack-alt", semantic: "snack-plan", text: "Decide on one satisfying snack before you need it." },
  { id: "water-with-meal", semantic: "meal-hydration", text: "Have a glass of water alongside the next meal." },
  { id: "water-with-meal-alt", semantic: "meal-hydration", text: "Pair the next meal with one full glass of water." },
  { id: "repeatable-breakfast", semantic: "repeatable-meal", text: "Choose one balanced breakfast you can repeat tomorrow." },
  { id: "repeatable-breakfast-alt", semantic: "repeatable-meal", text: "Set up one balanced breakfast that works again tomorrow." },
  { id: "simple-balanced-plate", semantic: "simple-balanced-meal", text: "Make the next meal a simple plate with protein, vegetables, and a satisfying portion." },
  { id: "simple-balanced-plate-alt", semantic: "simple-balanced-meal", text: "Keep the next meal simple with protein, vegetables, and a satisfying portion." },
  { id: "same-scale-conditions", semantic: "measurement-confirmation", text: "Repeat the next weigh-in under the same scale conditions." },
  { id: "same-scale-conditions-alt", semantic: "measurement-confirmation", text: "Confirm the number with the same scale setup next time." },
  { id: "steady-scale-check", semantic: "measurement-routine", text: "Use the same scale routine for the next confirming weigh-in." },
  { id: "steady-scale-check-alt", semantic: "measurement-routine", text: "Keep the scale routine identical for the confirming check." },
  { id: "confirm-saved-weight", semantic: "entry-confirmation", text: "Confirm the saved number with one normal follow-up weigh-in." },
  { id: "confirm-saved-weight-alt", semantic: "entry-confirmation", text: "Give this saved number one normal follow-up check." },
  { id: "calm-recheck", semantic: "measurement-pause", text: "Let one normal follow-up weigh-in settle this swing." },
  { id: "calm-recheck-alt", semantic: "measurement-pause", text: "Use one normal follow-up reading to settle this swing." }
]);

const PREFERENCE_ACTIONS = Object.freeze([
  { id: "preference-korean-vegetables", preferenceKey: "preference-korean-vegetables", semantic: "preferred-balanced-meal", text: "Choose one Korean-style vegetable plate for the next meal." },
  { id: "preference-korean-vegetables-alt", preferenceKey: "preference-korean-vegetables", semantic: "preferred-balanced-meal", text: "Make the next meal one Korean-style vegetable plate." },
  { id: "preference-vegetables", preferenceKey: "preference-vegetables", semantic: "preferred-vegetable-meal", text: "Bring the vegetables you wanted into the next meal." },
  { id: "preference-vegetables-alt", preferenceKey: "preference-vegetables", semantic: "preferred-vegetable-meal", text: "Add the vegetables you wanted to the next meal." },
  { id: "preference-korean", preferenceKey: "preference-korean", semantic: "preferred-balanced-meal", text: "Build the next balanced meal with the Korean flavors you like." },
  { id: "preference-korean-alt", preferenceKey: "preference-korean", semantic: "preferred-balanced-meal", text: "Use the Korean flavors you like in the next balanced meal." },
  { id: "preference-fruit", preferenceKey: "preference-fruit", semantic: "preferred-planned-snack", text: "Choose a fruit you enjoy for the next planned snack." },
  { id: "preference-fruit-alt", preferenceKey: "preference-fruit", semantic: "preferred-planned-snack", text: "Make the next planned snack a fruit you enjoy." },
  { id: "reaction-hydration-effort", preferenceKey: "reaction-hydration-effort", semantic: "acknowledged-hydration-effort", text: "Keep the hydration effort you mentioned steady today." },
  { id: "reaction-hydration-effort-alt", preferenceKey: "reaction-hydration-effort", semantic: "acknowledged-hydration-effort", text: "Follow through on the hydration routine you said you are working on." },
  { id: "reaction-vegetable-effort", preferenceKey: "reaction-vegetable-effort", semantic: "acknowledged-vegetable-effort", text: "Keep the vegetable effort you mentioned in the next satisfying meal." },
  { id: "reaction-vegetable-effort-alt", preferenceKey: "reaction-vegetable-effort", semantic: "acknowledged-vegetable-effort", text: "Follow through on the vegetable habit you said you are building." },
  { id: "reaction-protein-effort", preferenceKey: "reaction-protein-effort", semantic: "acknowledged-protein-effort", text: "Keep the protein effort you mentioned in the next satisfying meal." },
  { id: "reaction-protein-effort-alt", preferenceKey: "reaction-protein-effort", semantic: "acknowledged-protein-effort", text: "Follow through on the protein habit you said you are building." },
  { id: "reaction-movement-effort", preferenceKey: "reaction-movement-effort", semantic: "acknowledged-movement-effort", text: "Keep the comfortable movement effort you mentioned going today." },
  { id: "reaction-movement-effort-alt", preferenceKey: "reaction-movement-effort", semantic: "acknowledged-movement-effort", text: "Follow through on the comfortable movement routine you said you are building." },
  { id: "observer-mood-support", preferenceKey: "observer-mood-support", semantic: "noticed-mood-support", text: "Choose one easy, satisfying meal." },
  { id: "observer-mood-support-alt", preferenceKey: "observer-mood-support", semantic: "noticed-mood-support", text: "Keep the next meal easy and satisfying." }
]);

function stableIndex(value, length) {
  if (!length) return 0;
  const hash = crypto.createHash("sha256").update(String(value || "")).digest();
  return hash.readUInt32BE(0) % length;
}

function causalPreviousCoachMessages(store, currentWeight, limit = 10) {
  if (!currentWeight) return [];
  const allWeights = Array.isArray(store?.weights) ? store.weights : [];
  const currentIndex = allWeights.findIndex((weight) => weight.id === currentWeight.id);
  const cutoff = Date.parse(currentWeight.createdAt);
  const weights = allWeights
    .map((weight, sourceIndex) => ({ weight, sourceIndex, time: Date.parse(weight.createdAt) }))
    .filter((entry) => entry.weight.id !== currentWeight.id && Number.isFinite(entry.time) && (entry.time < cutoff || (entry.time === cutoff && entry.sourceIndex < currentIndex)))
    .sort((left, right) => right.time - left.time || right.sourceIndex - left.sourceIndex)
    .map((entry) => entry.weight);
  return weights.map((weight) => coachForWeight(store, weight.id)).filter(Boolean).slice(0, limit);
}

function inferActionMetadata(message) {
  if (!message) return null;
  if (message.actionId && message.actionSemantic) {
    return { id: message.actionId, semantic: message.actionSemantic, text: message.actionText || "" };
  }
  const text = String(message.text || "");
  return [...PREFERENCE_ACTIONS, ...COACH_ACTION_CATALOG].find((action) => text.includes(action.text)) || null;
}

function rotateCandidates(rows, seed) {
  if (!rows.length) return [];
  const start = stableIndex(seed, rows.length);
  return rows.slice(start).concat(rows.slice(0, start));
}

function selectCoachAction(store, currentWeight, preference, outlier, recentConflict) {
  const recentForDiversity = causalPreviousCoachMessages(store, currentWeight, 5).map(inferActionMetadata).filter(Boolean);
  const recent = recentForDiversity.slice(0, COACH_COOLDOWN_COUNT);
  const usedIds = new Set(recent.map((action) => action.id));
  const usedSemantics = new Set(recent.map((action) => action.semantic));
  const usedTexts = new Set(recent.map((action) => action.text).filter(Boolean));
  const diversityIds = new Set(recentForDiversity.map((action) => action.id));
  const diversitySemantics = new Set(recentForDiversity.map((action) => action.semantic));
  const diversityTexts = new Set(recentForDiversity.map((action) => action.text).filter(Boolean));
  const allActions = [...PREFERENCE_ACTIONS, ...COACH_ACTION_CATALOG];
  const familyKey = (action) => action.preferenceKey ? `preference:${action.preferenceKey}` : `semantic:${action.semantic}`;
  const families = new Map();
  for (const action of allActions) {
    const key = familyKey(action);
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(action);
  }
  let contextualKeys = [];
  if (outlier) {
    contextualKeys = ["measurement-confirmation", "measurement-routine", "entry-confirmation", "measurement-pause"].map((semantic) => `semantic:${semantic}`);
  } else if (recentConflict) {
    contextualKeys = ["semantic:simple-balanced-meal"];
  } else if (preference) {
    contextualKeys = [`preference:${preference.actionId}`];
  }
  const generalKeys = Array.from(families.keys()).filter((key) => {
    if (!key.startsWith("semantic:")) return false;
    const semantic = key.slice("semantic:".length);
    return !semantic.startsWith("measurement-") && semantic !== "entry-confirmation" && semantic !== "simple-balanced-meal";
  });
  const normalizedTime = Number.isFinite(Date.parse(currentWeight?.createdAt)) ? new Date(currentWeight.createdAt).toISOString() : "unknown-time";
  const causalSeed = `${normalizedTime}|${trimCoachNumber(weightInPounds(currentWeight))}|${outlier ? "outlier" : "ordinary"}|${recentConflict ? "recent-conflict" : "no-conflict"}|${preference?.actionId || "no-preference"}`;
  const orderedKeys = [
    ...rotateCandidates(Array.from(new Set(contextualKeys)), `${causalSeed}|contextual-family`),
    ...rotateCandidates(generalKeys.filter((key) => !contextualKeys.includes(key)), `${causalSeed}|general-family`)
  ];
  const familyCandidates = orderedKeys
    .map((key) => ({ key, rows: families.get(key) || [] }))
    .filter((family) => family.rows.length >= 2);
  const selectedFamily = familyCandidates.find((family) => !diversitySemantics.has(family.rows[0].semantic))
    || familyCandidates.find((family) => !usedSemantics.has(family.rows[0].semantic))
    || familyCandidates[0]
    || { key: "semantic:balanced-meal", rows: COACH_ACTION_CATALOG.filter((action) => action.semantic === "balanced-meal") };
  const realizations = rotateCandidates(selectedFamily.rows, `${causalSeed}|realization`);
  const selected = realizations.find((action) => !diversityIds.has(action.id) && !diversityTexts.has(action.text))
    || realizations.find((action) => !usedIds.has(action.id) && !usedTexts.has(action.text))
    || realizations[0];
  return {
    ...selected,
    realizations: realizations.map((action) => ({ id: action.id, text: action.text })),
    preferenceId: preference && selected.preferenceKey === preference.actionId ? preference.id : null,
    recentActionIds: recent.map((action) => action.id),
    recentActionSemantics: recent.map((action) => action.semantic),
    recentActionTexts: recent.map((action) => action.text).filter(Boolean)
  };
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

function movementMap(points) {
  return {
    days3: robustWindowMovement(points, 3),
    days7: robustWindowMovement(points, 7),
    days14: robustWindowMovement(points, 14),
    days28: robustWindowMovement(points, 28)
  };
}

function finiteMovement(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : NaN;
}

function strongestChangingEvidence(movements, latestDailyChange = 0) {
  const rows = [3, 7, 14, 28]
    .map((windowDays) => ({ windowDays, movement: finiteMovement(movements?.[`days${windowDays}`]) }))
    .filter((row) => Number.isFinite(row.movement) && Math.abs(row.movement) >= 0.05)
    .sort((left, right) => Math.abs(right.movement) - Math.abs(left.movement) || left.windowDays - right.windowDays);
  const selected = rows[0];
  if (selected) {
    return {
      kind: "window-movement",
      windowDays: selected.windowDays,
      movement: selected.movement,
      direction: selected.movement < 0 ? "down" : "up"
    };
  }
  return {
    kind: "daily-change",
    windowDays: 1,
    movement: Number(latestDailyChange) || 0,
    direction: Math.abs(Number(latestDailyChange) || 0) < 0.05 ? "flat" : latestDailyChange < 0 ? "down" : "up"
  };
}

function selectStrongestCoachEvidence({ points, movements, previousMovements, latestDailyChange, outlier, streak }) {
  if (!Array.isArray(points) || points.length <= 1) {
    return { kind: "baseline", windowDays: null, movement: 0, direction: "flat", relationKind: "new" };
  }
  if (outlier) {
    return { kind: "outlier", windowDays: 1, movement: latestDailyChange, direction: latestDailyChange < 0 ? "down" : "up", relationKind: "new" };
  }
  const windowRows = [3, 7, 14, 28].map((windowDays) => {
    const current = finiteMovement(movements?.[`days${windowDays}`]);
    const previous = finiteMovement(previousMovements?.[`days${windowDays}`]);
    const magnitudeChange = Number.isFinite(current) && Number.isFinite(previous) ? Math.abs(current) - Math.abs(previous) : NaN;
    return { windowDays, current, previous, magnitudeChange };
  });
  const short = windowRows.find((row) => row.windowDays === 3);
  const broad = windowRows.slice().reverse().find((row) => Number.isFinite(row.current) && Math.abs(row.current) >= 0.3);
  const correctiveShortBroadTurn = latestDailyChange <= -0.5
    && short && broad
    && Number.isFinite(short.current) && short.current <= -0.3
    && Number.isFinite(short.previous) && short.previous >= 0.05
    && broad.current >= 0.3;
  if (correctiveShortBroadTurn) {
    return {
      kind: "short-broad-contrast",
      windowDays: 3,
      movement: short.current,
      direction: short.current < 0 ? "down" : "up",
      comparisonWindowDays: broad.windowDays,
      comparisonMovement: broad.current,
      relationKind: "contrasts"
    };
  }
  if (streak?.reversal) {
    return { kind: "reversal", windowDays: 1, movement: latestDailyChange, direction: latestDailyChange < 0 ? "down" : "up", relationKind: "reversed" };
  }
  if (streak?.count >= 3 && Math.abs(streak.movement) >= 0.3) {
    return { kind: "streak", windowDays: null, movement: streak.movement, direction: streak.direction, count: streak.count, relationKind: "strengthened" };
  }
  const changing = windowRows
    .filter((row) => Number.isFinite(row.current) && Number.isFinite(row.previous) && Math.abs(row.current) >= 0.3 && Math.abs(row.magnitudeChange) >= 0.15)
    .sort((left, right) => Math.abs(right.magnitudeChange) - Math.abs(left.magnitudeChange) || left.windowDays - right.windowDays)[0];
  if (changing) {
    const relation = evidenceRelation(
      { movement: changing.current },
      { movement: changing.previous }
    );
    return {
      kind: changing.magnitudeChange >= 0 ? "window-acceleration" : "window-easing",
      windowDays: changing.windowDays,
      movement: changing.current,
      previousMovement: changing.previous,
      direction: changing.current < 0 ? "down" : "up",
      relationKind: relation.kind
    };
  }

  if (short && broad && Number.isFinite(short.current) && Math.abs(short.current) >= 0.3 && Math.sign(short.current) !== Math.sign(broad.current)) {
    return {
      kind: "short-broad-contrast",
      windowDays: 3,
      movement: short.current,
      direction: short.current < 0 ? "down" : "up",
      comparisonWindowDays: broad.windowDays,
      comparisonMovement: broad.current,
      relationKind: "contrasts"
    };
  }

  const robust = strongestChangingEvidence(movements, latestDailyChange);
  return robust;
}

function evidenceRelation(current, previous) {
  if (!previous) return { kind: "new", phrase: "new versus the prior context" };
  const currentSign = Math.abs(current.movement) < 0.05 ? 0 : Math.sign(current.movement);
  const previousSign = Math.abs(previous.movement) < 0.05 ? 0 : Math.sign(previous.movement);
  if (currentSign && previousSign && currentSign !== previousSign) return { kind: "reversed", phrase: "reversed from the prior context" };
  if (Math.abs(current.movement) > Math.abs(previous.movement) + 0.05) return { kind: "strengthened", phrase: "stronger than the prior context" };
  if (Math.abs(current.movement) + 0.05 < Math.abs(previous.movement)) return { kind: "eased", phrase: "easier than the prior context" };
  return { kind: "held", phrase: "similar to the prior context" };
}

function coachBobaRewardState(store, currentWeight, causalRows = [], options = {}) {
  const persisted = normalizeBobaRewardState(store?.bobaReward);
  const currentTime = Date.parse(currentWeight?.createdAt);
  if (!persisted || !Number.isFinite(currentTime)) return null;
  const latestWeight = latestWeightRecord(store);
  const isLatestWeight = latestWeight?.id === currentWeight.id;
  const requestedOperationalNow = Number(options.operationalNow);
  const operationalNow = Number.isFinite(requestedOperationalNow) ? requestedOperationalNow : Date.now();
  const asOf = isLatestWeight ? Math.max(currentTime, operationalNow) : currentTime;
  const currentDateKey = trackerDateKey(asOf);
  if (!currentDateKey || currentDateKey < persisted.baselineDateKey) return null;
  const causalWeightIds = new Set((Array.isArray(causalRows) ? causalRows : []).map((record) => String(record?.id || "")).filter(Boolean));
  const causalRewardState = {
    ...persisted,
    earnedThresholds: isLatestWeight ? persisted.earnedThresholds : persisted.earnedThresholds.filter((entry) => (
      entry.weightId ? causalWeightIds.has(String(entry.weightId)) : Date.parse(entry.earnedAt) <= currentTime
    ))
  };
  const rewardWeights = isLatestWeight ? (Array.isArray(store?.weights) ? store.weights : causalRows) : causalRows;
  const result = calculateBobaRewardState(rewardWeights, causalRewardState, {
    asOf,
    weightId: currentWeight.id,
    timeZone: trackerTimeZone
  });
  if (!result || !Number.isFinite(Number(result.currentSevenDayAverageLb))) return null;
  const earnedForWeightId = Math.max(0, Number(result.earnedForWeightId) || 0);
  return {
    baselineAverageLb: Number(result.baselineAverageLb),
    baselineAverageDisplayLb: Number(result.baselineAverageDisplayLb),
    currentSevenDayAverageLb: Number(result.currentSevenDayAverageLb),
    currentSevenDayAverageDisplayLb: Number(result.currentSevenDayAverageDisplayLb),
    nextThresholdLb: Number(result.nextThresholdLb),
    nextThresholdDisplayLb: Number(result.nextThresholdDisplayLb),
    poundsToNextBobaLb: Number(result.poundsToNextBobaLb),
    poundsToNextBobaDisplayLb: Number(result.poundsToNextBobaDisplayLb),
    observedDayCount: Number(result.observedDayCount) || 0,
    earnedCount: Math.max(0, Number(result.earnedCount) || 0),
    earnedForWeightId,
    latestEarnedThreshold: result.latestEarnedThreshold ? {
      level: Number(result.latestEarnedThreshold.level),
      thresholdLb: Number(result.latestEarnedThreshold.thresholdLb),
      weightId: result.latestEarnedThreshold.weightId ? String(result.latestEarnedThreshold.weightId) : null
    } : null
  };
}

function buildAnalysisPlan(context) {
  const evidence = context.strongestEvidence;
  return {
    version: COACH_ANALYSIS_VERSION,
    communicationStyle: COACH_STYLE_VERSION,
    verdict: context.verdict,
    current: {
      weight: Number(trimCoachNumber(context.currentWeight)),
      change: Number(trimCoachNumber(context.latestDailyChange)),
      direction: context.changeDirection
    },
    strongestEvidence: {
      kind: evidence.kind,
      windowDays: evidence.windowDays,
      movement: Number(trimCoachNumber(evidence.movement)),
      direction: evidence.direction,
      previousMovement: Number.isFinite(evidence.previousMovement) ? Number(trimCoachNumber(evidence.previousMovement)) : null,
      count: Number.isFinite(evidence.count) ? evidence.count : null,
      comparisonWindowDays: Number.isFinite(evidence.comparisonWindowDays) ? evidence.comparisonWindowDays : null,
      comparisonMovement: Number.isFinite(evidence.comparisonMovement) ? Number(trimCoachNumber(evidence.comparisonMovement)) : null
    },
    relationToPrior: context.evidenceRelation.kind,
    outlook: context.includeOutlook ? {
      weight: Number(context.outlook.toFixed(1)),
      roundedWeight: Math.round(context.outlook),
      change: Number(context.outlookChange.toFixed(3)),
      direction: context.outlookDirection,
      relationToEvidence: context.outlookEvidenceRelation
    } : null,
    action: {
      semantic: context.actionSemantic,
      approvedRealizations: context.actionRealizations.map((realization) => ({ id: realization.id, text: realization.text }))
    },
    bobaReward: context.bobaReward ? {
      currentSevenDayAverageLb: context.bobaReward.currentSevenDayAverageDisplayLb,
      nextThresholdLb: context.bobaReward.nextThresholdDisplayLb,
      poundsToNextBobaLb: context.bobaReward.poundsToNextBobaDisplayLb,
      earnedCount: context.bobaReward.earnedCount,
      earnedForWeightId: context.bobaReward.earnedForWeightId,
      earnedThresholdLb: context.bobaReward.earnedForWeightId > 0
        ? Number(Number(context.bobaReward.latestEarnedThreshold?.thresholdLb).toFixed(1))
        : null
    } : null,
    savedContext: context.preference ? {
      kind: context.preference.kind,
      transient: context.preference.transient === true
    } : null,
    personalAnchor: context.relationshipSupport ? {
      sourceType: context.relationshipSupport.sourceType,
      kind: context.relationshipSupport.kind
    } : null,
    relationshipSupport: context.relationshipSupport ? { kind: context.relationshipSupport.kind } : null
  };
}

function buildCoachContext(store, weightId, options = {}) {
  const { current, rows, points } = causalWeightRows(store, weightId);
  if (!current || !points.length) return null;
  const latestPoint = points[points.length - 1];
  const previousPoint = points.length > 1 ? points[points.length - 2] : null;
  const currentTime = Date.parse(current.createdAt);
  const history = weightForecast.buildOneYearHistory(points);
  const outlookPoint = history[history.length - 1] || null;
  const previousOutlookPoint = history.length > 1 ? history[history.length - 2] : null;
  const outlook = Number(outlookPoint && outlookPoint.weight);
  const previousOutlook = previousOutlookPoint ? Number(previousOutlookPoint.weight) : NaN;
  const outlookChange = Number.isFinite(outlook) && Number.isFinite(previousOutlook) ? outlook - previousOutlook : 0;
  const latestDailyChange = previousPoint ? latestPoint.weight - previousPoint.weight : 0;
  const dateKey = trackerDateKey(currentTime);
  const includePersonalContext = options.includePersonalContext === true;
  const requestedPersonalContextCutoff = Number(options.personalContextCutoff);
  const personalContextCutoff = Number.isFinite(requestedPersonalContextCutoff) ? requestedPersonalContextCutoff : currentTime;
  const trackerModifier = includePersonalContext ? selectTrackerModifier(store.trackerEvents, dateKey) : null;
  const recentConflict = includePersonalContext ? selectRecentConflict(store.trackerEvents, dateKey) : null;
  const causalCoachHistory = includePersonalContext
    ? causalPreviousCoachMessages(store, current, Math.max(10, (store.weights || []).length))
    : [];
  const preference = includePersonalContext ? selectSavedPreference(store.memories, personalContextCutoff, causalCoachHistory) : null;
  const suppliedPersonalAnchor = includePersonalContext && options.relationshipSupport?.id && options.relationshipSupport?.text
    ? (() => {
      const sourceType = String(options.relationshipSupport.sourceType || "brain-letter");
      const sourceHash = String(options.relationshipSupport.sourceHash || "");
      const specificity = String(options.relationshipSupport.specificity || "");
      const originalText = String(options.relationshipSupport.text);
      const text = sourceType === "brain-thought-anchor" && specificity === "source-specific"
        ? (migrateSourceSpecificBrainCareText(originalText, sourceHash)
          || personalAnchorCopy(
            BRAIN_THOUGHT_ANCHOR_COPY[String(options.relationshipSupport.kind || "").replace(/^brain-thought-/, "")] || BRAIN_THOUGHT_ANCHOR_COPY.letter,
            sourceHash,
            String(options.relationshipSupport.kind || "")
          ))
        : originalText;
      return {
        id: String(options.relationshipSupport.id),
        sourceType,
        kind: String(options.relationshipSupport.kind || "boyfriend-yap"),
        text,
        createdAt: String(options.relationshipSupport.createdAt || ""),
        sourceHash,
        specificity,
        cooldownFallback: options.relationshipSupport.cooldownFallback === true
      };
    })()
    : null;
  const selectedMemoryAnchor = includePersonalContext
    ? selectLilyPersonalAnchor(store.memories, personalContextCutoff, causalCoachHistory, `${new Date(currentTime).toISOString()}|${trimCoachNumber(weightInPounds(current))}`)
    : null;
  const relationshipSupport = suppliedPersonalAnchor
    || selectedMemoryAnchor
    || (includePersonalContext ? selectCarriedPersonalAnchor(store, current, causalCoachHistory) : null);
  const outlier = isWeightOutlier(points);
  const streak = recentWeightStreak(points);
  const movements = movementMap(points);
  const previousPoints = points.slice(0, -1);
  const previousMovements = previousPoints.length ? movementMap(previousPoints) : null;
  const previousStreak = previousPoints.length ? recentWeightStreak(previousPoints) : null;
  const strongestEvidence = selectStrongestCoachEvidence({
    points,
    movements,
    previousMovements,
    latestDailyChange,
    outlier,
    streak
  });
  const previousEvidenceMovement = ["window-acceleration", "window-easing", "window-movement", "short-broad-contrast"].includes(strongestEvidence.kind)
    ? finiteMovement(previousMovements?.[`days${strongestEvidence.windowDays}`])
    : strongestEvidence.kind === "streak"
      ? finiteMovement(previousStreak?.movement)
      : (previousPoints.length > 1 ? previousPoints.at(-1).weight - previousPoints.at(-2).weight : NaN);
  const previousEvidence = Number.isFinite(previousEvidenceMovement) ? {
    kind: strongestEvidence.kind,
    windowDays: strongestEvidence.windowDays,
    movement: previousEvidenceMovement,
    direction: Math.abs(previousEvidenceMovement) < 0.05 ? "flat" : previousEvidenceMovement < 0 ? "down" : "up"
  } : null;
  const computedRelation = evidenceRelation(strongestEvidence, previousEvidence);
  const relationKind = strongestEvidence.relationKind || computedRelation.kind;
  const relation = {
    kind: relationKind,
    phrase: {
      strengthened: "stronger than the prior context",
      eased: "weaker than the prior context",
      reversed: "reversed from the prior context",
      contrasts: "contrasts with the broader context",
      held: "similar to the prior context",
      new: "new versus the prior context"
    }[relationKind] || computedRelation.phrase
  };
  const outlookDirection = outlookChange > 0.05 ? "worsened" : outlookChange < -0.05 ? "improved" : "held";
  const priorOutlookChange = history.length > 2 ? history.at(-2).weight - history.at(-3).weight : 0;
  const priorOutlookDirection = priorOutlookChange > 0.05 ? "worsened" : priorOutlookChange < -0.05 ? "improved" : "held";
  const evidenceBad = strongestEvidence.direction === "up";
  const evidenceGood = strongestEvidence.direction === "down";
  const outlookReinforces = (evidenceBad && outlookDirection === "worsened") || (evidenceGood && outlookDirection === "improved");
  const outlookContradicts = (evidenceBad && outlookDirection === "improved") || (evidenceGood && outlookDirection === "worsened");
  const outlookDirectionFlip = priorOutlookDirection !== "held" && outlookDirection !== "held" && priorOutlookDirection !== outlookDirection;
  const includeOutlook = Math.abs(outlookChange) >= 0.5 || outlookDirectionFlip || outlookReinforces || outlookContradicts;
  const changeDirection = latestDailyChange > 0.05 ? "up" : latestDailyChange < -0.05 ? "down" : "unchanged";
  let verdict = "not-good-enough";
  if (points.length === 1) verdict = "baseline";
  else if (outlier) verdict = "verify";
  else if (changeDirection === "down") verdict = "good-progress";

  const actionPreference = preference?.id && preference.id === relationshipSupport?.id ? null : preference;
  const actionSelection = selectCoachAction(store, current, actionPreference, outlier, recentConflict);
  const bobaReward = coachBobaRewardState(store, current, rows, { operationalNow: options.operationalNow });
  const selectedPreference = actionSelection.preferenceId ? actionPreference : null;
  const comparisonWindowDays = Number.isFinite(strongestEvidence.comparisonWindowDays) ? strongestEvidence.comparisonWindowDays : 0;
  const selectedWindowDays = Math.max(Number(strongestEvidence.windowDays) || 0, comparisonWindowDays);
  const selectedEvidenceStartDay = strongestEvidence.kind === "streak" && Number.isFinite(strongestEvidence.count)
    ? points[Math.max(0, points.length - strongestEvidence.count)]?.day
    : selectedWindowDays > 1
      ? latestPoint.day - selectedWindowDays
      : null;
  const directReferenceIds = new Set([current.id, rows.length > 1 ? rows[rows.length - 2].id : null].filter(Boolean));
  const selectedEvidenceReferences = Number.isFinite(selectedEvidenceStartDay)
    ? rows
      .filter((record) => {
        const day = weightForecast.calendarDay(Date.parse(record.createdAt));
        return Number.isFinite(day) && day >= selectedEvidenceStartDay && day <= latestPoint.day && !directReferenceIds.has(record.id);
      })
      .map((record) => ({ type: "weight", id: record.id, role: "selected-evidence-window" }))
    : [];
  const evidenceReferences = [
    { type: "weight", id: current.id, role: "current" },
    ...(rows.length > 1 ? [{ type: "weight", id: rows[rows.length - 2].id, role: "comparison" }] : []),
    ...selectedEvidenceReferences,
    ...(trackerModifier ? [{ type: "tracker", id: trackerModifier.id, role: trackerModifier.type }] : []),
    ...(recentConflict ? [{ type: "tracker", id: recentConflict.id, role: "recent-conflict" }] : []),
    ...(selectedPreference ? [{ type: "memory", id: selectedPreference.id, role: selectedPreference.kind }] : []),
    ...(relationshipSupport ? [{
      type: relationshipSupport.sourceType || "brain-letter",
      id: relationshipSupport.id,
      role: relationshipSupport.kind,
      sourceHash: relationshipSupport.sourceHash,
      sourceCreatedAt: relationshipSupport.createdAt
    }] : [])
  ];
  const privateGoal = Object.prototype.hasOwnProperty.call(options, "privateGoal") ? Number(options.privateGoal) : privateCoachGoal;
  const context = {
    weightId: current.id,
    measurementAt: new Date(currentTime).toISOString(),
    currentWeight: weightInPounds(current),
    latestDailyWeight: latestPoint.weight,
    previousDailyWeight: previousPoint ? previousPoint.weight : null,
    latestDailyChange,
    changeDirection,
    streak,
    reversal: streak.reversal,
    outlier,
    movements,
    strongestEvidence,
    previousStrongestEvidence: previousEvidence,
    evidenceRelation: relation,
    outlook,
    previousOutlook: Number.isFinite(previousOutlook) ? previousOutlook : outlook,
    outlookChange,
    outlookDirection,
    previousOutlookDirection: priorOutlookDirection,
    includeOutlook,
    outlookEvidenceRelation: outlookReinforces ? "reinforces" : outlookContradicts ? "contradicts" : outlookDirectionFlip ? "direction-flip" : "material-movement",
    verdict,
    trackerModifier,
    personalAnchor: relationshipSupport,
    personalAnchorRequired: false,
    relationshipSupport,
    preference: selectedPreference ? { id: selectedPreference.id, kind: selectedPreference.kind, transient: selectedPreference.transient === true } : null,
    action: actionSelection.text,
    actionId: actionSelection.id,
    actionSemantic: actionSelection.semantic,
    actionRealizations: actionSelection.realizations,
    bobaReward,
    recentActionIds: actionSelection.recentActionIds,
    recentActionSemantics: actionSelection.recentActionSemantics,
    recentActionTexts: actionSelection.recentActionTexts,
    evidenceReferences,
    hiddenStrategy: hiddenStrategyState(privateGoal, weightInPounds(current)),
    communicationStyle: COACH_STYLE_VERSION,
    forecastFingerprint: history.map((point) => ({ day: point.day, weight: point.weight, outlookTargetWeight: point.outlookTargetWeight }))
  };
  context.analysisPlan = buildAnalysisPlan(context);
  context.contextHash = crypto.createHash("sha256").update(JSON.stringify(context)).digest("hex");
  return context;
}

function deterministicCurrentWeightClause(context) {
  const current = trimCoachNumber(context.currentWeight);
  if (context.previousDailyWeight === null || !Number.isFinite(Number(context.previousDailyWeight))) {
    return `${current} lb today has no earlier daily reading for comparison`;
  }
  const change = Math.abs(Number(context.latestDailyChange) || 0);
  if (change < 0.05) return `${current} lb today, unchanged from the previous daily reading`;
  return `${current} lb today, ${context.changeDirection} ${trimCoachNumber(change)} lb from the previous daily reading`;
}

function deterministicSevenDayClause(context) {
  const rawMovement = context?.movements?.days7;
  const movement = rawMovement === null || rawMovement === undefined ? NaN : Number(rawMovement);
  if (!Number.isFinite(movement)) return "and there is not enough history for a seven-day pattern yet";
  if (Math.abs(movement) < 0.05) return "and seven-day movement is steady";
  const direction = movement < 0 ? "down" : "up";
  const immediateDirection = context.changeDirection === "unchanged" ? "flat" : context.changeDirection;
  const connector = immediateDirection !== "flat" && immediateDirection !== direction ? "while" : "and";
  const qualifier = connector === "and" ? " also" : "";
  return `${connector} seven-day movement is${qualifier} ${direction} ${trimCoachNumber(Math.abs(movement))} lb`;
}

function deterministicCoachClosing(context) {
  if (Number(context?.bobaReward?.earnedForWeightId) > 0) return "A boba is earned—enjoy it!";
  if (context?.verdict === "good-progress") return "That progress is worth celebrating.";
  if (context?.verdict === "verify") return "One unusual reading does not deserve a verdict.";
  if (context?.verdict === "baseline") return "A clear start is enough for today.";
  return "One result does not define the week.";
}

function composeDeterministicCoachMemo(context) {
  if (!context) throw new Error("coach context is required");
  const current = deterministicCurrentWeightClause(context);
  const sevenDay = deterministicSevenDayClause(context);
  const factSentence = `${current}, ${sevenDay}.`;
  const actionSentence = String(context.action || "").trim();
  const closingSentence = deterministicCoachClosing(context);
  const text = normalizeCoachParagraph(`${factSentence} ${actionSentence} ${closingSentence}`);
  const action = identifyApprovedAction(text, context) || {
    id: context.actionId,
    semantic: context.actionSemantic,
    text: context.action
  };
  const validation = validateDeterministicCoachMemo(text, context, action);
  if (!validation.ok) {
    throw new Error(`deterministic coach memo failed: ${validation.errors.join(", ")}`);
  }
  return {
    text,
    status: "deterministic",
    structureId: "essential-v1",
    action,
    errors: [],
    wordCount: validation.wordCount,
    diagnostics: generationDiagnostics("deterministic", 0, [], Date.now())
  };
}

function validateDeterministicCoachMemo(text, context, selectedAction = null) {
  const paragraph = normalizeCoachParagraph(text);
  const errors = [];
  const wordCount = coachWordCount(paragraph);
  const sentenceCount = coachSentenceScopes(paragraph).length;
  if (/\r|\n/.test(String(text || ""))) errors.push("multiline");
  if (wordCount < COACH_MIN_WORDS || wordCount > COACH_MAX_WORDS) errors.push("word-count");
  if (sentenceCount < 2 || sentenceCount > 3) errors.push("sentence-count");
  if (!context || !paragraph.includes(`${trimCoachNumber(context.currentWeight)} lb`)) errors.push("current-weight");
  if (!/seven-day/i.test(paragraph)) errors.push("seven-day-read");
  const rawSevenDayMovement = context?.movements?.days7;
  const sevenDayMovement = rawSevenDayMovement === null || rawSevenDayMovement === undefined ? NaN : Number(rawSevenDayMovement);
  if (Number.isFinite(sevenDayMovement) && Math.abs(sevenDayMovement) >= 0.05
    && !paragraph.includes(`${trimCoachNumber(Math.abs(sevenDayMovement))} lb`)) errors.push("seven-day-value");
  if (context?.previousDailyWeight !== null && Number.isFinite(Number(context?.previousDailyWeight))) {
    const dailyChange = Math.abs(Number(context.latestDailyChange) || 0);
    if (dailyChange >= 0.05 && !paragraph.includes(`${trimCoachNumber(dailyChange)} lb`)) errors.push("daily-change");
  } else if (!/no earlier daily reading/i.test(paragraph)) {
    errors.push("baseline-change");
  }
  const action = selectedAction || identifyApprovedAction(paragraph, context);
  const recognizedActions = recognizedActionMatches(paragraph);
  const recognizedActionCount = recognizedActions.reduce((sum, entry) => sum + entry.occurrences, 0);
  if (!action || recognizedActionCount !== 1) errors.push(recognizedActionCount > 1 ? "multiple-actions" : "required-action-realization");
  if (/\b(?:anyway|story|signal|slogan|metaphor)\b|\b(?:weight|trend|data|progress)\s+line\b/i.test(paragraph)) errors.push("artificial-copy");
  if (/^(?:good sign|biggest watchout|best move|recommendation|main concern|next|action|reason|blunt read|honest read|improvement)\s*:/i.test(paragraph)) errors.push("role-prefix");
  if (/\b(?:Alan|Brain|saved (?:entry|thought|note|memory)|source (?:entry|thought|note|memory)|my mind|my thoughts?|got distracted|wandered back|thinking about)\b/i.test(paragraph)) errors.push("personal-source-label");
  if (/\b(?:obese|fat|lazy|disgusting|worthless|fasting|starv\w*|skip(?:ping)? meals?|purge|compensat\w*|punish\w*|restrict\w*|diagnos\w*|suicid\w*|self[- ]?harm\w*)\b/i.test(paragraph)
    || containsPrivateCoachBlockedTerm(paragraph)) errors.push("unsafe-language");
  if ((paragraph.match(/!/g) || []).length > 1 || /!{2,}/.test(paragraph)) errors.push("exclamation-overload");
  return { ok: errors.length === 0, errors: Array.from(new Set(errors)), text: paragraph, wordCount, action };
}

function countLiteralOccurrences(text, needle) {
  if (!needle) return 0;
  return String(text || "").toLowerCase().split(String(needle).toLowerCase()).length - 1;
}

function recognizedActionMatches(text) {
  return [...PREFERENCE_ACTIONS, ...COACH_ACTION_CATALOG]
    .map((action) => ({ ...action, occurrences: countLiteralOccurrences(text, action.text) }))
    .filter((action) => action.occurrences > 0);
}

function identifyApprovedAction(text, context) {
  const approved = Array.isArray(context?.actionRealizations) ? context.actionRealizations : [];
  const approvedMatches = approved
    .map((realization) => ({ ...realization, semantic: context.actionSemantic, occurrences: countLiteralOccurrences(text, realization.text) }))
    .filter((realization) => realization.occurrences > 0);
  const recognizedMatches = recognizedActionMatches(text);
  const totalApprovedOccurrences = approvedMatches.reduce((sum, realization) => sum + realization.occurrences, 0);
  const totalRecognizedOccurrences = recognizedMatches.reduce((sum, realization) => sum + realization.occurrences, 0);
  if (approvedMatches.length !== 1 || totalApprovedOccurrences !== 1 || totalRecognizedOccurrences !== 1) return null;
  return { id: approvedMatches[0].id, semantic: context.actionSemantic, text: approvedMatches[0].text };
}


function buildContextualFallbackCandidates(context) {
  return [composeDeterministicCoachMemo(context)];
}

function buildContextualFallbackResult(context) {
  return composeDeterministicCoachMemo(context);
}

function buildContextualFallback(context) {
  return composeDeterministicCoachMemo(context).text;
}

function coachSentenceScopes(text) {
  return String(text || "")
    .split(/(?:[!?]+|(?<!\d)\.(?!\d))/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function validateCoachParagraph(text, context) {
  return validateDeterministicCoachMemo(text, context);
}


function safeDiagnosticCode(value, fallback = "unknown") {
  const code = String(value || fallback).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return code || fallback;
}


function generationDiagnostics(stage, attemptCount, rejectionCodes, startedAt, extras = {}) {
  return {
    stage: safeDiagnosticCode(stage),
    attemptCount: Math.max(0, Number(attemptCount) || 0),
    rejectionCodes: Array.from(new Set((rejectionCodes || []).map((code) => safeDiagnosticCode(code)))).slice(0, 20),
    latencyMs: Math.max(0, Date.now() - startedAt),
    ...extras
  };
}

function coachGenerationInputHash(context) {
  const support = context?.relationshipSupport || null;
  return crypto.createHash("sha256").update(JSON.stringify({
    pipelineVersion: COACH_GENERATION_VERSION,
    analysisVersion: COACH_ANALYSIS_VERSION,
    validatorVersion: COACH_VALIDATOR_VERSION,
    weightId: context?.weightId || "",
    measurementAt: context?.measurementAt || "",
    analysisPlan: context?.analysisPlan || null,
    trackerModifier: context?.trackerModifier || null,
    relationshipSupport: support ? {
      id: support.id,
      sourceType: support.sourceType,
      kind: support.kind,
      createdAt: support.createdAt,
      sourceHash: support.sourceHash || crypto.createHash("sha256").update(String(support.text || "")).digest("hex")
    } : null,
    communicationStyle: context?.communicationStyle || ""
  })).digest("hex");
}

function sanitizeGenerationDiagnostics(value) {
  if (!value || typeof value !== "object") return null;
  const sanitized = {
    stage: safeDiagnosticCode(value.stage),
    attemptCount: Math.max(0, Number(value.attemptCount) || 0),
    rejectionCodes: Array.from(new Set((Array.isArray(value.rejectionCodes) ? value.rejectionCodes : []).map((code) => safeDiagnosticCode(code)))).slice(0, 20),
    latencyMs: Math.max(0, Number(value.latencyMs) || 0)
  };
  for (const key of ["candidateCount", "validCandidateCount"]) {
    if (Number.isFinite(Number(value[key]))) sanitized[key] = Math.max(0, Number(value[key]));
  }
  return sanitized;
}

function mergedGenerationDiagnostics(existing, context, value) {
  const current = sanitizeGenerationDiagnostics(value);
  if (!current || current.attemptCount <= 0 || !existing) return current;
  const nextInputHash = coachGenerationInputHash(context);
  const sameInput = existing.generationInputHash
    ? existing.generationInputHash === nextInputHash
    : existing.contextHash === context?.contextHash;
  if (!sameInput) return current;
  const prior = sanitizeGenerationDiagnostics(existing.diagnostics);
  if (!prior) return current;
  return {
    ...current,
    attemptCount: Math.min(99, prior.attemptCount + current.attemptCount),
    rejectionCodes: Array.from(new Set([...(prior.rejectionCodes || []), ...(current.rejectionCodes || [])])).slice(0, 20)
  };
}

function fingerprintMetadata(text, context, previousMessages = []) {
  const normalized = normalizeCoachParagraph(text).normalize("NFKC").toLowerCase();
  return {
    normalizedFingerprint: normalized,
    fingerprintHash: crypto.createHash("sha256").update(normalized).digest("hex"),
    argumentFingerprint: "",
    nearestPriorMessageId: null,
    nearestPriorSimilarity: null
  };
}

function sanitizePersonalAnchor(anchor) {
  if (!anchor?.id || !anchor?.text || !anchor?.kind) return null;
  return {
    sourceType: String(anchor.sourceType || "memory-personal-anchor"),
    id: String(anchor.id),
    sourceTimestamp: String(anchor.createdAt || ""),
    sourceHash: String(anchor.sourceHash || ""),
    semanticAnchorId: String(anchor.kind),
    approvedText: String(anchor.text),
    specificity: String(anchor.specificity || "")
  };
}

function personalAnchorFromCoachRecord(message) {
  const anchor = message?.personalAnchor;
  if (!anchor?.id || !anchor?.approvedText || !anchor?.semanticAnchorId) return null;
  const sourceType = String(anchor.sourceType || "memory-personal-anchor");
  const kind = String(anchor.semanticAnchorId);
  const sourceHash = String(anchor.sourceHash || "");
  let approvedText = String(anchor.approvedText);
  if (sourceType === "brain-thought-anchor") {
    approvedText = anchor.specificity === "source-specific"
      ? migrateSourceSpecificBrainCareText(approvedText, sourceHash)
      : "";
    if (!approvedText) {
      const thoughtKind = kind.replace(/^brain-thought-/, "");
      const allowedRows = BRAIN_THOUGHT_ANCHOR_COPY[thoughtKind] || BRAIN_THOUGHT_ANCHOR_COPY.letter;
      approvedText = (Array.isArray(allowedRows) ? allowedRows : [allowedRows]).includes(String(anchor.approvedText))
        ? String(anchor.approvedText)
        : personalAnchorCopy(allowedRows, sourceHash, kind);
    }
  } else if (sourceType === "brain-letter") {
    const allowedRows = BRAIN_RELATIONSHIP_COPY[kind] || BRAIN_RELATIONSHIP_COPY["boyfriend-yap"];
    approvedText = (Array.isArray(allowedRows) ? allowedRows : [allowedRows]).includes(String(anchor.approvedText))
      ? String(anchor.approvedText)
      : brainConnectionCopy(kind, sourceHash) || brainConnectionCopy("boyfriend-yap", sourceHash);
  } else if (sourceType === "memory-personal-anchor") {
    const allowedRows = kind.startsWith("sender-")
      ? senderMemoryAnchorRows(kind)
      : (LILY_PERSONAL_ANCHOR_COPY[kind] || LILY_PERSONAL_ANCHOR_COPY["lily-authentic-voice"]);
    approvedText = (Array.isArray(allowedRows) ? allowedRows : [allowedRows]).includes(String(anchor.approvedText))
      ? String(anchor.approvedText)
      : kind.startsWith("sender-")
        ? senderMemoryAnchorCopy(kind, sourceHash, kind)
        : personalAnchorCopy(allowedRows, sourceHash, kind);
  }
  return {
    sourceType,
    id: String(anchor.id),
    createdAt: String(anchor.sourceTimestamp || ""),
    sourceHash,
    kind,
    text: approvedText,
    specificity: String(anchor.specificity || "")
  };
}

function mergedAcceptedCopyHistory(existing, nextText, context = null) {
  const prior = Array.isArray(existing?.acceptedCopyHistory)
    ? existing.acceptedCopyHistory.filter((entry) => entry && typeof entry === "object")
    : [];
  const changed = existing?.text && normalizeCoachParagraph(existing.text) !== normalizeCoachParagraph(nextText);
  const previousText = normalizeCoachParagraph(existing?.text || "").normalize("NFKC").toLowerCase();
  const previous = changed && previousText ? {
    normalizedFingerprint: previousText,
    fingerprintHash: crypto.createHash("sha256").update(previousText).digest("hex")
  } : null;
  const rows = previous ? [previous, ...prior] : prior;
  const seen = new Set();
  return rows.filter((entry) => {
    const key = String(entry.fingerprintHash || entry.normalizedFingerprint || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12).map((entry) => ({
    normalizedFingerprint: String(entry.normalizedFingerprint || ""),
    fingerprintHash: String(entry.fingerprintHash || "")
  }));
}

async function generateCoachParagraph(context) {
  return composeDeterministicCoachMemo(context);
}

function createCoachMessageRecord(context, text, status, now = new Date().toISOString(), existing = null, metadata = {}) {
  const selectedAction = metadata.action || identifyApprovedAction(text, context) || {
    id: context.actionId,
    semantic: context.actionSemantic,
    text: context.action
  };
  const fingerprint = fingerprintMetadata(text, context, metadata.previousMessages || []);
  return {
    id: existing?.id || createId("coach"),
    weightId: context.weightId,
    text: normalizeCoachParagraph(text),
    verdict: context.verdict,
    evidenceReferences: context.evidenceReferences,
    contextHash: context.contextHash,
    generationInputHash: coachGenerationInputHash(context),
    generationVersion: COACH_GENERATION_VERSION,
    analysisVersion: COACH_ANALYSIS_VERSION,
    validatorVersion: COACH_VALIDATOR_VERSION,
    fallbackVersion: COACH_FALLBACK_VERSION,
    actionVersion: COACH_ACTION_VERSION,
    safetyVersion: COACH_SAFETY_VERSION,
    styleVersion: COACH_STYLE_VERSION,
    actionId: selectedAction.id,
    actionSemantic: selectedAction.semantic,
    actionText: selectedAction.text,
    composerStructureId: metadata.structureId || "essential-v1",
    analysisPlan: context.analysisPlan,
    personalAnchor: sanitizePersonalAnchor(context.personalAnchor),
    acceptedCopyHistory: mergedAcceptedCopyHistory(existing, text, context),
    diagnostics: mergedGenerationDiagnostics(existing, context, metadata.diagnostics),
    ...fingerprint,
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
  if (!message || String(message.status || "").startsWith("pending-")) return null;
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
  const currentWeight = (store.weights || []).find((weight) => weight.id === weightId);
  const previousMessages = causalPreviousCoachMessages(store, currentWeight, 10);
  const fallback = buildContextualFallbackResult(context, previousMessages);
  const record = createCoachMessageRecord(context, fallback.text, status, new Date().toISOString(), null, {
    action: fallback.action,
    structureId: fallback.structureId,
    previousMessages,
    diagnostics: generationDiagnostics("fallback-created", 0, [], Date.now())
  });
  return { ...store, coachMessages: [record, ...(Array.isArray(store.coachMessages) ? store.coachMessages : [])] };
}

function addPendingCoachForWeight(store, weightId, status = COACH_PENDING_STATUS) {
  if (coachForWeight(store, weightId)) return store;
  const context = buildCoachContext(store, weightId);
  if (!context) return store;
  const text = `${trimCoachNumber(context.currentWeight)} lb is safely saved. The full evidence-first coaching paragraph is still being prepared, so no verdict is being forced from an incomplete read. The measurement is secure, and the finished message will replace this automatically.`;
  const record = createCoachMessageRecord(context, text, status, new Date().toISOString(), null, {
    structureId: "pending-contextual-repair",
    previousMessages: causalPreviousCoachMessages(store, (store.weights || []).find((weight) => weight.id === weightId), 10),
    diagnostics: generationDiagnostics("pending-contextual-repair", 0, ["fallback-unavailable"], Date.now())
  });
  return { ...store, coachMessages: [record, ...(Array.isArray(store.coachMessages) ? store.coachMessages : [])] };
}

function addEmergencyCoachForWeight(store, weightId, status = "fallback-emergency-analysis") {
  const currentWeight = (store.weights || []).find((weight) => weight.id === weightId);
  if (!currentWeight) return store;
  const context = buildCoachContext(store, weightId, {
    includePersonalContext: false,
    privateGoal: privateCoachGoal
  });
  if (!context) return store;
  const existing = coachForWeight(store, weightId);
  const causalPrevious = causalPreviousCoachMessages(store, currentWeight, 10);
  let fallback;
  try {
    fallback = buildContextualFallbackResult(context, causalPrevious);
  } catch (error) {
    fallback = buildContextualFallbackResult(context, []);
  }
  const replacement = createCoachMessageRecord(context, fallback.text, status, new Date().toISOString(), existing, {
    action: fallback.action,
    structureId: fallback.structureId,
    previousMessages: causalPrevious,
    diagnostics: generationDiagnostics("emergency-analysis", 0, [], Date.now())
  });
  return {
    ...store,
    coachMessages: [
      replacement,
      ...(Array.isArray(store.coachMessages) ? store.coachMessages : [])
        .filter((message) => message.id !== existing?.id && message.weightId !== weightId)
    ]
  };
}

function ensurePublicCoachForWeight(store, weightId) {
  if (publicCoach(coachForWeight(store, weightId))) return store;
  let next = store;
  try {
    next = addFallbackCoachForWeight(next, weightId, "fallback-contextual");
  } catch (error) {
    console.warn("Lily coach contextual fallback repair failed", String(error?.name || "error"));
  }
  if (publicCoach(coachForWeight(next, weightId))) return next;
  return addEmergencyCoachForWeight(next, weightId);
}

function coachNeedsRepair(message) {
  const status = String(message?.status || "");
  if (message && (
    message.styleVersion !== COACH_STYLE_VERSION
    || message.analysisVersion !== COACH_ANALYSIS_VERSION
    || message.validatorVersion !== COACH_VALIDATOR_VERSION
    || message.fallbackVersion !== COACH_FALLBACK_VERSION
  )) return true;
  if (status.startsWith("pending-")) return true;
  return false;
}

function canonicalCoachBobaRewardFacts(value) {
  if (!value || typeof value !== "object") return null;
  const currentAverage = Number(value.currentSevenDayAverageDisplayLb ?? value.currentSevenDayAverageLb);
  const nextThreshold = Number(value.nextThresholdDisplayLb ?? value.nextThresholdLb);
  const poundsRemaining = Number(value.poundsToNextBobaDisplayLb ?? value.poundsToNextBobaLb);
  if (![currentAverage, nextThreshold, poundsRemaining].every(Number.isFinite)) return null;
  const earnedForWeightId = Math.max(0, Math.floor(Number(value.earnedForWeightId) || 0));
  const rawEarnedThreshold = value.earnedThresholdLb ?? value.latestEarnedThreshold?.thresholdLb;
  const earnedThreshold = earnedForWeightId > 0 && Number.isFinite(Number(rawEarnedThreshold))
    ? Number(Number(rawEarnedThreshold).toFixed(1))
    : null;
  return {
    currentSevenDayAverageLb: Number(currentAverage.toFixed(1)),
    nextThresholdLb: Number(nextThreshold.toFixed(1)),
    poundsToNextBobaLb: Number(poundsRemaining.toFixed(1)),
    earnedCount: Math.max(0, Math.floor(Number(value.earnedCount) || 0)),
    earnedForWeightId,
    earnedThresholdLb: earnedThreshold
  };
}

function coachBobaRewardNeedsRepair(message, currentReward) {
  const persistedFacts = canonicalCoachBobaRewardFacts(message?.analysisPlan?.bobaReward);
  const currentFacts = canonicalCoachBobaRewardFacts(currentReward);
  return JSON.stringify(persistedFacts) !== JSON.stringify(currentFacts);
}

async function persistWeightWithRecoverableCoach(created, options = {}) {
  const persist = options.persist || writeStore;
  const attachFallback = options.attachFallback || addFallbackCoachForWeight;
  const reportFallbackError = options.reportFallbackError || ((error) => {
    console.warn("Lily coach fallback creation failed", String(error?.name || "error"));
  });
  let savedStore = await persist((store) => reconcileBobaRewardInStore({
    ...store,
    weights: [created, ...(Array.isArray(store.weights) ? store.weights : [])]
  }, {
    asOf: created.createdAt,
    allowAwards: true,
    earnedAt: created.createdAt,
    weightId: created.id
  }));
  try {
    savedStore = await persist((store) => attachFallback(store, created.id, "fallback-contextual"));
  } catch (error) {
    reportFallbackError(error);
  }
  if (!coachForWeight(savedStore, created.id)) {
    try {
      savedStore = await persist((store) => addPendingCoachForWeight(store, created.id));
    } catch (pendingError) {
      reportFallbackError(pendingError);
    }
  }
  if (!publicCoach(coachForWeight(savedStore, created.id))) {
    try {
      savedStore = await persist((store) => ensurePublicCoachForWeight(store, created.id));
    } catch (emergencyError) {
      reportFallbackError(emergencyError);
    }
  }
  return savedStore;
}

function refreshLatestWeightOnlyCoach(store, status) {
  const latestWeight = (Array.isArray(store.weights) ? store.weights : [])
    .slice()
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
  if (!latestWeight) return store;
  const context = buildCoachContext(store, latestWeight.id, { includePersonalContext: false, privateGoal: privateCoachGoal });
  if (!context) return store;
  const existing = coachForWeight(store, latestWeight.id);
  const previousMessages = causalPreviousCoachMessages(store, latestWeight, 10);
  const memo = composeDeterministicCoachMemo(context);
  const replacement = createCoachMessageRecord(context, memo.text, status || "deterministic-refresh", new Date().toISOString(), existing, {
    action: memo.action,
    structureId: memo.structureId,
    previousMessages,
    diagnostics: memo.diagnostics
  });
  return {
    ...store,
    coachMessages: [replacement, ...(Array.isArray(store.coachMessages) ? store.coachMessages : []).filter((message) => message.id !== existing?.id)]
  };
}

function refreshIfLatestCoachReferences(store, referenceType, referenceId, status = "fallback-weight-only-context-removed") {
  const latest = latestCoachPayload(store);
  const latestRecord = latest ? coachForWeight(store, latest.weightId) : null;
  const wasReferenced = latestRecord?.evidenceReferences?.some((reference) => {
    const typeMatches = reference.type === referenceType
      || (referenceType === "memory" && String(reference.type || "").startsWith("memory-"));
    return typeMatches && reference.id === referenceId;
  });
  return wasReferenced ? refreshLatestWeightOnlyCoach(store, status) : store;
}

function refreshLatestCoachForSavedMemories(store) {
  const latestWeight = latestWeightRecord(store);
  return {
    store,
    updated: false,
    weightId: latestWeight?.id || null,
    latestCoach: publicCoach(latestWeight ? coachForWeight(store, latestWeight.id) : null)
  };
}

function refreshLatestCoachForBrainRelationship(store) {
  const latestWeight = latestWeightRecord(store);
  const existing = latestWeight ? coachForWeight(store, latestWeight.id) : null;
  return {
    store,
    updated: false,
    alreadyCurrent: false,
    weightId: latestWeight?.id || "",
    latestCoach: publicCoach(existing)
  };
}

function latestWeightRecord(store) {
  return (Array.isArray(store?.weights) ? store.weights : [])
    .slice()
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || String(right.id).localeCompare(String(left.id)))[0] || null;
}

function brainSourceWithinWeightWindow(weight, relationshipSupport, operationalNow = Date.now()) {
  const weightTime = Date.parse(weight?.createdAt);
  const supportTime = Date.parse(relationshipSupport?.createdAt);
  const now = Number(operationalNow);
  return Number.isFinite(weightTime)
    && Number.isFinite(supportTime)
    && Number.isFinite(now)
    && supportTime >= weightTime - BRAIN_WEIGHT_CONTEXT_LOOKBACK_MS
    && supportTime <= weightTime + BRAIN_WEIGHT_INDEX_GRACE_MS
    && supportTime <= now
    && now - supportTime <= BRAIN_RELATIONSHIP_MAX_AGE_MS;
}

async function reconcileLatestCoachBrainContext(options = {}) {
  const store = await readStore();
  const latestWeight = latestWeightRecord(store);
  return {
    updated: false,
    status: "personal-context-optional",
    weightId: latestWeight?.id || ""
  };
}

function scheduleBrainContextReconciliation() {
  return false;
}

function scheduleCoachGeneration(weightId, operationalNow = Date.now(), options = {}) {
  const id = String(weightId || "");
  if (!id) return false;
  const previousAttempt = coachGenerationLastAttemptAtByWeight.get(id) || 0;
  if (operationalNow - previousAttempt < 60 * 1000) return false;
  coachGenerationLastAttemptAtByWeight.set(id, operationalNow);
  const schedule = options.schedule || setImmediate;
  const generate = options.generate || generateAndReplaceCoach;
  schedule(() => {
    Promise.resolve(generate(id, { timeoutMs: Math.max(1, Number(options.timeoutMs || coachBackgroundGenerationTimeoutMs)) }))
      .catch((error) => console.warn("Lily coach generation or repair failed", String(error?.name || "error")));
  });
  return true;
}

function jsonHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function coachRefreshPreservationSnapshot(store, targetWeightId = "") {
  const weights = Array.isArray(store.weights) ? store.weights : [];
  const memories = Array.isArray(store.memories) ? store.memories : [];
  const trackerEvents = Array.isArray(store.trackerEvents) ? store.trackerEvents : [];
  const chats = Array.isArray(store.chats) ? store.chats : [];
  const coachMessages = Array.isArray(store.coachMessages) ? store.coachMessages : [];
  const latestWeight = weights
    .slice()
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || String(right.id).localeCompare(String(left.id)))[0] || null;
  const weightId = targetWeightId || latestWeight?.id || "";
  const targetCoaches = coachMessages.filter((message) => message.weightId === weightId);
  const targetCoach = coachForWeight(store, weightId);
  return {
    counts: {
      weights: weights.length,
      coachMessages: coachMessages.length,
      memories: memories.length,
      trackerEvents: trackerEvents.length,
      chats: chats.length
    },
    latestWeightId: latestWeight?.id || "",
    targetWeightId: weightId,
    targetCoachCount: targetCoaches.length,
    targetCoachId: targetCoach?.id || "",
    targetCoachCreatedAt: targetCoach?.createdAt || "",
    weightsHash: jsonHash(weights),
    bobaRewardHash: jsonHash(store.bobaReward || null),
    memoriesHash: jsonHash(memories),
    trackerEventsHash: jsonHash(trackerEvents),
    chatsHash: jsonHash(chats),
    otherCoachMessagesHash: jsonHash(coachMessages.filter((message) => message.weightId !== weightId))
  };
}

function assertCoachRefreshPreserved(before, after) {
  const fields = [
    "latestWeightId",
    "targetWeightId",
    "targetCoachCount",
    "targetCoachId",
    "targetCoachCreatedAt",
    "weightsHash",
    "bobaRewardHash",
    "memoriesHash",
    "trackerEventsHash",
    "chatsHash",
    "otherCoachMessagesHash"
  ];
  const changed = fields.filter((field) => before?.[field] !== after?.[field]);
  if (JSON.stringify(before?.counts) !== JSON.stringify(after?.counts)) changed.push("counts");
  if (changed.length) {
    throw Object.assign(new Error(`Coach refresh preservation check failed: ${changed.join(", ")}.`), { status: 409 });
  }
  return true;
}

function assertExpectedCoachRefreshState(snapshot, expected = {}, expectedCoach = {}) {
  const requiredCounts = ["weights", "coachMessages", "memories", "trackerEvents"];
  if (!requiredCounts.every((key) => Number.isInteger(expected[key]) && expected[key] >= 0)) {
    throw Object.assign(new Error("Exact expected weights, coachMessages, memories, and trackerEvents counts are required."), { status: 400 });
  }
  const mismatches = requiredCounts.filter((key) => snapshot.counts[key] !== expected[key]);
  if (mismatches.length) {
    throw Object.assign(new Error(`Coach refresh state changed: ${mismatches.join(", ")}.`), { status: 409 });
  }
  if (!expectedCoach.id || !expectedCoach.createdAt) {
    throw Object.assign(new Error("The expected latest coach id and createdAt are required."), { status: 400 });
  }
  if (snapshot.targetCoachId !== expectedCoach.id || snapshot.targetCoachCreatedAt !== expectedCoach.createdAt) {
    throw Object.assign(new Error("The latest coach identity changed; refresh was not applied."), { status: 409 });
  }
  if (snapshot.latestWeightId !== snapshot.targetWeightId || snapshot.targetCoachCount !== 1) {
    throw Object.assign(new Error("The latest weight must have exactly one coach record before refresh."), { status: 409 });
  }
  return true;
}

function latestCoachPersonalContextCutoff(store, coach) {
  const memoryIds = new Set((coach?.evidenceReferences || [])
    .filter((reference) => reference?.type === "memory" && reference.id)
    .map((reference) => reference.id));
  const timestamps = (store.memories || [])
    .filter((memory) => memoryIds.has(memory.id))
    .map((memory) => Date.parse(memory.createdAt))
    .filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : NaN;
}

function refreshLatestCoachStyleInStore(store, status = "fallback-style-refresh", now = Date.now(), options = {}) {
  const snapshot = coachRefreshPreservationSnapshot(store);
  const latestWeight = (store.weights || []).find((weight) => weight.id === snapshot.latestWeightId);
  const existing = coachForWeight(store, snapshot.latestWeightId);
  if (!latestWeight || !existing) return { store, updated: false, alreadyCurrent: false, weightId: snapshot.latestWeightId, personalContextCutoff: NaN };
  if (existing.styleVersion === COACH_STYLE_VERSION && options.force !== true) {
    return { store, updated: false, alreadyCurrent: true, weightId: latestWeight.id, personalContextCutoff: latestCoachPersonalContextCutoff(store, existing) };
  }
  const personalContextCutoff = latestCoachPersonalContextCutoff(store, existing);
  const context = buildCoachContext(store, latestWeight.id, {
    includePersonalContext: false,
    operationalNow: now
  });
  if (!context) return { store, updated: false, alreadyCurrent: false, weightId: latestWeight.id, personalContextCutoff };
  const previousMessages = causalPreviousCoachMessages(store, latestWeight, 10);
  const memo = composeDeterministicCoachMemo(context);
  const replacement = createCoachMessageRecord(context, memo.text, status || "deterministic-style-refresh", new Date(now).toISOString(), existing, {
    action: memo.action,
    structureId: memo.structureId,
    previousMessages,
    diagnostics: memo.diagnostics
  });
  return {
    store: {
      ...store,
      coachMessages: [replacement, ...(store.coachMessages || []).filter((message) => message.id !== existing.id && message.weightId !== latestWeight.id)]
    },
    updated: true,
    alreadyCurrent: false,
    weightId: latestWeight.id,
    personalContextCutoff,
    personalAnchor: null
  };
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
  const currentWeight = (snapshot.weights || []).find((weight) => weight.id === weightId);
  if (!currentWeight) return null;
  let saved = null;
  await writeStore((store) => {
    const weightStillExists = (store.weights || []).some((weight) => weight.id === weightId);
    if (!weightStillExists) return store;
    const context = buildCoachContext(store, weightId, {
      includePersonalContext: false,
      privateGoal: Object.prototype.hasOwnProperty.call(options, "privateGoal") ? options.privateGoal : privateCoachGoal,
      operationalNow: options.operationalNow
    });
    if (!context) return store;
    const existing = coachForWeight(store, weightId);
    const previousMessages = causalPreviousCoachMessages(store, currentWeight, 10);
    const memo = composeDeterministicCoachMemo(context);
    saved = createCoachMessageRecord(
      context,
      memo.text,
      options.status || "deterministic-refreshed",
      new Date().toISOString(),
      existing,
      {
        action: memo.action,
        structureId: memo.structureId,
        previousMessages,
        diagnostics: memo.diagnostics
      }
    );
    return {
      ...store,
      coachMessages: [saved, ...(store.coachMessages || []).filter((message) => message.id !== existing?.id && message.weightId !== weightId)]
    };
  });
  return publicCoach(saved);
}

async function regenerateRecentCoachMessages(options = {}) {
  const count = Math.min(5, Math.max(1, Number(options.count) || 5));
  const initial = await readStore();
  const targets = (initial.weights || [])
    .slice()
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || String(right.id).localeCompare(String(left.id)))
    .slice(0, count)
    .reverse()
    .map((weight) => weight.id);
  const outcomes = [];
  for (const weightId of targets) {
    await generateAndReplaceCoach(weightId, { ...options, status: "deterministic-regenerated" });
    const latest = await readStore();
    outcomes.push({ weightId, status: coachForWeight(latest, weightId)?.status || "missing" });
  }
  return outcomes;
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
    reportedNextPeriodDateKey: validTrackerDateKey(event.reportedNextPeriodDateKey),
    reportedNextHighDesireDateKey: validTrackerDateKey(event.reportedNextHighDesireDateKey),
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
    "reportedNextPeriodDateKey",
    "reportedNextHighDesireDateKey",
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
  if (normalized.reportedNextPeriodDateKey && normalized.reportedNextPeriodDateKey <= periodStartDateKey) {
    return { error: "The reported next period must be after the saved period start." };
  }
  if (normalized.reportedNextHighDesireDateKey && normalized.reportedNextHighDesireDateKey <= periodStartDateKey) {
    return { error: "The reported high-desire date must be after the saved period start." };
  }
  if (
    normalized.reportedNextPeriodDateKey
    && normalized.reportedNextHighDesireDateKey
    && normalized.reportedNextHighDesireDateKey < normalized.reportedNextPeriodDateKey
  ) {
    return { error: "The reported high-desire date cannot be before the reported next period." };
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

function latestReportedTrackerForecast(periodEvents) {
  return (Array.isArray(periodEvents) ? periodEvents : [])
    .filter((event) => event.reportedNextPeriodDateKey || event.reportedNextHighDesireDateKey)
    .sort((a, b) => (
      String(b.dateKey || "").localeCompare(String(a.dateKey || ""))
      || String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))
      || String(b.id || "").localeCompare(String(a.id || ""))
    ))[0] || null;
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
  const measuredCycle = estimatePeriodCycle(periods);
  const reportedForecast = latestReportedTrackerForecast(periods);
  const reportedNextPeriodDateKey = validTrackerDateKey(reportedForecast?.reportedNextPeriodDateKey);
  const reportedNextHighDesireDateKey = validTrackerDateKey(reportedForecast?.reportedNextHighDesireDateKey);
  const reportedCycleDays = reportedForecast && reportedNextPeriodDateKey
    ? daysBetweenDateKeys(reportedForecast.dateKey, reportedNextPeriodDateKey)
    : NaN;
  const hasReportedCycle = Number.isFinite(reportedCycleDays) && reportedCycleDays >= 15 && reportedCycleDays <= 60;
  const reportedPeriodStillUpcoming = latestPeriod
    && reportedForecast
    && latestPeriod.id === reportedForecast.id
    && reportedNextPeriodDateKey
    && reportedNextPeriodDateKey > latestPeriod.dateKey;
  const cycle = hasReportedCycle && reportedPeriodStillUpcoming
    ? {
        days: Math.round(reportedCycleDays),
        basis: "reported upcoming period date",
        sampleCount: periods.length,
        intervalCount: measuredCycle.intervalCount
      }
    : measuredCycle;
  const nextPeriodDateKey = reportedPeriodStillUpcoming
    ? reportedNextPeriodDateKey
    : latestPeriod
      ? addDaysToDateKey(latestPeriod.dateKey, cycle.days)
      : "";
  const rawDaysUntilNextPeriod = nextPeriodDateKey ? daysBetweenDateKeys(todayKey, nextPeriodDateKey) : null;
  const periodOverdueDays = Number.isFinite(rawDaysUntilNextPeriod) && rawDaysUntilNextPeriod < 0 ? Math.abs(rawDaysUntilNextPeriod) : 0;
  const reportedNextHighDesireOffsetDays = reportedNextPeriodDateKey && reportedNextHighDesireDateKey
    ? daysBetweenDateKeys(reportedNextPeriodDateKey, reportedNextHighDesireDateKey)
    : NaN;
  const confirmedHighDesireAnchor = reportedForecast && reportedNextHighDesireDateKey
    ? periods.find((event) => (
        event.dateKey > reportedForecast.dateKey
        && event.dateKey <= reportedNextHighDesireDateKey
      )) || null
    : null;
  const confirmedCycleHighDesireOffsetDays = confirmedHighDesireAnchor
    ? daysBetweenDateKeys(confirmedHighDesireAnchor.dateKey, reportedNextHighDesireDateKey)
    : NaN;
  const historicalHighDesireOffsetDays = latestPeriod && latestPeriod.reportedHighDesireDateKey
    ? daysBetweenDateKeys(latestPeriod.dateKey, latestPeriod.reportedHighDesireDateKey)
    : NaN;
  const highDesireOffsetDays = Number.isFinite(confirmedCycleHighDesireOffsetDays) && confirmedCycleHighDesireOffsetDays >= 0
    ? confirmedCycleHighDesireOffsetDays
    : Number.isFinite(reportedNextHighDesireOffsetDays) && reportedNextHighDesireOffsetDays >= 0
      ? reportedNextHighDesireOffsetDays
      : historicalHighDesireOffsetDays;
  let nextHighDesireDateKey = "";
  const reportedHighDesireStillUpcoming = reportedNextHighDesireDateKey
    && daysBetweenDateKeys(todayKey, reportedNextHighDesireDateKey) >= 0;
  if (reportedHighDesireStillUpcoming) {
    nextHighDesireDateKey = reportedNextHighDesireDateKey;
  } else if (latestPeriod && Number.isFinite(highDesireOffsetDays) && highDesireOffsetDays >= 0) {
    nextHighDesireDateKey = nextPredictedHighDesireDateKey(
      latestPeriod.dateKey,
      addDaysToDateKey(latestPeriod.dateKey, highDesireOffsetDays),
      cycle.days,
      todayKey
    );
  }
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
    reportedNextPeriodDateKey: reportedPeriodStillUpcoming ? reportedNextPeriodDateKey : "",
    reportedNextHighDesireDateKey: reportedHighDesireStillUpcoming ? reportedNextHighDesireDateKey : "",
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
    const preflightStore = await readStore();
    const preflightLatestWeight = latestWeightRecord(preflightStore);
    if (preflightLatestWeight && !publicCoach(coachForWeight(preflightStore, preflightLatestWeight.id))) {
      await writeStore((currentStore) => {
        const currentLatestWeight = latestWeightRecord(currentStore);
        return currentLatestWeight ? ensurePublicCoachForWeight(currentStore, currentLatestWeight.id) : currentStore;
      });
    }
    const stylePreflightStore = await readStore();
    const stylePreflightWeight = latestWeightRecord(stylePreflightStore);
    const stylePreflightCoach = stylePreflightWeight ? coachForWeight(stylePreflightStore, stylePreflightWeight.id) : null;
    if (stylePreflightCoach && coachNeedsRepair(stylePreflightCoach)) {
      await writeStore((currentStore) => {
        const currentWeight = latestWeightRecord(currentStore);
        const currentCoach = currentWeight ? coachForWeight(currentStore, currentWeight.id) : null;
        if (!currentWeight || !currentCoach || !coachNeedsRepair(currentCoach)) return currentStore;
        const refreshed = refreshLatestCoachStyleInStore(currentStore, "deterministic-read-repair", Date.now(), { force: true });
        return refreshed.updated ? refreshed.store : currentStore;
      });
    }
    const rewardPreflightStore = await readStore();
    const rewardPreflightWeight = latestWeightRecord(rewardPreflightStore);
    const rewardPreflightCoach = rewardPreflightWeight ? coachForWeight(rewardPreflightStore, rewardPreflightWeight.id) : null;
    const rewardPreflight = calculateStoreBobaReward(rewardPreflightStore, {
      asOf: Date.now(),
      weightId: rewardPreflightWeight?.id
    });
    if (rewardPreflightWeight && rewardPreflightCoach && coachBobaRewardNeedsRepair(rewardPreflightCoach, rewardPreflight)) {
      await writeStore((currentStore) => {
        const currentLatestWeight = latestWeightRecord(currentStore);
        const currentCoach = currentLatestWeight ? coachForWeight(currentStore, currentLatestWeight.id) : null;
        const currentReward = calculateStoreBobaReward(currentStore, {
          asOf: Date.now(),
          weightId: currentLatestWeight?.id
        });
        if (!currentLatestWeight || !currentCoach || !coachBobaRewardNeedsRepair(currentCoach, currentReward)) return currentStore;
        const refreshed = refreshLatestCoachStyleInStore(currentStore, "fallback-boba-window-refresh", Date.now(), { force: true });
        return refreshed.updated ? refreshed.store : currentStore;
      });
    }
    const store = await readStore();
    const latestWeight = latestWeightRecord(store);
    const latestCoach = latestWeight ? coachForWeight(store, latestWeight.id) : null;
    const bobaReward = calculateStoreBobaReward(store, { asOf: Date.now(), weightId: latestWeight?.id });
    if (latestWeight && coachNeedsRepair(latestCoach)) scheduleCoachGeneration(latestWeight.id);
    send(res, 200, {
      weights: publicWeights(store.weights).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      latestCoach: publicCoach(latestCoach),
      bobaReward: publicBobaReward(bobaReward)
    });
    return;
  }

  if (pathname === "/api/coach/refresh-saved-context" && req.method === "POST") {
    const body = await readJson(req);
    const memoryId = String(body.memoryId || "").trim();
    if (!memoryId) {
      send(res, 400, { error: "A saved memory id is required." });
      return;
    }
    const currentStore = await readStore();
    if (!(currentStore.memories || []).some((memory) => memory.id === memoryId)) {
      send(res, 404, { error: "Saved memory not found." });
      return;
    }
    const currentWeight = latestWeightRecord(currentStore);
    send(res, 200, {
      updated: false,
      alreadyCurrent: false,
      latestCoach: publicCoach(currentWeight ? coachForWeight(currentStore, currentWeight.id) : null),
      status: "personal-context-optional",
      memoryReferenced: false,
      backup: null,
      preserved: true
    });
    return;

    const expected = body.expected && typeof body.expected === "object" ? body.expected : {};
    const expectedCoach = body.expectedCoach && typeof body.expectedCoach === "object" ? body.expectedCoach : {};
    let baseline = null;
    let prepared = null;
    let personalContextCutoff = NaN;
    let backupFile = "";
    let alreadyCurrent = false;

    await writeStore(async (store) => {
      const memory = (store.memories || []).find((item) => item.id === memoryId);
      if (!memory) throw Object.assign(new Error("Saved memory not found."), { status: 404 });
      personalContextCutoff = Date.parse(memory.createdAt);
      if (!Number.isFinite(personalContextCutoff)) {
        throw Object.assign(new Error("Saved memory has no valid creation time."), { status: 409 });
      }
      baseline = coachRefreshPreservationSnapshot(store);
      assertExpectedCoachRefreshState(baseline, expected, expectedCoach);
      const existing = coachForWeight(store, baseline.targetWeightId);
      alreadyCurrent = Boolean(existing?.evidenceReferences?.some((reference) => reference.type === "memory" && reference.id === memoryId));
      if (alreadyCurrent) {
        prepared = { store, updated: false, weightId: baseline.targetWeightId, latestCoach: publicCoach(existing) };
        return store;
      }

      prepared = refreshLatestCoachForSavedMemories(store, [memoryId], personalContextCutoff, "fallback-saved-context-maintenance", Date.now());
      if (!prepared.updated) {
        throw Object.assign(new Error("Saved memory was not eligible for the latest coach."), { status: 409 });
      }
      const backupsDir = path.join(dataDir, "backups");
      await fsp.mkdir(backupsDir, { recursive: true });
      backupFile = `store-before-coach-refresh-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}.json`;
      await fsp.copyFile(storePath, path.join(backupsDir, backupFile));
      assertCoachRefreshPreserved(baseline, coachRefreshPreservationSnapshot(prepared.store, prepared.weightId));
      return prepared.store;
    });

    if (alreadyCurrent) {
      const currentStore = await readStore();
      const currentSnapshot = coachRefreshPreservationSnapshot(currentStore, prepared?.weightId || baseline?.targetWeightId);
      assertCoachRefreshPreserved(baseline, currentSnapshot);
      const currentRecord = coachForWeight(currentStore, currentSnapshot.targetWeightId);
      const memoryReferenced = Boolean(currentRecord?.evidenceReferences?.some((reference) => reference.type === "memory" && reference.id === memoryId));
      if (!memoryReferenced) {
        throw Object.assign(new Error("The current coach does not reference the requested saved memory."), { status: 409 });
      }
      send(res, 200, {
        updated: false,
        alreadyCurrent: true,
        latestCoach: publicCoach(currentRecord),
        status: currentRecord?.status || "missing",
        actionSemantic: currentRecord?.actionSemantic || "",
        memoryReferenced,
        backup: null,
        counts: currentSnapshot.counts,
        preserved: true
      });
      return;
    }

    if (prepared?.updated && prepared.weightId) {
      await generateAndReplaceCoach(prepared.weightId, { personalContextCutoff });
    }
    const finalStore = await readStore();
    const finalSnapshot = coachRefreshPreservationSnapshot(finalStore, prepared?.weightId || baseline?.targetWeightId);
    assertCoachRefreshPreserved(baseline, finalSnapshot);
    const finalRecord = coachForWeight(finalStore, finalSnapshot.targetWeightId);
    const memoryReferenced = Boolean(finalRecord?.evidenceReferences?.some((reference) => reference.type === "memory" && reference.id === memoryId));
    if (!memoryReferenced) {
      throw Object.assign(new Error("The refreshed coach did not retain the saved-memory reference."), { status: 409 });
    }
    send(res, 200, {
      updated: Boolean(prepared?.updated),
      alreadyCurrent,
      latestCoach: publicCoach(finalRecord),
      status: finalRecord?.status || "missing",
      actionSemantic: finalRecord?.actionSemantic || "",
      memoryReferenced,
      backup: backupFile || null,
      counts: finalSnapshot.counts,
      preserved: true
    });
    return;
  }

  if (pathname === "/api/coach/refresh-brain-relationship" && req.method === "POST") {
    const body = await readJson(req);
    const currentStore = await readStore();
    const currentWeight = latestWeightRecord(currentStore);
    send(res, 200, {
      updated: false,
      alreadyCurrent: false,
      latestCoach: publicCoach(currentWeight ? coachForWeight(currentStore, currentWeight.id) : null),
      status: "personal-context-optional",
      brainReferenced: false,
      backup: null,
      preserved: true
    });
    return;

    const expected = body.expected && typeof body.expected === "object" ? body.expected : {};
    const expectedCoach = body.expectedCoach && typeof body.expectedCoach === "object" ? body.expectedCoach : {};
    const operationalNow = Date.now();
    const initialStore = await readStore();
    const initialSnapshot = coachRefreshPreservationSnapshot(initialStore);
    assertExpectedCoachRefreshState(initialSnapshot, expected, expectedCoach);
    const initialWeight = (initialStore.weights || []).find((weight) => weight.id === initialSnapshot.targetWeightId);
    const initialWeightTime = Date.parse(initialWeight?.createdAt);
    const relationshipSupport = await fetchLatestBrainPersonalAnchor(initialStore, {
      cutoff: Number.isFinite(initialWeightTime) ? Math.min(operationalNow, initialWeightTime + BRAIN_WEIGHT_INDEX_GRACE_MS) : operationalNow,
      thoughtCutoff: operationalNow,
      earliest: Number.isFinite(initialWeightTime) ? initialWeightTime - BRAIN_WEIGHT_CONTEXT_LOOKBACK_MS : undefined,
      operationalNow,
      weight: initialWeight,
      weightId: initialSnapshot.targetWeightId,
      excludedWeightId: initialSnapshot.targetWeightId,
      preferNewestCurrentThought: true
    });
    const relationshipSupportTime = Date.parse(relationshipSupport?.createdAt || "");
    const eligibleCurrentThought = relationshipSupport?.sourceType === "brain-thought-anchor"
      && Number.isFinite(relationshipSupportTime)
      && relationshipSupportTime <= operationalNow
      && operationalNow - relationshipSupportTime <= BRAIN_RELATIONSHIP_MAX_AGE_MS;
    if (!relationshipSupport || (!eligibleCurrentThought && !brainSourceWithinWeightWindow(initialWeight, relationshipSupport, operationalNow))) {
      throw Object.assign(new Error("No recent eligible personal context was available for this refresh."), { status: 409 });
    }

    let baseline = null;
    let prepared = null;
    let backupFile = "";
    await writeStore(async (store) => {
      baseline = coachRefreshPreservationSnapshot(store);
      assertExpectedCoachRefreshState(baseline, expected, expectedCoach);
      prepared = refreshLatestCoachForBrainRelationship(store, relationshipSupport, "fallback-brain-relationship-maintenance", operationalNow, {
        allowCurrentThoughtRefresh: eligibleCurrentThought
      });
      if (!prepared.updated) {
        if (prepared.alreadyCurrent) return store;
        throw Object.assign(new Error("The recent personal context was not eligible for the latest coach."), { status: 409 });
      }
      const backupsDir = path.join(dataDir, "backups");
      await fsp.mkdir(backupsDir, { recursive: true });
      backupFile = `store-before-brain-relationship-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}.json`;
      await fsp.copyFile(storePath, path.join(backupsDir, backupFile));
      assertCoachRefreshPreserved(baseline, coachRefreshPreservationSnapshot(prepared.store, prepared.weightId));
      return prepared.store;
    });

    if (prepared?.updated) {
      await generateAndReplaceCoach(prepared.weightId, {
        personalContextCutoff: Number.isFinite(prepared.personalContextCutoff) ? prepared.personalContextCutoff : undefined,
        relationshipContextCutoff: operationalNow,
        relationshipSupport
      });
    }
    const finalStore = await readStore();
    const finalSnapshot = coachRefreshPreservationSnapshot(finalStore, prepared?.weightId || baseline?.targetWeightId);
    assertCoachRefreshPreserved(baseline, finalSnapshot);
    const finalRecord = coachForWeight(finalStore, finalSnapshot.targetWeightId);
    const expectedReferenceType = relationshipSupport.sourceType || "brain-letter";
    const brainReferenced = Boolean(finalRecord?.evidenceReferences?.some((reference) => reference.type === expectedReferenceType && reference.id === relationshipSupport.id));
    if (!brainReferenced || !finalRecord?.text?.includes(relationshipSupport.text)) {
      throw Object.assign(new Error("The refreshed coach did not retain the approved personal context."), { status: 409 });
    }
    send(res, 200, {
      updated: Boolean(prepared?.updated),
      alreadyCurrent: Boolean(prepared?.alreadyCurrent),
      latestCoach: publicCoach(finalRecord),
      status: finalRecord?.status || "missing",
      brainReferenced,
      backup: backupFile || null,
      counts: finalSnapshot.counts,
      preserved: true
    });
    return;
  }

  if (pathname === "/api/coach/refresh-style" && req.method === "POST") {
    const body = await readJson(req);
    const expected = body.expected && typeof body.expected === "object" ? body.expected : {};
    const expectedCoach = body.expectedCoach && typeof body.expectedCoach === "object" ? body.expectedCoach : {};
    let baseline = null;
    let prepared = null;
    let backupFile = "";

    await writeStore(async (store) => {
      baseline = coachRefreshPreservationSnapshot(store);
      assertExpectedCoachRefreshState(baseline, expected, expectedCoach);
      prepared = refreshLatestCoachStyleInStore(store, "fallback-style-maintenance", Date.now());
      if (!prepared.updated) {
        if (!prepared.alreadyCurrent) throw Object.assign(new Error("The latest coach could not be refreshed."), { status: 409 });
        return store;
      }
      const backupsDir = path.join(dataDir, "backups");
      await fsp.mkdir(backupsDir, { recursive: true });
      backupFile = `store-before-coach-style-refresh-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}.json`;
      await fsp.copyFile(storePath, path.join(backupsDir, backupFile));
      assertCoachRefreshPreserved(baseline, coachRefreshPreservationSnapshot(prepared.store, prepared.weightId));
      return prepared.store;
    });

    if (prepared.updated) {
      await generateAndReplaceCoach(prepared.weightId, {
        personalContextCutoff: Number.isFinite(prepared.personalContextCutoff) ? prepared.personalContextCutoff : undefined,
        relationshipSupport: prepared.personalAnchor || undefined
      });
    }
    const finalStore = await readStore();
    const finalSnapshot = coachRefreshPreservationSnapshot(finalStore, prepared.weightId || baseline.targetWeightId);
    assertCoachRefreshPreserved(baseline, finalSnapshot);
    const finalRecord = coachForWeight(finalStore, finalSnapshot.targetWeightId);
    const finalContext = buildCoachContext(finalStore, finalSnapshot.targetWeightId, { includePersonalContext: false });
    const validation = validateCoachParagraph(finalRecord?.text || "", finalContext);
    if (finalRecord?.styleVersion !== COACH_STYLE_VERSION || !validation.ok) {
      throw Object.assign(new Error(`The refreshed coach failed the supportive style gate: ${validation.errors.join(", ")}.`), { status: 409 });
    }
    send(res, 200, {
      updated: Boolean(prepared.updated),
      alreadyCurrent: Boolean(prepared.alreadyCurrent),
      latestCoach: publicCoach(finalRecord),
      status: finalRecord?.status || "missing",
      styleVersion: finalRecord?.styleVersion || "",
      backup: backupFile || null,
      counts: finalSnapshot.counts,
      preserved: true
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
      "reportedNextPeriodDateKey",
      "reportedNextHighDesireDateKey",
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
    const requestedUnit = body.unit == null ? "auto" : String(body.unit).trim().toLowerCase();
    const referenceStore = await readStore();
    const resolution = weightUnits.resolveWeightInput(body.weight, referenceStore.weights, requestedUnit, {
      timeZone: trackerTimeZone
    });
    if (resolution.status === "invalid") {
      const invalidUnit = resolution.error === "invalid-unit";
      send(res, 400, {
        error: invalidUnit ? "Choose kg, lb, or automatic detection." : "Enter a valid weight.",
        code: invalidUnit ? "invalid_weight_unit" : "invalid_weight"
      });
      return;
    }
    if (resolution.ambiguous) {
      send(res, 422, {
        error: "Choose kg or lb for this weigh-in.",
        code: "weight_unit_ambiguous",
        candidates: resolution.candidates
      });
      return;
    }
    if (!Number.isFinite(resolution.weightLb) || resolution.weightLb <= 0) {
      send(res, 400, { error: "Enter a valid weight." });
      return;
    }
    const now = new Date().toISOString();
    const created = {
      id: createId("weight"),
      weight: resolution.weightLb,
      unit: "lb",
      createdAt: now,
      updatedAt: now
    };
    const savedStore = await persistWeightWithRecoverableCoach(created);
    const savedCoach = coachForWeight(savedStore, created.id);
    const bobaReward = calculateStoreBobaReward(savedStore, { asOf: created.createdAt, weightId: created.id });
    send(res, 201, {
      weight: publicWeight(created),
      latestCoach: publicCoach(savedCoach),
      bobaReward: publicBobaReward(bobaReward),
      conversion: {
        inputWeight: resolution.inputValue,
        requestedUnit: resolution.requestedUnit,
        detectedUnit: resolution.detectedUnit,
        source: resolution.source,
        converted: resolution.detectedUnit === "kg",
        weightLb: resolution.weightLb
      }
    });
    if (coachNeedsRepair(savedCoach)) scheduleCoachGeneration(created.id);
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

    const personalContextCutoff = Date.parse(now);
    const createdNoteIds = created.filter((memory) => memory.kind === "note").map((memory) => memory.id);
    let coachRefresh = { updated: false, weightId: null, latestCoach: null };
    await writeStore((store) => {
      const withMemories = { ...store, memories: [...created, ...store.memories] };
      coachRefresh = refreshLatestCoachForSavedMemories(withMemories, createdNoteIds, personalContextCutoff);
      return coachRefresh.store;
    });
    send(res, 201, {
      memories: created.map(publicMemory),
      coachUpdated: coachRefresh.updated,
      latestCoach: coachRefresh.updated ? coachRefresh.latestCoach : null
    });
    if (coachRefresh.updated && coachRefresh.weightId) {
      setImmediate(() => {
        generateAndReplaceCoach(coachRefresh.weightId, {
          personalContextCutoff,
          timeoutMs: coachBackgroundGenerationTimeoutMs
        }).catch(() => {});
      });
    }
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
    await writeStore((store) => reconcileBobaRewardInStore(removeWeightAndCoach(store, id), { asOf: Date.now() }));
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
    const status = error.status || 500;
    send(res, status, { error: publicApiErrorMessage(error, status) });
  }
});

if (require.main === module) {
  ensureDataDir()
    .then(backfillBobaRewardState)
    .then(backfillCoachMessages)
    .then(() => {
      server.listen(port, () => {
        console.log(`Lily memory bank running at http://localhost:${port}`);
      });
    });
}

if (process.env.NODE_ENV === "test" || process.env.LILY_COACH_CLI === "1") {
  module.exports = {
    COACH_ACTION_CATALOG,
    COACH_ACTION_VERSION,
    COACH_ANALYSIS_VERSION,
    COACH_COOLDOWN_COUNT,
    COACH_FALLBACK_VERSION,
    COACH_GENERATION_VERSION,
    COACH_MAX_WORDS,
    COACH_MIN_WORDS,
    COACH_RELATIONSHIP_MAX_WORDS,
    COACH_RELATIONSHIP_MIN_WORDS,
    COACH_REACTION_MAX_AGE_MS,
    COACH_REACTION_REFRESH_MAX_AGE_MS,
    COACH_STYLE_VERSION,
    COACH_VALIDATOR_VERSION,
    BRAIN_RELATIONSHIP_MAX_AGE_MS,
    BRAIN_WEIGHT_CONTEXT_LOOKBACK_MS,
    BRAIN_WEIGHT_INDEX_GRACE_MS,
    BRAIN_CONTEXT_RECHECK_MS,
    BRAIN_RELATIONSHIP_COPY,
    BRAIN_THOUGHT_ANCHOR_COPY,
    LILY_PERSONAL_ANCHOR_COPY,
    PREFERENCE_ACTIONS,
    addFallbackCoachForWeight,
    addPendingCoachForWeight,
    backfillBobaRewardState,
    assertCoachRefreshPreserved,
    assertExpectedCoachRefreshState,
    backfillCoachMessages,
    buildCoachContext,
    calculateBobaRewardState,
    calculateStoreBobaReward,
    brainRelationshipSupportAvailable,
    brainRelationshipSupportFromFile,
    brainThoughtAnchorFromFile,
    brainSpecificSubjectFromFile,
    brainGeneralSpecificSubject,
    brainConnectionCopy,
    brainFileIsGeneratedNoteRecord,
    resolveBrainApiBase,
    brainSourceWithinWeightWindow,
    buildContextualFallback,
    buildContextualFallbackCandidates,
    buildContextualFallbackResult,
    causalPreviousCoachMessages,
    coachBobaRewardNeedsRepair,
    coachForWeight,
    coachNeedsRepair,
    coachRefreshPreservationSnapshot,
    coachWordCount,
    coachWordBounds,
    composeDeterministicCoachMemo,
    createCoachMessageRecord,
    ensureDataDir,
    fetchLatestBrainPersonalAnchor,
    fetchLatestBrainRelationshipSupport,
    fetchLatestBrainThoughtAnchor,
    generateAndReplaceCoach,
    generateCoachParagraph,
    hiddenStrategyState,
    latestCoachPayload,
    normalizeCoachParagraph,
    identifyApprovedAction,
    publicTrackerEvent,
    publicTrackerSummary,
    normalizePeriodDetails,
    trackerDateKey,
    daysBetweenDateKeys,
    addDaysToDateKey,
    publicCoach,
    publicApiErrorMessage,
    readStore,
    regenerateRecentCoachMessages,
    refreshLatestWeightOnlyCoach,
    refreshIfLatestCoachReferences,
    refreshLatestCoachForSavedMemories,
    refreshLatestCoachForBrainRelationship,
    reconcileLatestCoachBrainContext,
    refreshLatestCoachStyleInStore,
    removeWeightAndCoach,
    observerCareSignal,
    memoryPersonalAnchor,
    personalAnchorFromCoachRecord,
    personalAnchorIsAvailable,
    personalAnchorReferenceKeys,
    personalAnchorSemanticKind,
    persistWeightWithRecoverableCoach,
    reconcileBobaRewardInStore,
    reportedCoachEffort,
    referencedBrainLetterIds,
    selectSavedPreference,
    selectLilyPersonalAnchor,
    newestPersonalAnchor,
    sanitizePersonalAnchor,
    scheduleCoachGeneration,
    server,
    selectStrongestCoachEvidence,
    validateDeterministicCoachMemo,
    validateCoachParagraph,
    writeStore
  };
}
