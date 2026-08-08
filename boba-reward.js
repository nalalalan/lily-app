"use strict";

const weightForecast = require("./public/weight-forecast.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const BOBA_REWARD_VERSION = 2;
const DEFAULT_TIME_ZONE = "America/New_York";

function roundToTenth(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null;
}

function distanceToTenth(value) {
  if (!Number.isFinite(Number(value))) return null;
  const normalized = Math.max(0, Number(value));
  if (normalized === 0) return 0;
  return Math.max(0.1, roundToTenth(normalized));
}

function firstWholePoundThreshold(baselineAverageLb) {
  const baseline = Number(baselineAverageLb);
  if (!Number.isFinite(baseline) || baseline <= 0) return null;
  return Math.floor(baseline - 1 + 1e-9);
}

function thresholdForLevel(firstThresholdLb, level) {
  return Number(firstThresholdLb) - Math.floor(Number(level)) + 1;
}

function validDateKey(value) {
  const key = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return "";
  const [year, month, day] = key.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day ? key : "";
}

function dateKey(value, timeZone = DEFAULT_TIME_ZONE) {
  if (validDateKey(value)) return String(value);
  const time = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(time));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return validDateKey(`${year}-${month}-${day}`);
}

function calendarDayFromDateKey(value) {
  const key = validDateKey(value);
  if (!key) return NaN;
  const [year, month, day] = key.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function dateKeyFromCalendarDay(day) {
  if (!Number.isFinite(Number(day))) return "";
  return new Date(Math.round(Number(day)) * DAY_MS).toISOString().slice(0, 10);
}

function weightInPounds(record) {
  const value = Number(record?.weight);
  if (!Number.isFinite(value) || value <= 0) return NaN;
  return String(record?.unit || "lb").trim().toLowerCase() === "kg" ? value * 2.2046226218 : value;
}

function dailyWeightPoints(weights) {
  return weightForecast.normalizePoints((Array.isArray(weights) ? weights : []).map((record) => ({
    time: Date.parse(record?.createdAt),
    weight: weightInPounds(record)
  })));
}

function calculateSevenDayAverage(weights, options = {}) {
  const asOfDateKey = validDateKey(options.asOfDateKey)
    || dateKey(options.asOf === undefined ? Date.now() : options.asOf, options.timeZone || DEFAULT_TIME_ZONE);
  const asOfDay = calendarDayFromDateKey(asOfDateKey);
  if (!Number.isFinite(asOfDay)) return null;
  const windowStartDay = asOfDay - 6;
  const points = dailyWeightPoints(weights)
    .filter((point) => point.day >= windowStartDay && point.day <= asOfDay);
  if (!points.length) return null;
  const averageLb = points.reduce((sum, point) => sum + point.weight, 0) / points.length;
  return {
    averageLb,
    averageDisplayLb: roundToTenth(averageLb),
    observedDayCount: points.length,
    observedDateKeys: points.map((point) => dateKeyFromCalendarDay(point.day)),
    windowStartDateKey: dateKeyFromCalendarDay(windowStartDay),
    windowEndDateKey: asOfDateKey
  };
}

function normalizeEarnedThresholds(entries, firstThresholdLb) {
  const byLevel = new Map();
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const level = Math.floor(Number(entry?.level));
    if (!Number.isInteger(level) || level < 1 || byLevel.has(level)) return;
    const storedThresholdLb = Number(entry?.thresholdLb);
    const thresholdLb = Number.isFinite(storedThresholdLb) && storedThresholdLb > 0
      ? storedThresholdLb
      : thresholdForLevel(firstThresholdLb, level);
    byLevel.set(level, {
      level,
      thresholdLb,
      earnedAt: Number.isFinite(Date.parse(entry?.earnedAt)) ? new Date(entry.earnedAt).toISOString() : "",
      sevenDayAverageLb: Number.isFinite(Number(entry?.sevenDayAverageLb)) ? Number(entry.sevenDayAverageLb) : thresholdLb,
      weightId: entry?.weightId ? String(entry.weightId) : null
    });
  });
  return Array.from(byLevel.values()).sort((left, right) => left.level - right.level);
}

