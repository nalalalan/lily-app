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

const lilyThroughJul19 = [
  ["2026-06-26", 149.4], ["2026-06-28", 148.5], ["2026-06-29", 147.4],
  ["2026-06-30", 149], ["2026-07-01", 149.4], ["2026-07-02", 149.4],
  ["2026-07-03", 148.8], ["2026-07-04", 149.9], ["2026-07-06", 150.7],
  ["2026-07-07", 149], ["2026-07-08", 147.5], ["2026-07-10", 150.3],
  ["2026-07-11", 150.5], ["2026-07-12", 149.9], ["2026-07-13", 150],
  ["2026-07-14", 147.7], ["2026-07-15", 149.4], ["2026-07-16", 150.3],
  ["2026-07-17", 149.9], ["2026-07-18", 149.4], ["2026-07-19", 148.5]
].map(([date, weight]) => point(date, weight));
const asOfDay = forecast.calendarDay(new Date("2026-07-20T12:00:00-04:00").getTime());
const lilyForecast = forecast.calculateForecast(lilyThroughJul19, { asOfDay });
const lilyRead = coach.analyze(lilyThroughJul19, lilyForecast);
const lilyCopy = coach.compose(lilyRead);

assert.equal(lilyRead.state, "accelerating-loss", "Lily's current run must trigger the strongest celebration state");
assert.equal(lilyRead.transitionCount, 3, "four lower weigh-ins contain exactly three downward transitions");
assert.equal(lilyRead.weighInCount, 4, "the copy must count the four lower weigh-ins correctly");
assert.ok(Math.abs(lilyRead.totalChange + 1.8) < 1e-9, "the current run must report the exact 1.8 lb change");
assert.deepEqual(lilyRead.streakChanges.map((value) => Number(value.toFixed(1))), [-0.4, -0.5, -0.9]);
assert.equal(lilyRead.movementGrowing, true, "each current drop is larger than the prior drop");
assert.match(lilyCopy, /FOUR LOWER WEIGH-INS IN A ROW/);
assert.match(lilyCopy, /150\.3 → 148\.5 lb in three days/);
assert.match(lilyCopy, /!{3}/);
assert.equal(coach.buildCoachRead(lilyThroughJul19, lilyForecast), lilyCopy, "the same saved data must produce stable copy on refresh");

const nextPoints = lilyThroughJul19.concat(point("2026-07-20", 147.8));
const nextForecast = forecast.calculateForecast(nextPoints);
assert.notEqual(coach.buildCoachRead(nextPoints, nextForecast), lilyCopy, "a new dated weigh-in must refresh the sentence structure");

const todayPoints = lilyThroughJul19.concat(point("2026-07-20", 149.9));
const todayForecast = forecast.calculateForecast(todayPoints, { asOfDay });
const todayRead = coach.analyze(todayPoints, todayForecast);
const todayCopy = coach.compose(todayRead);
const todayVerdict = coach.verdict(todayRead);
const todayDetail = coach.composeDetail(todayRead);
assert.equal(todayRead.state, "turning-gain", "today's 1.4 lb rise must use the fired-up reversal state");
assert.equal(todayRead.previousDirection, -1, "today's read must remember the downward run it interrupted");
assert.equal(todayRead.previousTransitionCount, 3, "today followed four consecutive lower weigh-ins");
assert.equal(Number(todayRead.previousTotalMovement.toFixed(1)), 1.8, "the prior four-weigh-in run was 1.8 lb down");
assert.equal(todayVerdict, "I DON’T LIKE THIS WEIGH-IN—IT WENT THE WRONG WAY!!!");
assert.equal(coach.verdictTone(todayRead), "negative");
assert.ok(todayCopy.startsWith(`${todayVerdict} `), "today's judgment must be the first sentence");
assert.match(todayDetail, /^149\.9 lb is up 1\.4 lb since Jul 19\./);
assert.match(todayDetail, /four weigh-ins before today dropped 1\.8 lb/i);
assert.match(todayDetail, /1-year call still points to 141 lb/i);
assert.match(todayDetail, /today does NOT get a win/);
assert.match(todayCopy, /!{3}/);
assert.doesNotMatch(todayCopy, /bump|warning shot|not a verdict|next 24 hours/i);

const acceleratingGain = [
  point("2026-08-01", 150),
  point("2026-08-02", 150.4),
  point("2026-08-03", 150.9),
  point("2026-08-04", 151.8)
];
const gainForecast = forecast.calculateForecast(acceleratingGain);
const gainRead = coach.analyze(acceleratingGain, gainForecast);
assert.equal(gainRead.state, "accelerating-gain");
assert.match(coach.compose(gainRead), /!{3}/);

const flatPoints = dailySeries("2026-09-01", 8, () => 150);
const flatRead = coach.analyze(flatPoints, forecast.calculateForecast(flatPoints));
assert.equal(flatRead.state, "flat-noisy");

const isolatedSpike = dailySeries("2026-10-01", 8, (index) => index === 7 ? 170 : 150);
const spikeForecast = forecast.calculateForecast(isolatedSpike);
const spikeRead = coach.analyze(isolatedSpike, spikeForecast);
assert.ok(!["accelerating-gain", "steady-gain"].includes(spikeRead.state), "one outlier cannot be called a sustained upward run");
assert.equal(spikeForecast.momentum.strong, false, "one implausibly large jump cannot activate amplified momentum");
assert.equal(spikeRead.isOutlier, true, "an implausibly large one-day change must use the confirmation path");
assert.equal(coach.verdict(spikeRead), "THIS NUMBER IS TOO EXTREME TO JUDGE YET—CONFIRM IT!!!");
assert.equal(coach.verdictTone(spikeRead), "neutral");
assert.match(coach.composeDetail(spikeRead), /confirm|verify|check/i);

