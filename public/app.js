const app = document.getElementById("app");

const API_BASE = String(window.LILY_API_BASE || "").replace(/\/$/, "");
const TOKEN_KEY = "lily-api-token-v1";
const TOKEN_EXP_KEY = "lily-api-token-exp-v1";
const LEGACY_MEMORY_KEY = "lily-memories-v1";
const LEGACY_MIGRATED_KEY = "lily-legacy-migrated-v1";
const PIN_LENGTH = 6;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_WEIGHT_TREND_GAP_DAYS = 1;
const HIGH_CONFIDENCE_WEIGHT_SPAN_DAYS = 14;

const state = {
  authenticated: false,
  memories: [],
  weights: [],
  tracker: null,
  pendingFiles: [],
  chat: [
    {
      role: "assistant",
      content: "Ask from saved Lily memory."
    }
  ],
  loading: false,
  toastTimer: null
};

let resizeTimer = null;
let pictureWallLayoutTimer = null;

const memoryTextPlaceholder = "Save a note, date, preference, or pasted screenshot context.";

function init() {
  renderShell();
  bindEvents();
  if (hasStoredToken()) {
    setLocked(false);
    loadData();
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
              <img src="https://aolabs.io/marks/ao-ink.svg?v=20260516-suite-bloom" alt="">
            </a>
            <a class="suite-app-brand" href="/" aria-label="lily home">
              <img class="suite-app-mark" src="/icon.svg?v=20260507-suite3" alt="">
              <span class="suite-app-name">lily.aolabs.io</span>
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

        <main class="split-workspace">
          <section class="image-section" aria-label="Saved Lily pictures and notes">
            <p class="memory-count" id="imageCount" aria-live="polite">No media yet</p>
            <div class="photo-wall" id="photoWall" aria-label="Saved Lily pictures and notes"></div>
          </section>

          <section class="right-rail" aria-label="Lily tools">
            <section class="tracker-panel" aria-label="Lily conflict and period tracker">
              <div class="tracker-announcements" aria-live="polite">
                <p class="tracker-announcement" id="conflictAnnouncement">NO CONFLICTS SAVED</p>
                <p class="tracker-announcement" id="periodAnnouncement">PERIOD START NEEDED</p>
              </div>
              <div class="tracker-actions">
                <button class="secondary-button tracker-button" type="button" id="conflictButton">conflict</button>
                <button class="secondary-button tracker-button" type="button" id="periodButton">period</button>
              </div>
              <p class="tracker-detail" id="trackerDetail">No tracker events saved.</p>
            </section>

            <section class="chat-panel" aria-labelledby="chatTitle">
              <div class="panel-head">
                <div>
                  <h2 id="chatTitle">ask memory</h2>
                  <p>Answers only from saved Lily context.</p>
                </div>
              </div>
              <div class="messages" id="messages" aria-live="polite"></div>
              <form class="chat-form" id="chatForm">
                <textarea id="chatInput" rows="2" placeholder="Ask about Lily"></textarea>
                <button class="primary-button" type="submit">Ask</button>
              </form>
            </section>

            <section class="weight-panel" aria-labelledby="weightTitle">
              <div class="panel-head">
                <div>
                  <h2 id="weightTitle">weight</h2>
                  <p id="weightLatest">No weights saved.</p>
                  <p class="weight-estimate" id="weightEstimate">1-week, 1-month, 1-year estimates need saved weights.</p>
                </div>
              </div>
              <form class="weight-form" id="weightForm">
                <label class="weight-field-label" for="weightInput">Weight</label>
                <div class="weight-entry-row">
                  <div class="weight-input-wrap">
                    <input class="weight-input" id="weightInput" type="number" min="0" max="1000" step="0.1" inputmode="decimal" placeholder="0.0" aria-label="Lily weight in pounds">
                    <span aria-hidden="true">lb</span>
                  </div>
                  <button class="primary-button" type="submit">Save</button>
                </div>
              </form>
              <div class="weight-chart-wrap" id="weightChartWrap" aria-label="Lily weight over time"></div>
              <div class="weight-list" id="weightList" aria-label="Saved Lily weights"></div>
            </section>

            <section class="ingest-panel" aria-labelledby="saveTitle">
              <div class="panel-head">
                <div>
                  <h2 id="saveTitle">save memory</h2>
                  <p>Notes, screenshots, photos, videos.</p>
                </div>
              </div>
              <form id="memoryForm">
                <label class="drop-zone" id="dropZone" tabindex="0" for="photoInput">
                  <span>
                    <strong>Add media</strong>
                    <span>Choose, drop, or paste</span>
                  </span>
                </label>
                <input class="file-input" id="photoInput" type="file" accept="image/*,video/*" multiple>
                <div class="file-count" id="fileCount" aria-live="polite"></div>
                <textarea class="memory-field" id="memoryText" placeholder="${memoryTextPlaceholder}"></textarea>
                <div class="composer-actions">
                  <button class="secondary-button" id="clearComposer" type="button">Clear</button>
                  <button class="primary-button" type="submit">Save</button>
                </div>
              </form>
            </section>
          </section>
        </main>
      </div>

      <div class="pin-overlay" id="pinOverlay" role="dialog" aria-modal="true" aria-labelledby="pinTitle">
        <div class="pin-stage">
          <form class="pin-window" id="pinForm" autocomplete="off">
            <div class="pin-window-head">
              <div class="pin-icon" aria-hidden="true"><img src="/icon.svg?v=20260507-suite3" alt=""></div>
              <div>
                <h3 id="pinTitle">lily</h3>
                <p>Private memory</p>
              </div>
            </div>
            <label class="pin-label" for="pinInput">6-digit PIN</label>
            <input class="pin-input" id="pinInput" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="${PIN_LENGTH}" autocomplete="one-time-code" aria-describedby="pinError">
            <button class="pin-submit" type="submit">Unlock</button>
            <label class="remember-row">
              <input id="rememberDevice" type="checkbox">
              <span>Remember for 1 week</span>
            </label>
            <p class="pin-error" id="pinError" aria-live="polite"></p>
          </form>
        </div>
      </div>

      <div class="toast" id="toast" role="status" aria-live="polite"></div>

      <div class="image-viewer" id="imageViewer" aria-hidden="true">
        <button class="viewer-backdrop" id="viewerBackdrop" type="button" aria-label="Close media"></button>
        <div class="viewer-frame" role="dialog" aria-modal="true" aria-label="Media preview">
          <button class="viewer-close" id="viewerClose" type="button" aria-label="Close media">x</button>
          <img id="viewerImage" alt="">
          <video id="viewerVideo" controls playsinline preload="metadata" hidden></video>
        </div>
      </div>
    </section>
  `;
  renderChat();
  renderWall();
  renderWeights();
  renderTracker();
}

function bindEvents() {
  document.getElementById("pinForm").addEventListener("submit", (event) => {
    event.preventDefault();
    verifyPin();
  });

  document.getElementById("pinInput").addEventListener("input", (event) => {
    event.target.value = event.target.value.replace(/\D/g, "").slice(0, PIN_LENGTH);
    if (event.target.value.length === PIN_LENGTH) window.setTimeout(verifyPin, 80);
  });

  document.getElementById("lockButton").addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXP_KEY);
    setLocked(true);
  });

  document.getElementById("refreshButton").addEventListener("click", loadData);
  document.getElementById("memoryForm").addEventListener("submit", saveMemory);
  document.getElementById("weightForm").addEventListener("submit", saveWeight);
  document.getElementById("conflictButton").addEventListener("click", () => saveTrackerEvent("conflict"));
  document.getElementById("periodButton").addEventListener("click", () => saveTrackerEvent("period"));
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
  document.getElementById("viewerBackdrop").addEventListener("click", closeImageViewer);
  document.getElementById("viewerClose").addEventListener("click", closeImageViewer);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeImageViewer();
  });
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
  const pin = pinInput.value.replace(/\D/g, "").slice(0, PIN_LENGTH);
  if (pin.length !== PIN_LENGTH) {
    pinError.textContent = `Enter exactly ${PIN_LENGTH} digits.`;
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
    await loadData();
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

async function loadWeights() {
  if (!hasStoredToken()) return;
  try {
    const result = await apiFetch("/api/weights");
    state.weights = Array.isArray(result.weights) ? result.weights : [];
    renderWeights();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadTracker() {
  if (!hasStoredToken()) return;
  try {
    const result = await apiFetch("/api/tracker");
    state.tracker = result.tracker || null;
    renderTracker();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadData() {
  await Promise.all([loadMemories(), loadWeights(), loadTracker()]);
}

function addPendingFiles(files) {
  const media = files.filter((file) => isSupportedUpload(file));
  state.pendingFiles.push(...media);
  updateFileCount();
  if (media.length) {
    showToast(`${media.length} media file${media.length === 1 ? "" : "s"} added`);
  }
}

function updateFileCount() {
  const count = state.pendingFiles.length;
  document.getElementById("fileCount").textContent = count ? `${count} media file${count === 1 ? "" : "s"} ready` : "";
}

function isSupportedUpload(file) {
  return Boolean(file && (file.type.startsWith("image/") || file.type.startsWith("video/")));
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
    showToast("Add a note, image, or video first.");
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

async function saveWeight(event) {
  event.preventDefault();
  const input = document.getElementById("weightInput");
  const weight = Number(input.value);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 1000) {
    showToast("Enter a valid weight.");
    return;
  }

  setBusy(true);
  try {
    await apiFetch("/api/weights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weight, unit: "lb" })
    });
    input.value = "";
    await loadWeights();
    showToast("Weight saved");
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

async function saveTrackerEvent(type) {
  if (state.loading) return;
  setBusy(true);
  try {
    const result = await apiFetch(`/api/tracker/${type}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    state.tracker = result.tracker || null;
    renderTracker();
    showToast(type === "conflict" ? "Conflict saved" : "Period start saved");
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

function renderWeights() {
  const latest = document.getElementById("weightLatest");
  const estimate = document.getElementById("weightEstimate");
  const chartWrap = document.getElementById("weightChartWrap");
  const list = document.getElementById("weightList");
  if (!latest || !chartWrap || !list) return;

  const rows = weightRows();
  const newest = rows[0];
  latest.textContent = newest ? `${formatWeight(newest)} saved ${formatDateTime(newest.createdAt)}` : "No weights saved.";
  if (estimate) estimate.textContent = createWeightEstimate(rows);
  chartWrap.innerHTML = "";
  list.innerHTML = "";

  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state weight-empty";
    empty.textContent = "No weights saved.";
    chartWrap.appendChild(empty);
    return;
  }

  chartWrap.appendChild(createWeightChart(rows.slice().reverse()));
  rows.slice(0, 8).forEach((record) => list.appendChild(createWeightRow(record)));
}

function renderTracker() {
  const conflict = document.getElementById("conflictAnnouncement");
  const period = document.getElementById("periodAnnouncement");
  const detail = document.getElementById("trackerDetail");
  if (!conflict || !period || !detail) return;

  const tracker = state.tracker || {};
  const conflictDays = numberOrNull(tracker.daysSinceLastConflict);
  const longestConflictStreak = numberOrNull(tracker.longestConflictStreakDays);
  const periodDays = numberOrNull(tracker.daysUntilNextPeriod);

  conflict.textContent = conflictDays !== null
    ? `${Math.max(0, Math.round(conflictDays))} DAYS SINCE LAST CONFLICT. LONGEST STREAK: ${Math.max(0, Math.round(longestConflictStreak ?? conflictDays))} DAYS`
    : "NO CONFLICTS SAVED";
  period.textContent = periodDays !== null
    ? `${Math.max(0, Math.round(periodDays))} DAYS UNTIL NEXT PERIOD`
    : "PERIOD START NEEDED";

  const parts = [];
  if (tracker.latestConflictDateKey) parts.push(`conflict ${formatDateKey(tracker.latestConflictDateKey)}`);
  if (tracker.latestPeriodDateKey) parts.push(`period ${formatDateKey(tracker.latestPeriodDateKey)}`);
  if (tracker.latestPeriodDateKey && Number.isFinite(Number(tracker.periodCycleDays))) {
    parts.push(`${Math.round(Number(tracker.periodCycleDays))}-day estimate`);
  }
  if (Number(tracker.periodOverdueDays) > 0) {
    parts.push(`${Math.round(Number(tracker.periodOverdueDays))} days past estimate`);
  }
  detail.textContent = parts.length ? parts.join(" / ") : "No tracker events saved.";
}

function weightRows() {
  return state.weights
    .filter((record) => Number.isFinite(Number(record.weight)) && record.createdAt)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function createWeightEstimate(rows) {
  const estimateLabel = "1-week, 1-month, 1-year estimates";
  if (!rows.length) return `${estimateLabel} needs saved weights.`;

  const newest = rows[0];
  const latestWeight = weightInPounds(newest);
  const latestTime = Date.parse(newest.createdAt);
  if (!Number.isFinite(latestWeight) || !Number.isFinite(latestTime)) return `${estimateLabel} needs saved weights.`;

  const points = dailyWeightPoints(rows);
  if (points.length < 2) return `${estimateLabel} needs weights on different days. Latest ${trimWeight(latestWeight)} lb.`;

  const spanDays = (points[points.length - 1].time - points[0].time) / DAY_MS;
  if (!Number.isFinite(spanDays) || spanDays <= 0) return `${estimateLabel} needs weights on different days. Latest ${trimWeight(latestWeight)} lb.`;

  const trend = robustDailyWeightTrend(points);
  const rate = trend.rate;
  if (!Number.isFinite(rate)) {
    return `${estimateLabel} needs a stable trend. Latest ${trimWeight(latestWeight)} lb.`;
  }

  const latestDate = new Date(latestTime);
  const projections = [
    createWeightProjection("1 week", latestWeight, latestTime, rate, addCalendarDays(latestDate, 7)),
    createWeightProjection("1 month", latestWeight, latestTime, rate, addCalendarMonths(latestDate, 1)),
    createWeightProjection("1 year", latestWeight, latestTime, rate, addCalendarMonths(latestDate, 12), true)
  ].join("; ");
  const confidence = weightProjectionConfidence(points.length, spanDays, trend.rangeSlopes.length);
  return `${projections}. ${confidence}; ${formatSignedRate(rate)} lb/day median trend from ${points.length} weights over ${formatPreciseDuration(spanDays)}.`;
}

function dailyWeightPoints(rows) {
  const groups = new Map();
  rows.slice().reverse().forEach((record) => {
    const time = Date.parse(record.createdAt);
    const weight = weightInPounds(record);
    if (!Number.isFinite(time) || !Number.isFinite(weight)) return;
    const key = localDateKey(time);
    const group = groups.get(key) || { times: [], weights: [] };
    group.times.push(time);
    group.weights.push(weight);
    groups.set(key, group);
  });

  return Array.from(groups.values())
    .map((group) => ({
      time: median(group.times),
      weight: median(group.weights)
    }))
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.weight))
    .sort((a, b) => a.time - b.time);
}

