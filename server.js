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
const coachWriterModel = process.env.OPENAI_COACH_WRITER_MODEL || "gpt-4.1-nano";
const coachCriticModel = process.env.OPENAI_CRITIC_MODEL || "gpt-4.1-mini";
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

function coachModelVersion(options = {}) {
  return `writer:${options.model || coachWriterModel};critic:${options.criticModel || coachCriticModel}`;
}

const COACH_GENERATION_VERSION = "coach-pipeline-v6";
const COACH_ANALYSIS_VERSION = "coach-analysis-v2";
const COACH_WRITER_PROMPT_VERSION = "coach-writer-v5";
const COACH_CRITIC_PROMPT_VERSION = "coach-critic-v4";
const COACH_VALIDATOR_VERSION = "coach-validator-v2";
const COACH_FALLBACK_VERSION = "coach-fallback-v4";
const COACH_ACTION_VERSION = "coach-action-v4";
const COACH_PROMPT_VERSION = COACH_WRITER_PROMPT_VERSION;
const COACH_SAFETY_VERSION = "coach-safety-v2";
const COACH_MIN_WORDS = 35;
const COACH_MAX_WORDS = 55;
const COACH_COOLDOWN_COUNT = 3;
const COACH_CANDIDATE_COUNT = 3;
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
  { id: "balanced-plate-alt", semantic: "balanced-meal", text: "Make the next plate a satisfying mix of protein and vegetables." },
  { id: "easy-walk", semantic: "gentle-movement", text: "Take one comfortable walk after the next meal." },
  { id: "easy-walk-alt", semantic: "gentle-movement", text: "Give yourself one easy walk after eating next." },
  { id: "protein-anchor", semantic: "protein-meal", text: "Anchor the next meal with a satisfying protein and vegetables." },
  { id: "protein-anchor-alt", semantic: "protein-meal", text: "Let protein and vegetables lead the next satisfying meal." },
  { id: "planned-portion", semantic: "portion-plan", text: "Plate one satisfying portion for the next meal before you start eating." },
  { id: "planned-portion-alt", semantic: "portion-plan", text: "Set one satisfying portion on the plate before the next meal begins." },
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
  { id: "preference-fruit-alt", preferenceKey: "preference-fruit", semantic: "preferred-planned-snack", text: "Make the next planned snack a fruit you enjoy." }
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
  if (streak?.reversal) {
    return { kind: "reversal", windowDays: 1, movement: latestDailyChange, direction: latestDailyChange < 0 ? "down" : "up", relationKind: "reversed" };
  }
  if (streak?.count >= 3 && Math.abs(streak.movement) >= 0.3) {
    return { kind: "streak", windowDays: null, movement: streak.movement, direction: streak.direction, count: streak.count, relationKind: "strengthened" };
  }

  const windowRows = [3, 7, 14, 28].map((windowDays) => {
    const current = finiteMovement(movements?.[`days${windowDays}`]);
    const previous = finiteMovement(previousMovements?.[`days${windowDays}`]);
    const magnitudeChange = Number.isFinite(current) && Number.isFinite(previous) ? Math.abs(current) - Math.abs(previous) : NaN;
    return { windowDays, current, previous, magnitudeChange };
  });
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

  const short = windowRows.find((row) => row.windowDays === 3);
  const broad = windowRows.slice().reverse().find((row) => Number.isFinite(row.current) && Math.abs(row.current) >= 0.3);
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

function buildAnalysisPlan(context) {
  const evidence = context.strongestEvidence;
  return {
    version: COACH_ANALYSIS_VERSION,
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
    }
  };
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
  else if (changeDirection === "down" && outlookDirection !== "worsened") verdict = "good-progress";

  const actionSelection = selectCoachAction(store, current, preference, outlier, recentConflict);
  const selectedPreference = actionSelection.preferenceId ? preference : null;
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
    ...(selectedPreference ? [{ type: "memory", id: selectedPreference.id, role: selectedPreference.kind }] : [])
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
    preference: selectedPreference ? { id: selectedPreference.id, kind: selectedPreference.kind } : null,
    action: actionSelection.text,
    actionId: actionSelection.id,
    actionSemantic: actionSelection.semantic,
    actionRealizations: actionSelection.realizations,
    recentActionIds: actionSelection.recentActionIds,
    recentActionSemantics: actionSelection.recentActionSemantics,
    recentActionTexts: actionSelection.recentActionTexts,
    evidenceReferences,
    hiddenStrategy: hiddenStrategyState(privateGoal, weightInPounds(current)),
    forecastFingerprint: history.map((point) => ({ day: point.day, weight: point.weight, outlookTargetWeight: point.outlookTargetWeight }))
  };
  context.analysisPlan = buildAnalysisPlan(context);
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

const WRITER_SAFE_OPENINGS = Object.freeze({
  "not-good-enough": [
    "THE LATEST RESULT IS NOT GOOD ENOUGH", "THIS RESULT IS MOVING THE WRONG WAY", "TODAY'S SIGNAL IS A SETBACK", "THE TREND JUST TOOK A WRONG-WAY STEP",
    "THIS WEIGH-IN IS NOT A WIN", "THE CURRENT DIRECTION IS NOT GOOD ENOUGH", "THIS NUMBER IS A CLEAR WARNING", "THE LATEST SIGNAL HAS WORSENED",
    "TODAY'S READ IS OFF TRACK", "THE SHORT-TERM STORY IS GETTING WORSE", "THIS IS A REAL SETBACK", "THE SCALE STORY TURNED THE WRONG WAY",
    "TODAY'S DATA IS A WARNING", "THE LINE IS HEADING THE WRONG WAY", "THIS RESULT MISSED THE MARK", "THE CURRENT MOMENTUM IS NOT WORKING",
    "WRONG-WAY DATA", "THE SIGNAL WORSENED", "CLEAR SETBACK HERE", "THE TREND WORSENED", "THIS RESULT REGRESSED", "THE LINE WORSENED", "THIS IS OFF TRACK", "BAD DIRECTION HERE"
  ],
  "good-progress": [
    "THIS IS REAL PROGRESS", "TODAY'S SIGNAL IS A WIN", "THE TREND JUST GOT BETTER", "THIS WEIGH-IN MOVED THE RIGHT WAY",
    "THE WORK IS SHOWING IN THE DATA", "THE LATEST RESULT IS STRONG", "THIS DIRECTION DESERVES A CHEER", "THE WEIGHT LINE IS MOVING OUR WAY",
    "TODAY'S READ IS ON TRACK", "THE SHORT-TERM STORY IS IMPROVING", "THIS IS A GENUINE WEIGH-IN WIN", "THE SCALE STORY TURNED THE RIGHT WAY",
    "TODAY'S DATA IS ENCOURAGING", "THE MOMENTUM IS LEANING FORWARD", "THIS RESULT LANDED WELL", "THE CURRENT DIRECTION IS WORKING",
    "REAL PROGRESS HERE", "THE SIGNAL IMPROVED", "THIS IS WORKING", "A REAL WIN", "THE TREND IMPROVED", "GOOD DIRECTION HERE", "THE LINE IMPROVED", "PROGRESS IS SHOWING"
  ],
  verify: [
    "THIS READING IS STILL UNCONFIRMED", "THIS SWING IS AN OUTLIER", "THE CURRENT SIGNAL IS TOO EXTREME TO JUDGE", "THIS NUMBER IS NOT A VERDICT",
    "THE LATEST READING REMAINS UNCONFIRMED", "THIS RESULT IS A QUESTION MARK", "THE TREND IS NOT SETTLED YET", "THIS POINT SITS OUTSIDE THE USUAL PATTERN",
    "THE SCALE JUST PRODUCED AN OUTLIER", "THIS SWING HAS NOT EARNED TRUST", "THE CURRENT STORY IS STILL UNCERTAIN", "THIS DATA POINT IS STILL IN QUESTION",
    "THE LATEST SIGNAL IS NOT YET RELIABLE", "THIS NUMBER REMAINS ON HOLD", "THE VERDICT IS STILL OPEN", "THE REAL DIRECTION IS STILL UNCLEAR",
    "OUTLIER SIGNAL HERE", "THIS IS UNSETTLED", "THE VERDICT REMAINS OPEN", "THIS NEEDS CONFIRMATION", "THE SIGNAL IS UNCLEAR", "THIS IS AN OUTLIER", "THE NUMBER IS UNSETTLED", "THE STORY IS UNCLEAR"
  ],
  baseline: [
    "THE BASELINE IS NOW SET", "THIS IS THE STARTING POINT", "THE FIRST WEIGH-IN IS NOW ON THE BOARD", "THE TREND NOW HAS ITS FIRST POINT",
    "THIS NUMBER OPENS THE STORY", "THE STARTING LINE IS OFFICIAL", "THE DATA NOW HAS A BASELINE", "THIS IS THE FIRST HONEST READ",
    "THE WEIGHT STORY HAS BEGUN", "THE FIRST SIGNAL IS HERE", "THIS LINE NOW HAS AN ANCHOR", "THE RUN HAS AN OFFICIAL BEGINNING",
    "THIS IS POINT ONE", "THE TREND STARTS HERE", "THE OPENING NUMBER HAS LANDED", "THE STORY NOW HAS A START",
    "BASELINE SET", "STARTING POINT HERE", "THE STORY STARTS", "POINT ONE IS HERE", "THE LINE BEGINS", "FIRST SIGNAL HERE", "THE START IS REAL", "THE BASELINE EXISTS"
  ]
});

