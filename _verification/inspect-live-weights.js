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
  const history = weightForecast.buildOneYearHistory(dailyPoints, current, Date.now());
  const historyWeights = history.map((point) => point.weight);
  const jumps = history.slice(1).map((point, index) => Math.abs(point.weight - history[index].weight));
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
      ensembleWalkForwardMae: Number.isFinite(current.backtestMae)
        ? Math.round(current.backtestMae * 100) / 100
        : null,
      historyMinPounds: Math.round(Math.min(...historyWeights) * 10) / 10,
      historyMaxPounds: Math.round(Math.max(...historyWeights) * 10) / 10,
      historyMaxJumpPounds: Math.round(Math.max(0, ...jumps) * 10) / 10,
      currentMatchesHistory: history.at(-1)?.weight === current.oneYearWeight
    } : null,
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
