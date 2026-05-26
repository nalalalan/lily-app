const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, "public");
const dataDir = process.env.DATA_DIR || path.join(__dirname, ".data");
const mediaDir = path.join(dataDir, "media");
const storePath = path.join(dataDir, "store.json");
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 26 * 1024 * 1024);
const pin = process.env.LILY_PIN || "local-dev-pin-required";
const sessionSecret = process.env.SESSION_SECRET || "local-dev-lily-session-secret";
const openaiApiKey = process.env.OPENAI_API_KEY || "";
const chatModel = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
const visionModel = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
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
  ".ico": "image/x-icon"
};

let writeQueue = Promise.resolve();

async function ensureDataDir() {
  await fsp.mkdir(mediaDir, { recursive: true });
  try {
    await fsp.access(storePath);
  } catch (error) {
    await fsp.writeFile(storePath, JSON.stringify({ memories: [], chats: [] }, null, 2));
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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function readStore() {
  await ensureDataDir();
  const raw = await fsp.readFile(storePath, "utf8");
  const parsed = JSON.parse(raw || "{}");
  return {
    memories: Array.isArray(parsed.memories) ? parsed.memories : [],
    chats: Array.isArray(parsed.chats) ? parsed.chats : []
  };
}

function writeStore(mutator) {
  writeQueue = writeQueue.then(async () => {
    const store = await readStore();
    const nextStore = await mutator(store);
    const tmpPath = `${storePath}.tmp`;
    await fsp.writeFile(tmpPath, JSON.stringify(nextStore, null, 2));
    await fsp.rename(tmpPath, storePath);
    return nextStore;
  });
  return writeQueue;
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

function sanitizeFileName(name) {
  const ext = path.extname(name || "").toLowerCase().replace(/[^a-z0-9.]/g, "");
  const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
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
  if (!type.startsWith("image/")) throw Object.assign(new Error("Only images are supported"), { status: 400 });
  const filename = sanitizeFileName(file.name || "upload.jpg");
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
      const analysis = await analyzeImage(file.dataUrl, text);
      created.push({
        id: createId("photo"),
        kind: "photo",
        caption: text || file.name || "saved image",
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
      send(res, 400, { error: "Add a note or image first." });
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
      return { ...store, memories: store.memories.filter((memory) => memory.id !== id) };
    });
    if (deleted && deleted.file && deleted.file.filename) {
      fsp.unlink(path.join(mediaDir, deleted.file.filename)).catch(() => {});
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

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
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
      sendFile(res, path.join(mediaDir, filename));
      return;
    }

    let staticPath = pathname === "/" ? "/index.html" : pathname;
    const normalizedPath = path.normalize(staticPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(publicDir, normalizedPath);

    if (!filePath.startsWith(publicDir)) {
      send(res, 403, "Forbidden");
      return;
    }

    sendFile(res, filePath);
  } catch (error) {
    send(res, error.status || 500, { error: error.message || "Server error" });
  }
});

ensureDataDir().then(() => {
  server.listen(port, () => {
    console.log(`Lily memory bank running at http://localhost:${port}`);
  });
});
