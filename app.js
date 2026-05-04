const app = document.getElementById("app");

const PIN_HASH = "ec9c3833d2daef77604a3cfc097bbc5e919e4c96e8fd13bc34fdf0a2e4474e79";
const PIN_FALLBACK = ["6", "6", "9", "9"].join("");
const AUTH_UNTIL_KEY = "lily-auth-until-v1";
const SESSION_AUTH_KEY = "lily-session-auth-v1";
const MEMORY_KEY = "lily-memories-v1";
const HIDDEN_STARTERS_KEY = "lily-hidden-starters-v1";
const DB_NAME = "lily-memory-bank";
const DB_VERSION = 1;
const MEDIA_STORE = "media";
const REMEMBER_MS = 7 * 24 * 60 * 60 * 1000;

const starterItems = [
  {
    id: "starter-flowers-1",
    kind: "photo",
    source: "starter",
    image: imageUrl("1526047932273-341f2a7631f9"),
    caption: "soft flowers, saved for the wall",
    shape: "tall",
    focus: "center 45%"
  },
  {
    id: "starter-note-1",
    kind: "quote",
    source: "starter",
    text: "little things, kept close",
    createdAt: "starter"
  },
  {
    id: "starter-cafe",
    kind: "photo",
    source: "starter",
    image: imageUrl("1500530855697-b586d89ba3ee"),
    caption: "warm room, soft light, a place to remember",
    shape: "wide",
    focus: "center 52%"
  },
  {
    id: "starter-date",
    kind: "date",
    source: "starter",
    text: "birthdays, dates, tiny details",
    createdAt: "starter"
  },
  {
    id: "starter-sky",
    kind: "photo",
    source: "starter",
    image: imageUrl("1493246507139-91e8fad9978e"),
    caption: "green quiet and easy air",
    shape: "portrait",
    focus: "center"
  },
  {
    id: "starter-contact",
    kind: "contact",
    source: "starter",
    text: "numbers stay in one neat place",
    createdAt: "starter"
  },
  {
    id: "starter-bloom",
    kind: "photo",
    source: "starter",
    image: imageUrl("1490750967868-88aa4486c946"),
    caption: "a small bloom with a lot of feeling",
    shape: "square",
    focus: "center"
  },
  {
    id: "starter-address",
    kind: "address",
    source: "starter",
    text: "places that matter",
    createdAt: "starter"
  },
  {
    id: "starter-lights",
    kind: "photo",
    source: "starter",
    image: imageUrl("1519608487953-e999c86e7455"),
    caption: "night lights, pretty and a little cinematic",
    shape: "tall",
    focus: "center"
  },
  {
    id: "starter-note-2",
    kind: "note",
    source: "starter",
    text: "favorite snacks, addresses, plans, quotes",
    createdAt: "starter"
  },
  {
    id: "starter-table",
    kind: "photo",
    source: "starter",
    image: imageUrl("1517248135467-4c7edcad34c4"),
    caption: "table for the little rituals",
    shape: "wide",
    focus: "center 45%"
  },
  {
    id: "starter-quote-2",
    kind: "quote",
    source: "starter",
    text: "nice feelings, organized gently",
    createdAt: "starter"
  },
  {
    id: "starter-window",
    kind: "photo",
    source: "starter",
    image: imageUrl("1497366754035-f200968a6e72"),
    caption: "window light and calm color",
    shape: "portrait",
    focus: "center"
  },
  {
    id: "starter-water",
    kind: "photo",
    source: "starter",
    image: imageUrl("1500534623283-312aade485b7"),
    caption: "soft blue, clean air, saved mood",
    shape: "square",
    focus: "center"
  },
  {
    id: "starter-petal",
    kind: "photo",
    source: "starter",
    image: imageUrl("1518895949257-7621c3c786d7"),
    caption: "pink petals, quiet detail",
    shape: "portrait",
    focus: "center"
  }
];

