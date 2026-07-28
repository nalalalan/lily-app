const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

process.env.NODE_ENV = "test";
process.env.LILY_TRACKER_TIME_ZONE = "America/New_York";
process.env.LILY_PIN = "tracker-test-pin";
process.env.SESSION_SECRET = "tracker-test-session-secret";
process.env.DATA_DIR = path.join(os.tmpdir(), `lily-tracker-${process.pid}-${Date.now()}`);

const tracker = require("../server.js");

function period(overrides = {}) {
  return {
    id: "period-jul-3",
    type: "period",
    dateKey: "2026-07-03",
    periodEndDateKey: "2026-07-07",
    reportedHighDesireDateKey: "2026-07-15",
    createdAt: "2026-07-12T18:06:46.637Z",
    updatedAt: "2026-07-12T18:22:04.020Z",
    ...overrides
  };
}

function summary(events, iso) {
  return tracker.publicTrackerSummary(events, Date.parse(iso));
}

const original = summary([period()], "2026-07-27T16:00:00-04:00");
assert.equal(original.nextPeriodDateKey, "2026-07-31");
assert.equal(original.daysUntilNextPeriod, 4);
assert.equal(original.nextHighDesireDateKey, "2026-08-12");
assert.equal(original.daysUntilNextHighDesire, 16);

const correction = period({
  reportedNextPeriodDateKey: "2026-07-29",
  reportedNextHighDesireDateKey: "2026-08-11",
  updatedAt: "2026-07-27T20:00:00.000Z"
});
const corrected = summary([correction], "2026-07-27T16:00:00-04:00");
assert.equal(corrected.periodCount, 1, "a reported forecast cannot become an actual period event");
assert.equal(corrected.nextPeriodDateKey, "2026-07-29");
assert.equal(corrected.daysUntilNextPeriod, 2);
assert.equal(corrected.nextHighDesireDateKey, "2026-08-11");
assert.equal(corrected.daysUntilNextHighDesire, 15);
assert.equal(corrected.highDesireOffsetDays, 13, "the new high-desire offset is independent of the prior cycle's 12-day offset");
assert.equal(corrected.periodCycleDays, 26);
assert.equal(corrected.periodCycleBasis, "reported upcoming period date");
assert.equal(corrected.reportedHighDesireDateKey, "2026-07-15", "the historical Jul 15 report must remain intact");
assert.equal(corrected.reportedNextPeriodDateKey, "2026-07-29");
assert.equal(corrected.reportedNextHighDesireDateKey, "2026-08-11");

const due = summary([correction], "2026-07-29T12:00:00-04:00");
assert.equal(due.daysUntilNextPeriod, 0);
assert.equal(due.daysUntilNextHighDesire, 13);

const overdue = summary([correction], "2026-07-30T12:00:00-04:00");
assert.equal(overdue.nextPeriodDateKey, "2026-07-29", "a missed estimate must not fabricate or roll an actual period");
assert.equal(overdue.daysUntilNextPeriod, 0);
assert.equal(overdue.periodOverdueDays, 1);

const highestDay = summary([correction], "2026-08-11T12:00:00-04:00");
assert.equal(highestDay.nextHighDesireDateKey, "2026-08-11");
assert.equal(highestDay.daysUntilNextHighDesire, 0);

const rolledHigh = summary([correction], "2026-08-12T12:00:00-04:00");
assert.equal(rolledHigh.nextHighDesireDateKey, "2026-09-06");
assert.equal(rolledHigh.daysUntilNextHighDesire, 25);
assert.equal(rolledHigh.reportedNextHighDesireDateKey, "", "a past absolute report must not remain labelled as upcoming");

const actualJul29 = period({
  id: "period-jul-29",
  dateKey: "2026-07-29",
  periodEndDateKey: "",
  reportedHighDesireDateKey: "",
  reportedNextPeriodDateKey: "",
  reportedNextHighDesireDateKey: "",
  createdAt: "2026-07-29T12:00:00.000Z",
  updatedAt: "2026-07-29T12:00:00.000Z"
});
const confirmed = summary([actualJul29, correction], "2026-07-29T12:00:00-04:00");
assert.equal(confirmed.periodCount, 2);
assert.equal(confirmed.periodCycleDays, 26);
assert.match(confirmed.periodCycleBasis, /median interval/);
assert.equal(confirmed.nextPeriodDateKey, "2026-08-24");
assert.equal(confirmed.nextHighDesireDateKey, "2026-08-11");
assert.equal(confirmed.reportedNextPeriodDateKey, "", "a reported start must stop displaying once the matching actual start is saved");

const actualJul28 = { ...actualJul29, id: "period-jul-28", dateKey: "2026-07-28" };
const earlyActual = summary([actualJul28, correction], "2026-07-28T12:00:00-04:00");
assert.equal(earlyActual.latestPeriodDateKey, "2026-07-28");
assert.equal(earlyActual.reportedNextPeriodDateKey, "", "any newer actual period supersedes the originating report, even when it starts early");
assert.equal(earlyActual.nextPeriodDateKey, "2026-08-22");
assert.equal(earlyActual.periodCycleDays, 25);
assert.equal(earlyActual.highDesireOffsetDays, 14);
assert.equal(earlyActual.nextHighDesireDateKey, "2026-08-11");