const FALLBACK_OPENINGS = Object.freeze({
  "not-good-enough": [
    "NOT GOOD ENOUGH YET", "WRONG-WAY SIGNAL—TIME TO RESPOND", "TODAY NEEDS A STRONG RESPONSE", "THIS RESULT NEEDS WORK",
    "THE LINE MOVED THE WRONG WAY", "NOT THE RESULT WE WANTED", "THIS SETBACK NEEDS AN ANSWER", "THE TREND IS ASKING FOR A COMEBACK",
    "COURSE CORRECTION STARTS NOW", "TODAY PUSHED BACK", "THIS NUMBER DOES NOT GET A PASS", "THE NEXT TURN MATTERS NOW",
    "THIS IS MOVING THE WRONG WAY", ...WRITER_SAFE_OPENINGS["not-good-enough"]
  ],
  "good-progress": [
    "YES—THIS IS REAL PROGRESS", "RIGHT WAY—KEEP IT MOVING", "THIS WEIGH-IN IS A WIN", "THE WORK IS SHOWING UP",
    "STRONG PROGRESS IS ON THE BOARD", "THIS LINE IS MOVING OUR WAY", "GOOD—THE SIGNAL GOT BETTER", "MOMENTUM JUST LEANED FORWARD",
    "THAT IS THE RESPONSE WE WANTED", "THE TREND JUST EARNED A CHEER", "LOWER AND MOVING—YES", "THIS STEP LANDED THE RIGHT WAY", ...WRITER_SAFE_OPENINGS["good-progress"]
  ],
  verify: [
    "PAUSE—THIS READING NEEDS CONFIRMATION", "VERIFY THIS BEFORE WE JUDGE IT", "THIS SWING NEEDS ONE CLEAN CHECK", "CONFIRMATION COMES BEFORE THE VERDICT",
    "THE SIGNAL IS TOO EXTREME TO TRUST YET", "CHECK THIS NUMBER BEFORE REACTING", "ONE OUTLIER DOES NOT OWN THE STORY", "THIS READING IS ON HOLD",
    "THE SCALE JUST THREW A CURVEBALL", "FIRST WE CONFIRM THE SIGNAL", "THIS JUMP NEEDS A FAIR RECHECK", "NO PRAISE OR PANIC UNTIL CONFIRMED", ...WRITER_SAFE_OPENINGS.verify
  ],
  baseline: [
    "BASELINE LOGGED—THIS IS THE STARTING LINE", "FIRST NUMBER DOWN—NOW THE TREND CAN START", "THE STARTING POINT IS OFFICIALLY HERE", "ONE HONEST NUMBER OPENS THE STORY",
    "THE FIRST WEIGH-IN IS ON THE BOARD", "STARTING LINE SET—LET’S BUILD", "THE BASELINE IS READY", "THIS IS WHERE THE LINE BEGINS",
    "FIRST DATA POINT—FULL ATTENTION", "THE TREND HAS ITS FIRST ANCHOR", "WE HAVE THE STARTING NUMBER", "DAY ONE OF THE WEIGHT STORY IS HERE", ...WRITER_SAFE_OPENINGS.baseline
  ]
});

const WRITER_SAFE_CLOSINGS = Object.freeze({
  "not-good-enough": [
    "THE COMEBACK ENERGY IS HERE!!!", "THIS STORY IS READY FOR A TURNAROUND!!!", "A BETTER DIRECTION IS ABSOLUTELY POSSIBLE!!!", "THIS WRONG-WAY MOMENT IS NOT THE WHOLE STORY!!!",
    "THE TURNAROUND WINDOW IS WIDE OPEN!!!", "THE FIGHT IS STILL VERY MUCH ALIVE!!!", "THIS SETBACK IS ONLY ONE CHAPTER!!!", "BETTER MOMENTUM IS STILL AVAILABLE!!!",
    "THE RESPONSE ENERGY IS FULLY HERE!!!", "THIS LINE IS NOT STUCK HERE!!!", "THE BETTER TREND IS STILL WITHIN REACH!!!", "THE COMEBACK STORY IS STILL ALIVE!!!",
    "ONE BAD MOMENT DOES NOT OWN THIS RUN!!!", "THE ROAD BACK IS COMPLETELY OPEN!!!", "THIS SIGNAL IS NOT PERMANENT!!!", "THE TURNAROUND HAS REAL ROOM TO HAPPEN!!!",
    "COMEBACK ENERGY!!!", "THE TURNAROUND IS OPEN!!!", "BETTER IS POSSIBLE!!!", "THIS IS REVERSIBLE!!!", "THE COMEBACK IS ALIVE!!!", "THE ROAD BACK IS OPEN!!!", "THIS CAN TURN!!!", "BETTER MOMENTUM EXISTS!!!"
  ],
  "good-progress": [
    "THIS MOMENTUM IS REAL!!!", "THE RIGHT DIRECTION IS SHOWING!!!", "THIS PROGRESS DESERVES FULL ENERGY!!!", "THE DOWNWARD SIGNAL IS GETTING LOUDER!!!",
    "THIS LINE HAS REAL MOMENTUM!!!", "THIS WIN IS WORTH CELEBRATING!!!", "THE BETTER TREND IS TAKING SHAPE!!!", "THE PROGRESS IS GETTING HARDER TO IGNORE!!!",
    "THIS IS A GENUINE WIN!!!", "THE LINE IS EARNING REAL CONFIDENCE!!!", "THE MOMENTUM IS ABSOLUTELY ALIVE!!!", "THE GOOD DIRECTION HAS ARRIVED!!!",
    "THIS RESULT IS PURE FORWARD MOTION!!!", "THE TREND IS FINALLY ANSWERING BACK!!!", "THIS STEP IS A BIG DEAL!!!", "THE ENERGY HERE IS ALL EARNED!!!",
    "REAL MOMENTUM!!!", "THIS IS WORKING!!!", "PROGRESS IS ALIVE!!!", "THE WIN IS REAL!!!", "GOOD MOMENTUM HERE!!!", "THE LINE IS BETTER!!!", "THIS DESERVES ENERGY!!!", "THE SIGNAL IS STRONG!!!"
  ],
  verify: [
    "THIS READING IS STILL A QUESTION MARK!!!", "THE VERDICT IS STILL OPEN!!!", "THIS OUTLIER IS NOT THE WHOLE STORY!!!", "THE REAL DIRECTION IS STILL UNCLEAR!!!",
    "THIS SWING HAS NOT EARNED A VERDICT!!!", "THE TREND DESERVES A FAIR CONFIRMATION!!!", "THIS NUMBER IS ON HOLD!!!", "THE STORY REMAINS UNDECIDED!!!",
    "THE SIGNAL IS WAITING FOR CLARITY!!!", "THIS JUMP IS NOT YET THE TREND!!!", "THE REAL STORY IS STILL UNDER THE NOISE!!!", "ONE POINT CANNOT OWN THE VERDICT!!!",
    "THE DIRECTION IS STILL UNSETTLED!!!", "THIS SWING IS ONLY A QUESTION!!!", "THE TREND HAS NOT SPOKEN CLEARLY YET!!!", "THE FAIR VERDICT IS STILL PENDING!!!",
    "VERDICT STILL PENDING!!!", "THE SIGNAL IS UNCLEAR!!!", "THIS REMAINS UNSETTLED!!!", "NO VERDICT YET!!!", "THE STORY IS OPEN!!!", "CONFIRMATION IS PENDING!!!", "THE OUTLIER STANDS ALONE!!!", "CLARITY IS STILL COMING!!!"
  ],
  baseline: [
    "THE STARTING LINE IS OFFICIALLY HERE!!!", "THIS STORY NOW HAS ITS FIRST POINT!!!", "THE BASELINE IS ON THE BOARD!!!", "THE DIRECTION IS STILL WIDE OPEN!!!",
    "THE TREND NOW HAS AN ANCHOR!!!", "THIS IS THE FIRST HONEST MARK!!!", "THE WEIGHT STORY HAS BEGUN!!!", "THE FIRST POINT IS REAL!!!",
    "THE SIGNAL HAS ITS STARTING PLACE!!!", "THE RUN HAS AN OFFICIAL BEGINNING!!!", "THIS BASELINE IS READY FOR CONTEXT!!!", "THE STORY HAS A CLEAN START!!!",
    "THE DATA NOW HAS A FIRST CHAPTER!!!", "THE LINE EXISTS NOW!!!", "THIS IS WHERE THE TREND BEGINS!!!", "THE FIRST NUMBER HAS LANDED!!!",
    "THE STORY HAS STARTED!!!", "THE BASELINE IS REAL!!!", "POINT ONE IS HERE!!!", "THE LINE NOW EXISTS!!!", "THE START IS SET!!!", "THE TREND HAS BEGUN!!!", "THIS IS THE ANCHOR!!!", "THE FIRST POINT LANDED!!!"
  ]
});

const FALLBACK_CLOSINGS = Object.freeze({
  "not-good-enough": [
    "TURN THE NEXT ARROW DOWN—LET’S GO!!!", "ANSWER THIS WITH THE NEXT CHECK!!!", "MAKE THE NEXT NUMBER PUSH BACK!!!", "THE COMEBACK STARTS WITH THIS MOVE!!!",
    "NOW FIGHT FOR THE TURN!!!", "PUT THE NEXT POINT BACK ON TRACK!!!", "THIS LINE CAN TURN—GO GET IT!!!", "THE RESPONSE STARTS NOW!!!",
    "MAKE THE NEXT WEIGH-IN ANSWER!!!", "RESET THE DIRECTION—COME ON!!!", "GO EARN THE DOWNWARD ARROW!!!", "THE NEXT POINT IS THE COMEBACK CHANCE!!!",
    "WE KNOW WHAT NEEDS TO CHANGE—COME ON!!!", ...WRITER_SAFE_CLOSINGS["not-good-enough"]
  ],
  "good-progress": [
    "KEEP STACKING DOWNWARD PROOF!!!", "PROTECT THIS DIRECTION—LET’S GO!!!", "MAKE THE NEXT POINT AGREE!!!", "PRESS THIS ADVANTAGE!!!",
    "KEEP THE GOOD SIGNAL MOVING!!!", "STACK ANOTHER RIGHT-WAY ARROW!!!", "THIS IS MOMENTUM—USE IT!!!", "GO COLLECT THE NEXT WIN!!!",
    "KEEP THE LINE WORKING FOR YOU!!!", "BUILD ON THIS RIGHT NOW!!!", "ONE MORE GOOD POINT—LET’S GO!!!", "HOLD THE RHYTHM AND KEEP PRESSING!!!", ...WRITER_SAFE_CLOSINGS["good-progress"]
  ],
  verify: [
    "CONFIRM IT, THEN WE JUDGE THE TREND!!!", "LET THE NEXT CLEAN CHECK SETTLE IT!!!", "VERIFY FIRST, THEN ATTACK THE REAL SIGNAL!!!", "ONE FAIR RECHECK COMES NEXT!!!",
    "MAKE THE NEXT READING THE TIEBREAKER!!!", "CONFIRM THE NUMBER BEFORE THE HYPE!!!", "THE NEXT CLEAN POINT GETS THE VERDICT!!!", "CHECK IT ONCE, THEN WE MOVE!!!",
    "ONE CONFIRMING POINT WILL CLEAR THIS UP!!!", "VERIFY THE SWING AND BRING THE REAL STORY!!!", "THE TREND WAITS FOR ONE CLEAN ANSWER!!!", "CONFIRMATION FIRST—THEN FULL ENERGY!!!", ...WRITER_SAFE_CLOSINGS.verify
  ],
  baseline: [
    "THE NEXT POINT GIVES THIS LINE DIRECTION!!!", "NOW GIVE THE BASELINE A STRONG FOLLOW-UP!!!", "THE TREND STARTS WITH THE NEXT CHECK!!!", "COME BACK AND MAKE THE DIRECTION LOUD!!!",
    "ONE MORE POINT TURNS DATA INTO MOMENTUM!!!", "THE NEXT WEIGH-IN STARTS THE REAL READ!!!", "BUILD THE LINE ONE HONEST POINT AT A TIME!!!", "NOW LET THE NEXT NUMBER MOVE THE STORY!!!",
    "THE FOLLOW-UP IS WHERE MOMENTUM BEGINS!!!", "BRING THE NEXT POINT AND WE READ THE TURN!!!", "THE START IS SET—NOW BUILD ON IT!!!", "NEXT CHECK, NEXT SIGNAL—LET’S GO!!!", ...WRITER_SAFE_CLOSINGS.baseline
  ]
});