const state = {
  memories: loadMemories(),
  hiddenStarterIds: loadHiddenStarterIds(),
  pendingFiles: [],
  resizeTimer: null,
  toastTimer: null,
  verifying: false
};

function imageUrl(id, width = 1500) {
  return `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${width}&q=88`;
}

function init() {
  renderShell();
  bindShellEvents();
  renderWall();

  if (hasValidAuth()) {
    setLocked(false);
  } else {
    setLocked(true);
  }

  window.addEventListener("resize", () => {
    window.clearTimeout(state.resizeTimer);
    state.resizeTimer = window.setTimeout(renderWall, 120);
  });
}

function renderShell() {
  app.innerHTML = `
    <section class="memory-app is-locked" id="memoryApp">
      <div class="app-surface" aria-hidden="true" id="appSurface">
        <header class="topbar">
          <div class="brand">
            <h1>Lily</h1>
            <p>memory bank of Lily</p>
          </div>
          <div class="actions">
            <button class="icon-button" type="button" id="lockButton" title="Lock" aria-label="Lock">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="6" y="10" width="12" height="10" rx="2"></rect>
                <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10"></path>
              </svg>
            </button>
            <button class="icon-button" type="button" id="openComposer" title="Add memory" aria-label="Add memory">+</button>
          </div>
        </header>
        <main class="memory-wall" id="memoryWall" aria-label="Lily media and info wall"></main>
      </div>

      <div class="pin-overlay" id="pinOverlay" role="dialog" aria-modal="true" aria-labelledby="pinTitle">
        <form class="pin-window" id="pinForm" autocomplete="off">
          <div class="pin-icon" aria-hidden="true"><img src="/icon.svg" alt=""></div>
          <h2 id="pinTitle">Lily</h2>
          <p>memory bank of Lily</p>
          <label class="pin-label" for="pinInput">4 digits required</label>
          <input class="pin-input" id="pinInput" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="one-time-code" aria-describedby="pinError">
          <button class="pin-submit" type="submit">Verify</button>
          <label class="remember-row">
            <input id="rememberDevice" type="checkbox">
            <span>Remember this device for 1 week</span>
          </label>
          <p class="pin-error" id="pinError" aria-live="polite"></p>
        </form>
      </div>

      <div class="composer-overlay" id="composerOverlay" role="dialog" aria-modal="true" aria-labelledby="composerTitle">
        <form class="composer-window" id="composerForm">
          <div class="composer-head">
            <h2 id="composerTitle">Add memory</h2>
            <button class="close-button" id="closeComposer" type="button" aria-label="Close">x</button>
          </div>
          <label class="drop-zone" id="dropZone" tabindex="0" for="photoInput">
            <span>
              <strong>Photos</strong>
              <span>Choose or drop pictures</span>
            </span>
          </label>
          <input class="file-input" id="photoInput" type="file" accept="image/*" multiple>
          <div class="file-count" id="fileCount" aria-live="polite"></div>
          <textarea class="composer-field" id="memoryText" placeholder="quote, address, number, bday, tiny note"></textarea>
          <div class="composer-actions">
            <button class="secondary-button" id="clearComposer" type="button">Clear</button>
            <button class="primary-button" type="submit">Save</button>
          </div>
        </form>
      </div>

      <div class="toast" id="toast" role="status" aria-live="polite"></div>
    </section>
  `;
}

