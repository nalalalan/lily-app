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
assert.ok(app.includes('`about ${Math.round(exact)} lb in 1 yr`'), "an uncalibrated outlook must use a rounded about-value");
assert.equal((app.match(/id="weightCoach"/g) || []).length, 1, "the primary card must contain exactly one coach paragraph");
assert.ok(!app.includes('id="weightVerdict"'), "the rejected standalone verdict paragraph must stay removed");
assert.match(styles, /\.panel-head p\.weight-coach\s*\{[\s\S]*?font-weight:\s*700;/, "coach copy must have an intentional first-read treatment");
assert.ok(
  app.indexOf('id="weightLatest"') < app.indexOf('id="weightEstimate"') &&
    app.indexOf('id="weightEstimate"') < app.indexOf('id="weightCoach"'),
  "latest weight, forecast line, and one coach paragraph must lead the card in that order"
);
assert.ok(app.includes("state.latestCoach = normalizeLatestCoach(weightResult.latestCoach)"), "initial loading must retain the persisted coach paragraph");
assert.ok(app.includes("state.latestCoach = normalizeLatestCoach(result.latestCoach)"), "weight refreshes and saves must retain the returned coach paragraph");
assert.ok(app.includes("pollCoachReplacement(result.weight?.id, result.latestCoach?.text)"), "the open page must retrieve a critic-approved replacement without a manual refresh");
assert.ok(app.includes("for (const waitMs of [1200, 1800, 2500, 4000, 6000, 9000, 10000])"), "coach replacement polling must cover the bounded background generation window");
assert.ok(app.includes("asOfDay: dailyPoints[dailyPoints.length - 1].day"), "the headline and endpoint must stay anchored to the latest measured calendar day");
assert.ok(app.includes("String(saved.weightId) === String(newest.id)"), "a persisted coach paragraph must match the latest weight before display");
assert.doesNotMatch(app, /Not a reliable|Only .* of data|does not mean her weight will stay constant|This is an estimate, not a guarantee/i);
assert.doesNotMatch(app, /1-yr baseline|uncalibrated baseline|historically evaluated baseline/i);
assert.ok(!app.includes("completed 1-year outcomes"), "validation plumbing must not crowd the visible weight summary");
assert.ok(
  !app.includes("selected by rolling backtest"),
  "short sequential errors must not be mislabeled as annual rolling-backtest evidence"
);
assert.ok(app.includes('id="weightActualChartWrap"'), "actual weight must have its own chart");
assert.ok(app.includes('id="weightForecastChartWrap"'), "one-year trend outlook must have its own chart");
assert.ok(app.includes("actual weight vs time"), "the actual chart must use the screenshot-ready visible name");
assert.ok(app.includes("1-year trend outlook vs time"), "the outlook chart must use the screenshot-ready visible name");
assert.doesNotMatch(app, /one-year prediction history|prediction history/i, "public chart copy must use trend outlook language");
assert.ok(
  app.indexOf('id="weightActualChartWrap"') < app.indexOf('id="weightForecastChartWrap"'),
  "actual weight must remain visually primary above the trend outlook"
);
assert.ok(
  app.indexOf('id="weightForecastChartWrap"') < app.indexOf('id="weightForm"'),
  "both charts must appear before the weight-entry form"
);
assert.ok(app.includes('id="weightActualChartValue"'), "the actual chart must label the current saved weight");
assert.ok(app.includes('id="weightForecastChartValue"'), "the outlook chart must label its current endpoint");
assert.ok(app.includes('data-chart-kind", options.kind'), "each chart must identify its independent data domain");
assert.ok(app.includes('data-annual-calibrated'), "outlook points must expose annual-calibration state");
assert.ok(app.includes('data-continuity-bounded'), "outlook points must expose the continuity gate");
assert.ok(app.includes('data-outlook-direction'), "each outlook segment must expose its direction without relying on color");
assert.ok(app.includes('data-current-one-year-outlook'), "the SVG must retain the exact current outlook value");
assert.ok(app.includes('≈${Math.round(endpoint.weight)} lb ${arrow} ${signedChange}'), "the endpoint must directly label its rounded value, arrow, and change");
assert.ok(!app.includes("Validated from"), "the page must not overclaim annual validation");
assert.ok(
  index.indexOf("/weight-forecast.js") < index.indexOf("/app.js"),
  "forecast logic must load before the app"
);
assert.ok(!index.includes("/weight-coach.js"), "the retired browser-generated coach path must not ship beside persisted server coaching");
const actualChartStart = app.indexOf("function createActualWeightChart");
const forecastChartStart = app.indexOf("function createOneYearOutlookChart");
const actualChart = app.slice(actualChartStart, forecastChartStart);
const forecastChart = app.slice(forecastChartStart, app.indexOf("function createWeightRow", forecastChartStart));
assert.ok(actualChartStart > 0 && forecastChartStart > actualChartStart, "the two chart renderers must stay separate and actual-first");
assert.doesNotMatch(actualChart, /buildOneYearHistory|weight-outlook-segment/, "outlook values must never enter the actual chart or its y-domain");
assert.doesNotMatch(forecastChart, /weight-history-line|weight-trend-line/, "actual weights and their trend must never enter the outlook chart");
assert.match(forecastChart, /minSpan:\s*10,[\s\S]*?minPadding:\s*2,[\s\S]*?roundStep:\s*5,/, "the outlook must keep its independent padded five-pound-rounded scale");
assert.ok(forecastChart.includes('document.createElementNS(frame.ns, "line")'), "outlook points must be joined by straight non-overshooting segments");
assert.ok(!app.includes("one-year forecast history overlay"), "the rejected combined-overlay rendering path must stay removed");
assert.match(styles, /\.weight-chart-stack\s*\{[\s\S]*?display:\s*grid;/, "the two charts must render as a deliberate stack");
assert.match(styles, /\.weight-point\.is-current/, "the latest actual weight point must be visibly emphasized");
assert.ok(actualChart.includes("weight-current-label"), "the latest measured point must carry its exact direct label");
assert.match(styles, /\.weight-outlook-segment\.is-down\s*\{[\s\S]*?var\(--outlook-down\)/, "downward outlook segments must use dark sage");
assert.match(styles, /\.weight-outlook-segment\.is-up\s*\{[\s\S]*?var\(--outlook-up\)/, "upward outlook segments must use cranberry");
assert.match(styles, /\.weight-outlook-segment\.is-flat\s*\{[\s\S]*?var\(--outlook-flat\)/, "flat outlook segments must use taupe");
assert.match(styles, /\.weight-chart-wrap text\s*\{[\s\S]*?font-size:\s*11px;/, "chart axes must remain at least eleven pixels for screenshots");
assert.match(styles, /\.weight-chart-caption\s*\{[\s\S]*?font-size:\s*11px;/, "chart captions must remain at least eleven pixels for screenshots");
assert.match(styles, /weight-outlook-endpoint-label[\s\S]*?font-size:\s*13px;/, "endpoint labels must remain screenshot-readable");
assert.match(styles, /@media \(max-width:\s*560px\)[\s\S]*?\.suite-topbar,[\s\S]*?\.split-workspace\s*\{[\s\S]*?width:\s*calc\(100% - 20px\);/, "the 390px mobile layout must retain safe side gutters");
assert.match(styles, /@media \(max-width:\s*560px\)[\s\S]*?\.weight-entry-row\s*\{[\s\S]*?grid-template-columns:\s*1fr;/, "the mobile weight form must not overflow its card");
assert.match(styles, /body\s*\{[\s\S]*?overflow-x:\s*hidden;/, "the screenshot stack must not introduce horizontal overflow");
assert.match(styles, /\.weight-chart-card\s*\{[\s\S]*?min-width:\s*0;/, "chart cards must shrink inside the existing desktop rail and 390px mobile card");
assert.match(index, /\/app\.js\?v=/, "the live bundle must retain explicit cache versioning");

const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const weightPostStart = server.indexOf('if (pathname === "/api/weights" && req.method === "POST")');
const weightPostEnd = server.indexOf('if (pathname === "/api/memories" && req.method === "POST")', weightPostStart);
const weightPost = server.slice(weightPostStart, weightPostEnd);
assert.ok(weightPost.indexOf("send(res, 201") < weightPost.indexOf("setImmediate"), "the durable fallback must return before background model generation");
assert.ok(weightPost.includes("generateAndReplaceCoach(created.id).catch(() => {})"), "background coach generation must not turn a saved weigh-in into an HTTP failure");

console.log("Lily preservation tests passed");