function composeFallbackParagraph(opening, current, evidence, outlook, action, close, separators) {
  const clean = (value) => String(value || "").trim().replace(/[.!?]+$/g, "");
  const facts = [clean(current), clean(evidence), clean(outlook)].filter(Boolean);
  const factSeparators = [separators.currentEvidence, separators.evidenceOutlook];
  let body = `${clean(opening)}${separators.openingCurrent}${facts[0] || ""}`;
  for (let index = 1; index < facts.length; index += 1) body += `${factSeparators[index - 1] || ". "}${facts[index]}`;
  return `${body}. ${clean(action)}. ${String(close || "").trim()}`;
}

const FALLBACK_STRUCTURES = Object.freeze([
  (opening, current, evidence, outlook, action, close) => composeFallbackParagraph(opening, current, evidence, outlook, action, close, { openingCurrent: "—", currentEvidence: ". ", evidenceOutlook: ". " }),
  (opening, current, evidence, outlook, action, close) => composeFallbackParagraph(opening, current, evidence, outlook, action, close, { openingCurrent: ": ", currentEvidence: ". ", evidenceOutlook: ". " }),
  (opening, current, evidence, outlook, action, close) => composeFallbackParagraph(opening, current, evidence, outlook, action, close, { openingCurrent: ". ", currentEvidence: ". ", evidenceOutlook: ". " }),
  (opening, current, evidence, outlook, action, close) => composeFallbackParagraph(opening, current, evidence, outlook, action, close, { openingCurrent: "—", currentEvidence: "; ", evidenceOutlook: ". " }),
  (opening, current, evidence, outlook, action, close) => composeFallbackParagraph(opening, current, evidence, outlook, action, close, { openingCurrent: ": ", currentEvidence: "; ", evidenceOutlook: ". " }),
  (opening, current, evidence, outlook, action, close) => composeFallbackParagraph(opening, current, evidence, outlook, action, close, { openingCurrent: ". ", currentEvidence: "; ", evidenceOutlook: ". " }),
  (opening, current, evidence, outlook, action, close) => composeFallbackParagraph(opening, current, evidence, outlook, action, close, { openingCurrent: "—", currentEvidence: "—", evidenceOutlook: ". " }),
  (opening, current, evidence, outlook, action, close) => composeFallbackParagraph(opening, current, evidence, outlook, action, close, { openingCurrent: ": ", currentEvidence: "—", evidenceOutlook: ". " }),
  (opening, current, evidence, outlook, action, close) => composeFallbackParagraph(opening, current, evidence, outlook, action, close, { openingCurrent: ". ", currentEvidence: "—", evidenceOutlook: ". " }),
  (opening, current, evidence, outlook, action, close) => composeFallbackParagraph(opening, current, evidence, outlook, action, close, { openingCurrent: "—", currentEvidence: ". ", evidenceOutlook: "; " }),
  (opening, current, evidence, outlook, action, close) => composeFallbackParagraph(opening, current, evidence, outlook, action, close, { openingCurrent: ": ", currentEvidence: ". ", evidenceOutlook: "; " }),
  (opening, current, evidence, outlook, action, close) => composeFallbackParagraph(opening, current, evidence, outlook, action, close, { openingCurrent: ". ", currentEvidence: ". ", evidenceOutlook: "; " })
]);

function fallbackFactClauseVariants(context) {
  const currentWeight = trimCoachNumber(context.currentWeight);
  const change = context.changeDirection === "unchanged"
    ? "unchanged"
    : `${context.changeDirection} ${trimCoachNumber(Math.abs(context.latestDailyChange))} lb`;
  const current = [
    `${currentWeight} lb is ${change} today`,
    `Today’s ${currentWeight} lb reading is ${change}`,
    `The current result is ${currentWeight} lb, ${change} today`,
    `At ${currentWeight} lb, today’s result is ${change}`,
    `Today lands at ${currentWeight} lb and is ${change}`,
    `The latest reading is ${currentWeight} lb and ${change}`
  ];
  const evidence = context.strongestEvidence;
  const relation = evidence.kind === "window-acceleration"
    ? ["accelerated from the prior read", "accelerated beyond the earlier signal", "accelerated versus the previous window", "accelerated and strengthened from before"]
    : ({
      strengthened: ["stronger than before", "strengthened versus the prior read", "grew stronger than the earlier signal", "a stronger signal than the prior context"],
      eased: ["weaker than before", "eased versus the prior read", "softened from the earlier signal", "a weaker signal than the prior context"],
      reversed: ["reversed from before", "flipped from the earlier direction", "turned against the prior move", "a reversed signal versus the prior context"],
      held: ["similar to before", "steady against the prior read", "held near the earlier signal", "unchanged in strength from the prior context"],
      new: ["new against the prior context", "the first comparable signal", "new versus the earlier context", "a new read without a prior match"],
      contrasts: ["contrasting with the broader context", "a clear contrast with the broader read", "in contrast to the longer window", "contrasting against the broad signal"]
    }[context.evidenceRelation.kind] || ["new against the prior context"]);
  let evidenceText = [];
  const movement = trimCoachNumber(Math.abs(evidence.movement));
  if (evidence.kind === "baseline") {
    evidenceText = [
      "This first entry has no earlier movement to compare",
      "The baseline is new, with no prior movement for comparison",
      "This is the first reading, so earlier movement does not exist yet",
      "The opening entry supplies a new baseline rather than a trend"
    ];
  } else if (evidence.kind === "outlier") {
    evidenceText = relation.map((phrase, index) => [
      `The new 1-day outlier is ${evidence.direction} ${movement} lb and needs confirmation`,
      `A 1-day move of ${evidence.direction} ${movement} lb is a new outlier`,
      `The 1-day signal is ${evidence.direction} ${movement} lb, a new outlier needing confirmation`,
      `The new 1-day change is ${evidence.direction} ${movement} lb, an outlier rather than a settled trend`
    ][index % 4]);
  } else if (evidence.kind === "reversal") {
    evidenceText = relation.map((phrase, index) => [
      `The 1-day move reversed to ${evidence.direction} ${movement} lb from the prior direction`,
      `The earlier direction flipped, with the 1-day move now ${evidence.direction} ${movement} lb`,
      `A 1-day move of ${evidence.direction} ${movement} lb reversed the earlier direction`,
      `The prior direction turned, and the 1-day movement is ${evidence.direction} ${movement} lb`
    ][index % 4]);
  } else if (evidence.kind === "streak") {
    evidenceText = relation.map((phrase, index) => [
      `The ${evidence.count}-entry streak is ${evidence.direction} ${movement} lb and ${phrase}`,
      `Across the ${evidence.count}-entry streak, weight moved ${evidence.direction} ${movement} lb and the signal is ${phrase}`,
      `A ${evidence.count}-entry streak now runs ${evidence.direction} ${movement} lb and is ${phrase}`,
      `The ${evidence.count}-entry streak moved ${evidence.direction} ${movement} lb and the signal is ${phrase}`
    ][index % 4]);
  } else if (evidence.kind === "short-broad-contrast") {
    const comparisonDirection = evidence.comparisonMovement < 0 ? "down" : "up";
    const comparison = trimCoachNumber(Math.abs(evidence.comparisonMovement));
    evidenceText = [
      `The 3-day move is ${evidence.direction} ${movement} lb, contrasting with ${comparisonDirection} ${comparison} lb over ${evidence.comparisonWindowDays} days`,
      `A 3-day move of ${evidence.direction} ${movement} lb contrasts with ${comparisonDirection} ${comparison} lb across ${evidence.comparisonWindowDays} days`,
      `The contrast is clear: the 3-day move is ${evidence.direction} ${movement} lb versus ${comparisonDirection} ${comparison} lb over ${evidence.comparisonWindowDays} days`,
      `Across the 3-day window, ${evidence.direction} ${movement} lb contrasts with ${comparisonDirection} ${comparison} lb through ${evidence.comparisonWindowDays} days`
    ];
  } else {
    evidenceText = relation.map((phrase, index) => [
      `The ${evidence.windowDays}-day weight change is ${evidence.direction} ${movement} lb and ${phrase}`,
      `Across the ${evidence.windowDays}-day window, weight is ${evidence.direction} ${movement} lb and the signal is ${phrase}`,
      `${evidence.windowDays}-day evidence is ${evidence.direction} ${movement} lb and the signal is ${phrase}`,
      `The ${evidence.windowDays}-day result is ${evidence.direction} ${movement} lb and is ${phrase}`
    ][index % 4]);
  }
  const roundedOutlook = Math.round(context.outlook);
  const outlook = context.includeOutlook ? ({
    worsened: [
      `The 1-year trend outlook worsened to about ${roundedOutlook} lb`,
      `The 1-year trend outlook moved the wrong way to about ${roundedOutlook} lb`,
      `A worsened 1-year trend outlook now reads about ${roundedOutlook} lb`,
      `About ${roundedOutlook} lb is now the worsened 1-year trend outlook`
    ],
    improved: [
      `The 1-year trend outlook improved to about ${roundedOutlook} lb`,
      `The improved 1-year trend outlook now points to about ${roundedOutlook} lb`,
      `A better 1-year trend outlook now reads about ${roundedOutlook} lb`,
      `About ${roundedOutlook} lb is now the improved 1-year trend outlook`
    ],
    held: [
      `The 1-year trend outlook held at about ${roundedOutlook} lb`,
      `A steady 1-year trend outlook reads about ${roundedOutlook} lb`,
      `The 1-year trend outlook remains steady at about ${roundedOutlook} lb`,
      `About ${roundedOutlook} lb is where the 1-year trend outlook held steady`
    ]
  }[context.outlookDirection] || [`The 1-year trend outlook is holding at about ${roundedOutlook} lb`]) : [""];
  return { current, evidence: evidenceText, outlook };
}

