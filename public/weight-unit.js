(function attachLilyWeightUnits(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LilyWeightUnits = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createLilyWeightUnits() {
  "use strict";

  const KG_TO_LB = 2.2046226218;
  const HISTORY_DAY_LIMIT = 7;
  const MAX_REFERENCE_DISTANCE_LB = 30;
  const MIN_DISTANCE_MARGIN_LB = 10;
  const DEFAULT_TIME_ZONE = "America/New_York";

  function roundPounds(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function median(values) {
    const sorted = (Array.isArray(values) ? values : [])
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function normalizeUnit(value, fallback = "auto") {
    const unit = String(value == null ? fallback : value).trim().toLowerCase();
    return unit === "kg" || unit === "lb" || unit === "auto" ? unit : null;
  }

  function weightInPounds(recordOrValue, unit) {
    const isRecord = recordOrValue && typeof recordOrValue === "object";
    const value = Number(isRecord ? recordOrValue.weight : recordOrValue);
    if (!Number.isFinite(value)) return NaN;
    const sourceUnit = normalizeUnit(isRecord ? recordOrValue.unit : unit, "lb");
    if (!sourceUnit || sourceUnit === "auto") return value;
    return sourceUnit === "kg" ? value * KG_TO_LB : value;
  }

  function easternDateKey(value, timeZone = DEFAULT_TIME_ZONE) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const part = (type) => parts.find((entry) => entry.type === type)?.value || "";
    const year = part("year");
    const month = part("month");
    const day = part("day");
    return year && month && day ? `${year}-${month}-${day}` : "";
  }

  function latestDailyWeightsLb(records, options = {}) {
    const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
    const limit = Number.isInteger(options.limit) && options.limit > 0
      ? options.limit
      : HISTORY_DAY_LIMIT;
    const byDay = new Map();

    for (const record of Array.isArray(records) ? records : []) {
      const pounds = weightInPounds(record);
      const dateKey = easternDateKey(record && record.createdAt, timeZone);
      if (!Number.isFinite(pounds) || pounds <= 0 || !dateKey) continue;
      if (!byDay.has(dateKey)) byDay.set(dateKey, []);
      byDay.get(dateKey).push(pounds);
    }

    return Array.from(byDay.entries())
      .sort(([left], [right]) => right.localeCompare(left))
      .slice(0, limit)
      .map(([, values]) => median(values))
      .filter(Number.isFinite);
  }

  function historyReferenceLb(records, options = {}) {
    return median(latestDailyWeightsLb(records, options));
  }

  function invalidResolution(inputValue, requestedUnit, error) {
    return {
      status: "invalid",
      ambiguous: false,
      error,
      inputValue,
      requestedUnit,
      detectedUnit: null,
      source: "invalid",
      weightLb: null,
      weightLbExact: null,
      historyReferenceLb: null,
      candidates: null
    };
  }

  function resolvedWeight(inputValue, requestedUnit, detectedUnit, source, referenceLb, candidates) {
    const exact = detectedUnit === "kg" ? inputValue * KG_TO_LB : inputValue;
    return {
      status: "resolved",
      ambiguous: false,
      error: null,
      inputValue,
      requestedUnit,
      detectedUnit,
      source,
      weightLb: roundPounds(exact),
      weightLbExact: exact,
      historyReferenceLb: referenceLb,
      candidates
    };
  }

  function resolveWeightInput(value, records, requestedUnit = "auto", options = {}) {
    const inputValue = Number(value);
    const normalizedUnit = normalizeUnit(requestedUnit, "auto");
    if (!normalizedUnit) return invalidResolution(inputValue, null, "invalid-unit");
    if (!Number.isFinite(inputValue) || inputValue <= 0 || inputValue > 1000) {
      return invalidResolution(inputValue, normalizedUnit, "invalid-weight");
    }

    const referenceLb = historyReferenceLb(records, options);
    const candidates = {
      lb: {
        weightLb: roundPounds(inputValue),
        distanceLb: Number.isFinite(referenceLb) ? Math.abs(inputValue - referenceLb) : null
      },
      kg: {
        weightLb: roundPounds(inputValue * KG_TO_LB),
        distanceLb: Number.isFinite(referenceLb) ? Math.abs(inputValue * KG_TO_LB - referenceLb) : null
      }
    };

    if (normalizedUnit === "kg" || normalizedUnit === "lb") {
      return resolvedWeight(inputValue, normalizedUnit, normalizedUnit, "explicit", referenceLb, candidates);
    }

    if (!Number.isFinite(referenceLb)) {
      const detectedUnit = inputValue < 100 ? "kg" : "lb";
      return resolvedWeight(inputValue, normalizedUnit, detectedUnit, "threshold", null, candidates);
    }

    const lbDistance = candidates.lb.distanceLb;
    const kgDistance = candidates.kg.distanceLb;
    const detectedUnit = kgDistance < lbDistance ? "kg" : "lb";
    const winnerDistance = Math.min(lbDistance, kgDistance);
    const loserDistance = Math.max(lbDistance, kgDistance);
    if (winnerDistance <= MAX_REFERENCE_DISTANCE_LB && loserDistance - winnerDistance >= MIN_DISTANCE_MARGIN_LB) {
      return resolvedWeight(inputValue, normalizedUnit, detectedUnit, "history", referenceLb, candidates);
    }

    return {
      status: "ambiguous",
      ambiguous: true,
      error: "weight-unit-ambiguous",
      inputValue,
      requestedUnit: normalizedUnit,
      detectedUnit: null,
      source: "ambiguous",
      weightLb: null,
      weightLbExact: null,
      historyReferenceLb: referenceLb,
      candidates
    };
  }

  return Object.freeze({
    KG_TO_LB,
    HISTORY_DAY_LIMIT,
    MAX_REFERENCE_DISTANCE_LB,
    MIN_DISTANCE_MARGIN_LB,
    DEFAULT_TIME_ZONE,
    roundPounds,
    median,
    normalizeUnit,
    weightInPounds,
    easternDateKey,
    latestDailyWeightsLb,
    historyReferenceLb,
    resolveWeightInput
  });
});
