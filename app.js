const app = document.getElementById("app");

const API_BASE = String(window.LILY_API_BASE || "").replace(/\/$/, "");
const TOKEN_KEY = "lily-api-token-v1";
const TOKEN_EXP_KEY = "lily-api-token-exp-v1";
const LEGACY_MEMORY_KEY = "lily-memories-v1";
const LEGACY_MIGRATED_KEY = "lily-legacy-migrated-v1";

const state = {
  authenticated: false,
  memories: [],
  pendingFiles: [],
  chat: [
    {
      role: "assistant",
      content: "Ask about Lily."
    }
  ],
  loading: false,
  toastTimer: null
};

let resizeTimer = null;

const memoryTextPlaceholder = "Paste a note.";

function init() {
  renderShell();
  bindEvents();
  if (hasStoredToken()) {
    setLocked(false);
    loadMemories();
  } else {
    setLocked(true);
  }
}

function renderShell() {
  app.innerHTML = `
    <section class="memory-app is-locked" id="memoryApp">
      <div class="app-surface" id="appSurface" aria-hidden="true">
        <header class="suite-topbar" aria-label="lily navigation">
          <div class="suite-brand-cluster">
            <a class="suite-ao-home" href="https://aolabs.io/" aria-label="aolabs.io">
              <img src="https://aolabs.io/marks/ao-ink.svg?v=20260515-ao-disc-a" alt="">
            </a>
            <a class="suite-app-brand" href="/" aria-label="lily home">
              <img class="suite-app-mark" src="/icon.svg?v=20260507-suite3" alt="">
              <span class="suite-app-name">lily</span>
            </a>
          </div>
          <div class="suite-topbar-actions" aria-label="lily actions">
            <button class="icon-button" type="button" id="refreshButton" title="Refresh memories" aria-label="Refresh memories">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 0 1-14 5.3"></path><path d="M4 12A8 8 0 0 1 18 6.7"></path><path d="M18 3v4h-4"></path><path d="M6 21v-4h4"></path></svg>
            </button>
            <button class="icon-button" type="button" id="lockButton" title="Lock" aria-label="Lock">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="10" width="12" height="10" rx="2"></rect><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10"></path></svg>
            </button>
          </div>
        </header>

        <main class="workspace">
          <section class="chat-panel" aria-labelledby="chatTitle">
            <div class="panel-head">
              <div>
                <h2 id="chatTitle">Ask</h2>
              </div>
            </div>
            <div class="messages" id="messages" aria-live="polite"></div>
            <form class="chat-form" id="chatForm">
              <textarea id="chatInput" rows="2" placeholder="Ask about Lily"></textarea>
              <button class="primary-button" type="submit">Ask</button>
            </form>
          </section>

          <section class="ingest-panel" aria-labelledby="saveTitle">
            <div class="panel-head">
              <div>
                <h2 id="saveTitle">Add</h2>
              </div>
            </div>
            <form id="memoryForm">
              <label class="drop-zone" id="dropZone" tabindex="0" for="photoInput">
                <span>
                  <strong>Images</strong>
                  <span>Choose, drop, or paste</span>
                </span>
              </label>
              <input class="file-input" id="photoInput" type="file" accept="image/*" multiple>
              <div class="file-count" id="fileCount" aria-live="polite"></div>
              <textarea class="memory-field" id="memoryText" placeholder="${memoryTextPlaceholder}"></textarea>
              <div class="composer-actions">
                <button class="secondary-button" id="clearComposer" type="button">Clear</button>
                <button class="primary-button" type="submit">Save</button>
              </div>
            </form>
          </section>
        </main>

        <section class="memory-grid" aria-label="Saved Lily memory">
          <section class="image-section" aria-labelledby="imageTitle">
            <div class="section-head">
              <h2 id="imageTitle">Images</h2>
              <p id="imageCount">No images yet</p>
            </div>
            <div class="photo-wall" id="photoWall" aria-label="Saved Lily images"></div>
          </section>

          <section class="notes-section" aria-labelledby="notesTitle">
            <div class="section-head">
              <h2 id="notesTitle">Notes</h2>
              <p id="factCount">No notes yet</p>
            </div>
            <div class="fact-table-wrap">
              <table class="fact-table">
                <thead>
                  <tr>
                    <th scope="col">Fact</th>
                    <th scope="col">Date</th>
                  </tr>
                </thead>
                <tbody id="factTableBody"></tbody>
              </table>
            </div>
          </section>
        </section>
      </div>

      <div class="pin-overlay" id="pinOverlay" role="dialog" aria-modal="true" aria-labelledby="pinTitle">
        <form class="pin-window" id="pinForm" autocomplete="off">
          <div class="pin-icon" aria-hidden="true"><img src="/icon.svg?v=20260507-suite3" alt=""></div>
          <h2 id="pinTitle">lily</h2>
          <p>private memory</p>
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

      <div class="toast" id="toast" role="status" aria-live="polite"></div>
    </section>
  `;
  renderChat();
  renderWall();
}