function fallbackFactClauses(context) {
  const variants = fallbackFactClauseVariants(context);
  return { current: variants.current[0], evidence: variants.evidence[0], outlook: variants.outlook[0] };
}

function coachPresentationSeed(context) {
  return crypto.createHash("sha256").update(JSON.stringify({
    measurementAt: context.measurementAt,
    currentWeight: Number(trimCoachNumber(context.currentWeight)),
    latestDailyChange: Number(trimCoachNumber(context.latestDailyChange)),
    changeDirection: context.changeDirection,
    verdict: context.verdict,
    strongestEvidence: context.analysisPlan?.strongestEvidence || context.strongestEvidence,
    relationToPrior: context.evidenceRelation?.kind,
    outlook: context.includeOutlook ? Number(context.outlook.toFixed(3)) : null,
    outlookDirection: context.includeOutlook ? context.outlookDirection : null,
    trackerModifier: context.trackerModifier?.type || null,
    preference: context.preference?.kind || null,
    actionSemantic: context.actionSemantic
  })).digest("hex");
}

function tokenWords(text) {
  return String(text || "").normalize("NFKC").toLowerCase().match(/[a-z0-9]+/g) || [];
}

function openingFingerprint(text) {
  return tokenWords(String(text || "").split(/[—:.!?]/, 1)[0]).slice(0, 10).join(" ");
}

