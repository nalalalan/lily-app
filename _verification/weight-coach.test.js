const assert = require("node:assert/strict");
const forecast = require("../public/weight-forecast.js");
const coach = require("../public/weight-coach.js");

function point(date, weight) {
  const time = new Date(`${date}T12:00:00-04:00`).getTime();
  return { time, day: forecast.calendarDay(time), weight };
}

function dailySeries(startDate, count, weightAt) {
  const start = new Date(`${startDate}T12:00:00-04:00`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start.getTime());
    date.setDate(date.getDate() + index);
    return point(date.toISOString().slice(0, 10), weightAt(index));
  });
}

const lilyPoints = [
  ["2026-06-26", 149.4], ["2026-06-28", 148.5], ["2026-06-29", 147.4],
  ["2026-06-30", 149], ["2026-07-01", 149.4], ["2026-07-02", 149.4],
  ["2026-07-03", 148.8], ["2026-07-04", 149.9], ["2026-07-06", 150.7],
  ["2026-07-07", 149], ["2026-07-08", 147.5], ["2026-07-10", 150.3],
  ["2026-07-11", 150.5], ["2026-07-12", 149.9], ["2026-07-13", 150],
  ["2026-07-14", 147.7], ["2026-07-15", 149.4], ["2026-07-16", 150.3],
  ["2026-07-17", 149.9], ["2026-07-18", 149.4], ["2026-07-19", 148.5]
].map(([date, weight]) => point(date, weight));
const asOfDay = forecast.calendarDay(new Date("2026-07-20T12:00:00-04:00").getTime());
const lilyForecast = forecast.calculateForecast(lilyPoints, { asOfDay });
const lilyRead = coach.analyze(lilyPoints, lilyForecast);
const lilyCopy = coach.compose(lilyRead);

assert.equal(lilyRead.state, "accelerating-loss", "Lily's current run must trigger the strongest celebration state");
assert.equal(lilyRead.transitionCount, 3, "four lower weigh-ins contain exactly three downward transitions");
assert.equal(lilyRead.weighInCount, 4, "the copy must count the four lower weigh-ins correctly");
assert.ok(Math.abs(lilyRead.totalChange + 1.8) < 1e-9, "the current run must report the exact 1.8 lb change");
assert.deepEqual(lilyRead.streakChanges.map((value) => Number(value.toFixed(1))), [-0.4, -0.5, -0.9]);
assert.equal(lilyRead.movementGrowing, true, "each current drop is larger than the prior drop");
assert.match(lilyCopy, /FOUR LOWER WEIGH-INS IN A ROW/);
assert.match(lilyCopy, /150\.3 → 148\.5 lb in three days/);
assert.match(lilyCopy, /WEO+/);
assert.equal(coach.buildCoachRead(lilyPoints, lilyForecast), lilyCopy, "the same saved data must produce stable copy on refresh");

const nextPoints = lilyPoints.concat(point("2026-07-20", 147.8));
const nextForecast = forecast.calculateForecast(nextPoints);
assert.notEqual(coach.buildCoachRead(nextPoints, nextForecast), lilyCopy, "a new dated weigh-in must refresh the sentence structure");

const acceleratingGain = [
  point("2026-08-01", 150),
  point("2026-08-02", 150.4),
  point("2026-08-03", 150.9),
  point("2026-08-04", 151.8)
];
const gainForecast = forecast.calculateForecast(acceleratingGain);
const gainRead = coach.analyze(acceleratingGain, gainForecast);
assert.equal(gainRead.state, "accelerating-gain");
assert.match(coach.compose(gainRead), /(eyes up|response|wrong way|climbing|RED ALERT|upward streak)/i);

const flatPoints = dailySeries("2026-09-01", 8, () => 150);
const flatRead = coach.analyze(flatPoints, forecast.calculateForecast(flatPoints));
assert.equal(flatRead.state, "flat-noisy");

const isolatedSpike = dailySeries("2026-10-01", 8, (index) => index === 7 ? 170 : 150);
const spikeForecast = forecast.calculateForecast(isolatedSpike);
const spikeRead = coach.analyze(isolatedSpike, spikeForecast);
assert.ok(!["accelerating-gain", "steady-gain"].includes(spikeRead.state), "one outlier cannot be called a sustained upward run");
assert.equal(spikeForecast.momentum.strong, false, "one implausibly large jump cannot activate amplified momentum");

for (const copy of [lilyCopy, coach.compose(gainRead), coach.compose(flatRead), coach.compose(spikeRead)]) {
  assert.doesNotMatch(copy, /obese|unhealthy|worth|lazy|failure|starv|punish|crash diet/i);
  assert.ok(copy.length < 360, "coach copy must stay screenshot-friendly");
}

console.log("weight coach tests passed");