function bindEvents() {
  document.getElementById("pinForm").addEventListener("submit", (event) => {
    event.preventDefault();
    verifyPin();
  });

  document.getElementById("pinInput").addEventListener("input", (event) => {
    event.target.value = event.target.value.replace(/\D/g, "").slice(0, 4);
    if (event.target.value.length === 4) window.setTimeout(verifyPin, 80);
  });

  document.getElementById("lockButton").addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXP_KEY);
    setLocked(true);
  });

  document.getElementById("refreshButton").addEventListener("click", loadMemories);
  document.getElementById("memoryForm").addEventListener("submit", saveMemory);
  document.getElementById("clearComposer").addEventListener("click", clearComposer);
  document.getElementById("memoryText").addEventListener("paste", handleMemoryPaste);
  document.getElementById("memoryText").addEventListener("keydown", submitFormOnEnter("memoryForm"));
  document.getElementById("photoInput").addEventListener("change", (event) => {
    addPendingFiles(Array.from(event.target.files || []));
    event.target.value = "";
  });

  const dropZone = document.getElementById("dropZone");
  ["dragenter", "dragover"].forEach((type) => {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.add("is-dragging");
    });
  });
  ["dragleave", "drop"].forEach((type) => {
    dropZone.addEventListener(type, () => dropZone.classList.remove("is-dragging"));
  });
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    addPendingFiles(Array.from(event.dataTransfer.files || []));
  });
  dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      document.getElementById("photoInput").click();
    }
  });

  document.getElementById("chatForm").addEventListener("submit", askQuestion);
  document.getElementById("chatInput").addEventListener("keydown", submitFormOnEnter("chatForm"));
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(renderPhotoWall, 120);
  });
}

function submitFormOnEnter(formId) {
  return (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) {
      return;
    }

    event.preventDefault();
    document.getElementById(formId).requestSubmit();
  };
}

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

function storedToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

function hasStoredToken() {
  const exp = Number(localStorage.getItem(TOKEN_EXP_KEY) || 0);
  return Boolean(storedToken()) && exp > Date.now();
}

async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (storedToken()) headers.Authorization = `Bearer ${storedToken()}`;
  const response = await fetch(apiUrl(path), { ...options, headers });
  if (response.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXP_KEY);
    setLocked(true);
  }
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data.error || data || "Request failed");
  return data;
}

function setLocked(isLocked) {
  const memoryApp = document.getElementById("memoryApp");
  const appSurface = document.getElementById("appSurface");
  memoryApp.classList.toggle("is-locked", isLocked);
  appSurface.setAttribute("aria-hidden", String(isLocked));
  state.authenticated = !isLocked;
  if (isLocked) {
    window.setTimeout(() => document.getElementById("pinInput").focus(), 40);
  }
}

async function verifyPin() {
  const pinInput = document.getElementById("pinInput");
  const pinError = document.getElementById("pinError");
  const remember = document.getElementById("rememberDevice").checked;
  const pin = pinInput.value.replace(/\D/g, "").slice(0, 4);
  if (pin.length !== 4) {
    pinError.textContent = "Enter exactly 4 digits.";
    return;
  }

  try {
    const result = await apiFetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, remember })
    });
    localStorage.setItem(TOKEN_KEY, result.token);
    localStorage.setItem(TOKEN_EXP_KEY, String(result.expiresAt));
    pinError.textContent = "";
    pinInput.value = "";
    setLocked(false);
    showToast("Unlocked");
    await loadMemories();
    await migrateLegacyLocalMemories();
  } catch (error) {
    pinInput.value = "";
    pinError.textContent = "Wrong PIN or server unavailable.";
    document.getElementById("pinForm").classList.add("is-wrong");
    window.setTimeout(() => document.getElementById("pinForm").classList.remove("is-wrong"), 400);
  }
}

