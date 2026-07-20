(function attachLilyWeightForecast(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LilyWeightForecast = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createLilyWeightForecast() {
  "use strict";

  const DAY_MS = 24 * 60 * 60 * 1000;
  const MIN_DAMPED_MODEL_POINTS = 7;
  const MIN_DAMPED_MODEL_SPAN_DAYS = 14;
  const MIN_WALK_FORWARD_POINTS = 4;
  const MAX_WALK_FORWARD_ORIGINS = 24;
  const VALIDATION_HORIZONS = [7, 14, 28];
  const VALIDATION_TARGET_TOLERANCE_DAYS = 3;
  const ANNUAL_HORIZON_DAYS = 365;
  const ANNUAL_TARGET_TOLERANCE_DAYS = 7;
  const MIN_ANNUAL_ORIGIN_SPACING_DAYS = 28;
  const MIN_ANNUAL_CALIBRATION_POINTS = 20;
  const HUBER_LIMIT = 2.5;
  const ROBUST_SCALE_WINDOW = 30;
  const MOMENTUM_DECAY_DAYS = 48;
  const MOMENTUM_RATE_LIMIT = 0.5;
  const WEAK_MOMENTUM_RATE_LIMIT = 0.12;
  const PARAMETER_GRID = [
    [0.2, 0.02, 0.9], [0.2, 0.02, 0.95], [0.2, 0.02, 0.98],
    [0.2, 0.08, 0.9], [0.2, 0.08, 0.95], [0.2, 0.08, 0.98],
    [0.2, 0.2, 0.9], [0.2, 0.2, 0.95], [0.2, 0.2, 0.98],
    [0.4, 0.02, 0.9], [0.4, 0.02, 0.95], [0.4, 0.02, 0.98],
    [0.4, 0.08, 0.9], [0.4, 0.08, 0.95], [0.4, 0.08, 0.98],
    [0.4, 0.2, 0.9], [0.4, 0.2, 0.95], [0.4, 0.2, 0.98],
    [0.6, 0.02, 0.9], [0.6, 0.02, 0.95], [0.6, 0.02, 0.98],
    [0.6, 0.08, 0.9], [0.6, 0.08, 0.95], [0.6, 0.08, 0.98],
    [0.6, 0.2, 0.9], [0.6, 0.2, 0.95], [0.6, 0.2, 0.98]
  ].map(([alpha, beta, phi]) => ({ alpha, beta, phi }));

  function median(values) {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return NaN;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function theilSenSlope(points) {
    const slopes = [];
    for (let left = 0; left < points.length; left += 1) {
      for (let right = left + 1; right < points.length; right += 1) {
        const dayDelta = points[right].day - points[left].day;
        if (dayDelta > 0) slopes.push((points[right].weight - points[left].weight) / dayDelta);
      }
    }
    return median(slopes);
  }

  function pointsInRecentDays(points, endIndex, calendarDays) {
    const latestDay = points[endIndex].day;
    const firstDay = latestDay - Math.max(0, calendarDays - 1);
    return points.slice(0, endIndex + 1).filter((point) => point.day >= firstDay);
  }

  function recentDirectionalStreak(points, endIndex) {
    let direction = 0;
    let intervals = 0;
    let firstIndex = endIndex;
    const changes = [];
    for (let index = endIndex; index > 0; index -= 1) {
      const newer = points[index];
      const older = points[index - 1];
      const gap = newer.day - older.day;
      if (gap < 1 || gap > 2) break;
      const change = newer.weight - older.weight;
      const dailyRate = change / gap;
      const changeDirection = Math.sign(dailyRate);
      if (!changeDirection || Math.abs(dailyRate) < 0.1 || Math.abs(dailyRate) > 2.5) break;
      if (!direction) direction = changeDirection;
      if (changeDirection !== direction) break;
      intervals += 1;
      firstIndex = index - 1;
      changes.unshift(change);
    }
    return {
      direction,
      intervals,
      weighInCount: intervals ? intervals + 1 : 1,
      firstIndex,
      changes,
      totalChange: points[endIndex].weight - points[firstIndex].weight,
      durationDays: points[endIndex].day - points[firstIndex].day
    };
  }

  function momentumDiagnostics(points, endIndex) {
    const finalIndex = Number.isInteger(endIndex) ? Math.min(endIndex, points.length - 1) : points.length - 1;
    const prefix = points.slice(0, finalIndex + 1);
    const r3 = theilSenSlope(prefix.slice(-3));
    const r7 = theilSenSlope(pointsInRecentDays(points, finalIndex, 7));
    const r14 = theilSenSlope(pointsInRecentDays(points, finalIndex, 14));
    const streak = recentDirectionalStreak(points, finalIndex);
    const finiteRate = (value) => Number.isFinite(value) ? value : 0;
    let rawRate;
    let multiplier = 1;
    let strong = false;
    if (streak.intervals >= 2) {
      rawRate = 0.65 * finiteRate(r3) + 0.25 * finiteRate(r7) + 0.10 * finiteRate(r14);
      multiplier = Math.min(1.5, 1 + 0.15 * (streak.intervals - 1));
      strong = true;
    } else {
      rawRate = 0.25 * finiteRate(r7) + 0.10 * finiteRate(r14);
    }
    const rateLimit = strong ? MOMENTUM_RATE_LIMIT : WEAK_MOMENTUM_RATE_LIMIT;
    const momentumRate = Math.max(-rateLimit, Math.min(rateLimit, rawRate * multiplier));
    return {
      r3,
      r7,
      r14,
      rawRate,
      multiplier,
      momentumRate,
      strong,
      capped: Math.abs(rawRate * multiplier) > rateLimit,
      streak
    };
  }

  function horizonCap(points, endIndex, horizonDays) {
    const anchor = median(points.slice(Math.max(0, endIndex - 2), endIndex + 1).map((point) => point.weight));
    const cap = horizonDays <= 10
      ? Math.max(4, anchor * 0.04)
      : horizonDays <= 45
        ? Math.max(8, anchor * 0.08)
        : Math.max(20, anchor * 0.20);
    return { anchor, lower: Math.max(0.1, anchor - cap), upper: anchor + cap };
  }

  function projectWithMomentum(points, endIndex, model, targetDay, diagnostics) {
    const baseWeight = projectModel(model, targetDay);
    if (!Number.isFinite(baseWeight)) return NaN;
    const horizonDays = Math.max(0, targetDay - points[endIndex].day);
    const momentum = diagnostics || momentumDiagnostics(points, endIndex);
    const adjustment = momentum.momentumRate * MOMENTUM_DECAY_DAYS * (1 - Math.exp(-horizonDays / MOMENTUM_DECAY_DAYS));
    const limits = horizonCap(points, endIndex, horizonDays);
    return Math.max(limits.lower, Math.min(limits.upper, baseWeight + adjustment));
  }

  function calendarDay(time) {
    const date = new Date(time);
    if (!Number.isFinite(date.getTime())) return NaN;
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
  }

  function addCalendarMonths(day, months) {
    const date = new Date(day * DAY_MS);
    const originalDay = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);
    const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(originalDay, daysInMonth));
    return Math.floor(date.getTime() / DAY_MS);
  }

  function normalizePoints(inputPoints) {
    const groups = new Map();
    (Array.isArray(inputPoints) ? inputPoints : []).forEach((point) => {
      const weight = Number(point && point.weight);
      const time = Number(point && point.time);
      const suppliedDay = Number(point && point.day);
      const day = Number.isFinite(suppliedDay) ? Math.round(suppliedDay) : calendarDay(time);
      if (!Number.isFinite(weight) || weight <= 0 || !Number.isFinite(day)) return;
      const group = groups.get(day) || { day, times: [], weights: [] };
      if (Number.isFinite(time)) group.times.push(time);
      group.weights.push(weight);
      groups.set(day, group);
    });

    return Array.from(groups.values())
      .map((group) => ({
        day: group.day,
        time: group.times.length ? median(group.times) : group.day * DAY_MS,
        weight: median(group.weights)
      }))
      .filter((point) => Number.isFinite(point.day) && Number.isFinite(point.time) && Number.isFinite(point.weight))
      .sort((a, b) => a.day - b.day || a.time - b.time);
  }

  function dampedSteps(phi, days) {
    const horizon = Math.max(0, Number(days) || 0);
    if (!horizon) return 0;
    if (!Number.isFinite(phi) || phi <= 0) return 0;
    if (Math.abs(1 - phi) < 1e-9) return horizon;
    return phi * (1 - Math.pow(phi, horizon)) / (1 - phi);
  }

  function robustScale(errors) {
    if (errors.length < 3) return 0.75;
    const center = median(errors);
    const mad = median(errors.map((error) => Math.abs(error - center)));
    return Math.max(0.25, 1.4826 * (Number.isFinite(mad) ? mad : 0));
  }

  function clipInnovation(error, priorErrors) {
    const limit = HUBER_LIMIT * robustScale(priorErrors.slice(-ROBUST_SCALE_WINDOW));
    return Math.max(-limit, Math.min(limit, error));
  }

  function fitDampedSequence(points, parameters) {
    let level = points[0].weight;
    let trend = 0;
    let previousDay = points[0].day;
    const errors = [];
    const models = [{
      method: "damped",
      level,
      trend,
      day: previousDay,
      alpha: parameters.alpha,
      beta: parameters.beta,
      phi: parameters.phi,
      backtestMae: NaN
    }];

    for (let index = 1; index < points.length; index += 1) {
      const point = points[index];
      const gap = Math.max(1, point.day - previousDay);
      const predictedLevel = level + trend * dampedSteps(parameters.phi, gap);
      const predictedTrend = trend * Math.pow(parameters.phi, gap);
      const error = point.weight - predictedLevel;
      const innovation = clipInnovation(error, errors);
      level = predictedLevel + parameters.alpha * innovation;
      trend = predictedTrend + parameters.beta * (innovation / gap);
      errors.push(error);
      previousDay = point.day;
      models.push({
        method: "damped",
        level,
        trend,
        day: point.day,
        alpha: parameters.alpha,
        beta: parameters.beta,
        phi: parameters.phi,
        backtestMae: NaN
      });
    }
    return models;
  }

  function fitPersistenceSequence(points) {
    return points.map((point, index) => {
      return {
        method: "persistence",
        level: median(points.slice(Math.max(0, index - 2), index + 1).map((row) => row.weight)),
        trend: 0,
        day: point.day,
        phi: 0,
        backtestMae: NaN
      };
    });
  }

  function candidateDefinitions() {
    return [
      { id: "persistence", method: "persistence" },
      ...PARAMETER_GRID.map((parameters) => ({
        id: `damped-${parameters.alpha}-${parameters.beta}-${parameters.phi}`,
        method: "damped",
        parameters
      }))
    ];
  }

  function fitCandidateSequence(points, definition) {
    return definition.method === "damped"
      ? fitDampedSequence(points, definition.parameters)
      : fitPersistenceSequence(points);
  }

  function findValidationTarget(points, originIndex, horizonDays, lastIndex) {
    const requestedDay = points[originIndex].day + horizonDays;
    const finalIndex = Number.isInteger(lastIndex) ? Math.min(lastIndex, points.length - 1) : points.length - 1;
    for (let index = originIndex + 1; index <= finalIndex; index += 1) {
      if (points[index].day < requestedDay) continue;
      if (points[index].day > requestedDay + VALIDATION_TARGET_TOLERANCE_DAYS) return null;
      return { index, requestedDay, point: points[index] };
    }
    return null;
  }

  function evaluateCandidateWalkForwardAt(points, originModels, endIndex) {
    const evaluations = [];
    const maxHorizon = Math.max(...VALIDATION_HORIZONS);
    const pointCount = endIndex + 1;
    const originStart = Math.max(
      MIN_WALK_FORWARD_POINTS - 1,
      pointCount - MAX_WALK_FORWARD_ORIGINS - maxHorizon - VALIDATION_TARGET_TOLERANCE_DAYS
    );

    for (let originIndex = originStart; originIndex < endIndex; originIndex += 1) {
      if (originIndex + 1 < MIN_WALK_FORWARD_POINTS) continue;
      const model = originModels[originIndex];
      const usedTargets = new Set();
      VALIDATION_HORIZONS.forEach((horizonDays) => {
        const target = findValidationTarget(points, originIndex, horizonDays, endIndex);
        if (!target || usedTargets.has(target.index)) return;
        usedTargets.add(target.index);
        const predicted = projectModel(model, target.point.day);
        if (!Number.isFinite(predicted)) return;
        evaluations.push({
          originDay: points[originIndex].day,
          trainingLastDay: points[originIndex].day,
          targetDay: target.point.day,
          requestedHorizonDays: horizonDays,
          actualHorizonDays: target.point.day - points[originIndex].day,
          predicted,
          actual: target.point.weight,
          error: target.point.weight - predicted
        });
      });
    }

    const limited = evaluations.slice(-MAX_WALK_FORWARD_ORIGINS * VALIDATION_HORIZONS.length);
    return {
      evaluations: limited,
      score: median(limited.map((row) => Math.abs(row.error))),
      horizons: Array.from(new Set(limited.map((row) => row.requestedHorizonDays))).sort((a, b) => a - b)
    };
  }

  function prepareCandidateSequences(points) {
    return candidateDefinitions().map((definition) => ({
      definition,
      models: fitCandidateSequence(points, definition)
    }));
  }

  function selectModelAt(points, prepared, endIndex) {
    const persistenceEntry = prepared.find((entry) => entry.definition.method === "persistence");
    const persistence = persistenceEntry.models[endIndex];
    const spanDays = points[endIndex].day - points[0].day;
    if (endIndex + 1 < MIN_DAMPED_MODEL_POINTS || spanDays < MIN_DAMPED_MODEL_SPAN_DAYS) {
      return {
        ...persistence,
        selection: "short-history",
        validationCount: 0,
        validationHorizons: []
      };
    }

    const evaluated = prepared
      .map((entry) => {
        const validation = evaluateCandidateWalkForwardAt(points, entry.models, endIndex);
        return { ...entry, validation };
      })
      .filter((candidate) => Number.isFinite(candidate.validation.score))
      .sort((a, b) => a.validation.score - b.validation.score || a.definition.id.localeCompare(b.definition.id));
    if (!evaluated.length) {
      return {
        ...persistence,
        selection: "short-history",
        validationCount: 0,
        validationHorizons: []
      };
    }

    const bestScore = evaluated[0].validation.score;
    const competitiveLimit = bestScore + Math.max(0.25, bestScore * 0.75);
    const competitive = evaluated.filter((candidate) => candidate.validation.score <= competitiveLimit);
    const members = competitive.map((candidate) => {
      const rawWeight = 1 / Math.pow(Math.max(0.1, candidate.validation.score), 2);
      return {
        id: candidate.definition.id,
        model: candidate.models[endIndex],
        score: candidate.validation.score,
        rawWeight,
        weight: 0
      };
    });
    const totalWeight = members.reduce((sum, member) => sum + member.rawWeight, 0);
    members.forEach((member) => {
      member.weight = totalWeight > 0 ? member.rawWeight / totalWeight : 1 / members.length;
      delete member.rawWeight;
    });
    const evaluationById = new Map(evaluated.map((candidate) => [candidate.definition.id, candidate.validation.evaluations]));
    const validationRows = evaluated[0].validation.evaluations.map((base, rowIndex) => {
      const predicted = members.reduce((sum, member) => {
        const row = evaluationById.get(member.id)[rowIndex];
        return sum + member.weight * row.predicted;
      }, 0);
      return {
        ...base,
        predicted,
        error: base.actual - predicted
      };
    });

    return {
      method: "ensemble",
      day: points[endIndex].day,
      members,
      selection: "walk-forward-ensemble",
      backtestMae: median(validationRows.map((row) => Math.abs(row.error))),
      validationCount: validationRows.length,
      validationHorizons: Array.from(new Set(validationRows.map((row) => row.requestedHorizonDays))).sort((a, b) => a - b),
      validationRows
    };
  }

  function selectModel(points, prepared) {
    const candidates = prepared || prepareCandidateSequences(points);
    return selectModelAt(points, candidates, points.length - 1);
  }

  function projectModel(model, targetDay) {
    if (!model || !Number.isFinite(targetDay)) return NaN;
    if (model.method === "ensemble") {
      const projected = model.members
        .map((member) => ({ weight: member.weight, value: projectModel(member.model, targetDay) }))
        .filter((row) => Number.isFinite(row.weight) && Number.isFinite(row.value));
      const totalWeight = projected.reduce((sum, row) => sum + row.weight, 0);
      if (!(totalWeight > 0)) return NaN;
      const combined = projected.reduce((sum, row) => sum + row.value * row.weight, 0) / totalWeight;
      return Math.max(0.1, Number(combined.toFixed(12)));
    }
    if (!Number.isFinite(model.level)) return NaN;
    const horizonDays = Math.max(0, targetDay - model.day);
    const raw = model.method === "damped"
      ? model.level + model.trend * dampedSteps(model.phi, horizonDays)
      : model.level;
    return Number.isFinite(raw) ? Math.max(0.1, raw) : NaN;
  }

  function quantile(values, probability) {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return NaN;
    const position = Math.max(0, Math.min(1, probability)) * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  }

  function annualWalkForwardErrors(points, prepared) {
    if (points.length < MIN_WALK_FORWARD_POINTS + 1) return [];
    if (points[points.length - 1].day - points[0].day < ANNUAL_HORIZON_DAYS) return [];
    const completed = [];
    let lastAcceptedOriginDay = -Infinity;
    for (let originIndex = MIN_WALK_FORWARD_POINTS - 1; originIndex < points.length - 1; originIndex += 1) {
      if (points[originIndex].day - lastAcceptedOriginDay < MIN_ANNUAL_ORIGIN_SPACING_DAYS) continue;
      const requestedDay = points[originIndex].day + ANNUAL_HORIZON_DAYS;
      let target = null;
      for (let index = originIndex + 1; index < points.length; index += 1) {
        if (points[index].day < requestedDay) continue;
        if (points[index].day <= requestedDay + ANNUAL_TARGET_TOLERANCE_DAYS) {
          target = points[index];
        }
        break;
      }
      if (!target) continue;
      const originModel = selectModelAt(points, prepared, originIndex);
      const predicted = projectWithMomentum(points, originIndex, originModel, target.day);
      if (!Number.isFinite(predicted)) continue;
      completed.push({
        originDay: points[originIndex].day,
        trainingLastDay: points[originIndex].day,
        targetDay: target.day,
        predicted,
        actual: target.weight,
        error: target.weight - predicted
      });
      lastAcceptedOriginDay = points[originIndex].day;
    }
    return completed.slice(-MAX_WALK_FORWARD_ORIGINS);
  }

  function calculateForecast(inputPoints, options) {
    const points = normalizePoints(inputPoints);
    if (!points.length) return null;
    const prepared = prepareCandidateSequences(points);
    const model = selectModel(points, prepared);
    const requestedDay = Number(options && options.asOfDay);
    const anchorDay = Number.isFinite(requestedDay)
      ? Math.max(points[points.length - 1].day, Math.round(requestedDay))
      : points[points.length - 1].day;
    const oneWeekDay = anchorDay + 7;
    const oneMonthDay = addCalendarMonths(anchorDay, 1);
    const oneYearDay = addCalendarMonths(anchorDay, 12);
    const spanDays = points[points.length - 1].day - points[0].day;
    const momentum = momentumDiagnostics(points, points.length - 1);
    const baseOneWeekWeight = projectModel(model, oneWeekDay);
    const baseOneMonthWeight = projectModel(model, oneMonthDay);
    const baseOneYearWeight = projectModel(model, oneYearDay);
    const oneWeekWeight = projectWithMomentum(points, points.length - 1, model, oneWeekDay, momentum);
    const oneMonthWeight = projectWithMomentum(points, points.length - 1, model, oneMonthDay, momentum);
    const oneYearWeight = projectWithMomentum(points, points.length - 1, model, oneYearDay, momentum);
    const skipAnnualEvaluation = Boolean(options && options.skipAnnualEvaluation);
    const annualErrors = skipAnnualEvaluation ? [] : annualWalkForwardErrors(points, prepared);
    const annualValidationCount = annualErrors.length;
    const annualCalibrationReady = annualValidationCount >= MIN_ANNUAL_CALIBRATION_POINTS;
    const annualAbsoluteError = annualCalibrationReady
      ? quantile(annualErrors.map((row) => Math.abs(row.error)), 0.9)
      : NaN;
    const oneYearErrorBand = Number.isFinite(annualAbsoluteError)
      ? {
        lower: Math.max(0.1, oneYearWeight - annualAbsoluteError),
        upper: oneYearWeight + annualAbsoluteError,
        nominalCoverage: 0.9,
        method: "empirical-annual-errors"
      }
      : null;
    const confidence = spanDays < 90
      ? "learning"
      : annualCalibrationReady
        ? "historically-evaluated"
        : "provisional";

    return {
      pointCount: points.length,
      spanDays,
      latestDay: points[points.length - 1].day,
      latestTime: points[points.length - 1].time,
      latestWeight: points[points.length - 1].weight,
      anchorDay,
      method: model.method,
      selection: model.selection,
      backtestMae: model.backtestMae,
      validationCount: model.validationCount || 0,
      validationHorizons: model.validationHorizons || [],
      model,
      momentum,
      confidence,
      annualValidationCount,
      annualMedianAbsoluteError: median(annualErrors.map((row) => Math.abs(row.error))),
      annualValidationRows: annualErrors,
      annualCalibrationReady,
      oneYearErrorBand,
      oneWeekDay,
      baseOneWeekWeight,
      oneWeekWeight,
      oneMonthDay,
      baseOneMonthWeight,
      oneMonthWeight,
      oneYearDay,
      baseOneYearWeight,
      oneYearWeight
    };
  }

  function buildOneYearHistory(inputPoints, currentForecast, currentTime) {
    const points = normalizePoints(inputPoints);
    if (!points.length) return [];
    const prepared = prepareCandidateSequences(points);
    const history = points.map((point, index) => {
      const isFinalMeasuredPoint = index === points.length - 1 && currentForecast && currentForecast.anchorDay === point.day;
      const model = selectModelAt(points, prepared, index);
      const oneYearDay = addCalendarMonths(point.day, 12);
      const forecast = isFinalMeasuredPoint ? currentForecast : {
        oneYearDay,
        oneYearWeight: projectWithMomentum(points, index, model, oneYearDay),
        method: model.method,
        annualCalibrationReady: false
      };
      return {
        time: point.time,
        day: point.day,
        weight: forecast.oneYearWeight,
        projectedDay: forecast.oneYearDay,
        method: forecast.method,
        annualCalibrated: forecast.annualCalibrationReady,
        isCurrent: isFinalMeasuredPoint
      };
    });

    const now = Number(currentTime);
    const nowDay = calendarDay(now);
    if (currentForecast && Number.isFinite(nowDay) && nowDay > points[points.length - 1].day) {
      history.push({
        time: now,
        day: nowDay,
        weight: currentForecast.oneYearWeight,
        projectedDay: currentForecast.oneYearDay,
        method: currentForecast.method,
        annualCalibrated: currentForecast.annualCalibrationReady,
        isCurrent: true
      });
    } else if (currentForecast && history.length) {
      history[history.length - 1].weight = currentForecast.oneYearWeight;
      history[history.length - 1].projectedDay = currentForecast.oneYearDay;
      history[history.length - 1].method = currentForecast.method;
      history[history.length - 1].annualCalibrated = currentForecast.annualCalibrationReady;
      history[history.length - 1].isCurrent = true;
    }
    return history;
  }

  return {
    DAY_MS,
    addCalendarMonths,
    buildOneYearHistory,
    calculateForecast,
    calendarDay,
    dampedSteps,
    normalizePoints,
    momentumDiagnostics,
    projectModel
  };
});