const actualJul30 = { ...actualJul29, id: "period-jul-30", dateKey: "2026-07-30" };
const lateActual = summary([actualJul30, correction], "2026-07-30T12:00:00-04:00");
assert.equal(lateActual.reportedNextPeriodDateKey, "", "a late actual period also supersedes the originating report");
assert.equal(lateActual.nextPeriodDateKey, "2026-08-26");
assert.equal(lateActual.periodCycleDays, 27);
assert.equal(lateActual.highDesireOffsetDays, 12, "the exact high-desire report re-anchors to the actual cycle start");
const lateActualRolled = summary([actualJul30, correction], "2026-08-12T12:00:00-04:00");
assert.equal(lateActualRolled.nextHighDesireDateKey, "2026-09-07");
assert.equal(lateActualRolled.daysUntilNextHighDesire, 26);

const actualAug24 = { ...actualJul29, id: "period-aug-24", dateKey: "2026-08-24" };
const secondCycle = summary([actualAug24, actualJul30, correction], "2026-08-24T12:00:00-04:00");
assert.equal(secondCycle.highDesireOffsetDays, 12, "the first confirmed actual cycle keeps the corrected offset across later periods");
assert.equal(secondCycle.nextHighDesireDateKey, "2026-09-05");
assert.equal(secondCycle.daysUntilNextHighDesire, 12);

const staleEditedReport = period({
  id: "period-jun-07",
  dateKey: "2026-06-07",
  reportedNextPeriodDateKey: "2026-07-05",
  reportedNextHighDesireDateKey: "2026-07-18",
  updatedAt: "2026-07-31T20:00:00.000Z"
});
const newerOriginReport = period({
  id: "period-jul-03-newer-origin",
  reportedNextPeriodDateKey: "2026-07-29",
  reportedNextHighDesireDateKey: "2026-08-11",
  updatedAt: "2026-07-27T20:00:00.000Z"
});
const originOrdered = summary([staleEditedReport, newerOriginReport], "2026-07-27T12:00:00-04:00");
assert.equal(originOrdered.reportedNextPeriodDateKey, "2026-07-29", "newer actual origins outrank later edits to older forecast origins");
assert.equal(originOrdered.reportedNextHighDesireDateKey, "2026-08-11");
const revealedPrior = summary([staleEditedReport], "2026-07-01T12:00:00-04:00");
assert.equal(revealedPrior.reportedNextPeriodDateKey, "2026-07-05", "deleting a newer-origin report deterministically reveals the prior report");

const beforeEasternMidnight = summary([correction], "2026-07-28T03:59:59.000Z");
const afterEasternMidnight = summary([correction], "2026-07-28T04:00:00.000Z");
assert.equal(beforeEasternMidnight.todayDateKey, "2026-07-27");
assert.equal(beforeEasternMidnight.daysUntilNextPeriod, 2);
assert.equal(beforeEasternMidnight.daysUntilNextHighDesire, 15);
assert.equal(afterEasternMidnight.todayDateKey, "2026-07-28");
assert.equal(afterEasternMidnight.daysUntilNextPeriod, 1);
assert.equal(afterEasternMidnight.daysUntilNextHighDesire, 14);

const normalized = tracker.normalizePeriodDetails({
  reportedNextPeriodDateKey: "2026-07-29",
  reportedNextHighDesireDateKey: "2026-08-11"
}, "2026-07-03");
assert.deepEqual(normalized.details.reportedNextPeriodDateKey, "2026-07-29");
assert.deepEqual(normalized.details.reportedNextHighDesireDateKey, "2026-08-11");
assert.match(
  tracker.normalizePeriodDetails({ reportedNextPeriodDateKey: "2026-07-02" }, "2026-07-03").error,
  /after the saved period start/
);
assert.match(
  tracker.normalizePeriodDetails({
    reportedNextPeriodDateKey: "2026-07-29",
    reportedNextHighDesireDateKey: "2026-07-28"
  }, "2026-07-03").error,
  /cannot be before/
);
assert.match(
  tracker.normalizePeriodDetails({ reportedNextHighDesireDateKey: "2026-06-01" }, "2026-07-03").error,
  /after the saved period start/
);
assert.equal(
  tracker.normalizePeriodDetails({ reportedNextHighDesireDateKey: "2026-08-11" }, "2026-07-03").details.reportedNextHighDesireDateKey,
  "2026-08-11",
  "a valid standalone reported high-desire date remains an explicit absolute anchor"
);

async function verifyFutureReportCannotBecomeActualEvent() {
  await tracker.ensureDataDir();
  await new Promise((resolve) => tracker.server.listen(0, "127.0.0.1", resolve));
  try {
    const address = tracker.server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const authResponse = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: process.env.LILY_PIN, remember: false })
    });
    assert.equal(authResponse.status, 200);
    const auth = await authResponse.json();
    const headers = {
      authorization: `Bearer ${auth.token}`,
      "content-type": "application/json"
    };
    const todayKey = tracker.trackerDateKey(Date.now());
    const futureDateKey = tracker.addDaysToDateKey(todayKey, 1);
    const rejected = await fetch(`${base}/api/tracker/period`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dateKey: futureDateKey })
    });
    assert.equal(rejected.status, 400, "a reported future date cannot be posted as an actual period event");
    const afterResponse = await fetch(`${base}/api/tracker`, { headers });
    assert.equal(afterResponse.status, 200);
    const after = await afterResponse.json();
    assert.equal(after.tracker.periodCount, 0);
    assert.equal(after.tracker.events.length, 0, "a rejected future event must not mutate tracker history");
  } finally {
    await new Promise((resolve, reject) => tracker.server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(process.env.DATA_DIR, { recursive: true, force: true });
  }
}

verifyFutureReportCannotBecomeActualEvent()
  .then(() => console.log("tracker forecast checks passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