function normalizeBobaRewardState(rewardState) {
  const baselineAverageLb = Number(rewardState?.baselineAverageLb);
  const baselineDateKey = validDateKey(rewardState?.baselineDateKey);
  if (!Number.isFinite(baselineAverageLb) || baselineAverageLb <= 0 || !baselineDateKey) return null;
  const storedFirstThresholdLb = Number(rewardState?.firstThresholdLb);
  const firstThresholdLb = Number.isInteger(storedFirstThresholdLb) && storedFirstThresholdLb > 0
    ? storedFirstThresholdLb
    : firstWholePoundThreshold(baselineAverageLb);
  if (!Number.isInteger(firstThresholdLb) || firstThresholdLb <= 0) return null;
  return {
    version: BOBA_REWARD_VERSION,
    baselineAverageLb,
    firstThresholdLb,
    baselineDateKey,
    baselineRecordedAt: Number.isFinite(Date.parse(rewardState?.baselineRecordedAt))
      ? new Date(rewardState.baselineRecordedAt).toISOString()
      : `${baselineDateKey}T12:00:00.000Z`,
    baselineWindow: {
      windowStartDateKey: validDateKey(rewardState?.baselineWindow?.windowStartDateKey)
        || dateKeyFromCalendarDay(calendarDayFromDateKey(baselineDateKey) - 6),
      windowEndDateKey: validDateKey(rewardState?.baselineWindow?.windowEndDateKey) || baselineDateKey,
      observedDayCount: Math.max(0, Math.floor(Number(rewardState?.baselineWindow?.observedDayCount) || 0)),
      observedDateKeys: Array.from(new Set((Array.isArray(rewardState?.baselineWindow?.observedDateKeys)
        ? rewardState.baselineWindow.observedDateKeys
        : []).map(validDateKey).filter(Boolean))).sort()
    },
    earnedThresholds: normalizeEarnedThresholds(rewardState?.earnedThresholds, firstThresholdLb)
  };
}

function createBobaRewardBaseline(weights, options = {}) {
  const baselineDateKey = validDateKey(options.baselineDateKey);
  if (!baselineDateKey) return null;
  const window = calculateSevenDayAverage(weights, {
    asOfDateKey: baselineDateKey,
    timeZone: options.timeZone || DEFAULT_TIME_ZONE
  });
  if (!window) return null;
  const recordedAt = Number.isFinite(Date.parse(options.recordedAt))
    ? new Date(options.recordedAt).toISOString()
    : `${baselineDateKey}T12:00:00.000Z`;
  return {
    version: BOBA_REWARD_VERSION,
    baselineAverageLb: window.averageLb,
    firstThresholdLb: firstWholePoundThreshold(window.averageLb),
    baselineDateKey,
    baselineRecordedAt: recordedAt,
    baselineWindow: {
      windowStartDateKey: window.windowStartDateKey,
      windowEndDateKey: window.windowEndDateKey,
      observedDayCount: window.observedDayCount,
      observedDateKeys: window.observedDateKeys
    },
    earnedThresholds: []
  };
}

