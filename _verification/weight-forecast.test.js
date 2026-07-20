const assert = require("node:assert/strict");
const forecast = require("../public/weight-forecast.js");

function point(date, weight) {
  const time = new Date(`${date}T12:00:00-04:00`).getTime();
  return { time, day: forecast.calendarDay(time), weight };
}

function dailySeries(startDate, count, weightAt) {
  const start = new Date(`${startDate}T12:00:00-04:00`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start.getTime());
    date.setDate(date.getDate() + index);
    const time = date.getTime();
    return { time, day: forecast.calendarDay(time), weight: weightAt(index) };
  });
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const constant = dailySeries("2026-01-01", 20, () => 150);
const constantForecast = forecast.calculateForecast(constant);
assert.equal(constantForecast.oneYearWeight, 150, "constant history should stay constant");
assert.equal(constantForecast.confidence, "learning", "sub-90-day histories must remain in learning state");
assert.equal(constantForecast.annualValidationCount, 0, "short histories have no completed annual outcomes");
assert.equal(constantForecast.annualCalibrationReady, false, "a one-year estimate cannot be calibrated without annual outcomes");
assert.equal(constantForecast.oneYearErrorBand, null, "do not invent an annual error band before calibration");
assert.notEqual(constantForecast.selection, "rolling-backtest", "one-step errors must not be called a rolling backtest");
for (const row of constantForecast.model.validationRows || []) {
  assert.ok(row.trainingLastDay <= row.originDay, "walk-forward training must stop at its origin");
  assert.ok(row.originDay < row.targetDay, "walk-forward targets must be in the future of each origin");
}

const sparse = forecast.calculateForecast([point("2026-01-01", 142)]);
assert.equal(sparse.method, "persistence", "one point should use the stable baseline");
assert.equal(sparse.oneYearWeight, 142, "one point should still return a finite forecast");

const shortHistory = dailySeries("2026-02-01", 8, (index) => 150 + Math.sin(index) * 0.4);
const shortForecast = forecast.calculateForecast(shortHistory);
const shortHistoryPoints = forecast.buildOneYearHistory(shortHistory, shortForecast, shortHistory.at(-1).time);
assert.strictEqual(
  shortHistoryPoints.at(-1).weight,
  shortForecast.oneYearWeight,
  "the current overlay point must use the exact headline forecast value"
);

const extendedHistory = shortHistory.concat(dailySeries("2026-02-09", 4, (index) => 149.8 + index * 0.1));
const extendedForecast = forecast.calculateForecast(extendedHistory);
const extendedHistoryPoints = forecast.buildOneYearHistory(extendedHistory, extendedForecast, extendedHistory.at(-1).time);
assert.deepEqual(
  extendedHistoryPoints.slice(0, shortHistory.length).map(({ isCurrent, ...value }) => value),
  shortHistoryPoints.map(({ isCurrent, ...value }) => value),
  "future weigh-ins must not change prior forecast points"
);

const ensembleBase = dailySeries("2026-08-01", 40, (index) => 145 + index * 0.04 + Math.sin(index / 2) * 0.5);
const ensembleBaseForecast = forecast.calculateForecast(ensembleBase);
assert.equal(ensembleBaseForecast.method, "ensemble", "the ensemble test must exercise the walk-forward ensemble path");
assert.ok(
  Math.abs(ensembleBaseForecast.backtestMae - median(ensembleBaseForecast.model.validationRows.map((row) => Math.abs(row.error)))) < 1e-9,
  "reported walk-forward error must be the actual combined ensemble error"
);
const ensembleBaseHistory = forecast.buildOneYearHistory(ensembleBase, ensembleBaseForecast, ensembleBase.at(-1).time);
const ensembleExtended = ensembleBase.concat(dailySeries("2026-09-10", 10, (index) => 147 + Math.cos(index) * 0.4));
const ensembleExtendedForecast = forecast.calculateForecast(ensembleExtended);
const ensembleExtendedHistory = forecast.buildOneYearHistory(ensembleExtended, ensembleExtendedForecast, ensembleExtended.at(-1).time);
assert.deepEqual(
  ensembleExtendedHistory.slice(0, ensembleBase.length).map(({ isCurrent, ...value }) => value),
  ensembleBaseHistory.map(({ isCurrent, ...value }) => value),
  "future weigh-ins must not change prior ensemble forecast points"
);

