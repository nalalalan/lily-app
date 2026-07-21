const API_BASE = "https://lily-api-production.up.railway.app";
const weightForecast = require("../public/weight-forecast.js");

async function main() {
  if (!process.env.LILY_PIN) throw new Error("LILY_PIN is unavailable.");

  const auth = await fetch(`${API_BASE}/api/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: process.env.LILY_PIN })
  });
  if (!auth.ok) throw new Error(`Authentication failed (${auth.status}).`);
  const { token } = await auth.json();

  const response = await fetch(`${API_BASE}/api/weights`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`Weight fetch failed (${response.status}).`);
  const payload = await response.json();
  const rows = (Array.isArray(payload.weights) ? payload.weights : [])
    .map((record) => ({
      createdAt: record.createdAt,
      pounds: String(record.unit || "lb").toLowerCase() === "kg"
        ? Number(record.weight) * 2.2046226218
        : Number(record.weight)
    }))
    .filter((record) => Number.isFinite(record.pounds) && Number.isFinite(Date.parse(record.createdAt)))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const firstTime = rows.length ? Date.parse(rows[0].createdAt) : NaN;
  const latestTime = rows.length ? Date.parse(rows[rows.length - 1].createdAt) : NaN;
  const dailyPoints = weightForecast.normalizePoints(rows.map((record) => ({
    time: Date.parse(record.createdAt),
    weight: record.pounds
  })));
  const current = weightForecast.calculateForecast(dailyPoints, {
    asOfDay: weightForecast.calendarDay(Date.now())
  });
  const trajectory = weightForecast.buildForecastHistory(dailyPoints);
  const history = weightForecast.buildOneYearHistory(dailyPoints, current, Date.now());
  const historyWeights = history.map((point) => point.weight);
  const jumps = history.slice(1).map((point, index) => Math.abs(point.weight - history[index].weight));
  const horizonJumps = Object.fromEntries([
    ["oneWeek", "oneWeekWeight"],
    ["oneMonth", "oneMonthWeight"],
    ["oneYear", "oneYearWeight"]
  ].map(([label, key]) => [
    label,
    Math.max(0, ...trajectory.slice(1).map((point, index) => Math.abs(point[key] - trajectory[index][key])))
  ]));
  let annualDirectionChanges = 0;
  let priorAnnualDirection = 0;
  trajectory.slice(1).forEach((point, index) => {
    const direction = Math.sign(point.oneYearWeight - trajectory[index].oneYearWeight);
    if (direction && priorAnnualDirection && direction !== priorAnnualDirection) annualDirectionChanges += 1;
    if (direction) priorAnnualDirection = direction;
  });
  const latestCoach = payload.latestCoach;
  const coachText = String(latestCoach?.text || "").trim();
  const coachWords = coachText.match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu) || [];
  if (!latestCoach || !latestCoach.weightId || !latestCoach.createdAt || !coachText) {
    throw new Error("Live API did not return a persisted latestCoach payload.");
  }
  if (coachWords.length < 35 || coachWords.length > 55 || /[\r\n]/.test(coachText)) {
    throw new Error(`Live coach paragraph failed its one-paragraph word-count gate: ${coachWords.length}`);
  }
  if (/goal|target weight|jyp|idol|obese|fasting|skip(?:ping)? meals?|punish|compensat|diagnos|[âÃÂ�]/i.test(coachText)) {
    throw new Error("Live coach paragraph failed its privacy, safety, or encoding gate.");
  }
  if (rows.length && !coachText.includes(`${rows.at(-1).pounds} lb`)) {
    throw new Error("Live coach paragraph does not contain the latest measured weight.");
  }
  if (current && !coachText.includes(`about ${Math.round(current.oneYearWeight)} lb`)) {
    throw new Error("Live coach paragraph does not match the current rounded trend outlook.");
  }
  console.log(JSON.stringify({
    count: rows.length,
    distinctDates: new Set(rows.map((record) => record.createdAt.slice(0, 10))).size,
    spanDays: Number.isFinite(firstTime) && Number.isFinite(latestTime)
      ? Math.round(((latestTime - firstTime) / 86400000) * 100) / 100
      : 0,
    forecast: current ? {
      method: current.method,
      modelSelection: current.selection,
      confidence: current.confidence,
      availableHorizonValidationCount: current.validationCount,
      availableHorizonDays: current.validationHorizons,
      annualValidationCount: current.annualValidationCount,
      annualCalibrationReady: current.annualCalibrationReady,
      oneYearErrorBand: current.oneYearErrorBand,
      ensembleMembers: Array.isArray(current.model?.members)
        ? current.model.members.map((member) => ({
          id: member.id,
          score: Math.round(member.score * 100) / 100,
          weight: Math.round(member.weight * 1000) / 1000
        }))
        : [],
      oneWeekPounds: Math.round(current.oneWeekWeight * 10) / 10,
      oneMonthPounds: Math.round(current.oneMonthWeight * 10) / 10,
      oneYearPounds: Math.round(current.oneYearWeight * 10) / 10,
      rawOneWeekPounds: Math.round(current.rawOneWeekWeight * 10) / 10,
      rawOneMonthPounds: Math.round(current.rawOneMonthWeight * 10) / 10,
      rawOneYearPounds: Math.round(current.rawOneYearWeight * 10) / 10,
      causalOneYearOutlookTargetPounds: Math.round(current.causalOneYearOutlookTarget * 10) / 10,
      ensembleWalkForwardMae: Number.isFinite(current.backtestMae)
        ? Math.round(current.backtestMae * 100) / 100
        : null,
      historyMinPounds: Math.round(Math.min(...historyWeights) * 10) / 10,
      historyMaxPounds: Math.round(Math.max(...historyWeights) * 10) / 10,
      historyMaxJumpPounds: Math.round(Math.max(0, ...jumps) * 10) / 10,
      historyMaxJumpByHorizon: Object.fromEntries(Object.entries(horizonJumps).map(([key, value]) => [key, Math.round(value * 10) / 10])),
      historyAnnualDirectionChanges: annualDirectionChanges,
      currentMatchesHistory: history.at(-1)?.weight === current.oneYearWeight
    } : null,
    latestCoach: {
      weightId: latestCoach.weightId,
      createdAt: latestCoach.createdAt,
      words: coachWords.length,
      text: coachText,
      persistedParagraphGatePassed: true
    },
    rows: rows.map((record) => ({
      date: record.createdAt.slice(0, 10),
      pounds: Math.round(record.pounds * 10) / 10
    }))
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