async function loadMemories() {
  if (!hasStoredToken()) return;
  try {
    const result = await apiFetch("/api/memories");
    state.memories = result.memories || [];
    renderWall();
  } catch (error) {
    showToast(error.message);
  }
}

function addPendingFiles(files) {
  const images = files.filter((file) => file.type.startsWith("image/"));
  state.pendingFiles.push(...images);
  updateFileCount();
  if (images.length) {
    showToast(`${images.length} image${images.length === 1 ? "" : "s"} added`);
  }
}

function updateFileCount() {
  const count = state.pendingFiles.length;
  document.getElementById("fileCount").textContent = count ? `${count} image${count === 1 ? "" : "s"} ready` : "";
}

function clearComposer() {
  state.pendingFiles = [];
  document.getElementById("memoryText").value = "";
  updateFileCount();
}

function handleMemoryPaste(event) {
  const clipboard = event.clipboardData;
  if (!clipboard || !clipboard.items) return;

  const images = Array.from(clipboard.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item, index) => {
      const file = item.getAsFile();
      if (!file) return null;
      const extension = item.type.split("/")[1] || "png";
      return new File([file], file.name || `pasted-screenshot-${Date.now()}-${index}.${extension}`, { type: file.type || item.type });
    })
    .filter(Boolean);

  if (!images.length) return;

  const hasText = clipboard.getData("text/plain").trim().length > 0;
  if (!hasText) event.preventDefault();
  addPendingFiles(images);
}

async function saveMemory(event) {
  event.preventDefault();
  const text = document.getElementById("memoryText").value.trim();
  const files = state.pendingFiles.slice();
  if (!text && !files.length) {
    showToast("Add a note or image first.");
    return;
  }

  setBusy(true);
  try {
    const encodedFiles = [];
    for (const file of files) {
      encodedFiles.push({ name: file.name, type: file.type, dataUrl: await readFileAsDataUrl(file) });
    }
    await apiFetch("/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, files: encodedFiles })
    });
    clearComposer();
    await loadMemories();
    showToast("Saved to Lily");
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

async function askQuestion(event) {
  event.preventDefault();
  const input = document.getElementById("chatInput");
  const message = input.value.trim();
  if (!message || state.loading) return;

  state.chat.push({ role: "user", content: message });
  input.value = "";
  renderChat();
  setBusy(true);

  try {
    const result = await apiFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    state.chat.push({ role: "assistant", content: result.answer, sources: result.sources || [], warning: result.warning });
  } catch (error) {
    state.chat.push({ role: "assistant", content: error.message || "I could not answer that yet." });
  } finally {
    setBusy(false);
    renderChat();
  }
}

function renderChat() {
  const messages = document.getElementById("messages");
  if (!messages) return;
  messages.innerHTML = "";
  state.chat.forEach((message) => {
    const node = document.createElement("article");
    node.className = `message ${message.role}`;
    const content = document.createElement("p");
    content.textContent = message.content;
    node.appendChild(content);

    if (message.warning) {
      const warning = document.createElement("span");
      warning.className = "message-warning";
      warning.textContent = message.warning;
      node.appendChild(warning);
    }

    if (message.sources && message.sources.length) {
      const sources = document.createElement("div");
      sources.className = "sources";
      message.sources.slice(0, 4).forEach((source) => {
        const item = document.createElement("span");
        item.textContent = source.text || source.caption || source.summary || source.kind;
        sources.appendChild(item);
      });
      node.appendChild(sources);
    }

    messages.appendChild(node);
  });
  messages.scrollTop = messages.scrollHeight;
}

function renderWall() {
  renderPhotoWall();
  renderFactTable();
}

function renderPhotoWall() {
  const wall = document.getElementById("photoWall");
  const count = document.getElementById("imageCount");
  if (!wall || !count) return;
  const photos = state.memories.filter((memory) => memory.kind === "photo");
  count.textContent = photos.length ? `${photos.length} saved` : "No images yet";
  wall.innerHTML = "";

  if (!photos.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No images.";
    wall.appendChild(empty);
    return;
  }

  const width = wall.clientWidth || window.innerWidth || 320;
  const columnCount = Math.max(2, Math.min(8, Math.floor(width / 150)));
  wall.style.setProperty("--photo-columns", String(columnCount));
  const columns = Array.from({ length: columnCount }, () => {
    const column = document.createElement("div");
    column.className = "photo-column";
    wall.appendChild(column);
    return column;
  });
  photos.forEach((memory, index) => columns[index % columnCount].appendChild(createPhotoTile(memory)));
}

function renderFactTable() {
  const body = document.getElementById("factTableBody");
  const count = document.getElementById("factCount");
  if (!body || !count) return;
  const rows = factRows();
  count.textContent = rows.length ? `${rows.length} facts` : "No notes yet";
  body.innerHTML = "";

  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 2;
    cell.textContent = "No notes.";
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  rows.forEach((item) => {
    const row = document.createElement("tr");
    const fact = document.createElement("td");
    const date = document.createElement("td");
    fact.textContent = item.fact;
    date.textContent = formatDate(item.createdAt);
    row.append(fact, date);
    body.appendChild(row);
  });
}

function factRows() {
  return state.memories
    .filter((memory) => memory.kind !== "photo")
    .flatMap((memory) => {
      const facts = splitFactText(memory.text || memory.summary || "");
      return facts.map((fact, index) => ({
        id: `${memory.id || "fact"}_${index}`,
        fact,
        createdAt: memory.createdAt || memory.updatedAt
      }));
    });
}

function splitFactText(text) {
  const cleaned = String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!cleaned) return [];

  const lineParts = cleaned
    .split(/\n+/)
    .flatMap((line) => line.split(/\s*(?:\u2022|;| - )\s*/))
    .map((part) => part.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);

  return lineParts.flatMap((part) => {
    const sentences = part.match(/[^.!?]+(?:[.!?]+|$)/g) || [part];
    if (sentences.length <= 1) return [part];
    return sentences
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 2);
  }).slice(0, 200);
}