const withOutlier = dailySeries("2026-03-01", 24, (index) => index === 11 ? 225 : 150 + Math.sin(index / 2) * 0.5);
const outlierForecast = forecast.calculateForecast(withOutlier);
assert.ok(
  Math.abs(outlierForecast.oneYearWeight - 150) < 10,
  `one outlier should not create a huge annual forecast (${outlierForecast.oneYearWeight})`
);

const sustainedTrend = dailySeries("2026-04-01", 40, (index) => 140 + index * 0.12);
const trendForecast = forecast.calculateForecast(sustainedTrend);
assert.ok(trendForecast.oneYearWeight > sustainedTrend.at(-1).weight, "a sustained trend should forecast in the same direction");
assert.ok(
  trendForecast.oneYearWeight - sustainedTrend.at(-1).weight < 0.12 * 365,
  "a one-year forecast must damp rather than extend the full daily rate for 365 days"
);

const duplicateA = [point("2026-05-01", 149), point("2026-05-01", 151), point("2026-05-02", 150)];
const duplicateB = duplicateA.slice().reverse();
assert.deepEqual(
  forecast.normalizePoints(duplicateA),
  forecast.normalizePoints(duplicateB),
  "same-day duplicate order must not affect daily medians"
);

const beforeDst = new Date("2026-03-07T12:00:00-05:00").getTime();
const afterDst = new Date("2026-03-08T12:00:00-04:00").getTime();
assert.equal(
  forecast.calendarDay(afterDst) - forecast.calendarDay(beforeDst),
  1,
  "calendar-day spacing must stay exact across daylight-saving changes"
);

const pathological = dailySeries("2026-06-01", 30, (index) => Math.max(1, 200 - index * 6));
const pathologicalForecast = forecast.calculateForecast(pathological);
assert.ok(Number.isFinite(pathologicalForecast.oneYearWeight), "forecasts must remain finite");
assert.ok(pathologicalForecast.oneYearWeight > 0, "forecasts must never be negative");

const lilyHistory = [
  ["2026-06-26", 149.4], ["2026-06-28", 148.5], ["2026-06-29", 147.4],
  ["2026-06-30", 149], ["2026-07-01", 149.4], ["2026-07-02", 149.4],
  ["2026-07-03", 148.8], ["2026-07-04", 149.9], ["2026-07-06", 150.7],
  ["2026-07-07", 149], ["2026-07-08", 147.5], ["2026-07-10", 150.3],
  ["2026-07-11", 150.5], ["2026-07-12", 149.9], ["2026-07-13", 150],
  ["2026-07-14", 147.7], ["2026-07-15", 149.4], ["2026-07-16", 150.3],
  ["2026-07-17", 149.9], ["2026-07-18", 149.4], ["2026-07-19", 148.5]
].map(([date, weight]) => point(date, weight));
const lilyAsOfDay = forecast.calendarDay(new Date("2026-07-20T12:00:00-04:00").getTime());
const lilyForecast = forecast.calculateForecast(lilyHistory, { asOfDay: lilyAsOfDay });
const lilyForecastHistory = forecast.buildOneYearHistory(lilyHistory, lilyForecast, new Date("2026-07-20T12:00:00-04:00").getTime());
assert.equal(lilyForecast.confidence, "learning", "the live-shaped 22-day record must stay explicitly unvalidated");
assert.equal(lilyForecast.annualValidationCount, 0, "the live-shaped record has no annual outcomes");
assert.equal(lilyForecast.annualCalibrationReady, false, "the live-shaped one-year endpoint is an uncalibrated baseline");
assert.equal(Number(lilyForecast.oneWeekWeight.toFixed(1)), 145, "current positive momentum must move the one-week forecast decisively");
assert.equal(Number(lilyForecast.oneMonthWeight.toFixed(1)), 137.4, "current positive momentum must move the one-month forecast decisively");
assert.equal(Number(lilyForecast.oneYearWeight.toFixed(1)), 123.5, "current positive momentum must move the one-year forecast decisively");
assert.equal(lilyForecast.momentum.momentumRate, -0.5, "the current three-drop run should reach the bounded celebratory momentum rate");
assert.equal(lilyForecastHistory.at(-1).weight, lilyForecast.oneYearWeight, "live-shaped headline and overlay must match exactly");
assert.equal(lilyForecastHistory.at(-1).annualCalibrated, false, "the current overlay point must carry its uncalibrated state");