function bindShellEvents() {
  const pinForm = document.getElementById("pinForm");
  const pinInput = document.getElementById("pinInput");
  const openComposer = document.getElementById("openComposer");
  const closeComposer = document.getElementById("closeComposer");
  const clearComposer = document.getElementById("clearComposer");
  const composerForm = document.getElementById("composerForm");
  const photoInput = document.getElementById("photoInput");
  const dropZone = document.getElementById("dropZone");
  const lockButton = document.getElementById("lockButton");

  pinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    verifyPin();
  });

  pinInput.addEventListener("input", () => {
    pinInput.value = pinInput.value.replace(/\D/g, "").slice(0, 4);
    if (pinInput.value.length === 4) {
      window.setTimeout(verifyPin, 90);
    }
  });

  openComposer.addEventListener("click", () => {
    if (!hasValidAuth()) return;
    openComposerPanel();
  });

  closeComposer.addEventListener("click", closeComposerPanel);
  clearComposer.addEventListener("click", clearComposerFields);

  composerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveComposer();
  });

  photoInput.addEventListener("change", () => {
    addPendingFiles(Array.from(photoInput.files || []));
    photoInput.value = "";
  });

  ["dragenter", "dragover"].forEach((type) => {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.add("is-dragging");
    });
  });

  ["dragleave", "drop"].forEach((type) => {
    dropZone.addEventListener(type, () => {
      dropZone.classList.remove("is-dragging");
    });
  });

  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    addPendingFiles(Array.from(event.dataTransfer.files || []));
  });

  dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      photoInput.click();
    }
  });

  lockButton.addEventListener("click", () => {
    localStorage.removeItem(AUTH_UNTIL_KEY);
    sessionStorage.removeItem(SESSION_AUTH_KEY);
    closeComposerPanel();
    setLocked(true);
  });
}

function setLocked(isLocked) {
  const memoryApp = document.getElementById("memoryApp");
  const appSurface = document.getElementById("appSurface");
  const pinInput = document.getElementById("pinInput");

  memoryApp.classList.toggle("is-locked", isLocked);
  appSurface.setAttribute("aria-hidden", String(isLocked));

  if (isLocked) {
    pinInput.value = "";
    window.setTimeout(() => pinInput.focus(), 40);
  }
}

function hasValidAuth() {
  const rememberedUntil = Number(localStorage.getItem(AUTH_UNTIL_KEY) || 0);
  return rememberedUntil > Date.now() || sessionStorage.getItem(SESSION_AUTH_KEY) === "true";
}

async function verifyPin() {
  if (state.verifying) return;
  const pinInput = document.getElementById("pinInput");
  const pinError = document.getElementById("pinError");
  const pinWindow = document.getElementById("pinForm");
  const rememberDevice = document.getElementById("rememberDevice");
  const value = pinInput.value.replace(/\D/g, "").slice(0, 4);

  if (value.length !== 4) {
    pinError.textContent = "Enter exactly 4 digits.";
    return;
  }

  state.verifying = true;
  const digest = await hashPin(value);
  state.verifying = false;

  if (digest === PIN_HASH) {
    pinError.textContent = "";
    if (rememberDevice.checked) {
      localStorage.setItem(AUTH_UNTIL_KEY, String(Date.now() + REMEMBER_MS));
    } else {
      sessionStorage.setItem(SESSION_AUTH_KEY, "true");
    }
    setLocked(false);
    showToast("Unlocked");
    return;
  }

  pinInput.value = "";
  pinError.textContent = "Wrong PIN.";
  pinWindow.classList.remove("is-wrong");
  void pinWindow.offsetWidth;
  pinWindow.classList.add("is-wrong");
  pinInput.focus();
}

