(function attachLilyWeightForecast(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LilyWeightForecast = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createLilyWeightForecast() {
  "use strict";

  const DAY_MS = 24 * 60 * 60 * 1000;
  const MIN_DAMPED_MODEL_POINTS = 7;
  const MIN_DAMPED_MODEL_SPAN_DAYS = 14;
  const DAMPED_MODEL_IMPROVEMENT = 0.9;
  const HUBER_LIMIT = 2.5;
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
    const limit = HUBER_LIMIT * robustScale(priorErrors);
    return Math.max(-limit, Math.min(limit, error));
  }

  function scoredMedian(errors) {
    if (!errors.length) return NaN;
    const warmup = Math.min(2, Math.max(0, errors.length - 1));
    return median(errors.slice(warmup).map(Math.abs));
  }

  function fitDampedModel(points, parameters) {
    let level = points[0].weight;
    let trend = 0;
    let previousDay = points[0].day;
    const errors = [];

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
    }

    return {
      method: "damped",
      level,
      trend,
      day: points[points.length - 1].day,
      alpha: parameters.alpha,
      beta: parameters.beta,
      phi: parameters.phi,
      backtestMae: scoredMedian(errors)
    };
  }

  function fitPersistenceModel(points) {
    const errors = [];
    for (let index = 1; index < points.length; index += 1) {
      const priorWeights = points
        .slice(Math.max(0, index - 3), index)
        .map((point) => point.weight);
      errors.push(points[index].weight - median(priorWeights));
    }
    return {
      method: "persistence",
      level: median(points.slice(-3).map((point) => point.weight)),
      trend: 0,
      day: points[points.length - 1].day,
      phi: 0,
      backtestMae: scoredMedian(errors)
    };
  }

  function selectModel(points) {
    const persistence = fitPersistenceModel(points);
    const spanDays = points[points.length - 1].day - points[0].day;
    if (points.length < MIN_DAMPED_MODEL_POINTS || spanDays < MIN_DAMPED_MODEL_SPAN_DAYS) {
      return { ...persistence, selection: "short-history" };
    }

    const candidates = PARAMETER_GRID
      .map((parameters) => fitDampedModel(points, parameters))
      .filter((model) => Number.isFinite(model.backtestMae))
      .sort((a, b) => a.backtestMae - b.backtestMae || a.phi - b.phi || a.alpha - b.alpha || a.beta - b.beta);
    const best = candidates[0];
    const persistenceMae = persistence.backtestMae;
    if (
      best &&
      Number.isFinite(persistenceMae) &&
      persistenceMae > 0 &&
      best.backtestMae <= persistenceMae * DAMPED_MODEL_IMPROVEMENT
    ) {
      return { ...best, selection: "rolling-backtest" };
    }
    return { ...persistence, selection: "rolling-backtest" };
  }

  function projectModel(model, targetDay) {
    if (!model || !Number.isFinite(model.level) || !Number.isFinite(targetDay)) return NaN;
    const horizonDays = Math.max(0, targetDay - model.day);
    const raw = model.method === "damped"
      ? model.level + model.trend * dampedSteps(model.phi, horizonDays)
      : model.level;
    return Number.isFinite(raw) ? Math.max(0.1, raw) : NaN;
  }

  function calculateForecast(inputPoints, options) {
    const points = normalizePoints(inputPoints);
    if (!points.length) return null;
    const model = selectModel(points);
    const requestedDay = Number(options && options.asOfDay);
    const anchorDay = Number.isFinite(requestedDay)
      ? Math.max(points[points.length - 1].day, Math.round(requestedDay))
      : points[points.length - 1].day;
    const oneWeekDay = anchorDay + 7;
    const oneMonthDay = addCalendarMonths(anchorDay, 1);
    const oneYearDay = addCalendarMonths(anchorDay, 12);
    const spanDays = points[points.length - 1].day - points[0].day;

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
      model,
      oneWeekDay,
      oneWeekWeight: projectModel(model, oneWeekDay),
      oneMonthDay,
      oneMonthWeight: projectModel(model, oneMonthDay),
      oneYearDay,
      oneYearWeight: projectModel(model, oneYearDay)
    };
  }

  function buildOneYearHistory(inputPoints, currentForecast, currentTime) {
    const points = normalizePoints(inputPoints);
    if (!points.length) return [];
    const history = points.map((point, index) => {
      const isFinalMeasuredPoint = index === points.length - 1 && currentForecast && currentForecast.anchorDay === point.day;
      const forecast = isFinalMeasuredPoint
        ? currentForecast
        : calculateForecast(points.slice(0, index + 1));
      return {
        time: point.time,
        day: point.day,
        weight: forecast.oneYearWeight,
        projectedDay: forecast.oneYearDay,
        method: forecast.method,
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
        isCurrent: true
      });
    } else if (currentForecast && history.length) {
      history[history.length - 1].weight = currentForecast.oneYearWeight;
      history[history.length - 1].projectedDay = currentForecast.oneYearDay;
      history[history.length - 1].method = currentForecast.method;
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
    projectModel
  };
});