function calculateBobaRewardState(weights, rewardState, options = {}) {
  const normalizedState = normalizeBobaRewardState(rewardState);
  if (!normalizedState) return null;
  const currentWindow = calculateSevenDayAverage(weights, options);
  if (!currentWindow) return null;

  const existingThresholds = normalizedState.earnedThresholds.slice();
  const existingLevels = new Set(existingThresholds.map((entry) => entry.level));
  const crossedLevelCount = currentWindow.averageLb <= normalizedState.firstThresholdLb + 1e-9
    ? Math.max(0, Math.floor(normalizedState.firstThresholdLb - currentWindow.averageLb + 1e-9) + 1)
    : 0;
  const earnedAtTime = options.earnedAt instanceof Date
    ? options.earnedAt.getTime()
    : typeof options.earnedAt === "number"
      ? options.earnedAt
      : Date.parse(options.earnedAt);
  const asOfTime = options.asOf instanceof Date
    ? options.asOf.getTime()
    : typeof options.asOf === "number"
      ? options.asOf
      : Date.parse(options.asOf);
  const earnedAt = Number.isFinite(earnedAtTime)
    ? new Date(earnedAtTime).toISOString()
    : Number.isFinite(asOfTime)
      ? new Date(asOfTime).toISOString()
      : new Date().toISOString();
  const weightId = options.weightId ? String(options.weightId) : null;
  const newlyEarnedThresholds = [];
  for (let level = 1; options.allowAwards === true && level <= crossedLevelCount; level += 1) {
    if (existingLevels.has(level)) continue;
    const event = {
      level,
      thresholdLb: thresholdForLevel(normalizedState.firstThresholdLb, level),
      earnedAt,
      sevenDayAverageLb: currentWindow.averageLb,
      weightId
    };
    existingThresholds.push(event);
    newlyEarnedThresholds.push(event);
    existingLevels.add(level);
  }
  existingThresholds.sort((left, right) => left.level - right.level);

  const earnedCount = existingThresholds.length;
  let nextLevel = 1;
  while (existingLevels.has(nextLevel)) nextLevel += 1;
  const nextThresholdLb = thresholdForLevel(normalizedState.firstThresholdLb, nextLevel);
  const poundsToNextBobaLb = Math.max(0, currentWindow.averageLb - nextThresholdLb);
  const latestEarnedThreshold = existingThresholds[existingThresholds.length - 1] || null;
  const nextState = {
    ...normalizedState,
    earnedThresholds: existingThresholds
  };

  return {
    state: nextState,
    baselineAverageLb: normalizedState.baselineAverageLb,
    baselineAverageDisplayLb: roundToTenth(normalizedState.baselineAverageLb),
    baselineDateKey: normalizedState.baselineDateKey,
    firstThresholdLb: normalizedState.firstThresholdLb,
    currentSevenDayAverageLb: currentWindow.averageLb,
    currentSevenDayAverageDisplayLb: currentWindow.averageDisplayLb,
    nextThresholdLb,
    nextThresholdDisplayLb: roundToTenth(nextThresholdLb),
    poundsToNextBobaLb,
    poundsToNextBobaDisplayLb: distanceToTenth(poundsToNextBobaLb),
    observedDayCount: currentWindow.observedDayCount,
    observedDateKeys: currentWindow.observedDateKeys,
    windowStartDateKey: currentWindow.windowStartDateKey,
    windowEndDateKey: currentWindow.windowEndDateKey,
    earnedCount,
    earnedForWeightId: weightId
      ? existingThresholds.filter((entry) => entry.weightId === weightId).length
      : 0,
    newlyEarned: newlyEarnedThresholds.length,
    newlyEarnedThresholds,
    latestEarnedThreshold
  };
}

function publicBobaReward(result) {
  if (!result) return null;
  return {
    baselineAverageLb: result.baselineAverageDisplayLb,
    baselineDateKey: result.baselineDateKey,
    currentSevenDayAverageLb: result.currentSevenDayAverageDisplayLb,
    nextThresholdLb: result.nextThresholdDisplayLb,
    poundsToNextBobaLb: result.poundsToNextBobaDisplayLb,
    observedDayCount: result.observedDayCount,
    windowStartDateKey: result.windowStartDateKey,
    windowEndDateKey: result.windowEndDateKey,
    earnedCount: result.earnedCount,
    latestEarnedThreshold: result.latestEarnedThreshold ? {
      level: result.latestEarnedThreshold.level,
      thresholdLb: roundToTenth(result.latestEarnedThreshold.thresholdLb),
      earnedAt: result.latestEarnedThreshold.earnedAt
    } : null
  };
}

module.exports = {
  BOBA_REWARD_VERSION,
  DEFAULT_TIME_ZONE,
  calculateBobaRewardState,
  calculateSevenDayAverage,
  createBobaRewardBaseline,
  normalizeBobaRewardState,
  publicBobaReward,
  roundToTenth
};