function closingFingerprint(text) {
  const sentences = String(text || "").split(/[.!?]+/).map((part) => part.trim()).filter(Boolean);
  return tokenWords(sentences.at(-1) || "").slice(-10).join(" ");
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

function containsAdditionalBehaviorAction(text) {
  const value = String(text || "");
  const knownHype = [...Object.values(FALLBACK_OPENINGS).flat(), ...Object.values(FALLBACK_CLOSINGS).flat()]
    .sort((left, right) => right.length - left.length);
  let remainder = value;
  for (const phrase of knownHype) {
    let index = remainder.toLowerCase().indexOf(phrase.toLowerCase());
    while (index !== -1) {
      remainder = `${remainder.slice(0, index)} ${remainder.slice(index + phrase.length)}`;
      index = remainder.toLowerCase().indexOf(phrase.toLowerCase());
    }
  }
  if (/\b(?:accountab\w*|breath\w*|call\w*|climb\w*|dinner|drink|hydrate|water|eat|eating|food|meal|order\w*|snack|stair\w*|stand\w*|calorie|protein|vegetable|fruit|walk|walking|run|running|jog|exercise|workout|train|training|squat|lunge|lift|cycle|swim|stretch|sleep|bedtime|fast|skip|restrict|purge|track|log|cook|prepare|pack|portion)\w*\b/i.test(remainder)
    || /\bweigh(?:ed|ing|s)?\b/i.test(remainder)) return true;
  if (/\b(?:you\s+(?:should|must|need\s+to|ought\s+to)|should|must|ought\s+to|need\s+to|try(?:ing)?\b|consider(?:ing)?\b|aim\s+to|remember\s+to|(?:it\s+)?would\s+help(?:\s+to)?|could\s+help|helps?\s+(?:with|by|to)|make\s+sure\s+to|be\s+sure\s+to|commit\s+to)\b/i.test(remainder)) return true;
  if (/(?:^|[.!?;,—]\s*)(?:taking|standing|calling|breathing|climbing|ordering|planning|preparing|walking|running|exercising)\b/i.test(remainder)) return true;
  const imperativeStarts = new Set([
    "add", "anchor", "avoid", "breathe", "bring", "build", "call", "change", "choose", "cook", "count", "cut", "decide", "do", "drink",
    "eat", "exercise", "fill", "get", "give", "grab", "have", "hydrate", "leave", "let", "lift", "log", "make", "move", "order", "pack", "pair",
    "keep", "pause", "pick", "plan", "plate", "prepare", "put", "repeat", "replace", "rest", "run", "save", "serve", "set", "sit", "skip", "sleep", "slow",
    "snack", "stand", "start", "stop", "stretch", "swap", "take", "track", "train", "try", "consider", "use", "walk", "weigh", "write"
  ]);
  return remainder.split(/[.!?;,—]+/).some((clause) => {
    const words = tokenWords(clause);
    while (["now", "please", "today", "next", "then"].includes(words[0])) words.shift();
    return imperativeStarts.has(words[0]);
  });
}

function structuralFingerprint(text, context) {
  let normalized = String(text || "").normalize("NFKC").toLowerCase();
  const recognized = [...PREFERENCE_ACTIONS, ...COACH_ACTION_CATALOG]
    .map((action) => action.text)
    .concat(Array.isArray(context?.actionRealizations) ? context.actionRealizations.map((realization) => realization.text) : [])
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const actionText of recognized) normalized = normalized.split(String(actionText).toLowerCase()).join(" action ");
  return normalized
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " date ")
    .replace(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/g, " date ")
    .replace(/[-+]?\d+(?:\.\d+)?\s*(?:lb|pounds?)\b/g, " weight ")
    .replace(/\b\d+-day\b/g, " window ")
    .replace(/\b\d+-entry\b/g, " streak ")
    .replace(/[-+]?\d+(?:\.\d+)?/g, " value ")
    .replace(/[^a-z]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trigramSet(text, context) {
  const words = structuralFingerprint(text, context).split(" ").filter(Boolean);
  const rows = new Set();
  for (let index = 0; index + 2 < words.length; index += 1) rows.add(words.slice(index, index + 3).join(" "));
  return rows;
}

function trigramSimilarity(left, right, context) {
  const a = trigramSet(left, context);
  const b = trigramSet(right, context);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return (2 * overlap) / (a.size + b.size);
}

function noveltyErrors(text, context, previousMessages = [], selectedAction = identifyApprovedAction(text, context)) {
  const openingRecent = (previousMessages || []).slice(0, 6);
  const structuralRecent = (previousMessages || []).slice(0, 10);
  const actionRecent = (previousMessages || []).slice(0, COACH_COOLDOWN_COUNT);
  const errors = [];
  const opening = openingFingerprint(text);
  const closing = closingFingerprint(text);
  const structure = structuralFingerprint(text, context);
  if (openingRecent.some((message) => opening && openingFingerprint(message.text || message) === opening)) errors.push("repeat-opening");
  if (openingRecent.some((message) => closing && closingFingerprint(message.text || message) === closing)) errors.push("repeat-closing");
  if (structuralRecent.some((message) => structuralFingerprint(message.text || message, context) === structure)) errors.push("repeat-structure");
  if (structuralRecent.some((message) => trigramSimilarity(text, message.text || message, context) >= 0.72)) errors.push("repeat-trigrams");
  const recentActions = actionRecent.map(inferActionMetadata).filter(Boolean);
  if (selectedAction && recentActions.some((action) => action.text === selectedAction.text)) errors.push("action-cooldown");
  if (selectedAction && recentActions.some((action) => action.semantic === selectedAction.semantic)) errors.push("action-semantic-cooldown");
  return Array.from(new Set(errors));
}

function buildContextualFallbackCandidates(context, previousMessages = [], limit = 1, options = {}) {
  const requestedLimit = Math.max(1, Math.min(24, Number(limit) || 1));
  if (!context) {
    const text = "WEIGH-IN SAVED—THE DATA IS HERE, AND THE NEXT CONSISTENT CHECK WILL MAKE THE DIRECTION CLEARER. Build the next meal around protein, vegetables, and a satisfying portion. KEEP SHOWING UP FOR THE TREND—LET’S GO!!!";
    return [{ text, structureId: "empty", errors: [], wordCount: coachWordCount(text) }];
  }
  const openings = options.writerSafe
    ? (WRITER_SAFE_OPENINGS[context.verdict] || WRITER_SAFE_OPENINGS["not-good-enough"])
    : (FALLBACK_OPENINGS[context.verdict] || FALLBACK_OPENINGS["not-good-enough"]);
  const closings = options.writerSafe
    ? (WRITER_SAFE_CLOSINGS[context.verdict] || WRITER_SAFE_CLOSINGS["not-good-enough"])
    : (FALLBACK_CLOSINGS[context.verdict] || FALLBACK_CLOSINGS["not-good-enough"]);
  const facts = fallbackFactClauseVariants(context);
  const presentationSeed = coachPresentationSeed(context);
  const start = stableIndex(`${presentationSeed}|fallback`, FALLBACK_STRUCTURES.length);
  const rejectionCounts = {};
  const recentOpeningFingerprints = new Set(previousMessages.slice(0, 6).map((message) => openingFingerprint(message.text || message)));
  const recentClosingFingerprints = new Set(previousMessages.slice(0, 6).map((message) => closingFingerprint(message.text || message)));
  const actionRows = context.actionRealizations || [{ id: context.actionId, text: context.action }];
  const allEligibleOpenings = rotateCandidates(openings
    .map((text, index) => ({ text, index }))
    .filter((entry) => !recentOpeningFingerprints.has(openingFingerprint(entry.text))), `${presentationSeed}|opening-axis`);
  const allEligibleClosings = rotateCandidates(closings
    .map((text, index) => ({ text, index }))
    .filter((entry) => !recentClosingFingerprints.has(closingFingerprint(entry.text))), `${presentationSeed}|closing-axis`);
  const axisLimit = Math.max(6, Number(options.axisLimit) || 6);
  const eligibleOpenings = allEligibleOpenings.slice(0, axisLimit);
  const eligibleClosings = allEligibleClosings.slice(0, axisLimit);
  const scheduled = [];
  const structureCount = FALLBACK_STRUCTURES.length;
  for (let structureOffset = 0; structureOffset < structureCount; structureOffset += 1) {
    const structureIndex = (start + structureOffset) % FALLBACK_STRUCTURES.length;
    for (const openingEntry of eligibleOpenings) {
      for (const closingEntry of eligibleClosings) {
        for (let factOffset = 0; factOffset < 4; factOffset += 1) {
          const currentIndex = (structureOffset * 5 + factOffset) % facts.current.length;
          const evidenceIndex = (structureOffset * 7 + factOffset * 3) % facts.evidence.length;
          const outlookIndex = (structureOffset * 11 + factOffset * 5) % facts.outlook.length;
          for (let actionOffset = 0; actionOffset < actionRows.length; actionOffset += 1) {
            const realization = actionRows[actionOffset];
            const text = normalizeCoachParagraph(FALLBACK_STRUCTURES[structureIndex](
              openingEntry.text,
              facts.current[currentIndex],
              facts.evidence[evidenceIndex],
              facts.outlook[outlookIndex],
              realization.text,
              closingEntry.text
            ));
            const wordCount = coachWordCount(text);
            if (wordCount < COACH_MIN_WORDS || wordCount > COACH_MAX_WORDS) {
              rejectionCounts["word-count"] = (rejectionCounts["word-count"] || 0) + 1;
              continue;
            }
            const structureId = `${context.verdict}-${structureIndex + 1}-${openingEntry.index + 1}-${closingEntry.index + 1}-${currentIndex + 1}-${evidenceIndex + 1}-${outlookIndex + 1}-${actionOffset + 1}`;
            scheduled.push({
              text,
              structureId,
              scheduleRank: stableIndex(`${presentationSeed}|${structureId}`, 0x7fffffff)
            });
          }
        }
      }
    }
  }
  scheduled.sort((left, right) => left.scheduleRank - right.scheduleRank || left.structureId.localeCompare(right.structureId));
  const validationBatchSize = 192;
  const selectedCandidates = [];
  const selectedOpenings = new Set();
  const selectedClosings = new Set();
  const selectedStructures = new Set();
  for (let batchStart = 0; batchStart < scheduled.length; batchStart += validationBatchSize) {
    const validCandidates = [];
    for (const candidate of scheduled.slice(batchStart, batchStart + validationBatchSize)) {
      const validation = validateCoachParagraph(candidate.text, context, previousMessages, { privateGoal: NaN });
      if (!validation.ok) {
        for (const error of validation.errors) rejectionCounts[error] = (rejectionCounts[error] || 0) + 1;
        continue;
      }
      const priorSimilarities = previousMessages.slice(0, 10).map((message) => trigramSimilarity(validation.text, message.text || message, context));
      validCandidates.push({
        text: validation.text,
        structureId: candidate.structureId,
        action: validation.action,
        errors: [],
        wordCount: validation.wordCount,
        maxPriorSimilarity: priorSimilarities.length ? Math.max(...priorSimilarities) : 0
      });
    }
    validCandidates.sort((left, right) => left.maxPriorSimilarity - right.maxPriorSimilarity || left.structureId.localeCompare(right.structureId) || left.text.localeCompare(right.text));
    for (const candidate of validCandidates) {
      const opening = openingFingerprint(candidate.text);
      const closing = closingFingerprint(candidate.text);
      const structure = structuralFingerprint(candidate.text, context);
      if (selectedOpenings.has(opening) || selectedClosings.has(closing) || selectedStructures.has(structure)) continue;
      const siblingErrors = noveltyErrors(candidate.text, context, selectedCandidates.map((entry) => ({
        text: entry.text,
        actionId: entry.action?.id,
        actionSemantic: entry.action?.semantic,
        actionText: entry.action?.text
      })), candidate.action).filter((error) => error !== "action-cooldown" && error !== "action-semantic-cooldown");
      if (siblingErrors.length) continue;
      selectedCandidates.push(candidate);
      selectedOpenings.add(opening);
      selectedClosings.add(closing);
      selectedStructures.add(structure);
      if (selectedCandidates.length >= requestedLimit) return selectedCandidates;
    }
  }
  const maxAxisLimit = Math.max(allEligibleOpenings.length, allEligibleClosings.length);
  if (selectedCandidates.length < requestedLimit && axisLimit < maxAxisLimit) {
    return buildContextualFallbackCandidates(context, previousMessages, requestedLimit, {
      ...options,
      axisLimit: Math.min(maxAxisLimit, axisLimit + 4)
    });
  }
  if (selectedCandidates.length) return selectedCandidates;
  throw new Error(`no compliant contextual fallback invariant: ${Object.entries(rejectionCounts).sort((left, right) => right[1] - left[1]).slice(0, 5).map(([key, count]) => `${key}=${count}`).join(",")}`);
}

function buildContextualFallbackResult(context, previousMessages = []) {
  return buildContextualFallbackCandidates(context, previousMessages, 1)[0];
}

function buildContextualFallback(context, previousMessages = []) {
  return buildContextualFallbackResult(context, previousMessages).text;
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

function coachSentenceScopes(text) {
  return String(text || "")
    .split(/(?:[!?]+|(?<!\d)\.(?!\d))/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function coachClaimScopes(text) {
  const outlookBoundary = /(?:[,;—]\s*|\b(?:and|while|but)\s+)(?=(?:the\s+|a\s+|about\s+)?(?:(?:worsened|improved|better|steady|held|wrong[- ]way)\s+)?(?:1-year\s+trend\s+)?outlook\b)/i;
  return coachSentenceScopes(text)
    .flatMap((sentence) => sentence.split(outlookBoundary))
    .map((part) => part.trim())
    .filter(Boolean);
}

function movementClaimPattern(direction, movement) {
  return new RegExp(`\\b${direction}\\s+${trimCoachNumber(Math.abs(movement)).replace(".", "\\.")}\\s+lb\\b`, "i");
}

function evidenceClaimMatches(scope, context) {
  const evidence = context?.strongestEvidence;
  if (!evidence || context.verdict === "baseline") return true;
  if (!movementClaimPattern(evidence.direction, evidence.movement).test(scope)) return false;
  const relationPattern = {
    strengthened: /\b(?:accelerat\w*|stronger|strengthened|worse|worsened|grew|intensif\w*)\b/i,
    eased: /\b(?:weaker|eased|easier|soften\w*)\b/i,
    reversed: /\b(?:reversed|flipped|turned)\b/i,
    held: /\b(?:similar|steady|held|unchanged)\b/i,
    new: /\b(?:new|first|outlier)\b/i,
    contrasts: /\bcontrast\w*\b/i
  }[context.evidenceRelation?.kind];
  if (relationPattern && !relationPattern.test(scope)) return false;
  if (evidence.kind === "streak") {
    return scope.includes(`${evidence.count}-entry`) && /\bstreak\b/i.test(scope);
  }
  if (evidence.kind === "short-broad-contrast") {
    const comparisonDirection = evidence.comparisonMovement < 0 ? "down" : "up";
    return scope.includes("3-day")
      && scope.includes(`${evidence.comparisonWindowDays} days`)
      && movementClaimPattern(comparisonDirection, evidence.comparisonMovement).test(scope)
      && /\bcontrast\w*\b/i.test(scope);
  }
  return scope.includes(`${evidence.windowDays}-day`)
    && (evidence.kind !== "outlier" || /\boutlier\b/i.test(scope));
}

function outlookClaimMatches(scope, context) {
  if (!context?.includeOutlook || !/\boutlook\b/i.test(scope) || !scope.includes(`about ${Math.round(context.outlook)} lb`)) return false;
  const directionPattern = {
    worsened: /\b(?:wrong way|worsen\w*)\b/i,
    improved: /\b(?:improv\w*|better)\b/i,
    held: /\b(?:held|steady|holding)\b/i
  }[context.outlookDirection];
  return !directionPattern || directionPattern.test(scope);
}

function approvedCoachCopyComponents(context) {
  const facts = fallbackFactClauseVariants(context);
  return {
    openings: FALLBACK_OPENINGS[context?.verdict] || FALLBACK_OPENINGS["not-good-enough"],
    currentFacts: facts.current,
    evidenceFacts: facts.evidence,
    outlookFacts: context?.includeOutlook ? facts.outlook.filter(Boolean) : [],
    modifiers: context?.trackerModifier?.text ? [context.trackerModifier.text] : [],
    closings: FALLBACK_CLOSINGS[context?.verdict] || FALLBACK_CLOSINGS["not-good-enough"]
  };
}

function closedCoachGrammarErrors(text, context, selectedAction) {
  if (!context || !selectedAction?.text) return ["closed-copy-grammar"];
  const components = approvedCoachCopyComponents(context);
  const source = String(text || "").normalize("NFKC");
  const lower = source.toLowerCase();
  const errors = [];
  if (source.includes("?")) errors.push("closed-fact-question");
  const slot = (name, rows, required = true) => {
    const matches = rows
      .filter((component) => countLiteralOccurrences(source, component) === 1)
      .map((component) => {
        const start = lower.indexOf(component.toLowerCase());
        return { name, text: component, start, end: start + component.length };
      });
    if (matches.length !== 1) {
      if (required || matches.length > 1) errors.push(`closed-${name}`);
      return null;
    }
    return matches[0];
  };
  const opening = slot("opening", components.openings);
  const current = slot("current-fact", components.currentFacts);
  const evidence = slot("evidence-fact", components.evidenceFacts);
  const outlook = components.outlookFacts.length ? slot("outlook-fact", components.outlookFacts) : null;
  let modifier = null;
  if (components.modifiers.length) modifier = slot("modifier", components.modifiers, false);
  const actionStart = lower.indexOf(selectedAction.text.toLowerCase());
  const action = actionStart >= 0 ? { name: "action", text: selectedAction.text, start: actionStart, end: actionStart + selectedAction.text.length } : null;
  if (!action) errors.push("closed-action");
  const closing = slot("closing", components.closings);
  const ordered = [opening, current, evidence, outlook, modifier, action, closing].filter(Boolean);
  if (ordered.length >= 2) {
    if (source.slice(0, ordered[0].start).trim() || source.slice(ordered.at(-1).end).trim()) errors.push("closed-copy-residue");
    for (let index = 1; index < ordered.length; index += 1) {
      const prior = ordered[index - 1];
      const next = ordered[index];
      if (prior.end > next.start) {
        errors.push("closed-slot-order");
        continue;
      }
      const separator = source.slice(prior.end, next.start);
      const isOpeningBoundary = prior.name === "opening" && next.name === "current-fact";
      const allowed = isOpeningBoundary
        ? /^\s*(?:—|–|:|\.)\s*$/.test(separator)
        : next.name === "action"
          ? /^\s*\.\s*$/.test(separator)
          : prior.name === "action"
            ? /^\s*$/.test(separator)
          : /^\s*(?:\.|;|—|–)\s*$/.test(separator);
      if (!allowed) errors.push(`closed-separator-${prior.name}-${next.name}`);
    }
  }
  const expectedNames = ["opening", "current-fact", "evidence-fact", ...(outlook ? ["outlook-fact"] : []), ...(modifier ? ["modifier"] : []), "action", "closing"];
  if (ordered.map((entry) => entry.name).join("|") !== expectedNames.join("|")) errors.push("closed-slot-order");
  return Array.from(new Set(errors));
}

function validateCoachParagraph(text, context, previousMessages = [], options = {}) {
  const paragraph = normalizeCoachParagraph(text);
  const errors = [];
  const words = coachWordCount(paragraph);
  if (/[\r\n]/.test(String(text || ""))) errors.push("multiline");
  if (words < COACH_MIN_WORDS || words > COACH_MAX_WORDS) errors.push("word-count");
  const unsafe = /\b(?:obese|fat|body|lazy|disgusting|failure|worthless|worth|bmi|jyp|korean idol|fast|fasting|starve|starving|skip(?:ping)?(?:\s+(?:a|the))?\s+meals?|purge|purging|compensat\w*|punish\w*|restrict\w*|under-?eat\w*|overexercis\w*|excessive exercise|depriv\w*|guilt|shame|diagnos\w*|depress\w*)\b/i;
  if (unsafe.test(paragraph)) errors.push("unsafe-language");
  if (/\b(?:horn\w*|sex(?:ual)?|ovulat\w*|conflict|phone|address|relationship|appearance)\b/i.test(paragraph)) errors.push("private-context-leak");
  if (/[\u00e2\u00c3\u00c2\ufffd]/.test(paragraph)) errors.push("mojibake");
  if (/\b(?:safety-held|high-safe-urgency|steady-safe)\b/i.test(paragraph)) errors.push("private-strategy-leak");
  if (/\b(?:goal|goal weight|internal target|target weight)\b/i.test(paragraph)) errors.push("goal-reference");
  if (/\b(?:period|cycle|menstrual)\b.{0,35}\b(?:caused?|made|explains?)\b|\b(?:caused?|made|explains?)\b.{0,35}\b(?:period|cycle|menstrual)\b/i.test(paragraph)) errors.push("period-causality");
  if (!context || !paragraph.includes(`${trimCoachNumber(context.currentWeight)} lb`)) errors.push("current-weight");
  if (context?.includeOutlook && !paragraph.includes(`about ${Math.round(context.outlook)} lb`)) errors.push("outlook-weight");
  if (context && !context.includeOutlook && /\b1-year trend outlook\b/i.test(paragraph)) errors.push("unsolicited-outlook");
  const actionMatch = context ? identifyApprovedAction(paragraph, context) : null;
  const recognizedActions = recognizedActionMatches(paragraph);
  if (context && !actionMatch) errors.push(recognizedActions.length > 1 ? "multiple-actions" : "required-action-realization");
  if (context) {
    const withoutSelectedAction = paragraph.replace(actionMatch?.text || "", "").replace(context.trackerModifier?.text || "", "");
    if (containsAdditionalBehaviorAction(withoutSelectedAction)) errors.push("extra-action");
    errors.push(...closedCoachGrammarErrors(paragraph, context, actionMatch));
  }
  const currentClaim = context ? coachSentenceScopes(paragraph).find((scope) => {
    if (!scope.includes(`${trimCoachNumber(context.currentWeight)} lb`)) return false;
    if (context.changeDirection === "unchanged") return /\b(?:unchanged|same|flat)\b/i.test(scope);
    return movementClaimPattern(context.changeDirection, context.latestDailyChange).test(scope);
  }) : null;
  if (context && !currentClaim) errors.push("current-claim");
  if (context?.includeOutlook && !coachClaimScopes(paragraph).some((scope) => outlookClaimMatches(scope, context))) errors.push("outlook-claim");
  if (context && context.verdict !== "baseline") {
    if (!coachClaimScopes(paragraph).some((scope) => evidenceClaimMatches(scope, context))) errors.push("evidence-claim");
  }
  const leadVerdict = paragraph.slice(0, 150);
  const verdictPattern = context && {
    "not-good-enough": /\b(?:not good enough|wrong[- ]way|needs? (?:work|a response|attention|a correction|to change)|setback|regression|worsen\w*|course correction|red flag|bad signal|pushed back|does not get a pass|moving (?:the )?wrong way)\b/i,
    "good-progress": /\b(?:real progress|right way|a win|strong progress|moving our way|got better|improv\w*|positive signal|lower and moving|landed the right way|momentum)\b/i,
    verify: /\b(?:pause|verify|confirmation|confirm\w*|outlier|recheck|too extreme to trust|on hold|curved?ball|tie[ -]?breaker)\b/i,
    baseline: /\b(?:baseline|starting (?:line|point)|first (?:number|weigh-in|data point|anchor)|where the line begins|trend has its first|day one)\b/i
  }[context.verdict];
  if (verdictPattern && !verdictPattern.test(leadVerdict)) errors.push("verdict");
  if (context?.verdict === "not-good-enough" && /\b(?:amazing|awesome|great job|a win|approved)\b/i.test(paragraph)) errors.push("verdict-conflict");
  if (context?.verdict === "good-progress" && /\b(?:not good enough|not approved|failure|bad result)\b/i.test(paragraph)) errors.push("verdict-conflict");
  const allowedNumbers = context ? [
    1, 3, 7, 14, 28,
    Number(trimCoachNumber(context.currentWeight)),
    Math.round(context.outlook),
    Number(context.outlook.toFixed(1)),
    Number(trimCoachNumber(Math.abs(context.latestDailyChange))),
    Number(context.strongestEvidence?.windowDays),
    Number(trimCoachNumber(Math.abs(context.strongestEvidence?.movement))),
    Number(context.strongestEvidence?.count),
    Number(context.strongestEvidence?.comparisonWindowDays),
    Number(trimCoachNumber(Math.abs(context.strongestEvidence?.comparisonMovement))),
    Number(context.streak?.count),
    ...Object.values(context.movements || {}).map((movement) => Number(trimCoachNumber(Math.abs(movement))))
  ] : [];
  for (const number of numericTokens(paragraph)) {
    if (!allowedNumbers.some((allowed) => Number.isFinite(allowed) && Math.abs(allowed - number) < 0.001)) {
      errors.push("unsupported-number");
      break;
    }
  }
  const hiddenGoal = Number(options.privateGoal);
  if (Number.isFinite(hiddenGoal) && numericTokens(paragraph).some((number) => Math.abs(number - hiddenGoal) < 0.001)) errors.push("goal-leak");
  errors.push(...noveltyErrors(paragraph, context, previousMessages, actionMatch));
  return { ok: errors.length === 0, errors: Array.from(new Set(errors)), text: paragraph, wordCount: words, action: actionMatch };
}

async function requestCoachResponse(input, options = {}) {
  const apiKey = Object.prototype.hasOwnProperty.call(options, "apiKey") ? options.apiKey : openaiApiKey;
  if (!apiKey) throw new Error("coach model unavailable");
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Number(options.timeoutMs || coachGenerationTimeoutMs));
  let timeoutId;
  try {
    const timeout = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error("coach model timeout"));
      }, timeoutMs);
    });
    const requestBody = {
      model: options.model || chatModel,
      input,
      max_output_tokens: Number(options.maxOutputTokens || 520)
    };
    if (options.schema) {
      requestBody.text = {
        format: {
          type: "json_schema",
          name: options.schemaName || "lily_coach_output",
          strict: true,
          schema: options.schema
        }
      };
    }
    const request = fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify(requestBody)
    });
    const response = await Promise.race([request, timeout]);
    if (!response.ok) throw new Error("coach model request failed");
    return responseText(await response.json());
  } finally {
    clearTimeout(timeoutId);
  }
}

