const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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
assert.equal((app.match(/Analyzing today’s weigh-in…/g) || []).length, 1, "a saved weigh-in must use exactly one analyzing message");
assert.ok(app.includes("const COACH_ANALYSIS_WINDOW_MS = 8000;"), "the analyzing state must end at the eight-second deadline");
const coachCheckpointsMatch = app.match(/const COACH_POLL_CHECKPOINTS_MS = Object\.freeze\(\[([^\]]+)\]\);/);
assert.ok(coachCheckpointsMatch, "coach polling must use explicit bounded checkpoints");
const coachCheckpoints = coachCheckpointsMatch[1].split(",").map((value) => Number(value.trim()));
assert.ok(coachCheckpoints.length >= 2 && coachCheckpoints.every((value) => Number.isFinite(value) && value > 0 && value < 8000), "every coach poll must occur inside the eight-second window");
assert.deepEqual(coachCheckpoints, coachCheckpoints.slice().sort((a, b) => a - b), "coach polling checkpoints must move forward without cumulative runaway waits");

const saveWeightStart = app.indexOf("async function saveWeight(event)");
const saveWeightEnd = app.indexOf("function mergeSavedWeight", saveWeightStart);
const saveWeight = app.slice(saveWeightStart, saveWeightEnd);
assert.ok(saveWeightStart > 0 && saveWeightEnd > saveWeightStart, "the save path must remain independently auditable");
assert.ok(saveWeight.includes("state.weights = mergeSavedWeight(state.weights, result.weight)"), "the POST response must update the weight and charts without a second fetch");
assert.ok(saveWeight.includes("const analysis = beginCoachAnalysis(result.weight?.id, fallbackCoach)"), "the saved weight must enter the bounded analyzing state");
assert.ok(saveWeight.indexOf("renderWeights()") < saveWeight.indexOf("pollCoachReplacement(analysis)"), "the saved weight and charts must render before background polling begins");
assert.ok(!saveWeight.includes("await loadWeights()"), "the immediate saved-weight render must not wait for a follow-up GET");

