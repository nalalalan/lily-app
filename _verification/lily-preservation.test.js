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
assert.ok(app.includes('id="weightVerdict"'), "the primary card must show a standalone current verdict");
assert.ok(app.includes('id="weightCoach"'), "the primary card must carry the live coach analysis");
assert.match(styles, /\.panel-head p\.weight-verdict/, "the verdict must have a distinct first-read treatment");
assert.match(styles, /weight-verdict\[data-tone="positive"\]/, "approved results must expose a positive status treatment");
assert.match(styles, /weight-verdict\[data-tone="negative"\]/, "disapproved results must expose a negative status treatment");
assert.match(styles, /\.panel-head p\.weight-coach/, "coach copy must have an intentional readable treatment");
assert.ok(
  app.indexOf('id="weightVerdict"') < app.indexOf('id="weightCoach"'),
  "the current verdict must render before broader trend analysis"
);
assert.ok(app.includes("WEIGHT_COACH.verdict(read)"), "the visible verdict must come from the tested coach state");
assert.ok(app.includes("WEIGHT_COACH.composeDetail(read)"), "the broader analysis must stay separate from the verdict");
assert.doesNotMatch(app, /Not a reliable|Only .* of data|does not mean her weight will stay constant|This is an estimate, not a guarantee/i);
assert.doesNotMatch(app, /1-yr baseline|uncalibrated baseline|historically evaluated baseline/i);
assert.ok(!app.includes("completed 1-year outcomes"), "validation plumbing must not crowd the visible weight summary");
assert.ok(
  !app.includes("selected by rolling backtest"),
  "short sequential errors must not be mislabeled as annual rolling-backtest evidence"
);
assert.ok(app.includes('id="weightActualChartWrap"'), "actual weight must have its own chart");
assert.ok(app.includes('id="weightForecastChartWrap"'), "one-year prediction history must have its own chart");
assert.ok(
  app.indexOf('id="weightActualChartWrap"') < app.indexOf('id="weightForecastChartWrap"'),
  "actual weight must remain visually primary above prediction history"
);
assert.ok(app.includes('id="weightActualChartValue"'), "the actual chart must label the current saved weight");
assert.ok(app.includes('id="weightForecastChartValue"'), "the prediction chart must label its current endpoint");
assert.ok(app.includes('data-chart-kind", options.kind'), "each chart must identify its independent data domain");
assert.ok(app.includes('data-annual-calibrated'), "prediction-history points must expose annual-calibration state");
assert.ok(app.includes('data-continuity-bounded'), "prediction-history points must expose the continuity gate");
assert.ok(!app.includes("Validated from"), "the page must not overclaim annual validation");
assert.ok(
  index.indexOf("/weight-forecast.js") < index.indexOf("/weight-coach.js") && index.indexOf("/weight-coach.js") < index.indexOf("/app.js"),
  "forecast and coach logic must load before the app"
);
const actualChartStart = app.indexOf("function createActualWeightChart");
const forecastChartStart = app.indexOf("function createOneYearForecastChart");
const actualChart = app.slice(actualChartStart, forecastChartStart);
const forecastChart = app.slice(forecastChartStart, app.indexOf("function createWeightRow", forecastChartStart));
assert.ok(actualChartStart > 0 && forecastChartStart > actualChartStart, "the two chart renderers must stay separate and actual-first");
assert.doesNotMatch(actualChart, /buildOneYearHistory|weight-prediction/, "forecast values must never enter the actual chart or its y-domain");
assert.doesNotMatch(forecastChart, /weight-history-line|weight-trend-line/, "actual weights and their trend must never enter the prediction chart");
assert.ok(!app.includes("one-year forecast history overlay"), "the rejected combined-overlay rendering path must stay removed");
assert.match(styles, /\.weight-chart-stack\s*\{[\s\S]*?display:\s*grid;/, "the two charts must render as a deliberate stack");
assert.match(styles, /\.weight-point\.is-current/, "the latest actual weight point must be visibly emphasized");
assert.ok(index.includes("20260720-weight-verdict-v4"), "the live bundle must carry the verdict-first cache key");

console.log("Lily preservation tests passed");
