const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

assert.ok(
  app.indexOf('<section class="image-section"') < app.indexOf('<section class="right-rail"'),
  "the photo/video wall must remain left of the controls on desktop"
);
assert.match(
  styles,
  /\.split-workspace\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) minmax\(320px, 354px\);/,
  "the existing media-wall/right-rail desktop proportions must stay preserved"
);
assert.match(
  styles,
  /\.memory-app\.is-loading \.app-surface\s*\{[\s\S]*?display:\s*none;/,
  "the empty workspace must stay hidden during authenticated loading"
);

const storedSessionStart = app.indexOf("async function loadStoredSession()");
const storedSessionEnd = app.indexOf("async function verifyPin()", storedSessionStart);
const storedSession = app.slice(storedSessionStart, storedSessionEnd);
assert.ok(
  storedSession.indexOf("await loadData({ rethrow: true })") < storedSession.indexOf("setLocked(false)"),
  "stored sessions must load all persisted data before revealing the workspace"
);

const verifyPinStart = app.indexOf("async function verifyPin()");
const verifyPinEnd = app.indexOf("async function loadMemories()", verifyPinStart);
const verifyPin = app.slice(verifyPinStart, verifyPinEnd);
assert.ok(
  verifyPin.indexOf("await loadData({ rethrow: true })") < verifyPin.indexOf("setLocked(false)"),
  "newly unlocked sessions must load all persisted data before revealing the workspace"
);

const loadDataStart = app.indexOf("async function loadData(options = {})");
const loadDataEnd = app.indexOf("function addPendingFiles", loadDataStart);
const loadData = app.slice(loadDataStart, loadDataEnd);
for (const endpoint of ["/api/memories", "/api/weights", "/api/tracker"]) {
  assert.ok(loadData.includes(`apiFetch("${endpoint}")`), `initial loading must include ${endpoint}`);
}
assert.ok(
  loadData.indexOf("state.memories =") < loadData.indexOf("renderWall()"),
  "media state must be assigned before the wall is rendered"
);

assert.ok(app.includes('].join(" · ")'), "the visible forecast values must stay compact and scannable");
assert.ok(app.includes('`1 yr ${trimWeight(forecast.oneYearWeight)} lb`'), "the primary card must show a direct one-year forecast");
assert.ok(app.includes('id="weightCoach"'), "the primary card must carry the live coach analysis");
assert.match(styles, /\.panel-head p\.weight-coach/, "coach copy must have an intentional readable treatment");
assert.doesNotMatch(app, /Not a reliable|Only .* of data|does not mean her weight will stay constant|This is an estimate, not a guarantee/i);
assert.doesNotMatch(app, /1-yr baseline|uncalibrated baseline|historically evaluated baseline/i);
assert.ok(!app.includes("completed 1-year outcomes"), "validation plumbing must not crowd the visible weight summary");
assert.ok(
  !app.includes("selected by rolling backtest"),
  "short sequential errors must not be mislabeled as annual rolling-backtest evidence"
);
assert.ok(app.includes('predictionLabel.textContent = "1-YR FORECAST"'), "the overlay must be labeled as a forecast");
assert.ok(app.includes('data-annual-calibrated'), "overlay points must expose annual-calibration state");
assert.ok(!app.includes("Validated from"), "the page must not overclaim annual validation");
assert.ok(
  index.indexOf("/weight-forecast.js") < index.indexOf("/weight-coach.js") && index.indexOf("/weight-coach.js") < index.indexOf("/app.js"),
  "forecast and coach logic must load before the app"
);
assert.ok(
  app.indexOf("points.forEach((point) =>") < app.indexOf("predictionPoints.forEach((point) =>"),
  "the connected forecast series must render as an overlay above the measured weight points"
);

console.log("Lily preservation tests passed");
