"use strict";

const apiBase = String(process.env.LILY_API_BASE || "https://lily-api-production.up.railway.app").replace(/\/+$/, "");
const pin = String(process.env.LILY_PIN || "");
const expectDetailedBrain = process.env.LILY_EXPECT_DETAILED_BRAIN === "1";

async function readJson(response, stage) {
  if (!response.ok) throw new Error(`${stage} returned ${response.status}`);
  return response.json();
}

async function run() {
  if (!pin) throw new Error("LILY_PIN is required");
  const auth = await readJson(await fetch(`${apiBase}/api/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin })
  }), "auth");
  const weights = await readJson(await fetch(`${apiBase}/api/weights`, {
    headers: { authorization: `Bearer ${auth.token}` }
  }), "weights");
  const reward = weights.bobaReward || null;
  const memo = String(weights.latestCoach?.text || "");
  const checks = {
    latestCoachMatchesLatestWeight: Boolean(weights.weights?.[0]?.id && weights.latestCoach?.weightId === weights.weights[0].id),
    baseline: reward?.baselineAverageLb === 150.3 && reward?.baselineDateKey === "2026-08-08",
    currentAverage: reward?.currentSevenDayAverageLb === 150.3,
    nextThreshold: reward?.nextThresholdLb === 149.3,
    distance: reward?.poundsToNextBobaLb === 1,
    observedWindow: reward?.observedDayCount === 4 && reward?.windowStartDateKey === "2026-08-02" && reward?.windowEndDateKey === "2026-08-08",
    noRewardYet: reward?.earnedCount === 0 && reward?.latestEarnedThreshold === null,
    memoCurrentAverage: /150\.3 lb 7-day average|7-day average[^.]*150\.3 lb/i.test(memo),
    memoNextThreshold: /149\.3 lb/i.test(memo),
    memoDistance: /1\.0 lb/i.test(memo),
    memoBoba: /boba/i.test(memo),
    memoDetailedBrain: memo.includes("The 1x1, 2x2, and 3x3 pressure arrays need to be presented clearly"),
    memoNoSourceWrapper: !/\b(?:Brain|thought|note|source|retriev|remember)\b/i.test(memo),
    memoWordCountSafe: ((memo.match(/[A-Za-z0-9]+(?:[’'][A-Za-z0-9]+)*/g) || []).length <= 80),
    memoExclamationSafe: (memo.match(/!/g) || []).length <= 1
  };
  const required = Object.entries(checks)
    .filter(([name]) => name !== "memoDetailedBrain" || expectDetailedBrain)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  console.log(JSON.stringify({
    ok: required.length === 0,
    checks,
    reward
  }));
  if (required.length) throw new Error(`live boba verification failed: ${required.join(", ")}`);
}

run().catch((error) => {
  console.error(String(error?.message || "live boba verification failed"));
  process.exitCode = 1;
});
