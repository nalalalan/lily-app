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

const acceleratingLoss = [
  point("2026-08-01", 150),
  point("2026-08-02", 149.7),
  point("2026-08-03", 149.2),
  point("2026-08-04", 148.3)
];
const steadyLoss = [
  point("2026-08-01", 150),
  point("2026-08-02", 149.6),
  point("2026-08-03", 149.2),
  point("2026-08-04", 148.8)
];
const turningLoss = [
  point("2026-08-01", 149),
  point("2026-08-02", 149.4),
  point("2026-08-03", 149.9),
  point("2026-08-04", 149.2)
];
const acceleratingGain = [
  point("2026-08-01", 150),
  point("2026-08-02", 150.4),
  point("2026-08-03", 150.9),
  point("2026-08-04", 151.8)
];
const steadyGain = [
  point("2026-08-01", 150),
  point("2026-08-02", 150.4),
  point("2026-08-03", 150.8),
  point("2026-08-04", 151.2)
];
const turningGain = [
  point("2026-08-01", 150),
  point("2026-08-02", 149.6),
  point("2026-08-03", 149.1),
  point("2026-08-04", 150.2)
];
const flatNoisy = dailySeries("2026-09-01", 8, () => 150);

const fixtures = [
  ["accelerating-loss", acceleratingLoss, "positive"],
  ["steady-loss", steadyLoss, "positive"],
  ["turning-loss", turningLoss, "positive"],
  ["accelerating-gain", acceleratingGain, "negative"],
  ["steady-gain", steadyGain, "negative"],
  ["turning-gain", turningGain, "negative"],
  ["flat-noisy", flatNoisy, "neutral"]
];

const banned = /\b(?:not good enough|red alert|warning|wake-up call|trend alarm|fight|attack|hunt|earn|prove|clap back|lock in|no excuses?|failure|lazy|shame|guilt|depress\w*|anxious|anxiety|rejection sensitivity|dysphoria|diagnos\w*|fasting|skip(?:ping)? meals?)\b/i;
const allCopies = [];

for (const [expectedState, points, expectedTone] of fixtures) {
  const read = coach.analyze(points, forecast.calculateForecast(points));
  assert.equal(read.state, expectedState, `${expectedState} fixture reaches its state`);
  assert.equal(coach.verdictTone(read), expectedTone, `${expectedState} keeps an unmistakable data verdict`);
  const copies = Array.from({ length: 6 }, (_, seed) => coach.compose({ ...read, seed }));
  assert.equal(new Set(copies).size, 6, `${expectedState} retains six distinct supportive reads`);
  for (const copy of copies) {
    assert(copy.startsWith(`${coach.STATE_VERDICTS[expectedState]} `), `${expectedState} puts the verdict first`);
    assert(copy.includes(`${Number(read.latestWeight.toFixed(1))}`), `${expectedState} names the measured weight`);
    assert.doesNotMatch(copy, banned, `${expectedState} avoids rejection, alarm, coercion, diagnoses, and unsafe weight-loss language`);
    assert.doesNotMatch(copy, /!{2,}/, `${expectedState} avoids exclamation overload`);
    assert.doesNotMatch(copy, /\b[A-Z]{4,}\b/, `${expectedState} avoids all-caps pressure`);
    assert.match(copy, /not a judgment|does not define|cannot define|not identity|can|possible|progress|win|encouraging|proud|enjoy|room|open|context/i, `${expectedState} preserves agency and hope`);
    assert(copy.length < 420, `${expectedState} stays screenshot-friendly`);
  }
  allCopies.push(...copies);
}
assert.equal(new Set(allCopies).size, 42, "all state and seed combinations remain distinct");

const stableRead = coach.analyze(acceleratingLoss, forecast.calculateForecast(acceleratingLoss));
assert.equal(
  coach.buildCoachRead(acceleratingLoss, forecast.calculateForecast(acceleratingLoss)),
  coach.compose(stableRead),
  "the same saved data produces stable copy"
);

const first = [point("2026-11-01", 150)];
const firstRead = coach.analyze(first, forecast.calculateForecast(first));
assert.equal(coach.verdict(firstRead), "The baseline is set, with no judgment on day one.");
assert.match(coach.compose(firstRead), /starting point|information, not identity/i);

const isolatedSpike = dailySeries("2026-10-01", 8, (index) => index === 7 ? 170 : 150);
const spikeRead = coach.analyze(isolatedSpike, forecast.calculateForecast(isolatedSpike));
assert.equal(spikeRead.isOutlier, true);
assert.equal(coach.verdict(spikeRead), "This reading needs confirmation before judgment.");
assert.match(coach.compose(spikeRead), /same scale conditions|fair follow-up/i);
assert.doesNotMatch(coach.compose(spikeRead), banned);

assert.match(coach.compose(null), /^The coach is ready for the first weigh-in\./);
assert.doesNotMatch(coach.compose(null), banned);

console.log("weight coach tests passed");