function coachWriterSchema(candidatePool) {
  const allowedTexts = Array.from(new Set((candidatePool || []).map((candidate) => candidate.text || candidate).filter(Boolean)));
  return {
    type: "object",
    additionalProperties: false,
    required: ["candidates"],
    properties: {
      candidates: {
        type: "array",
        minItems: COACH_CANDIDATE_COUNT,
        maxItems: COACH_CANDIDATE_COUNT,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: { text: { type: "string", enum: allowedTexts } }
        }
      }
    }
  };
}

const COACH_CRITIC_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["approved", "selectedIndex", "reasonCode", "checks"],
  properties: {
    approved: { type: "boolean" },
    selectedIndex: { type: "integer", minimum: -1, maximum: COACH_CANDIDATE_COUNT - 1 },
    reasonCode: { type: "string" },
    checks: {
      type: "object",
      additionalProperties: false,
      required: ["facts", "evidence", "verdict", "actionCompliance", "privacySafety", "originality"],
      properties: {
        facts: { type: "boolean" },
        evidence: { type: "boolean" },
        verdict: { type: "boolean" },
        actionCompliance: { type: "boolean", description: "Set true to PASS when the selected candidate has exactly one tagged instruction and zero other concrete behavior instructions; factual weight-change language and declarative hype are not instructions." },
        privacySafety: { type: "boolean" },
        originality: { type: "boolean" }
      }
    }
  }
});

function parseStructuredJson(text) {
  try {
    return JSON.parse(String(text || "").replace(/^```json\s*|\s*```$/gi, "").trim());
  } catch (error) {
    return null;
  }
}

function parseWriterCandidates(text) {
  const parsed = parseStructuredJson(text);
  if (!parsed || !Array.isArray(parsed.candidates)) return [];
  return parsed.candidates.slice(0, COACH_CANDIDATE_COUNT).map((candidate) => normalizeCoachParagraph(candidate?.text)).filter(Boolean);
}

