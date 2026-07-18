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

const constant = dailySeries("2026-01-01", 20, () => 150);
const constantForecast = forecast.calculateForecast(constant);
assert.equal(constantForecast.oneYearWeight, 150, "constant history should stay constant");

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

console.log("weight forecast tests passed");
