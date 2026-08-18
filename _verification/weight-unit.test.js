"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const units = require("../public/weight-unit.js");

function weight(id, value, unit, date) {
  return {
    id,
    weight: value,
    unit,
    createdAt: `${date}T16:00:00.000Z`
  };
}

function historyAt(pounds) {
  return Array.from({ length: 7 }, (_, index) => weight(
    `history-${index}`,
    pounds,
    "lb",
    `2026-08-${String(index + 1).padStart(2, "0")}`
  ));
}

const noHistoryKg = units.resolveWeightInput(68, [], "auto");
assert.equal(noHistoryKg.detectedUnit, "kg");
assert.equal(noHistoryKg.weightLb, 149.91);
assert.equal(`${noHistoryKg.inputValue} kg → ${(Math.round(noHistoryKg.weightLb * 10) / 10).toFixed(1)} lb`, "68 kg → 149.9 lb");
assert.equal(units.resolveWeightInput(68.2, [], "auto").weightLb, 150.36);

const noHistoryLb = units.resolveWeightInput(150, [], "auto");
assert.equal(noHistoryLb.detectedUnit, "lb");
assert.equal(noHistoryLb.weightLb, 150);
assert.equal(`${noHistoryLb.weightLb} lb`, "150 lb");
assert.equal(units.resolveWeightInput(149.8, [], "auto").detectedUnit, "lb");
assert.equal(units.resolveWeightInput(99.9, [], "auto").detectedUnit, "kg", "the no-history threshold is strictly below 100");
assert.equal(units.resolveWeightInput(100, [], "auto").detectedUnit, "lb", "100 begins the no-history pound range");

const history150 = historyAt(150);
const historicalKg = units.resolveWeightInput(68, history150, "auto");
assert.equal(historicalKg.source, "history");
assert.equal(historicalKg.detectedUnit, "kg");
assert(historicalKg.candidates.kg.distanceLb < 0.1);
assert.equal(units.resolveWeightInput(150, history150, "auto").detectedUnit, "lb");

const outlierAmbiguity = units.resolveWeightInput(100, history150, "auto");
assert.equal(outlierAmbiguity.status, "ambiguous", "neither candidate is within 30 lb of recent history");
assert.equal(outlierAmbiguity.detectedUnit, null);

const closeMarginAmbiguity = units.resolveWeightInput(50, historyAt(80), "auto");
assert.equal(closeMarginAmbiguity.status, "ambiguous", "a winner less than 10 lb closer still requires a choice");
assert(closeMarginAmbiguity.candidates.lb.distanceLb <= 30);
assert(closeMarginAmbiguity.candidates.kg.distanceLb - closeMarginAmbiguity.candidates.lb.distanceLb < 10);

const explicitKg = units.resolveWeightInput(100, history150, "kg");
assert.equal(explicitKg.status, "resolved");
assert.equal(explicitKg.source, "explicit");
assert.equal(explicitKg.detectedUnit, "kg");
assert.equal(explicitKg.weightLb, 220.46);
assert.equal(units.resolveWeightInput(100, history150, "lb").weightLb, 100);
assert.equal(units.resolveWeightInput(68, history150, "stone").error, "invalid-unit");

const mixedDailyHistory = [
  weight("old-ignored", 999, "lb", "2026-08-01"),
  weight("day-2", 140, "lb", "2026-08-02"),
  weight("day-3", 141, "lb", "2026-08-03"),
  weight("day-4", 142, "lb", "2026-08-04"),
  weight("day-5", 143, "lb", "2026-08-05"),
  weight("day-6", 144, "lb", "2026-08-06"),
  weight("day-7", 145, "lb", "2026-08-07"),
  weight("day-8-kg", 60, "kg", "2026-08-08"),
  weight("day-8-lb", 160, "lb", "2026-08-08")
];
const latestDaily = units.latestDailyWeightsLb(mixedDailyHistory);
assert.equal(latestDaily.length, 7, "history detection uses the latest seven daily values");
assert.equal(latestDaily.at(-1), 140, "an eighth, older day is excluded");
assert.equal(units.historyReferenceLb(mixedDailyHistory), 143, "same-day entries reduce to a median before the seven-day reference median");