const symmetricGain = dailySeries("2026-10-01", 21, (index) => 150 + index * 0.15);
const symmetricGainForecast = forecast.calculateForecast(symmetricGain);
assert.ok(symmetricGainForecast.oneYearWeight > symmetricGain.at(-1).weight + 15, "a sustained gain must move the annual forecast strongly upward");

const isolatedHigh = dailySeries("2026-11-01", 21, (index) => index === 20 ? 170 : 150);
const isolatedHighForecast = forecast.calculateForecast(isolatedHigh);
assert.equal(isolatedHighForecast.momentum.strong, false, "one isolated high value must not activate amplified momentum");
assert.ok(isolatedHighForecast.oneYearWeight < 155, "one isolated high value must not create a runaway annual forecast");

const annualHistory = dailySeries("2023-01-01", 930, (index) => 145 + index * 0.005 + Math.sin(index / 9) * 0.6);
const annualStarted = Date.now();
const annualForecast = forecast.calculateForecast(annualHistory);
assert.ok(Date.now() - annualStarted < 3000, "a multi-year annual evaluation must remain responsive");
assert.ok(annualForecast.annualValidationCount >= 20, "annual calibration needs at least 20 completed checks");
assert.equal(annualForecast.annualCalibrationReady, true, "20 spaced annual checks make historical calibration available");
assert.equal(annualForecast.oneYearErrorBand.nominalCoverage, 0.9, "the empirical band must identify nominal rather than guaranteed coverage");
for (let index = 1; index < annualForecast.annualValidationRows.length; index += 1) {
  assert.ok(
    annualForecast.annualValidationRows[index].originDay - annualForecast.annualValidationRows[index - 1].originDay >= 28,
    "annual evaluation origins must be spaced at least 28 days apart"
  );
}
for (const row of annualForecast.annualValidationRows) {
  assert.equal(row.trainingLastDay, row.originDay, "annual training must stop at its origin");
  assert.ok(row.originDay < row.targetDay, "annual targets must follow their origins");
}

const annualPrefixForecast = forecast.calculateForecast(annualHistory.slice(0, 900));
const fullAnnualRows = new Map(annualForecast.annualValidationRows.map((row) => [`${row.originDay}:${row.targetDay}`, row]));
for (const prefixRow of annualPrefixForecast.annualValidationRows) {
  const fullRow = fullAnnualRows.get(`${prefixRow.originDay}:${prefixRow.targetDay}`);
  assert.ok(fullRow, "extending the history must preserve every shared annual evaluation origin");
  assert.ok(Math.abs(fullRow.predicted - prefixRow.predicted) < 1e-9, "future weights must not change prior annual predictions");
}

const overlayStarted = Date.now();
const performanceHistory = annualHistory.slice(0, 365);
const performanceForecast = forecast.calculateForecast(performanceHistory);
const performanceOverlay = forecast.buildOneYearHistory(performanceHistory, performanceForecast, performanceHistory.at(-1).time);
assert.equal(performanceOverlay.length, performanceHistory.length, "the overlay must keep every weigh-in date");
assert.ok(Date.now() - overlayStarted < 3000, "a one-year overlay must render without freezing the page");

console.log("weight forecast tests passed");