const stateFixtures = [
  {
    expected: "accelerating-loss",
    points: [point("2026-08-01", 150), point("2026-08-02", 149.7), point("2026-08-03", 149.2), point("2026-08-04", 148.3)]
  },
  {
    expected: "steady-loss",
    points: [point("2026-08-01", 150), point("2026-08-02", 149.6), point("2026-08-03", 149.2), point("2026-08-04", 148.8)]
  },
  {
    expected: "turning-loss",
    points: [point("2026-08-01", 149), point("2026-08-02", 149.4), point("2026-08-03", 149.9), point("2026-08-04", 149.2)]
  },
  { expected: "accelerating-gain", points: acceleratingGain },
  {
    expected: "steady-gain",
    points: [point("2026-08-01", 150), point("2026-08-02", 150.4), point("2026-08-03", 150.8), point("2026-08-04", 151.2)]
  },
  { expected: "turning-gain", points: todayPoints },
  { expected: "flat-noisy", points: flatPoints }
];

const allCopies = [];
for (const fixture of stateFixtures) {
  const read = coach.analyze(fixture.points, forecast.calculateForecast(fixture.points));
  assert.equal(read.state, fixture.expected, `${fixture.expected} fixture must reach the intended state`);
  const copies = Array.from({ length: 6 }, (_, seed) => coach.compose({ ...read, seed }));
  assert.equal(new Set(copies).size, 6, `${fixture.expected} must have six genuinely different responses`);
  for (const [seed, copy] of copies.entries()) {
    const label = `${fixture.expected}/${seed}`;
    const seededRead = { ...read, seed };
    const verdict = coach.verdict(seededRead);
    const detail = coach.composeDetail(seededRead);
    assert.equal(verdict, coach.STATE_VERDICTS[fixture.expected], `${label} must use the state's fixed verdict`);
    assert.ok(copy.startsWith(`${verdict} `), `${label} must put judgment before hype and context`);
    assert.doesNotMatch(verdict, /1-year|forecast|weigh-ins before|previous run/i, `${label} verdict must stay focused on the current result`);
    assert.ok(detail.includes(Number(read.latestWeight.toFixed(1)).toString()), `${label} detail must name the actual latest weight`);
    assert.match(copy, /!{3}/, `${label} needs unmistakable hype`);
    assert.match(
      copy,
      /(attack|answer|break|bring|charge|chase|choose|collect|control|drive|earn|fight|flip|force|get a walk|go|grab|hold|hunt|keep|lock|make|move|nail|own|pick|plan|press|protect|repeat|reset|stack|stay|take|tighten|win)/i,
      `${label} must carry an active next move`
    );
    assert.doesNotMatch(copy, /bump|warning shot|not a verdict|no panic|no shrug|no shame|no drama|no honest streak|scale noise|undecided/i, `${label} must not fall back to de-escalating copy`);
    assert.doesNotMatch(copy, /obese|unhealthy|worth|lazy|failure|starv|punish|crash diet/i, `${label} must stay non-shaming and non-diagnostic`);
    assert.ok(copy.length < 360, `${label} must stay screenshot-friendly`);
  }
  if (["accelerating-loss", "steady-loss", "turning-loss"].includes(fixture.expected)) {
    assert.match(coach.verdict(read), /LOVE|GOOD|LIKE/, `${fixture.expected} must explicitly approve the result`);
    assert.equal(coach.verdictTone(read), "positive");
  } else if (["accelerating-gain", "steady-gain", "turning-gain"].includes(fixture.expected)) {
    assert.match(coach.verdict(read), /DON’T LIKE|GETTING WORSE/, `${fixture.expected} must explicitly disapprove the result`);
    assert.doesNotMatch(coach.verdict(read), /\bGOOD\b|GREAT|AWESOME|PERFECT|\bYES\b|\bWIN\b/, `${fixture.expected} verdict cannot sound approving`);
    assert.equal(coach.verdictTone(read), "negative");
  } else {
    assert.match(coach.verdict(read), /NOT SATISFIED/, "flat/noisy must plainly withhold approval");
    assert.equal(coach.verdictTone(read), "neutral");
  }
  allCopies.push(...copies);
}
assert.equal(new Set(allCopies).size, 42, "all seven states and six variants must remain distinct");

const firstRead = coach.analyze([point("2026-11-01", 150)], forecast.calculateForecast([point("2026-11-01", 150)]));
assert.equal(coach.verdict(firstRead), "TOO EARLY TO JUDGE—FIRST NUMBER LOGGED, NOW LET’S BUILD THE TREND!!!");
assert.match(coach.verdict(firstRead), /TOO EARLY TO JUDGE/, "the first weigh-in must explicitly hold judgment");
assert.equal(coach.verdictTone(firstRead), "ready");
assert.match(coach.composeDetail(firstRead), /^150 lb is the starting line\./);
assert.match(coach.compose(null), /^READY FOR THE FIRST WEIGH-IN!!!/);
assert.match(coach.compose(null), /!{3}/, "even the empty coach invitation must carry hype");

console.log("weight coach tests passed");