function safeDiagnosticCode(value, fallback = "unknown") {
  const code = String(value || fallback).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return code || fallback;
}

function parseCriticResult(text, candidateCount = COACH_CANDIDATE_COUNT) {
  const parsed = parseStructuredJson(text);
  if (!parsed || typeof parsed.approved !== "boolean" || !Number.isInteger(parsed.selectedIndex) || !parsed.checks || typeof parsed.checks !== "object") {
    return { valid: false, approved: false, selectedIndex: -1, reasonCode: "critic-format", checks: {} };
  }
  const checkFields = {
    facts: "facts",
    evidence: "evidence",
    verdict: "verdict",
    oneAction: "actionCompliance",
    privacySafety: "privacySafety",
    originality: "originality"
  };
  const checksPass = Object.values(checkFields).every((field) => parsed.checks[field] === true);
  const selectedValid = parsed.selectedIndex >= 0 && parsed.selectedIndex < candidateCount;
  const approved = parsed.approved === true && checksPass && selectedValid;
  return {
    valid: true,
    approved,
    selectedIndex: selectedValid ? parsed.selectedIndex : -1,
    reasonCode: safeDiagnosticCode(parsed.reasonCode, approved ? "approved" : (checksPass ? "critic-rejected" : "critic-check-failed")),
    checks: Object.fromEntries(Object.entries(checkFields).map(([key, field]) => [key, parsed.checks[field] === true]))
  };
}

function publicCoachFacts(context) {
  return {
    analysis: context.analysisPlan,
    periodModifier: context.trackerModifier?.text || null,
    urgency: context.hiddenStrategy === "high-safe-urgency" ? "high but safe" : context.hiddenStrategy === "safety-held" ? "firm and safety-conscious" : "steady and safe",
    approvedCopyComponents: approvedCoachCopyComponents(context)
  };
}

function criticCoachFacts(context) {
  return {
    verdict: context.analysisPlan.verdict,
    current: context.analysisPlan.current,
    strongestEvidence: context.analysisPlan.strongestEvidence,
    relationToPrior: context.analysisPlan.relationToPrior,
    outlook: context.analysisPlan.outlook,
    periodModifier: context.trackerModifier?.text || null,
    urgency: context.hiddenStrategy === "high-safe-urgency" ? "high but safe" : context.hiddenStrategy === "safety-held" ? "firm and safety-conscious" : "steady and safe"
  };
}

function recentCoachAvoidance(previousMessages = []) {
  const recentActions = previousMessages.slice(0, COACH_COOLDOWN_COUNT).map(inferActionMetadata).filter(Boolean);
  return {
    openings: previousMessages.slice(0, 6).map((message) => openingFingerprint(message.text || message)).filter(Boolean),
    closings: previousMessages.slice(0, 6).map((message) => closingFingerprint(message.text || message)).filter(Boolean),
    structuralFingerprints: previousMessages.slice(0, 10).map((message) => structuralFingerprint(message.text || message, null)).filter(Boolean),
    orderedTrigrams: previousMessages.slice(0, 10).map((message) => Array.from(trigramSet(message.text || message, null))),
    recentActionSentences: recentActions.map((action) => action.text).filter(Boolean),
    recentActionMeanings: recentActions.map((action) => action.semantic).filter(Boolean)
  };
}