function createPhotoTile(memory) {
  const card = document.createElement("figure");
  card.className = "photo-tile";
  card.title = memory.summary || memory.caption || "saved image";

  const image = document.createElement("img");
  image.alt = memory.caption || "Saved Lily image";
  image.loading = "lazy";
  const mediaPath = memory.file && memory.file.url ? memory.file.url : "";
  image.src = apiUrl(`${mediaPath}?token=${encodeURIComponent(storedToken())}`);
  card.appendChild(image);

  const caption = document.createElement("figcaption");
  caption.className = "photo-caption";
  caption.textContent = memory.summary || memory.caption || "saved image";
  card.appendChild(caption);

  appendDelete(card, memory);
  return card;
}

function appendDelete(card, memory) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "delete-button";
  button.setAttribute("aria-label", "Delete memory");
  button.textContent = "x";
  button.addEventListener("click", async () => {
    if (!window.confirm("Delete this memory?")) return;
    try {
      await apiFetch(`/api/memories/${encodeURIComponent(memory.id)}`, { method: "DELETE" });
      await loadMemories();
      showToast("Deleted");
    } catch (error) {
      showToast(error.message);
    }
  });
  card.appendChild(button);
}

function labelForKind(kind) {
  return {
    quote: "quote",
    date: "date",
    contact: "number",
    address: "place",
    note: "note",
    photo: "photo"
  }[kind] || "note";
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "saved";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function setBusy(isBusy) {
  state.loading = isBusy;
  document.querySelectorAll(".primary-button").forEach((button) => {
    button.disabled = isBusy;
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

async function migrateLegacyLocalMemories() {
  if (localStorage.getItem(LEGACY_MIGRATED_KEY) === "true") return;
  try {
    const raw = localStorage.getItem(LEGACY_MEMORY_KEY);
    const legacy = raw ? JSON.parse(raw) : [];
    const textItems = Array.isArray(legacy)
      ? legacy.filter((item) => item && item.text).map((item) => item.text).slice(0, 50)
      : [];
    if (!textItems.length) {
      localStorage.setItem(LEGACY_MIGRATED_KEY, "true");
      return;
    }
    await apiFetch("/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: textItems.join("\n\n") })
    });
    localStorage.setItem(LEGACY_MIGRATED_KEY, "true");
    await loadMemories();
    showToast("Imported browser-only notes");
  } catch (error) {
    localStorage.setItem(LEGACY_MIGRATED_KEY, "true");
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  window.clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  state.toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2400);
}

init();