const coachPollStart = app.indexOf("async function pollCoachReplacement(analysis)");
const coachPollEnd = app.indexOf("async function saveTrackerEvent", coachPollStart);
const coachPoll = app.slice(coachPollStart, coachPollEnd);
assert.ok(coachPoll.includes("for (const elapsedMs of COACH_POLL_CHECKPOINTS_MS)"), "replacement polling must follow the bounded absolute checkpoints");
assert.ok(coachPoll.includes("latestCoach.text !== analysis.initialText"), "changed persisted copy must be revealed before the deadline");
assert.ok(app.includes("analysis.latestPersistedCoach || analysis.fallbackCoach"), "the deadline must reveal the latest persisted fallback when copy never changes");
assert.ok(app.includes("asOfDay: dailyPoints[dailyPoints.length - 1].day"), "the headline and endpoint must stay anchored to the latest measured calendar day");
assert.ok(app.includes("saved.weightId === newestId"), "a persisted coach paragraph must match the latest weight before display");
assert.doesNotMatch(
  app,
  /DROP IN A WEIGH-IN|DROP IN THE FIRST WEIGH-IN|FIRST NUMBER IN|TODAY NEEDS A RESPONSE|THAT[’']S REAL MOVEMENT|balanced plate you can repeat|COME ON—LET[’']S GO/i,
  "the browser must not synthesize emergency coaching when persisted copy is missing"
);
assert.ok(app.includes('const COACH_EMPTY_TEXT = "No coach message yet.";'), "an empty history must use compact non-coaching copy");
assert.ok(app.includes('const COACH_UNAVAILABLE_TEXT = "Coach message unavailable.";'), "a missing persisted record must use compact unavailable copy");
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
assert.ok(app.includes('<span class="weight-chart-title">1-year trend outlook</span>'), "the outlook chart must use the concise sentence-case title");
assert.ok(!app.includes("1-year trend outlook vs time"), "the redundant versus-time suffix must stay removed from the outlook title");
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
assert.ok(app.includes('const endpointLabel = `≈${Math.round(endpoint.weight)} lb`'), "the endpoint must directly label only its rounded value");
assert.ok(app.includes('id="weightForecastChartContext"'), "the outlook caption must reserve a separate preserved-progress line");
assert.ok(app.includes("createOneYearOutlookChart(outlookHistory, outlookPresentation)"), "the caption and SVG must share one presentation state");
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
assert.match(forecastChart, /rightPadding:\s*72,[\s\S]*?yTickStep:\s*5,/, "the outlook must reserve a collision-free endpoint gutter and use five-pound y ticks");
assert.ok(forecastChart.includes('document.createElementNS(frame.ns, "line")'), "outlook points must be joined by straight non-overshooting segments");
assert.ok(forecastChart.includes("weight-outlook-endpoint-leader"), "the endpoint label must connect to its point with a leader line");
assert.ok(forecastChart.includes('is-${direction}${index === points.length - 1 ? " is-latest" : ""}'), "the latest outlook segment must be independently emphasized");
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
assert.match(styles, /\.weight-outlook-caption \.weight-chart-title\s*\{[\s\S]*?white-space:\s*nowrap;/, "the outlook title must remain on one line");
assert.match(styles, /\.weight-outlook-caption \.weight-outlook-verdict\s*\{[\s\S]*?white-space:\s*nowrap;/, "the latest verdict must remain on one line");
assert.match(styles, /\.weight-outlook-segment\.is-latest\s*\{[\s\S]*?stroke-width:\s*3\.5;/, "the latest segment must read more strongly than older history");
assert.match(styles, /@media \(max-width:\s*560px\)[\s\S]*?\.suite-topbar,[\s\S]*?\.split-workspace\s*\{[\s\S]*?width:\s*calc\(100% - 20px\);/, "the 390px mobile layout must retain safe side gutters");
assert.match(styles, /@media \(max-width:\s*560px\)[\s\S]*?\.weight-entry-row\s*\{[\s\S]*?grid-template-columns:\s*1fr;/, "the mobile weight form must not overflow its card");
assert.match(styles, /body\s*\{[\s\S]*?overflow-x:\s*hidden;/, "the screenshot stack must not introduce horizontal overflow");
assert.match(styles, /\.weight-chart-card\s*\{[\s\S]*?min-width:\s*0;/, "chart cards must shrink inside the existing desktop rail and 390px mobile card");
assert.match(index, /\/app\.js\?v=/, "the live bundle must retain explicit cache versioning");

const coachTextStart = app.indexOf("function normalizeLatestCoach");
const coachTextEnd = app.indexOf("function dailyWeightPoints", coachTextStart);
assert.ok(coachTextStart > 0 && coachTextEnd > coachTextStart, "persisted coach display logic must remain independently testable");
const coachTextSandbox = {};
vm.runInNewContext(`
  const COACH_ANALYZING_TEXT = "Analyzing today’s weigh-in…";
  const COACH_EMPTY_TEXT = "No coach message yet.";
  const COACH_UNAVAILABLE_TEXT = "Coach message unavailable.";
  ${app.slice(coachTextStart, coachTextEnd)}
  this.readCoach = weightCoachText;
`, coachTextSandbox);
const readCoach = coachTextSandbox.readCoach;
const savedCoach = { weightId: "weight-new", text: "Persisted server coach.", createdAt: "2026-07-22T12:00:00Z" };
const analyzingCoach = { weightId: "weight-new", deadlineAt: 8000 };
assert.equal(readCoach({ id: "weight-new" }, savedCoach, analyzingCoach, 7999), "Analyzing today’s weigh-in…", "the fallback must stay hidden throughout the analysis window");
assert.equal(readCoach({ id: "weight-new" }, savedCoach, analyzingCoach, 8000), savedCoach.text, "the persisted fallback must appear exactly at the deadline");
assert.equal(readCoach({ id: "weight-new" }, savedCoach, null, 0), savedCoach.text, "settled views must render only persisted server copy");
assert.equal(readCoach({ id: "weight-new" }, { ...savedCoach, weightId: "weight-old" }, null, 0), "Coach message unavailable.", "a coach record for another weight must never be synthesized into a replacement");
assert.equal(readCoach(null, null, null, 0), "No coach message yet.", "an empty history must not render coaching");

const presentationStart = app.indexOf("function createOneYearOutlookPresentation");
const presentationEnd = app.indexOf("function createOneYearOutlookChart", presentationStart);
assert.ok(presentationStart > 0 && presentationEnd > presentationStart, "the shared outlook presentation state must remain independently testable");
const presentationSandbox = {
  formatShortDate(value) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric"
    }).format(new Date(value));
  },
  formatProjectionDate() {
    return "Jul 21, 2027";
  },
  dateFromCalendarDay() {
    return new Date("2027-07-21T12:00:00-04:00");
  }
};
vm.runInNewContext(`${app.slice(presentationStart, presentationEnd)}\nthis.buildPresentation = createOneYearOutlookPresentation;`, presentationSandbox);
const buildPresentation = presentationSandbox.buildPresentation;
const outlookPoint = (date, weight) => ({
  time: Date.parse(`${date}T12:00:00-04:00`),
  weight,
  projectedDay: 0
});

const starting = buildPresentation([outlookPoint("2026-07-01", 150)]);
assert.equal(starting.verdict, "STARTING POINT — NEXT WEIGH-IN SETS DIRECTION");
assert.equal(starting.direction, "starting");

const improving = buildPresentation([
  outlookPoint("2026-07-01", 150),
  outlookPoint("2026-07-02", 149),
  outlookPoint("2026-07-03", 148.25)
]);
assert.equal(improving.verdict, "RIGHT WAY ↓ 0.8 lb since Jul 2");
assert.equal(improving.context, "Now 1.8 lb lower than Jul 1. Keep stacking downward arrows.");

const setback = buildPresentation([
  outlookPoint("2026-07-01", 150),
  outlookPoint("2026-07-02", 147),
  outlookPoint("2026-07-03", 148)
]);
assert.equal(setback.verdict, "WRONG WAY ↑ 1.0 lb since Jul 2");
assert.equal(setback.context, "Still 2.0 lb lower than Jul 1. Turn the next arrow down.");

const flat = buildPresentation([
  outlookPoint("2026-07-01", 150),
  outlookPoint("2026-07-02", 149),
  outlookPoint("2026-07-03", 149.049)
]);
assert.equal(flat.verdict, "NO CHANGE → since Jul 2");
assert.equal(flat.context, "Still 1.0 lb lower than Jul 1. Turn the next arrow down.");
assert.equal(buildPresentation([outlookPoint("2026-07-01", 150), outlookPoint("2026-07-02", 150.05)]).direction, "up", "exactly 0.05 lb must not enter the under-0.05 flat branch");

const worseOverall = buildPresentation([
  outlookPoint("2026-07-01", 150),
  outlookPoint("2026-07-02", 152),
  outlookPoint("2026-07-03", 151)
]);
assert.equal(worseOverall.context, "Now 1.0 lb higher than Jul 1. Turn the next arrow down.");
const equalOverall = buildPresentation([
  outlookPoint("2026-07-01", 150),
  outlookPoint("2026-07-02", 151),
  outlookPoint("2026-07-03", 150)
]);
assert.equal(equalOverall.context, "Back at the Jul 1 starting outlook. Make the next arrow point down.");

const liveAcceptance = buildPresentation([
  outlookPoint("2026-06-26", 149.397225),
  outlookPoint("2026-07-20", 144.677225),
  outlookPoint("2026-07-21", 145.427225)
]);
assert.equal(liveAcceptance.endpointExact, "145.4 lb");
assert.equal(liveAcceptance.endpointLabel, "≈145 lb");
assert.equal(liveAcceptance.verdict, "WRONG WAY ↑ 0.8 lb since Jul 20");
assert.equal(liveAcceptance.context, "Still 4.0 lb lower than Jun 26. Turn the next arrow down.");
assert.match(liveAcceptance.tooltip, /one-year trend outlook 145\.4 lb/);
assert.match(liveAcceptance.ariaLabel, /Exact current endpoint 145\.4 lb\. The latest outlook worsened 0\.8 lb since Jul 20\./);
assert.doesNotMatch(liveAcceptance.ariaLabel, /[↑↓→]/, "accessibility text must say improved, worsened, or held instead of relying on glyphs");

const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const weightPostStart = server.indexOf('if (pathname === "/api/weights" && req.method === "POST")');
const weightPostEnd = server.indexOf('if (pathname === "/api/memories" && req.method === "POST")', weightPostStart);
const weightPost = server.slice(weightPostStart, weightPostEnd);
assert.ok(weightPost.indexOf("send(res, 201") < weightPost.indexOf("setImmediate"), "the durable fallback must return before background model generation");
assert.ok(weightPost.includes("generateAndReplaceCoach(created.id).catch(() => {})"), "background coach generation must not turn a saved weigh-in into an HTTP failure");

console.log("Lily preservation tests passed");