assert(Math.abs(units.weightInPounds({ weight: 68.0388555, unit: "kg" }) - 150) < 0.0001);
const equivalentKg = units.resolveWeightInput(68.0388555, history150, "kg");
const equivalentLb = units.resolveWeightInput(150, history150, "lb");
assert.equal(equivalentKg.weightLb, equivalentLb.weightLb, "equivalent kg and lb inputs normalize to the same canonical pounds");

const helperSource = fs.readFileSync(path.join(__dirname, "..", "public", "weight-unit.js"), "utf8");
const browserContext = { Intl };
vm.runInNewContext(helperSource, browserContext);
assert.equal(browserContext.LilyWeightUnits.resolveWeightInput(68, [], "auto").detectedUnit, "kg", "the shared helper also exposes its browser API");

const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const index = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
const packageJson = fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8");
assert(index.indexOf("/weight-unit.js?v=") < index.indexOf("/app.js?v="), "the cache-busted detector loads before the app bundle");
assert.match(app, /aria-label="Lily weight in kilograms or pounds"/);
assert.match(app, /68 kg →|resolution\.inputValue\)} kg →/, "kg previews visibly point to the converted pound value");
assert.match(app, /body:\s*JSON\.stringify\(\{ weight, unit: submittedUnit \}\)/, "automatic or explicit detection is sent to the API");
assert.match(app, /const submittedUnit = state\.weightUnitOverride \|\| "auto"/);
assert.match(app, /function formatWeight\(record\)[\s\S]*?weightInPounds\(record\)[\s\S]*?lb/, "every saved record label renders canonical pounds");
assert.match(app, /Choose kg or lb before saving\./, "ambiguous automatic detection cannot save silently");
assert.match(app, /resolution\.ambiguous \|\| state\.weightUnitChoiceRequired/, "a server-required choice cannot retry automatic mode without an override");
assert.match(app, /error\?\.status === 422[\s\S]*?weight_unit_ambiguous[\s\S]*?weightUnitChoiceRequired = true/, "a server-side stale-history ambiguity reopens the explicit choices");
assert(!app.includes('id="weightInputUnit" aria-hidden="true">auto</span>'), "the visible empty suffix names both accepted units instead of internal auto mode");
assert.match(styles, /\.weight-unit-choice\[aria-pressed="true"\]/, "the compact explicit-unit controls expose their selected state");
assert.match(styles, /\.weight-unit-choices\s*\{[\s\S]*?flex-wrap:\s*wrap;/, "the ambiguity choices wrap on narrow screens");
assert(!index.includes("weight-coach.js"), "the retired browser coach generator is not loaded");
assert(!packageJson.includes("weight-coach"), "retired browser coach checks are removed");
assert(!fs.existsSync(path.join(__dirname, "..", "public", "weight-coach.js")));
assert(!fs.existsSync(path.join(__dirname, "weight-coach.test.js")));

const poundsFunctionStart = app.indexOf("function weightInPounds(record)");
const poundsFunctionEnd = app.indexOf("function median", poundsFunctionStart);
const formatFunctionStart = app.indexOf("function trimWeight(value)");
const formatFunctionEnd = app.indexOf("function setBusy", formatFunctionStart);
const displaySandbox = { WEIGHT_UNITS: units };
vm.runInNewContext(`
  ${app.slice(poundsFunctionStart, poundsFunctionEnd)}
  ${app.slice(formatFunctionStart, formatFunctionEnd)}
  this.formatWeightRecord = formatWeight;
`, displaySandbox);
assert.equal(displaySandbox.formatWeightRecord({ weight: 68.0388555, unit: "kg" }), "150 lb", "legacy kg records render in pounds without changing their stored identity");

console.log("weight-unit verification passed");
