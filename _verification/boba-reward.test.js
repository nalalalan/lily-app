"use strict";

const assert = require("node:assert/strict");
const {
  calculateBobaRewardState,
  calculateSevenDayAverage,
  createBobaRewardBaseline,
  normalizeBobaRewardState,
  publicBobaReward
} = require("../boba-reward.js");

function weight(id, date, pounds, unit = "lb") {
  return {
    id,
    weight: pounds,
    unit,
    createdAt: date.includes("T") ? date : `${date}T16:00:00.000Z`,
    updatedAt: date.includes("T") ? date : `${date}T16:00:00.000Z`
  };
}

function dailySeries(startDate, count, pounds, prefix) {
  const start = new Date(`${startDate}T16:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const current = new Date(start);
    current.setUTCDate(current.getUTCDate() + index);
    return weight(`${prefix}-${index + 1}`, current.toISOString(), pounds);
  });
}

const liveBaselineWeights = [
  weight("aug-2", "2026-08-02", 150.5),
  weight("aug-3", "2026-08-03", 150.4),
  weight("aug-4", "2026-08-04", 150.3),
  weight("aug-5", "2026-08-05", 150.1)
];
const productionWindow = calculateSevenDayAverage(liveBaselineWeights, { asOfDateKey: "2026-08-08" });
assert.equal(productionWindow.averageLb, 150.325, "the exact live Aug 2-8 baseline uses the four observed daily medians");
assert.equal(productionWindow.averageDisplayLb, 150.3);
assert.equal(productionWindow.observedDayCount, 4, "missing days are not imputed into the denominator");
assert.deepEqual(productionWindow.observedDateKeys, ["2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"]);
assert.equal(productionWindow.windowStartDateKey, "2026-08-02");
assert.equal(productionWindow.windowEndDateKey, "2026-08-08");

const productionBaseline = createBobaRewardBaseline(liveBaselineWeights, {
  baselineDateKey: "2026-08-08",
  recordedAt: "2026-08-08T18:00:00.000Z"
});
assert.equal(productionBaseline.baselineAverageLb, 150.325);
assert.deepEqual(productionBaseline.baselineWindow, {
  windowStartDateKey: "2026-08-02",
  windowEndDateKey: "2026-08-08",
  observedDayCount: 4,
  observedDateKeys: ["2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"]
}, "the persisted baseline retains its source-window provenance");
const productionReward = calculateBobaRewardState(liveBaselineWeights, productionBaseline, { asOfDateKey: "2026-08-08" });
assert.equal(productionReward.nextThresholdLb, 149.325);
assert.equal(productionReward.nextThresholdDisplayLb, 149.3);
assert.equal(productionReward.poundsToNextBobaDisplayLb, 1);
assert.deepEqual(publicBobaReward(productionReward), {
  baselineAverageLb: 150.3,
  baselineDateKey: "2026-08-08",
  currentSevenDayAverageLb: 150.3,
  nextThresholdLb: 149.3,
  poundsToNextBobaLb: 1,
  observedDayCount: 4,
  windowStartDateKey: "2026-08-02",
  windowEndDateKey: "2026-08-08",
  earnedCount: 0,
  latestEarnedThreshold: null
});
assert.equal(
  calculateBobaRewardState(liveBaselineWeights, productionBaseline, { asOf: "2026-08-08T18:00:00.000Z" }).currentSevenDayAverageLb,
  150.325,
  "server ISO timestamps resolve through the Eastern calendar window"
);

const easternGrouping = calculateSevenDayAverage([
  weight("same-day-morning", "2026-08-02T14:00:00.000Z", 140),
  weight("same-day-night", "2026-08-03T01:00:00.000Z", 160),
  weight("next-day", "2026-08-03T14:00:00.000Z", 155)
], { asOfDateKey: "2026-08-03" });
assert.equal(easternGrouping.observedDayCount, 2, "UTC-midnight crossings still group by America/New_York date");
assert.equal(easternGrouping.averageLb, 152.5, "same-day readings reduce to one median before the seven-day mean");

const kilograms = calculateSevenDayAverage([
  weight("kg", "2026-08-08", 68.0388555, "kg")
], { asOfDateKey: "2026-08-08" });
assert(Math.abs(kilograms.averageLb - 150) < 0.0001, "kilograms convert to pounds before averaging");

const baselineWeights = dailySeries("2026-08-01", 7, 150, "baseline");
const baseline = createBobaRewardBaseline(baselineWeights, {
  baselineDateKey: "2026-08-07",
  recordedAt: "2026-08-07T16:00:00.000Z"
});
const skippedWeights = [...baselineWeights, ...dailySeries("2026-08-08", 7, 147, "skip")];
const readOnlySkipped = calculateBobaRewardState(skippedWeights, baseline, {
  asOfDateKey: "2026-08-14",
  weightId: "skip-7"
});
assert.equal(readOnlySkipped.currentSevenDayAverageLb, 147);
assert.equal(readOnlySkipped.newlyEarned, 0, "GET/read calculations never mint a reward when the window ages or changes");
assert.equal(readOnlySkipped.earnedCount, 0);
assert.deepEqual(readOnlySkipped.state.earnedThresholds, []);

const awardedThree = calculateBobaRewardState(skippedWeights, baseline, {
  asOfDateKey: "2026-08-14",
  asOf: "2026-08-14T16:00:00.000Z",
  earnedAt: "2026-08-14T16:00:00.000Z",
  weightId: "skip-7",
  allowAwards: true
});
assert.equal(awardedThree.newlyEarned, 3, "one new weigh-in can earn every newly passed one-pound threshold");
assert.deepEqual(awardedThree.newlyEarnedThresholds.map((entry) => entry.level), [1, 2, 3]);
assert.deepEqual(awardedThree.newlyEarnedThresholds.map((entry) => entry.thresholdLb), [149, 148, 147]);
assert.equal(awardedThree.earnedForWeightId, 3);
assert.equal(awardedThree.nextThresholdLb, 146);

const risenWeights = [...skippedWeights, ...dailySeries("2026-08-15", 7, 151, "rise")];
const afterRise = calculateBobaRewardState(risenWeights, awardedThree.state, {
  asOfDateKey: "2026-08-21",
  asOf: "2026-08-21T16:00:00.000Z",
  weightId: "rise-7",
  allowAwards: true
});
assert.equal(afterRise.newlyEarned, 0);
assert.equal(afterRise.earnedCount, 3, "a rise never revokes an earned boba");

const recrossWeights = [...risenWeights, ...dailySeries("2026-08-22", 7, 147, "recross")];
const afterRecross = calculateBobaRewardState(recrossWeights, afterRise.state, {
  asOfDateKey: "2026-08-28",
  asOf: "2026-08-28T16:00:00.000Z",
  weightId: "recross-7",
  allowAwards: true
});
assert.equal(afterRecross.newlyEarned, 0, "rising and crossing an already-earned threshold again cannot duplicate it");
assert.equal(afterRecross.earnedCount, 3);

const lowerWeights = [...recrossWeights, ...dailySeries("2026-08-29", 7, 146, "lower")];
const earnedFourth = calculateBobaRewardState(lowerWeights, afterRecross.state, {
  asOfDateKey: "2026-09-04",
  asOf: "2026-09-04T16:00:00.000Z",
  weightId: "lower-7",
  allowAwards: true
});
assert.equal(earnedFourth.newlyEarned, 1);
assert.equal(earnedFourth.earnedCount, 4);
assert.equal(earnedFourth.earnedForWeightId, 1);

const deletedTriggerWeight = lowerWeights.filter((record) => record.id !== "lower-7");
const afterDeletion = calculateBobaRewardState(deletedTriggerWeight, earnedFourth.state, {
  asOfDateKey: "2026-09-04"
});
assert.equal(afterDeletion.earnedCount, 4, "deleting a weight cannot revoke a persisted reward event");
assert.equal(afterDeletion.newlyEarned, 0, "deletion and read paths cannot create another reward");
assert.deepEqual(
  normalizeBobaRewardState(afterDeletion.state).earnedThresholds.map((entry) => entry.level),
  [1, 2, 3, 4]
);

console.log("boba-reward verification passed");