async function hashPin(value) {
  if (window.crypto && window.crypto.subtle) {
    const bytes = new TextEncoder().encode(value);
    const digest = await window.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  return value === PIN_FALLBACK ? PIN_HASH : "";
}

function openComposerPanel() {
  clearComposerFields();
  document.getElementById("composerOverlay").classList.add("is-open");
  window.setTimeout(() => document.getElementById("memoryText").focus(), 40);
}

function closeComposerPanel() {
  document.getElementById("composerOverlay").classList.remove("is-open");
}

function clearComposerFields() {
  state.pendingFiles = [];
  document.getElementById("memoryText").value = "";
  updateFileCount();
}

function addPendingFiles(files) {
  const images = files.filter((file) => file.type.startsWith("image/"));
  state.pendingFiles.push(...images);
  updateFileCount();
}

function updateFileCount() {
  const fileCount = document.getElementById("fileCount");
  const count = state.pendingFiles.length;
  fileCount.textContent = count ? `${count} photo${count === 1 ? "" : "s"} ready` : "";
}

async function saveComposer() {
  const memoryText = document.getElementById("memoryText");
  const rawText = memoryText.value.trim();
  const files = state.pendingFiles.slice();

  if (!rawText && files.length === 0) {
    showToast("Add a photo or a note first.");
    return;
  }

  const created = [];
  const textPieces = splitTextPieces(rawText);
  const sharedCaption = textPieces[0] || "";

  for (const file of files) {
    try {
      const mediaId = createId("media");
      const dataUrl = await readFileAsDataUrl(file);
      await putMedia({ id: mediaId, dataUrl, name: file.name, type: file.type, createdAt: new Date().toISOString() });
      created.push({
        id: createId("photo"),
        kind: "photo",
        source: "user",
        mediaId,
        caption: sharedCaption || cleanFileName(file.name),
        shape: choosePhotoShape(file.name),
        focus: "center",
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      showToast("Could not save one photo in this browser.");
    }
  }

  for (const piece of textPieces) {
    created.push({
      id: createId("memory"),
      kind: classifyText(piece),
      source: "user",
      text: piece,
      createdAt: new Date().toISOString()
    });
  }

  if (created.length === 0) {
    return;
  }

  state.memories = [...created.reverse(), ...state.memories];
  saveMemories(state.memories);
  renderWall();
  closeComposerPanel();
  clearComposerFields();
  showToast(`${created.length} saved`);
}

function splitTextPieces(rawText) {
  if (!rawText) return [];
  return rawText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function classifyText(text) {
  const lower = text.toLowerCase();
  const phonePattern = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
  const datePattern = /\b(?:bday|birthday|anniversary|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/i;
  const addressPattern = /\b\d{1,6}\s+([a-z0-9'.-]+\s+){1,7}(street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|place|pl|way|blvd|boulevard|apt|unit|circle|cir)\b/i;
  const quotePattern = /^["']|["']$/;

  if (phonePattern.test(text) || lower.includes("phone") || lower.includes("number")) return "contact";
  if (addressPattern.test(text) || lower.includes("address")) return "address";
  if (datePattern.test(text)) return "date";
  if (quotePattern.test(text) || text.length > 86) return "quote";
  return "note";
}

function renderWall() {
  const wall = document.getElementById("memoryWall");
  if (!wall) return;

  const columns = getColumnCount();
  const visibleStarterItems = starterItems.filter((item) => !state.hiddenStarterIds.includes(item.id));
  const items = [...state.memories, ...visibleStarterItems];
  wall.style.setProperty("--columns", String(columns));
  wall.innerHTML = "";

  const columnNodes = Array.from({ length: columns }, () => {
    const column = document.createElement("div");
    column.className = "masonry-column";
    wall.appendChild(column);
    return column;
  });

  items.forEach((item, index) => {
    const card = item.kind === "photo" ? createPhotoCard(item) : createInfoCard(item);
    columnNodes[index % columns].appendChild(card);
  });
}

function getColumnCount() {
  const width = window.innerWidth;
  if (width < 420) return 2;
  if (width < 680) return 3;
  if (width < 980) return 4;
  if (width < 1240) return 5;
  return 6;
}

function createPhotoCard(item) {
  const card = document.createElement("article");
  card.className = `memory-card photo ${item.shape || "portrait"}`;
  card.style.setProperty("--focus", item.focus || "center");

  const image = document.createElement("img");
  image.alt = item.caption || "Lily memory";
  image.loading = "lazy";
  image.decoding = "async";

  if (item.image) {
    image.src = item.image;
  } else if (item.mediaId) {
    image.src = "";
    getMedia(item.mediaId).then((media) => {
      if (media && media.dataUrl) {
        image.src = media.dataUrl;
      }
    });
  }

  const caption = document.createElement("div");
  caption.className = "photo-caption";
  const captionText = document.createElement("span");
  captionText.textContent = item.caption || "saved photo";
  caption.appendChild(captionText);

  card.appendChild(image);
  card.appendChild(caption);
  appendDeleteButton(card, item);
  return card;
}

function createInfoCard(item) {
  const card = document.createElement("article");
  card.className = `memory-card info-card ${item.kind}`;

  const label = document.createElement("span");
  label.className = "type-label";
  label.textContent = labelForKind(item.kind);

  const text = document.createElement("p");
  text.className = "info-text";
  text.textContent = trimDisplayText(item.text || "");

  const meta = document.createElement("div");
  meta.className = "meta-row";
  const date = document.createElement("span");
  date.textContent = item.createdAt === "starter" ? "starter" : formatDate(item.createdAt);
  meta.appendChild(date);

  card.appendChild(label);
  card.appendChild(text);
  card.appendChild(meta);
  appendDeleteButton(card, item);
  return card;
}

function appendDeleteButton(card, item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "delete-button";
  button.setAttribute("aria-label", "Delete memory");
  button.textContent = "x";
  button.addEventListener("click", () => deleteMemory(item));
  card.appendChild(button);
}

async function deleteMemory(item) {
  const confirmed = window.confirm("Delete this memory?");
  if (!confirmed) return;

  if (item.source === "starter") {
    state.hiddenStarterIds = Array.from(new Set([...state.hiddenStarterIds, item.id]));
    saveHiddenStarterIds(state.hiddenStarterIds);
    renderWall();
    showToast("Deleted");
    return;
  }

  const memory = state.memories.find((memoryItem) => memoryItem.id === item.id);
  if (!memory) return;

  state.memories = state.memories.filter((memoryItem) => memoryItem.id !== item.id);
  saveMemories(state.memories);
  if (memory.mediaId) {
    await deleteMedia(memory.mediaId);
  }
  renderWall();
  showToast("Deleted");
}

function labelForKind(kind) {
  const labels = {
    quote: "quote",
    date: "date",
    contact: "number",
    address: "place",
    note: "fact"
  };
  return labels[kind] || "fact";
}

function trimDisplayText(text) {
  if (text.length <= 180) return text;
  return `${text.slice(0, 177).trim()}...`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "saved";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function createId(prefix) {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function cleanFileName(name) {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim() || "saved photo";
}

function choosePhotoShape(seed) {
  const shapes = ["portrait", "square", "tall", "wide"];
  let total = 0;
  for (const char of seed) total += char.charCodeAt(0);
  return shapes[total % shapes.length];
}

function loadMemories() {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function saveMemories(memories) {
  localStorage.setItem(MEMORY_KEY, JSON.stringify(memories));
}

function loadHiddenStarterIds() {
  try {
    const raw = localStorage.getItem(HIDDEN_STARTERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function saveHiddenStarterIds(ids) {
  localStorage.setItem(HIDDEN_STARTERS_KEY, JSON.stringify(ids));
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

let dbPromise = null;

function openDatabase() {
  if (!("indexedDB" in window)) {
    return Promise.resolve(null);
  }

  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MEDIA_STORE)) {
        db.createObjectStore(MEDIA_STORE, { keyPath: "id" });
      }
    });

    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

  return dbPromise;
}

async function putMedia(record) {
  const db = await openDatabase();
  if (!db) throw new Error("IndexedDB unavailable");

  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE, "readwrite");
    tx.objectStore(MEDIA_STORE).put(record);
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () => reject(tx.error));
  });
}

async function getMedia(id) {
  const db = await openDatabase();
  if (!db) return null;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE, "readonly");
    const request = tx.objectStore(MEDIA_STORE).get(id);
    request.addEventListener("success", () => resolve(request.result || null));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function deleteMedia(id) {
  const db = await openDatabase();
  if (!db) return;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE, "readwrite");
    tx.objectStore(MEDIA_STORE).delete(id);
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () => reject(tx.error));
  });
}

function showToast(message) {
  const toast = document.getElementById("toast");
  window.clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  state.toastTimer = window.setTimeout(() => {
    toast.classList.remove("is-visible");
  }, 2200);
}

init();
