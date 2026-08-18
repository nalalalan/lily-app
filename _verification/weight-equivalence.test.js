"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const units = require("../public/weight-unit.js");
const forecast = require("../public/weight-forecast.js");
const boba = require("../boba-reward.js");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-weight-equivalence-"));
process.env.NODE_ENV = "test";
process.env.DATA_DIR = testDataDir;
const coach = require("../server.js");

function record(id, pounds, day, unit) {
  const weight = unit === "kg" ? pounds / units.KG_TO_LB : pounds;
  const createdAt = `2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`;
  return { id, weight, unit, createdAt, updatedAt: createdAt };
}

function poundsPoints(records) {
  return forecast.normalizePoints(records.map((row) => ({
    time: Date.parse(row.createdAt),
    weight: units.weightInPounds(row)
  })));
}

function near(left, right, label, tolerance = 1e-8) {
  assert(Math.abs(Number(left) - Number(right)) <= tolerance, `${label}: ${left} !== ${right}`);
}

try {
  const pounds = [151.2, 150.9, 150.6, 150.3, 150, 149.7, 149.4, 149, 149, 149, 149, 149, 149, 149];
  const lbRecords = pounds.map((value, index) => record(`weight-${index}`, value, index + 2, "lb"));
  const kgRecords = pounds.map((value, index) => record(`weight-${index}`, value, index + 2, "kg"));

  const explicitKg = units.resolveWeightInput(150 / units.KG_TO_LB, [], "kg");
  const explicitLb = units.resolveWeightInput(150, [], "lb");
  assert.equal(explicitKg.weightLb, explicitLb.weightLb, "equivalent input paths persist the same two-decimal pounds");

  const lbPoints = poundsPoints(lbRecords);
  const kgPoints = poundsPoints(kgRecords);
  assert.deepEqual(kgPoints, lbPoints, "legacy kg and pound records produce identical canonical trend points");

  const asOfDay = forecast.calendarDay(Date.parse("2026-08-15T12:00:00.000Z"));
  const lbForecast = forecast.calculateForecast(lbPoints, { asOfDay });
  const kgForecast = forecast.calculateForecast(kgPoints, { asOfDay });
  for (const key of ["oneWeekWeight", "oneMonthWeight", "oneYearWeight", "causalOneYearOutlookTarget"]) {
    near(kgForecast[key], lbForecast[key], `equivalent forecast ${key}`);
  }
  assert.deepEqual(
    forecast.buildForecastHistory(kgPoints).map((row) => [row.day, row.oneWeekWeight, row.oneMonthWeight, row.oneYearWeight]),
    forecast.buildForecastHistory(lbPoints).map((row) => [row.day, row.oneWeekWeight, row.oneMonthWeight, row.oneYearWeight]),
    "equivalent inputs produce the same causal forecast history"
  );

  const lbWindow = boba.calculateSevenDayAverage(lbRecords, { asOfDateKey: "2026-08-15" });
  const kgWindow = boba.calculateSevenDayAverage(kgRecords, { asOfDateKey: "2026-08-15" });
  near(kgWindow.averageLb, lbWindow.averageLb, "equivalent seven-day average");
  assert.equal(kgWindow.averageDisplayLb, lbWindow.averageDisplayLb);

  const lbBaseline = boba.createBobaRewardBaseline(lbRecords, {
    baselineDateKey: "2026-08-08",
    recordedAt: "2026-08-08T12:00:00.000Z"
  });
  const kgBaseline = boba.createBobaRewardBaseline(kgRecords, {
    baselineDateKey: "2026-08-08",
    recordedAt: "2026-08-08T12:00:00.000Z"
  });
  near(kgBaseline.baselineAverageLb, lbBaseline.baselineAverageLb, "equivalent boba baseline");
  const lbReward = boba.calculateBobaRewardState(lbRecords, lbBaseline, {
    asOfDateKey: "2026-08-15",
    allowAwards: true,
    weightId: "weight-13",
    earnedAt: "2026-08-15T12:00:00.000Z"
  });
  const kgReward = boba.calculateBobaRewardState(kgRecords, kgBaseline, {
    asOfDateKey: "2026-08-15",
    allowAwards: true,
    weightId: "weight-13",
    earnedAt: "2026-08-15T12:00:00.000Z"
  });
  assert.equal(kgReward.earnedCount, lbReward.earnedCount, "reward eligibility is unit-equivalent");
  assert.equal(kgReward.newlyEarned, lbReward.newlyEarned);
  assert.equal(kgReward.nextThresholdLb, lbReward.nextThresholdLb);
  near(kgReward.poundsToNextBobaLb, lbReward.poundsToNextBobaLb, "equivalent boba distance");

  const baseStore = { memories: [], trackerEvents: [], chats: [], coachMessages: [] };
  const lbStore = { ...baseStore, weights: lbRecords.slice().reverse(), bobaReward: lbReward.state };
  const kgStore = { ...baseStore, weights: kgRecords.slice().reverse(), bobaReward: kgReward.state };
  const lbContext = coach.buildCoachContext(lbStore, "weight-13", { operationalNow: Date.parse("2026-08-15T12:00:00.000Z") });
  const kgContext = coach.buildCoachContext(kgStore, "weight-13", { operationalNow: Date.parse("2026-08-15T12:00:00.000Z") });
  for (const key of ["currentWeight", "previousDailyWeight", "latestDailyChange", "outlook"]) {
    near(kgContext[key], lbContext[key], `equivalent memo fact ${key}`);
  }
  near(kgContext.movements.days7, lbContext.movements.days7, "equivalent memo seven-day fact");
  assert.equal(
    coach.composeDeterministicCoachMemo(kgContext).text,
    coach.composeDeterministicCoachMemo(lbContext).text,
    "equivalent inputs produce the same visible memo"
  );

  console.log("weight normalization equivalence verification passed");
} finally {
  fs.rmSync(testDataDir, { recursive: true, force: true });
}