function robustDailyWeightTrend(points, direction) {
  const slopes = [];
  const longGapSlopes = [];
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const dayDelta = (points[j].time - points[i].time) / DAY_MS;
      if (dayDelta > 0) {
        const slope = (points[j].weight - points[i].weight) / dayDelta;
        slopes.push(slope);
        if (dayDelta >= MIN_WEIGHT_TREND_GAP_DAYS) longGapSlopes.push(slope);
      }
    }
  }
  const basisSlopes = longGapSlopes.length ? longGapSlopes : slopes;
  const finiteSlopes = basisSlopes.filter((slope) => Number.isFinite(slope));
  const alignedSlopes = finiteSlopes.filter((slope) => (
    slope !== 0 &&
    (!direction || Math.sign(slope) === direction)
  ));
  const rangeSlopes = direction && alignedSlopes.length ? alignedSlopes : finiteSlopes;
  return {
    rate: median(rangeSlopes),
    rangeSlopes
  };
}

function createWeightProjection(label, latestWeight, latestTime, rate, projectedDate, includeYear = false) {
  const projectionDays = (projectedDate.getTime() - latestTime) / DAY_MS;
  const projectedWeight = latestWeight + rate * projectionDays;
  return `${label} ${formatProjectionDate(projectedDate, includeYear)}: ${trimWeight(projectedWeight)} lb`;
}

function addCalendarDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function addCalendarMonths(date, months) {
  const next = new Date(date.getTime());
  const originalDay = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  const daysInMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(originalDay, daysInMonth));
  return next;
}

function weightProjectionConfidence(pointCount, spanDays, rangeSlopeCount) {
  if (pointCount < 2 || rangeSlopeCount < 1) return "Needs more saved weights";
  if (spanDays < HIGH_CONFIDENCE_WEIGHT_SPAN_DAYS || pointCount < 7) return "Early trend, not high-confidence yet";
  return "Research-grade trend";
}

function weightInPounds(record) {
  const value = Number(record && record.weight);
  if (!Number.isFinite(value)) return NaN;
  return String(record.unit || "lb").trim().toLowerCase() === "kg" ? value * 2.2046226218 : value;
}

function localDateKey(time) {
  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function createWeightChart(records) {
  const ns = "http://www.w3.org/2000/svg";
  const width = 330;
  const height = 178;
  const pad = { top: 16, right: 16, bottom: 32, left: 42 };
  const values = records.map((record) => Number(record.weight));
  const times = records.map((record) => Date.parse(record.createdAt));
  const validTimes = times.map((time) => (Number.isFinite(time) ? time : Date.now()));
  let minTime = Math.min(...validTimes);
  let maxTime = Math.max(...validTimes);
  let minWeight = Math.min(...values);
  let maxWeight = Math.max(...values);

  if (minTime === maxTime) {
    minTime -= 60 * 60 * 1000;
    maxTime += 60 * 60 * 1000;
  }

  if (minWeight === maxWeight) {
    minWeight -= 1;
    maxWeight += 1;
  } else {
    const spread = maxWeight - minWeight;
    minWeight -= Math.max(0.2, spread * 0.18);
    maxWeight += Math.max(0.2, spread * 0.18);
  }

  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const xFor = (time) => pad.left + ((time - minTime) / (maxTime - minTime)) * plotWidth;
  const yFor = (weight) => pad.top + (1 - (weight - minWeight) / (maxWeight - minWeight)) * plotHeight;
  const points = records.map((record, index) => ({
    x: xFor(validTimes[index]),
    y: yFor(Number(record.weight)),
    record
  }));
  const sameChartDay = new Date(records[0].createdAt).toDateString() === new Date(records[records.length - 1].createdAt).toDateString();
  const pathData = points
    .map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");

  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Lily weight chart with ${records.length} saved ${records.length === 1 ? "entry" : "entries"}.`);

  const grid = document.createElementNS(ns, "g");
  grid.setAttribute("class", "weight-grid");
  [0, 0.5, 1].forEach((ratio) => {
    const y = pad.top + ratio * plotHeight;
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", String(pad.left));
    line.setAttribute("x2", String(width - pad.right));
    line.setAttribute("y1", y.toFixed(1));
    line.setAttribute("y2", y.toFixed(1));
    grid.appendChild(line);
  });
  svg.appendChild(grid);

  const axis = document.createElementNS(ns, "g");
  axis.setAttribute("class", "weight-axis");
  [
    ["line", { x1: pad.left, x2: pad.left, y1: pad.top, y2: height - pad.bottom }],
    ["line", { x1: pad.left, x2: width - pad.right, y1: height - pad.bottom, y2: height - pad.bottom }]
  ].forEach(([tag, attrs]) => {
    const line = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([key, value]) => line.setAttribute(key, String(value)));
    axis.appendChild(line);
  });
  svg.appendChild(axis);

  const yMax = document.createElementNS(ns, "text");
  yMax.setAttribute("x", "8");
  yMax.setAttribute("y", String(pad.top + 4));
  yMax.textContent = `${trimWeight(maxWeight)} lb`;
  svg.appendChild(yMax);

  const yMin = document.createElementNS(ns, "text");
  yMin.setAttribute("x", "8");
  yMin.setAttribute("y", String(height - pad.bottom + 4));
  yMin.textContent = `${trimWeight(minWeight)} lb`;
  svg.appendChild(yMin);

  const firstTime = document.createElementNS(ns, "text");
  firstTime.setAttribute("x", String(pad.left));
  firstTime.setAttribute("y", String(height - 8));
  firstTime.textContent = formatShortDate(records[0].createdAt, sameChartDay);
  svg.appendChild(firstTime);

  const lastTime = document.createElementNS(ns, "text");
  lastTime.setAttribute("x", String(width - pad.right));
  lastTime.setAttribute("y", String(height - 8));
  lastTime.setAttribute("text-anchor", "end");
  lastTime.textContent = formatShortDate(records[records.length - 1].createdAt, sameChartDay);
  svg.appendChild(lastTime);

  if (points.length > 1) {
    const trend = document.createElementNS(ns, "path");
    trend.setAttribute("class", "weight-trend");
    trend.setAttribute("d", pathData);
    svg.appendChild(trend);
  }

  points.forEach((point) => {
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("class", "weight-point");
    circle.setAttribute("cx", point.x.toFixed(1));
    circle.setAttribute("cy", point.y.toFixed(1));
    circle.setAttribute("r", "4");
    const title = document.createElementNS(ns, "title");
    title.textContent = `${formatWeight(point.record)} saved ${formatDateTime(point.record.createdAt)}`;
    circle.appendChild(title);
    svg.appendChild(circle);
  });

  return svg;
}

function createWeightRow(record) {
  const row = document.createElement("div");
  row.className = "weight-row";

  const value = document.createElement("strong");
  value.textContent = formatWeight(record);

  const time = document.createElement("time");
  time.dateTime = record.createdAt || "";
  time.textContent = formatDateTime(record.createdAt);

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "weight-delete";
  deleteButton.setAttribute("aria-label", `Delete ${formatWeight(record)} saved ${formatDateTime(record.createdAt)}`);
  deleteButton.textContent = "x";
  deleteButton.addEventListener("click", async () => {
    if (!window.confirm("Delete this weight?")) return;
    try {
      await apiFetch(`/api/weights/${encodeURIComponent(record.id)}`, { method: "DELETE" });
      await loadWeights();
      showToast("Weight deleted");
    } catch (error) {
      showToast(error.message);
    }
  });

  row.append(value, time, deleteButton);
  return row;
}

function renderPhotoWall() {
  const wall = document.getElementById("photoWall");
  const count = document.getElementById("imageCount");
  if (!wall || !count) return;
  const photoMemories = state.memories
    .filter((memory) => memory.kind === "photo" || memory.kind === "video")
    .sort((a, b) => String(b.createdAt || b.updatedAt || "").localeCompare(String(a.createdAt || a.updatedAt || "")));
  const displayPhotos = photoMemories.filter(hasDisplayablePhoto);
  const sourcePhotoNotes = photoMemories.filter((memory) => !hasDisplayablePhoto(memory));
  const notes = noteRows().slice(0, 60);
  count.textContent = displayPhotos.length || sourcePhotoNotes.length || notes.length
    ? `${displayPhotos.length} media / ${sourcePhotoNotes.length + notes.length} note${sourcePhotoNotes.length + notes.length === 1 ? "" : "s"}`
    : "No memories yet";
  wall.innerHTML = "";

  if (!displayPhotos.length && !sourcePhotoNotes.length && !notes.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Add notes, photos, or videos.";
    wall.appendChild(empty);
    return;
  }

  if (displayPhotos.length) {
    const pictureWall = document.createElement("div");
    pictureWall.className = "picture-wall";
    displayPhotos.forEach((memory) => pictureWall.appendChild(createPhotoTile(memory)));
    wall.appendChild(pictureWall);
    queuePictureWallLayout();
  }

  if (sourcePhotoNotes.length || notes.length) {
    const notesWall = document.createElement("div");
    notesWall.className = "notes-wall";
    sourcePhotoNotes.forEach((memory) => notesWall.appendChild(createPhotoTile(memory)));
    notes.forEach((memory) => notesWall.appendChild(createNoteTile(memory)));
    wall.appendChild(notesWall);
  }
}

function renderFactTable() {
  const body = document.getElementById("factTableBody");
  const count = document.getElementById("factCount");
  if (!body || !count) return;
  const rows = noteRows();
  count.textContent = rows.length ? `${rows.length} notes` : "No notes yet";
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
    fact.textContent = noteMemoryText(item);
    date.textContent = formatDateTime(item.createdAt);
    row.append(fact, date);
    body.appendChild(row);
  });
}

function factRows() {
  return noteRows().map((memory) => ({
    id: memory.id,
    fact: noteMemoryText(memory),
    createdAt: memory.createdAt || memory.updatedAt
  }));
}

function noteRows() {
  return state.memories
    .filter((memory) => memory.kind !== "photo" && memory.kind !== "video")
    .sort((a, b) => String(b.createdAt || b.updatedAt || "").localeCompare(String(a.createdAt || a.updatedAt || "")));
}

function createPhotoTile(memory) {
  const card = document.createElement("figure");
  card.className = "photo-tile";
  card.title = photoMemoryText(memory);
  const isVideo = isVideoMemory(memory);
  if (hasDisplayablePhoto(memory)) {
    card.classList.add("is-image-tile");
    if (isVideo) card.classList.add("is-video-tile");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", isVideo ? "Open saved video" : "Open saved image");
    card.addEventListener("click", (event) => {
      if (event.target.closest(".delete-button")) return;
      openImageViewer(memory);
    });
    card.addEventListener("keydown", (event) => {
      if (event.target !== card || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      openImageViewer(memory);
    });

    const media = isVideo ? document.createElement("video") : document.createElement("img");
    if (isVideo) {
      media.muted = true;
      media.playsInline = true;
      media.preload = "metadata";
      media.setAttribute("aria-label", memory.caption || memory.summary || "Saved Lily video");
    } else {
      media.alt = memory.caption || memory.summary || "Saved Lily image";
      media.loading = "lazy";
    }
    media.src = imageUrlForMemory(memory);
    if (!isVideo && media.complete && media.naturalWidth && media.naturalHeight) {
      setPhotoTileRatio(card, media);
    } else {
      media.addEventListener(isVideo ? "loadedmetadata" : "load", () => {
        setPhotoTileRatio(card, media);
        queuePictureWallLayout();
      }, { once: true });
    }
    media.addEventListener("error", () => card.classList.add("is-image-missing"), { once: true });
    card.appendChild(media);

    const caption = document.createElement("figcaption");
    caption.className = "photo-caption";
    caption.textContent = photoMemoryText(memory);
    card.appendChild(caption);
  } else {
    card.classList.add("is-note-tile", "is-source-tile");
    const note = document.createElement("figcaption");
    note.className = "photo-note";

    const text = document.createElement("p");
    text.textContent = photoMemoryText(memory);

    const date = document.createElement("time");
    date.dateTime = memory.createdAt || memory.updatedAt || "";
    date.textContent = formatDateTime(memory.createdAt || memory.updatedAt);

    note.append(text, date);
    card.appendChild(note);
  }

  appendDelete(card, memory);
  return card;
}

function setPhotoTileRatio(card, image) {
  const naturalWidth = Number(image.naturalWidth || image.videoWidth || 0);
  const naturalHeight = Number(image.naturalHeight || image.videoHeight || 0);
  if (!naturalWidth || !naturalHeight) return;
  card.dataset.ratio = String(naturalWidth / naturalHeight);
}

function queuePictureWallLayout() {
  window.clearTimeout(pictureWallLayoutTimer);
  pictureWallLayoutTimer = window.setTimeout(layoutPictureWall, 30);
}

function layoutPictureWall() {
  const wall = document.querySelector(".picture-wall");
  if (!wall) return;
  const cards = Array.from(wall.querySelectorAll(".photo-tile.is-image-tile"));
  if (!cards.length) return;

  const wallWidth = Math.floor(wall.clientWidth || 0);
  if (!wallWidth) return;
  const compact = window.matchMedia("(max-width: 720px)").matches;
  const gap = 4;
  const targetColumnWidth = compact ? 116 : 160;
  const columnCount = Math.max(2, Math.floor((wallWidth + gap) / (targetColumnWidth + gap)));
  const columnWidth = (wallWidth - gap * (columnCount - 1)) / columnCount;
  const targetArea = compact ? 46000 : 78000;
  const columnHeights = Array(columnCount).fill(0);

  cards.forEach((card) => {
    const ratio = Math.max(0.3, Math.min(3.4, Number(card.dataset.ratio || 1) || 1));
    const desiredWidth = Math.sqrt(targetArea * ratio);
    const desiredSpan = Math.round((desiredWidth + gap) / (columnWidth + gap));
    const span = Math.max(1, Math.min(columnCount, desiredSpan));
    const width = Math.round(columnWidth * span + gap * (span - 1));
    const height = Math.round(width / ratio);
    let bestStart = 0;
    let bestY = Number.POSITIVE_INFINITY;

    for (let start = 0; start <= columnCount - span; start += 1) {
      const y = Math.max(...columnHeights.slice(start, start + span));
      if (y < bestY) {
        bestY = y;
        bestStart = start;
      }
    }

    const x = Math.round(bestStart * (columnWidth + gap));
    card.style.setProperty("--tile-width", `${width}px`);
    card.style.setProperty("--tile-height", `${height}px`);
    card.style.transform = `translate(${x}px, ${Math.round(bestY)}px)`;

    const nextY = bestY + height + gap;
    for (let column = bestStart; column < bestStart + span; column += 1) {
      columnHeights[column] = nextY;
    }
  });

  wall.style.height = `${Math.max(...columnHeights) - gap}px`;
}

function photoMemoryText(memory) {
  const facts = Array.isArray(memory.facts) ? memory.facts.filter(Boolean) : [];
  const extracted = String(memory.extractedText || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .find(Boolean);
  return [
    memory.summary,
    memory.caption,
    facts[0],
    extracted,
    memory.file?.originalName,
    isVideoMemory(memory) ? "Saved video" : "Saved image"
  ].map((value) => String(value || "").trim()).find(Boolean);
}

function noteMemoryText(memory) {
  return String(memory.text || memory.summary || memory.caption || memory.extractedText || "Saved note").trim();
}

function createNoteTile(memory) {
  const card = document.createElement("figure");
  card.className = "photo-tile is-note-tile is-fact-tile";
  card.title = noteMemoryText(memory);

  const note = document.createElement("figcaption");
  note.className = "photo-note";

  const text = document.createElement("p");
  text.textContent = noteMemoryText(memory);

  const date = document.createElement("time");
  date.dateTime = memory.createdAt || memory.updatedAt || "";
  date.textContent = formatDateTime(memory.createdAt || memory.updatedAt);

  note.append(text, date);
  card.appendChild(note);
  appendDelete(card, memory);
  return card;
}

function hasDisplayablePhoto(memory) {
  const mediaPath = memory.file && memory.file.url ? memory.file.url : "";
  const fileSize = Number(memory.file && memory.file.size ? memory.file.size : 0);
  return Boolean(mediaPath) && fileSize >= 512;
}

function isVideoMemory(memory) {
  return memory.kind === "video" || String(memory.file?.type || "").startsWith("video/");
}

function imageUrlForMemory(memory) {
  const mediaPath = memory.file && memory.file.url ? memory.file.url : "";
  return apiUrl(`${mediaPath}?token=${encodeURIComponent(storedToken())}`);
}

function openImageViewer(memory) {
  const viewer = document.getElementById("imageViewer");
  const image = document.getElementById("viewerImage");
  const video = document.getElementById("viewerVideo");
  const close = document.getElementById("viewerClose");
  if (!viewer || !image || !video || !memory) return;

  if (isVideoMemory(memory)) {
    image.hidden = true;
    image.removeAttribute("src");
    image.alt = "";
    video.hidden = false;
    video.src = imageUrlForMemory(memory);
    video.setAttribute("aria-label", memory.caption || memory.summary || "Saved Lily video");
  } else {
    video.hidden = true;
    video.pause();
    video.removeAttribute("src");
    video.removeAttribute("aria-label");
    image.hidden = false;
    image.src = imageUrlForMemory(memory);
    image.alt = memory.caption || memory.summary || "Saved Lily image";
  }
  viewer.classList.add("is-open");
  viewer.setAttribute("aria-hidden", "false");
  document.body.classList.add("viewer-open");
  window.setTimeout(() => close && close.focus(), 0);
}

function closeImageViewer() {
  const viewer = document.getElementById("imageViewer");
  const image = document.getElementById("viewerImage");
  const video = document.getElementById("viewerVideo");
  if (!viewer || !viewer.classList.contains("is-open")) return;

  viewer.classList.remove("is-open");
  viewer.setAttribute("aria-hidden", "true");
  document.body.classList.remove("viewer-open");
  if (image) {
    image.removeAttribute("src");
    image.alt = "";
    image.hidden = false;
  }
  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.removeAttribute("aria-label");
    video.hidden = true;
  }
}

function appendDelete(card, memory) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "delete-button";
  button.setAttribute("aria-label", "Delete memory");
  button.textContent = "x";
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
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

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "saved";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatShortDate(value, includeTime = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, includeTime
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric" }).format(date);
}

function formatProjectionDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatProjectionDate(value, includeYear = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const options = {
    month: "short",
    day: "numeric"
  };
  if (includeYear) options.year = "numeric";
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function formatDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric"
  }).format(date);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatDuration(days) {
  if (!Number.isFinite(days) || days < 0) return "";
  if (days < 1) {
    const hours = Math.max(1, Math.round(days * 24));
    return `${hours} hr`;
  }
  const rounded = Math.max(1, Math.round(days));
  return `${rounded} day${rounded === 1 ? "" : "s"}`;
}

function formatPreciseDuration(days) {
  if (!Number.isFinite(days) || days < 0) return "";
  const totalHours = Math.max(1, Math.round(days * 24));
  const wholeDays = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (!wholeDays) return `${hours} hr`;
  if (!hours) return `${wholeDays} day${wholeDays === 1 ? "" : "s"}`;
  return `${wholeDays} day${wholeDays === 1 ? "" : "s"} ${hours} hr`;
}

function formatSignedRate(rate) {
  if (!Number.isFinite(rate)) return "";
  const rounded = Math.round(Math.abs(rate) * 1000) / 1000;
  const text = rounded.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `${rate >= 0 ? "+" : "-"}${text || "0"}`;
}

function trimWeight(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  return String(Math.round(numeric * 10) / 10).replace(/\.0$/, "");
}

function formatWeight(record) {
  return `${trimWeight(record.weight)} ${record.unit || "lb"}`;
}

function setBusy(isBusy) {
  state.loading = isBusy;
  document.querySelectorAll(".primary-button, .tracker-button").forEach((button) => {
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
