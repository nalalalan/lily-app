"use strict";

const { calculateSevenDayAverage, roundToTenth } = require("../boba-reward.js");

const apiBase = String(process.env.LILY_API_BASE || "https://lily-api-production.up.railway.app").replace(/\/+$/, "");
const pin = String(process.env.LILY_PIN || "");
const timeZone = "America/New_York";

async function readJson(response, stage) {
  if (!response.ok) throw new Error(`${stage} returned ${response.status}`);
  return response.json();
}

function wordCount(text) {
  return String(text || "").match(/[A-Za-z0-9]+(?:[’'][A-Za-z0-9]+)*/g)?.length || 0;
}

function sentenceCount(text) {
  const normalized = String(text || "").trim();
  if (!normalized || !/[.!?]$/.test(normalized)) return 0;
  return normalized.match(/[^.!?]+[.!?]+/g)?.length || 0;
}

function displayedDistance(value) {
  const normalized = Math.max(0, Number(value));
  if (!Number.isFinite(normalized)) return null;
  if (normalized === 0) return 0;
  return Math.max(0.1, roundToTenth(normalized));
}

function trimNumber(value) {
  return Number(Number(value).toFixed(1)).toString();
}

async function run() {
  if (!pin) throw new Error("LILY_PIN is required");
  const auth = await readJson(await fetch(`${apiBase}/api/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin })
  }), "auth");
  const payload = await readJson(await fetch(`${apiBase}/api/weights`, {
    headers: { authorization: `Bearer ${auth.token}` }
  }), "weights");

  const weights = Array.isArray(payload.weights) ? payload.weights : [];
  const latest = weights[0] || null;
  const reward = payload.bobaReward || null;
  const memo = String(payload.latestCoach?.text || "").trim();
  const currentWindow = calculateSevenDayAverage(weights, { asOf: Date.now(), timeZone });
  const baselineWindow = reward?.baselineDateKey
    ? calculateSevenDayAverage(weights, { asOfDateKey: reward.baselineDateKey, timeZone })
    : null;
  const firstThreshold = baselineWindow ? Math.floor(baselineWindow.averageLb - 1 + 1e-9) : null;
  const expectedNextThreshold = Number.isInteger(firstThreshold)
    ? firstThreshold - Number(reward?.earnedCount || 0)
    : null;
  const expectedDistance = currentWindow && Number.isFinite(expectedNextThreshold)
    ? displayedDistance(currentWindow.averageLb - expectedNextThreshold)
    : null;
  const coachKeys = Object.keys(payload.latestCoach || {}).sort();
  const checks = {
    hasWeights: weights.length > 0,
    canonicalPoundRecords: weights.every((record) => record?.unit === "lb" && Number.isFinite(Number(record.weight)) && Number(record.weight) > 0),
    latestCoachMatchesLatestWeight: Boolean(latest?.id && payload.latestCoach?.weightId === latest.id),
    publicCoachShape: JSON.stringify(coachKeys) === JSON.stringify(["createdAt", "text", "weightId"]),
    baselineMatchesStoredWeights: Boolean(baselineWindow && reward?.baselineAverageLb === baselineWindow.averageDisplayLb),
    currentAverageMatchesStoredWeights: Boolean(currentWindow && reward?.currentSevenDayAverageLb === currentWindow.averageDisplayLb),
    observedWindowMatchesStoredWeights: Boolean(currentWindow
      && reward?.observedDayCount === currentWindow.observedDayCount
      && reward?.windowStartDateKey === currentWindow.windowStartDateKey
      && reward?.windowEndDateKey === currentWindow.windowEndDateKey),
    nextThresholdIsPoundBased: reward?.nextThresholdLb === expectedNextThreshold,
    distanceIsPoundBased: reward?.poundsToNextBobaLb === expectedDistance,
    earnedStateCoherent: Number.isInteger(reward?.earnedCount)
      && reward.earnedCount >= 0
      && (reward.latestEarnedThreshold === null
        ? reward.earnedCount === 0
        : reward.earnedCount > 0 && Number.isFinite(Number(reward.latestEarnedThreshold.thresholdLb))),
    memoIsOneParagraph: Boolean(memo) && !/[\r\n]/.test(memo),
    memoHasTwoOrThreeSentences: sentenceCount(memo) >= 2 && sentenceCount(memo) <= 3,
    memoWithinWordCap: wordCount(memo) <= 42,
    memoNamesLatestPounds: Boolean(latest && memo.includes(`${trimNumber(latest.weight)} lb`)),
    memoNoInternalWrapper: !/\b(?:Alan|Brain|source|retriev|role|coach:)\b/i.test(memo),
    memoNoArtificialFiller: !/\b(?:anyway|story|signal)\b/i.test(memo),
    memoSafety: !/\b(?:fast(?:ing)?|skip(?:ping)? meals?|punish|compensat|diagnos|target weight|goal weight)\b/i.test(memo),
    memoExclamationSafe: (memo.match(/!/g) || []).length <= 1
  };
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    checks,
    summary: {
      weightCount: weights.length,
      currentSevenDayAverageLb: reward?.currentSevenDayAverageLb,
      nextThresholdLb: reward?.nextThresholdLb,
      poundsToNextBobaLb: reward?.poundsToNextBobaLb,
      memoWords: wordCount(memo),
      memoSentences: sentenceCount(memo)
    }
  }));
  if (failed.length) throw new Error(`live Lily verification failed: ${failed.join(", ")}`);
}

run().catch((error) => {
  console.error(String(error?.message || "live Lily verification failed"));
  process.exitCode = 1;
});
