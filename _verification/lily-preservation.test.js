const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
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
const apiFetchStart = app.indexOf("async function apiFetch(path, options = {})");
const apiFetchEnd = app.indexOf("function setLocked", apiFetchStart);
const apiFetch = app.slice(apiFetchStart, apiFetchEnd);
assert.ok(apiFetch.includes("response.status >= 500"), "the browser must independently contain server failures");
assert.ok(apiFetch.includes("Something went wrong. Please try again."), "server failures must render as concise recovery guidance");
assert.doesNotMatch(apiFetch, /invariant|word-count=|evidence-claim=|outlook-(?:weight|claim)=|verdict=/i, "internal validator diagnostics must not exist in the browser error path");
assert.ok(server.includes('"reportedNextPeriodDateKey"'), "reported upcoming periods must stay separate from actual period clicks");
assert.ok(server.includes('"reportedNextHighDesireDateKey"'), "reported upcoming high-desire dates must be stored independently from historical reports");
assert.ok(server.includes("Tracker entries cannot be dated in the future."), "future reported dates must never bypass the future actual-event rejection");
assert.ok(app.includes("tracker.reportedNextPeriodDateKey"), "the tracker detail must identify a currently active reported period date");
assert.ok(app.includes("tracker.reportedNextHighDesireDateKey"), "the tracker detail must identify a currently active reported high-desire date");
assert.ok(app.includes('periodParts.push(`${overdue} ${overdue === 1 ? "DAY" : "DAYS"} PAST ${basis}`)'), "an overdue forecast must not render as zero days until");
assert.ok(app.includes('report.className = "tracker-row-report"'), "reported forecast details must remain visible on their deletable period row");
assert.match(styles, /\.tracker-row-report\s*\{[\s\S]*?font-size:\s*11px;/, "reported tracker details must remain readable in bottom history");
assert.ok(
  loadData.indexOf("state.memories =") < loadData.indexOf("renderWall()"),
  "media state must be assigned before the wall is rendered"
);

assert.ok(app.includes('].join(" · ")'), "the visible forecast values must stay compact and scannable");
assert.ok(app.includes('`about ${Math.round(exact)} lb in 1 yr`'), "an uncalibrated outlook must use a rounded about-value");
assert.equal((app.match(/id="weightCoach"/g) || []).length, 1, "the primary card must contain exactly one coach paragraph");
assert.equal((app.match(/id="weightBoba"/g) || []).length, 1, "the primary card must contain exactly one boba progress line");
assert.ok(!app.includes('id="weightVerdict"'), "the rejected standalone verdict paragraph must stay removed");
assert.match(styles, /\.panel-head \.weight-boba\s*\{[\s\S]*?font-weight:\s*740;/, "boba progress must remain a compact, intentional part of the weight card");
assert.match(styles, /\.weight-boba\[hidden\]\s*\{[\s\S]*?display:\s*none;/, "the boba surface must not expose first-paint placeholders before live data arrives");
for (const id of ["weightBobaAverage", "weightBobaWindow", "weightBobaThreshold", "weightBobaDistance", "weightBobaEarned"]) {
  assert.equal((app.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `${id} must have one direct-read surface`);
}
assert.match(app, /weightBobaEarned"\)\.textContent\s*=\s*reward\.earnedCount === 1[\s\S]*?bobas earned/, "the persistent earned-boba count must remain visible, not only available to assistive technology");
assert.match(styles, /\.panel-head p\.weight-coach\s*\{[\s\S]*?font-weight:\s*520;/, "coach copy must remain normal-weight and readable");
assert.ok(
  app.indexOf('id="weightLatest"') < app.indexOf('id="weightEstimate"') &&
    app.indexOf('id="weightEstimate"') < app.indexOf('id="weightCoach"'),
  "latest weight, forecast line, and one coach paragraph must lead the card in that order"
);
assert.ok(app.includes("state.latestCoach = normalizeLatestCoach(weightResult.latestCoach)"), "initial loading must retain the persisted coach paragraph");
assert.ok(app.includes("state.bobaReward = normalizeBobaReward(weightResult.bobaReward)"), "initial loading must retain persisted boba progress");
assert.ok(app.includes("state.latestCoach = normalizeLatestCoach(result.latestCoach)"), "weight refreshes and saves must retain the returned coach paragraph");
assert.ok(app.includes("state.bobaReward = normalizeBobaReward(result.bobaReward)"), "weight refreshes and saves must retain returned boba progress");
assert.doesNotMatch(app, /Analyzing today’s weigh-in|COACH_ANALYSIS_WINDOW_MS|COACH_POLL_CHECKPOINTS_MS|pollCoachReplacement|scheduleCoachContextFollowups/, "deterministic coaching must render immediately without model or context polling");

const saveWeightStart = app.indexOf("async function saveWeight(event)");
const saveWeightEnd = app.indexOf("function mergeSavedWeight", saveWeightStart);
const saveWeight = app.slice(saveWeightStart, saveWeightEnd);
assert.ok(saveWeightStart > 0 && saveWeightEnd > saveWeightStart, "the save path must remain independently auditable");
assert.ok(saveWeight.includes("state.weights = mergeSavedWeight(state.weights, result.weight)"), "the POST response must update the weight and charts without a second fetch");
assert.ok(saveWeight.includes("state.latestCoach = normalizeLatestCoach(result.latestCoach)"), "the persisted deterministic memo must be accepted directly from the POST response");
assert.ok(saveWeight.indexOf("state.latestCoach = normalizeLatestCoach(result.latestCoach)") < saveWeight.indexOf("renderWeights()"), "the deterministic memo must be available in the same render as the saved weight");
assert.doesNotMatch(saveWeight, /beginCoachAnalysis|pollCoachReplacement|scheduleCoachContextFollowups/, "saving a weight must not start a replacement pipeline");
assert.ok(!saveWeight.includes("await loadWeights()"), "the immediate saved-weight render must not wait for a follow-up GET");
const memoWeightPostStart = server.indexOf('pathname === "/api/weights" && req.method === "POST"');
const memoWeightPostEnd = server.indexOf('pathname === "/api/memories" && req.method === "POST"', memoWeightPostStart);
assert.doesNotMatch(server.slice(memoWeightPostStart, memoWeightPostEnd), /scheduleBrainContextReconciliation|reconcileLatestCoachBrainContext/, "saving a weight must not schedule a context-only rewrite");
const weightGetStart = server.indexOf('pathname === "/api/weights" && req.method === "GET"');
const weightGetEnd = server.indexOf('pathname === "/api/coach/refresh-saved-context"', weightGetStart);
assert.ok(weightGetStart > 0 && weightGetEnd > weightGetStart, "the authenticated weight read must remain independently auditable");
assert.doesNotMatch(server.slice(weightGetStart, weightGetEnd), /reconcileLatestCoachBrainContext/, "reading weights must not fetch context to rewrite an existing memo");
assert.ok(server.includes("composeDeterministicCoachMemo"), "one deterministic server composer must own visible memo copy");

const saveMemoryStart = app.indexOf("async function saveMemory(event)");
const saveMemoryEnd = app.indexOf("async function saveWeight(event)", saveMemoryStart);
const saveMemory = app.slice(saveMemoryStart, saveMemoryEnd);
assert.ok(saveMemoryStart > 0 && saveMemoryEnd > saveMemoryStart, "the saved-note path must remain independently auditable");
assert.doesNotMatch(saveMemory, /beginCoachAnalysis|pollCoachReplacement|scheduleCoachContextFollowups/, "saving a memory must not start a memo replacement pipeline");
assert.ok(!saveMemory.includes("state.weights ="), "a saved reaction must not mutate measured weight or chart data in the browser");
assert.ok(app.includes("asOfDay: dailyPoints[dailyPoints.length - 1].day"), "the headline and endpoint must stay anchored to the latest measured calendar day");
assert.ok(app.includes("saved.weightId === newestId"), "a persisted coach paragraph must match the latest weight before display");
assert.doesNotMatch(
  app,
  /DROP IN A WEIGH-IN|DROP IN THE FIRST WEIGH-IN|FIRST NUMBER IN|TODAY NEEDS A RESPONSE|THAT[’']S REAL MOVEMENT|balanced plate you can repeat|COME ON—LET[’']S GO/i,
  "the browser must not synthesize emergency coaching when persisted copy is missing"
);
assert.ok(app.includes('const COACH_EMPTY_TEXT = "No coach message yet.";'), "an empty history must use compact non-coaching copy");
assert.ok(!app.includes("COACH_PREPARING_TEXT"), "the retired asynchronous preparing state must stay removed");
assert.doesNotMatch(app, /Coach message unavailable/i, "the browser can never recreate the rejected unavailable dead end");
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
  const COACH_EMPTY_TEXT = "No coach message yet.";
  ${app.slice(coachTextStart, coachTextEnd)}
  this.readCoach = weightCoachText;
  this.formatBoba = formatBobaReward;
`, coachTextSandbox);
const readCoach = coachTextSandbox.readCoach;
const formatBoba = coachTextSandbox.formatBoba;
const savedCoach = { weightId: "weight-new", text: "Persisted server coach.", createdAt: "2026-07-22T12:00:00Z" };
assert.equal(readCoach({ id: "weight-new" }, savedCoach), savedCoach.text, "the persisted deterministic memo must render immediately");
assert.equal(readCoach({ id: "weight-new" }, { ...savedCoach, weightId: "weight-old" }), "No coach message yet.", "a coach record for another weight must never be synthesized into a replacement");
assert.equal(readCoach(null, null), "No coach message yet.", "an empty history must not render coaching");
assert.equal(
  formatBoba({ baselineAverageLb: 150.3, baselineDateKey: "2026-08-08", currentSevenDayAverageLb: 150.3, nextThresholdLb: 149, poundsToNextBobaLb: 1.3, observedDayCount: 4, windowStartDateKey: "2026-08-02", windowEndDateKey: "2026-08-08", earnedCount: 0 }),
  "Average for the last 7 calendar days: 150.3 lb. Window Aug 2–8; 4 weigh-in days included. Next boba average 149 lb, 1.3 lb to go. 0 bobas earned.",
  "the live baseline must identify the exact seven-day window, averaged days, threshold, and remaining distance"
);
assert.equal(
  formatBoba({ baselineAverageLb: 150.3, baselineDateKey: "2026-08-08", currentSevenDayAverageLb: 148.2, nextThresholdLb: 147, poundsToNextBobaLb: 1.2, observedDayCount: 7, windowStartDateKey: "2026-08-16", windowEndDateKey: "2026-08-22", earnedCount: 2 }),
  "Average for the last 7 calendar days: 148.2 lb. Window Aug 16–22; 7 weigh-in days included. Next boba average 147 lb, 1.2 lb to go. 2 bobas earned.",
  "earned rewards and the next one-time threshold must remain visible together"
);
assert.equal(formatBoba(null), "", "an unavailable reward state must not render a placeholder card");

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

const weightPostStart = server.indexOf('if (pathname === "/api/weights" && req.method === "POST")');
const weightPostEnd = server.indexOf('if (pathname === "/api/memories" && req.method === "POST")', weightPostStart);
const weightPost = server.slice(weightPostStart, weightPostEnd);
assert.ok(weightPost.indexOf("persistWeightWithRecoverableCoach(created)") < weightPost.indexOf("send(res, 201"), "the primary weight and recoverable coach state must persist before success returns");
assert.ok(weightPost.indexOf("send(res, 201") < weightPost.indexOf("scheduleCoachGeneration(created.id)"), "any deterministic repair must remain isolated from the durable primary response");
assert.ok(server.includes('console.warn("Lily coach generation or repair failed", String(error?.name || "error"))'), "deterministic repair failures must record only a sanitized stage");
assert.ok(server.includes('pathname === "/api/coach/refresh-saved-context"'), "the authenticated legacy maintenance route remains explicit rather than automatic");
assert.ok(server.includes('pathname === "/api/coach/refresh-style"'), "an authenticated exact-preservation route can refresh only the latest coach style");
assert.ok(server.includes("assertExpectedCoachRefreshState(baseline, expected, expectedCoach)"), "the one-time live refresh requires an exact production identity and count baseline");
assert.ok(server.includes("assertCoachRefreshPreserved(baseline, coachRefreshPreservationSnapshot(prepared.store, prepared.weightId))"), "the live refresh verifies preservation inside the server write queue");
assert.doesNotMatch(server, /execFile|spawn\([^)]*refresh-latest-saved-context/, "the live refresh never writes the Railway store from a second process");

const personalAnchorStart = server.indexOf("function brainThoughtAnchorFromFile");
const personalAnchorEnd = server.indexOf("function brainFileIsGeneratedNoteRecord", personalAnchorStart);
const personalAnchorReducer = server.slice(personalAnchorStart, personalAnchorEnd);
assert.ok(personalAnchorStart > 0 && personalAnchorEnd > personalAnchorStart, "the safe Brain personal-anchor reducer must remain independently inspectable");
assert.doesNotMatch(personalAnchorReducer, /brainFileIsGeneratedNoteRecord|genericBrainYapIsSafe|unsafeTopic|quotedOrThirdPartySource|maxAgeMs/, "Brain source authenticity cannot be rejected by metadata shape, age, or mixed private clauses before safe reduction");
assert.ok(personalAnchorReducer.includes('topics[0] || "letter"'), "an authentic Brain thought without a public topic must reduce to a specific safe trust meaning");
assert.ok(server.includes("personalAnchorRequired: false"), "personal context must remain optional in finalized memo validation");
assert.ok(!server.includes('errors.push("missing-personal-anchor")'), "memo validation must not force an unrelated personal anchor");
assert.ok(server.includes('"fallback-emergency-analysis"'), "a validator-passing emergency analysis must prevent a saved weight from becoming unavailable");
assert.ok(server.includes("includePersonalContext: false"), "deterministic save and repair paths must not wait for personal context");
assert.ok(server.includes("ensurePublicCoachForWeight"), "authenticated weight reads and writes must self-heal a missing or pending latest coach idempotently");
assert.ok(server.includes("personalAnchor: sanitizePersonalAnchor(context.personalAnchor)"), "the private coach record must persist only the reduced personal anchor needed for exact repair");
assert.ok(server.includes("semanticAnchorId") && server.includes("approvedText"), "private anchor provenance must retain its semantic kind and approved copy without raw source text");
assert.doesNotMatch(server, /sourceSpecificBrainContextLeads|BRAIN_LED_FALLBACK_STRUCTURES|supportLeads\s*:\s*true/, "no source type may move personal context ahead of the verdict and measured evidence");
assert.doesNotMatch(server, /startsWith\(context\.relationshipSupport\.text\.toLowerCase\(\)\)/, "the final validator cannot require a personal source sentence to lead visible coaching");
assert.doesNotMatch(server, /const standalone = coachSentenceScopes\(source\)[\s\S]{0,240}personal-anchor-glued/, "the final validator must require a woven detour rather than a detached personal sentence");
assert.doesNotMatch(server, /new Error\("[^"]*\bBrain\b[^"]*"\)/i, "authenticated maintenance errors cannot expose an internal source name to the browser");

console.log("Lily preservation tests passed");