function criticCandidatePayload(candidate, context = null, previousMessages = []) {
  const text = String(candidate?.text || "");
  const actionText = String(candidate?.action?.text || "");
  const start = actionText ? text.indexOf(actionText) : -1;
  const similarities = previousMessages.slice(0, 10).map((message) => trigramSimilarity(text, message.text || message, context));
  const novelty = noveltyErrors(text, context, previousMessages, candidate?.action || null);
  const payload = {
    annotatedText: start < 0 ? text : `${text.slice(0, start)}<approved_action>${actionText}</approved_action>${text.slice(start + actionText.length)}`,
    verdictEvidence: {
      expectedFamily: context?.verdict || null,
      approvedFamilyOpening: Boolean(context && (WRITER_SAFE_OPENINGS[context.verdict] || []).some((opening) => text.startsWith(opening)))
    },
    originalityEvidence: {
      openingFresh: !novelty.includes("repeat-opening"),
      closingFresh: !novelty.includes("repeat-closing"),
      structureFresh: !novelty.includes("repeat-structure"),
      actionCooldownPass: !novelty.includes("action-cooldown") && !novelty.includes("action-semantic-cooldown"),
      maxOrderedTrigramSimilarity: similarities.length ? Number(Math.max(...similarities).toFixed(3)) : 0,
      rejectionThreshold: 0.72
    }
  };
  return {
    ...payload
  };
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

function sanitizeCriticResult(value) {
  if (!value || typeof value !== "object") return null;
  const checkKeys = ["facts", "evidence", "verdict", "oneAction", "privacySafety", "originality"];
  return {
    valid: value.valid === true,
    approved: value.approved === true,
    selectedIndex: Number.isInteger(value.selectedIndex) ? value.selectedIndex : -1,
    reasonCode: safeDiagnosticCode(value.reasonCode, "not-run"),
    checks: Object.fromEntries(checkKeys.map((key) => [key, value.checks?.[key] === true]))
  };
}

function fingerprintMetadata(text, context, previousMessages = []) {
  const normalized = structuralFingerprint(text, context);
  const nearest = (previousMessages || []).slice(0, 10)
    .map((message) => ({
      id: typeof message === "object" ? message.id || null : null,
      similarity: trigramSimilarity(text, message.text || message, context)
    }))
    .sort((left, right) => right.similarity - left.similarity)[0] || null;
  return {
    normalizedFingerprint: normalized,
    fingerprintHash: crypto.createHash("sha256").update(normalized).digest("hex"),
    nearestPriorMessageId: nearest?.id || null,
    nearestPriorSimilarity: nearest ? Number(nearest.similarity.toFixed(3)) : null
  };
}

async function generateCoachParagraph(context, previousMessages = [], options = {}) {
  const startedAt = Date.now();
  const totalTimeoutMs = Math.max(25, Number(options.timeoutMs || coachGenerationTimeoutMs));
  const remainingTimeoutMs = () => {
    const remaining = totalTimeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new Error("coach model timeout");
    return Math.max(1, remaining);
  };
  const fallback = buildContextualFallbackResult(context, previousMessages);
  const configuredKey = Object.prototype.hasOwnProperty.call(options, "apiKey") ? options.apiKey : openaiApiKey;
  if (!configuredKey) {
    return {
      text: fallback.text,
      status: "fallback-no-model",
      structureId: fallback.structureId,
      action: fallback.action,
      diagnostics: generationDiagnostics("no-model", 0, ["no-model"], startedAt)
    };
  }

  const writerCandidatePool = buildContextualFallbackCandidates(context, previousMessages, COACH_CANDIDATE_COUNT, { writerSafe: true });
  if (writerCandidatePool.length < COACH_CANDIDATE_COUNT) {
    return {
      text: fallback.text,
      status: "fallback-writer-pool",
      structureId: fallback.structureId,
      action: fallback.action,
      diagnostics: generationDiagnostics("writer-pool", 0, ["writer-pool-too-small"], startedAt, { candidateCount: writerCandidatePool.length })
    };
  }
  const writerPoolTexts = writerCandidatePool.map((candidate) => candidate.text);
  const normalizedWriterPool = new Set(writerPoolTexts.map((text) => normalizeCoachParagraph(text)));
  const writerSchema = coachWriterSchema(writerCandidatePool);

  const rejectionCodes = [];
  let lastStatus = "fallback-writer-validation";
  let lastCritic = null;
  let attempts = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    attempts += 1;
    try {
      const system = [
        "Select three genuinely different evidence-first fitness-coach paragraphs for Lily from the supplied approved candidate pool and return only the required JSON.",
        `Each candidate must be ${COACH_MIN_WORDS}-${COACH_MAX_WORDS} words in one paragraph.`,
        "Copy each selected candidate exactly. Every pool entry has already passed the factual, one-action, privacy, safety, originality, and closed-grammar checks.",
        "Prefer candidates whose framing makes the strongest new evidence and its relationship to the prior read immediately clear.",
        "Use three different openings, closings, structures, and action realizations when the pool permits.",
        "Every pool entry already satisfies the recent-message originality and action-cooldown gates.",
        "Never mention a goal, target weight, private strategy, BMI, diagnosis, appearance, worth, fasting, skipped meals, restriction, compensation, punishment, JYP, or idol training."
      ].join(" ");
      const writerText = await requestCoachResponse([
        { role: "system", content: system },
        { role: "user", content: `FACTS: ${JSON.stringify(criticCoachFacts(context))}\nAPPROVED CANDIDATE POOL: ${JSON.stringify(writerPoolTexts)}` }
      ], { ...options, model: options.model || coachWriterModel, timeoutMs: remainingTimeoutMs(), schema: writerSchema, schemaName: "lily_coach_candidates_v3", maxOutputTokens: 520 });
      const candidates = parseWriterCandidates(writerText);
      if (candidates.length !== COACH_CANDIDATE_COUNT) {
        lastStatus = "fallback-writer-format";
        rejectionCodes.push("writer-format");
        continue;
      }
      if (new Set(candidates).size !== COACH_CANDIDATE_COUNT) {
        lastStatus = "fallback-writer-validation";
        rejectionCodes.push("writer-duplicate-candidates");
        continue;
      }
      if (candidates.some((candidate) => !normalizedWriterPool.has(candidate))) {
        lastStatus = "fallback-writer-validation";
        rejectionCodes.push("writer-outside-pool");
        continue;
      }
      const validCandidates = [];
      for (const candidate of candidates) {
        const validation = validateCoachParagraph(candidate, context, previousMessages, {
          privateGoal: Object.prototype.hasOwnProperty.call(options, "privateGoal") ? options.privateGoal : privateCoachGoal
        });
        if (!validation.ok) {
          rejectionCodes.push(...validation.errors);
          continue;
        }
        const siblingErrors = noveltyErrors(validation.text, context, validCandidates.map((entry) => ({ text: entry.text, actionId: entry.action.id, actionSemantic: entry.action.semantic, actionText: entry.action.text })), validation.action)
          .filter((error) => error !== "action-cooldown" && error !== "action-semantic-cooldown");
        if (siblingErrors.length) {
          rejectionCodes.push(...siblingErrors.map((error) => `candidate-${error}`));
          continue;
        }
        validCandidates.push({ text: validation.text, action: validation.action });
      }
      if (validCandidates.length !== COACH_CANDIDATE_COUNT) {
        lastStatus = "fallback-writer-validation";
        rejectionCodes.push("writer-incomplete-valid-candidates");
        continue;
      }

      const criticText = await requestCoachResponse([
        {
          role: "system",
          content: "Select exactly one of the three alternatives that makes the strongest new story clearest, then independently evaluate all six critic checks for that selected candidate only. Never combine the alternatives or count language from an unselected candidate; they are separate paragraph choices. Every candidate has already passed deterministic fact, evidence, verdict, single-action, privacy, safety, and originality checks. Approve only if every check passes for the selected candidate; reject with a concrete reason for any failed check. For verdict, FACTS.verdict is an internal classification, not required copy. verdictEvidence.approvedFamilyOpening is an exact deterministic family check. Set verdict=true when it is true unless the paragraph makes one of these narrow contradictions: praises an adverse not-good-enough result, condemns a good-progress result, treats a verify outlier as settled, or claims a trend from a baseline. Hype intensity, uppercase, firmness, or excitement cannot fail verdict. For actionCompliance, inspect only the selected annotatedText. The one instruction is enclosed once by <approved_action> tags. Set actionCompliance=true when text outside those tags has no additional concrete instruction. The tags are critic-only metadata. Never count factual weight-change language, comparison material, or an unselected alternative. Ingredients and flavor inside the marked sentence are one instruction. For originality, use originalityEvidence as exact measurements: set originality=true when every freshness/cooldown flag is true and maxOrderedTrigramSimilarity is below rejectionThreshold. Do not subjectively reject required facts, a generic coaching tone, or similarities already below that threshold. Declarative hype is framing, not another instruction. Energetic uppercase wording is not itself a safety failure. If all six checks pass, return approved=true, the selected index, and reasonCode approved. Return only the required JSON."
        },
        {
          role: "user",
          content: `FACTS: ${JSON.stringify(criticCoachFacts(context))}\nCANDIDATES: ${JSON.stringify(validCandidates.map((candidate) => criticCandidatePayload(candidate, context, previousMessages)))}`
        }
      ], { ...options, model: options.criticModel || coachCriticModel, timeoutMs: remainingTimeoutMs(), schema: COACH_CRITIC_SCHEMA, schemaName: "lily_coach_critic_v3", maxOutputTokens: 260 });
      const critic = parseCriticResult(criticText, validCandidates.length);
      lastCritic = critic;
      if (!critic.valid) {
        lastStatus = "fallback-critic-format";
        rejectionCodes.push("critic-format");
        continue;
      }
      if (!critic.approved) {
        lastStatus = "fallback-critic-rejected";
        rejectionCodes.push(critic.reasonCode);
        continue;
      }
      const selected = validCandidates[critic.selectedIndex];
      return {
        text: selected.text,
        status: "generated-and-critic-approved",
        structureId: null,
        action: selected.action,
        criticResult: critic,
        diagnostics: generationDiagnostics("critic-approved", attempts, rejectionCodes, startedAt, { candidateCount: candidates.length, validCandidateCount: validCandidates.length })
      };
    } catch (error) {
      const code = /timeout/i.test(error?.message || "") ? "timeout" : "api-error";
      rejectionCodes.push(code);
      lastStatus = code === "timeout" ? "fallback-timeout" : "fallback-api-error";
      if (code === "timeout") break;
    }
  }
  return {
    text: fallback.text,
    status: lastStatus,
    structureId: fallback.structureId,
    action: fallback.action,
    criticResult: lastCritic,
    diagnostics: generationDiagnostics(lastStatus.replace(/^fallback-/, ""), attempts, rejectionCodes, startedAt)
  };
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
    generationVersion: COACH_GENERATION_VERSION,
    analysisVersion: COACH_ANALYSIS_VERSION,
    writerPromptVersion: COACH_WRITER_PROMPT_VERSION,
    criticPromptVersion: COACH_CRITIC_PROMPT_VERSION,
    validatorVersion: COACH_VALIDATOR_VERSION,
    fallbackVersion: COACH_FALLBACK_VERSION,
    actionVersion: COACH_ACTION_VERSION,
    modelVersion: metadata.modelVersion || coachModelVersion(),
    promptVersion: COACH_PROMPT_VERSION,
    safetyVersion: COACH_SAFETY_VERSION,
    actionId: selectedAction.id,
    actionSemantic: selectedAction.semantic,
    actionText: selectedAction.text,
    fallbackStructureId: metadata.structureId || null,
    analysisPlan: context.analysisPlan,
    diagnostics: sanitizeGenerationDiagnostics(metadata.diagnostics),
    criticResult: sanitizeCriticResult(metadata.criticResult),
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

function refreshLatestWeightOnlyCoach(store, status) {
  const latestWeight = (Array.isArray(store.weights) ? store.weights : [])
    .slice()
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
  if (!latestWeight) return store;
  const context = buildCoachContext(store, latestWeight.id, { includePersonalContext: false, privateGoal: privateCoachGoal });
  if (!context) return store;
  const existing = coachForWeight(store, latestWeight.id);
  const previousMessages = causalPreviousCoachMessages(store, latestWeight, 10);
  const fallback = buildContextualFallbackResult(context, previousMessages);
  const replacement = createCoachMessageRecord(context, fallback.text, status, new Date().toISOString(), existing, {
    action: fallback.action,
    structureId: fallback.structureId,
    previousMessages,
    diagnostics: generationDiagnostics("context-refreshed", 0, [], Date.now())
  });
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
  const currentWeight = (snapshot.weights || []).find((weight) => weight.id === weightId);
  const previousMessages = causalPreviousCoachMessages(snapshot, currentWeight, 10);
  const result = await generateCoachParagraph(context, previousMessages, options);
  if (result.status.startsWith("fallback-")) {
    let savedFallback = fallbackRecord;
    await writeStore((store) => {
      const existing = coachForWeight(store, weightId);
      const weightStillExists = (store.weights || []).some((weight) => weight.id === weightId);
      if (!existing || !weightStillExists || existing.contextHash !== context.contextHash) return store;
      savedFallback = createCoachMessageRecord(context, result.text, result.status, new Date().toISOString(), existing, {
        action: result.action,
        structureId: result.structureId,
        previousMessages,
        diagnostics: result.diagnostics,
        criticResult: result.criticResult,
        modelVersion: coachModelVersion(options)
      });
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
    saved = createCoachMessageRecord(context, result.text, result.status, new Date().toISOString(), existing, {
      action: result.action,
      structureId: result.structureId,
      previousMessages,
      diagnostics: result.diagnostics,
      criticResult: result.criticResult,
      modelVersion: coachModelVersion(options)
    });
    return {
      ...store,
      coachMessages: [saved, ...(store.coachMessages || []).filter((message) => message.id !== existing.id)]
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
    let prepared = false;
    await writeStore((store) => {
      const currentWeight = (store.weights || []).find((weight) => weight.id === weightId);
      const context = buildCoachContext(store, weightId, {
        privateGoal: Object.prototype.hasOwnProperty.call(options, "privateGoal") ? options.privateGoal : privateCoachGoal
      });
      if (!currentWeight || !context) return store;
      const previousMessages = causalPreviousCoachMessages(store, currentWeight, 10);
      const fallback = buildContextualFallbackResult(context, previousMessages);
      const existing = coachForWeight(store, weightId);
      const replacement = createCoachMessageRecord(context, fallback.text, "fallback-regenerating", new Date().toISOString(), existing, {
        action: fallback.action,
        structureId: fallback.structureId,
        previousMessages,
        diagnostics: generationDiagnostics("regeneration-fallback", 0, [], Date.now()),
        modelVersion: coachModelVersion(options)
      });
      prepared = true;
      return {
        ...store,
        coachMessages: [replacement, ...(store.coachMessages || []).filter((message) => message.id !== existing?.id && message.weightId !== weightId)]
      };
    });
    if (!prepared) continue;
    await generateAndReplaceCoach(weightId, options);
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

if (process.env.NODE_ENV === "test" || process.env.LILY_COACH_CLI === "1") {
  module.exports = {
    COACH_ACTION_CATALOG,
    COACH_ACTION_VERSION,
    COACH_ANALYSIS_VERSION,
    COACH_COOLDOWN_COUNT,
    COACH_CRITIC_PROMPT_VERSION,
    COACH_FALLBACK_VERSION,
    COACH_GENERATION_VERSION,
    COACH_MAX_WORDS,
    COACH_MIN_WORDS,
    COACH_VALIDATOR_VERSION,
    COACH_WRITER_PROMPT_VERSION,
    FALLBACK_CLOSINGS,
    FALLBACK_OPENINGS,
    FALLBACK_STRUCTURES,
    PREFERENCE_ACTIONS,
    WRITER_SAFE_CLOSINGS,
    WRITER_SAFE_OPENINGS,
    addFallbackCoachForWeight,
    backfillCoachMessages,
    buildCoachContext,
    buildContextualFallback,
    buildContextualFallbackCandidates,
    buildContextualFallbackResult,
    causalPreviousCoachMessages,
    coachForWeight,
    coachWordCount,
    criticCandidatePayload,
    criticCoachFacts,
    createCoachMessageRecord,
    ensureDataDir,
    fallbackFactClauseVariants,
    fallbackFactClauses,
    coachPresentationSeed,
    generateAndReplaceCoach,
    generateCoachParagraph,
    hiddenStrategyState,
    latestCoachPayload,
    normalizeCoachParagraph,
    noveltyErrors,
    openingFingerprint,
    closingFingerprint,
    structuralFingerprint,
    trigramSimilarity,
    identifyApprovedAction,
    parseCriticResult,
    parseWriterCandidates,
    publicCoach,
    readStore,
    regenerateRecentCoachMessages,
    refreshLatestWeightOnlyCoach,
    refreshIfLatestCoachReferences,
    removeWeightAndCoach,
    selectStrongestCoachEvidence,
    similarityScore,
    validateCoachParagraph,
    writeStore
  };
}
