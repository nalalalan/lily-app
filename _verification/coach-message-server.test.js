const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-coach-server-"));
process.env.NODE_ENV = "test";
process.env.DATA_DIR = tempDir;
process.env.LILY_INTERNAL_GOAL_LB = "117";

const coach = require("../server.js");

function response(text) {
  return { ok: true, json: async () => ({ output_text: text }) };
}

function queuedFetch(texts) {
  const queue = texts.slice();
  return async () => response(queue.shift() || "");
}

function fixtureStore() {
  const weights = [
    { id: "weight-1", weight: 151.2, unit: "lb", createdAt: "2026-07-17T12:00:00.000Z", updatedAt: "2026-07-17T12:00:00.000Z" },
    { id: "weight-2", weight: 150.3, unit: "lb", createdAt: "2026-07-18T12:00:00.000Z", updatedAt: "2026-07-18T12:00:00.000Z" },
    { id: "weight-3", weight: 148.5, unit: "lb", createdAt: "2026-07-19T12:00:00.000Z", updatedAt: "2026-07-19T12:00:00.000Z" },
    { id: "weight-4", weight: 149.9, unit: "lb", createdAt: "2026-07-20T12:00:00.000Z", updatedAt: "2026-07-20T12:00:00.000Z" },
    { id: "weight-5", weight: 149.9, unit: "lb", createdAt: "2026-07-21T12:00:00.000Z", updatedAt: "2026-07-21T12:00:00.000Z" }
  ];
  return {
    weights,
    memories: [
      {
        id: "preference-1",
        kind: "note",
        text: "She loves Korean food and said she wants vegetables in every meal.",
        createdAt: "2026-07-01T12:00:00.000Z",
        updatedAt: "2026-07-01T12:00:00.000Z"
      },
      {
        id: "private-contact",
        kind: "contact",
        text: "A private phone number that must never enter coaching.",
        createdAt: "2026-07-01T12:00:00.000Z",
        updatedAt: "2026-07-01T12:00:00.000Z"
      }
    ],
    trackerEvents: [
      {
        id: "period-current",
        type: "period",
        dateKey: "2026-07-21",
        periodEndDateKey: "2026-07-22",
        reportedHighDesireDateKey: "2026-07-29",
        createdAt: "2026-07-21T10:00:00.000Z",
        updatedAt: "2026-07-21T10:00:00.000Z"
      },
      {
        id: "conflict-old",
        type: "conflict",
        dateKey: "2026-07-10",
        createdAt: "2026-07-10T12:00:00.000Z",
        updatedAt: "2026-07-10T12:00:00.000Z"
      }
    ],
    chats: [],
    coachMessages: []
  };
}

async function run() {
  await coach.ensureDataDir();
  await coach.writeStore(() => fixtureStore());
  await coach.backfillCoachMessages();
  await coach.backfillCoachMessages();

  const migrated = await coach.readStore();
  assert.equal(migrated.weights.length, 5, "backfill preserves every weight");
  assert.equal(migrated.memories.length, 2, "backfill preserves memories");
  assert.equal(migrated.trackerEvents.length, 2, "backfill preserves tracker data");
  assert.equal(migrated.coachMessages.length, migrated.weights.length, "idempotent backfill gives every existing weigh-in exactly one persisted fallback");

  const latest = coach.latestCoachPayload(migrated);
  assert.deepEqual(Object.keys(latest).sort(), ["createdAt", "text", "weightId"], "public coach exposes only its approved three fields");
  assert.equal(latest.weightId, "weight-5");
  assert(!JSON.stringify(latest).includes("117"), "private configuration never enters the public coach payload");

  const latestRecord = coach.coachForWeight(migrated, "weight-5");
  for (const key of ["text", "weightId", "verdict", "evidenceReferences", "contextHash", "generationVersion", "modelVersion", "promptVersion", "safetyVersion", "status", "createdAt", "updatedAt"]) {
    assert(Object.prototype.hasOwnProperty.call(latestRecord, key), `private coach record includes ${key}`);
  }
  assert(latestRecord.evidenceReferences.some((reference) => reference.type === "memory" && reference.id === "preference-1"));
  assert(latestRecord.evidenceReferences.some((reference) => reference.type === "tracker" && reference.id === "period-current"));
  assert(!JSON.stringify(latestRecord).toLowerCase().includes("highdesire"), "sexual tracker fields never enter coach records");
  assert(!JSON.stringify(latestRecord).includes("2026-07-29"), "sexual tracker dates never enter coach records");

  const context = coach.buildCoachContext(migrated, "weight-5", { privateGoal: 117 });
  const anotherGoalContext = coach.buildCoachContext(migrated, "weight-5", { privateGoal: 132 });
  assert.deepEqual(context.forecastFingerprint, anotherGoalContext.forecastFingerprint, "private strategy cannot alter forecast history");
  assert.equal(context.outlook, anotherGoalContext.outlook, "private strategy cannot alter the headline outlook");
  assert.notEqual(context.hiddenStrategy, anotherGoalContext.hiddenStrategy, "private configuration may affect only hidden urgency state");
  assert.equal(context.trackerModifier.type, "active-logged-period");
  assert(!JSON.stringify(context.trackerModifier).toLowerCase().includes("desire"));

  const baselineStore = {
    weights: [migrated.weights[0]],
    memories: [],
    trackerEvents: [],
    chats: [],
    coachMessages: []
  };
  const baselineContext = coach.buildCoachContext(baselineStore, "weight-1", { privateGoal: 117 });
  assert.equal(baselineContext.outlookDirection, "held", "the first weigh-in has no prior outlook to worsen from");
  const baselineFallback = coach.buildContextualFallback(baselineContext);
  const baselineValidation = coach.validateCoachParagraph(baselineFallback, baselineContext, [], { privateGoal: 117 });
  assert.equal(baselineValidation.ok, true, `baseline fallback must validate: ${baselineValidation.errors.join(", ")}`);

  const dislikedPreferenceStore = {
    ...baselineStore,
    memories: [{
      id: "negative-preference",
      kind: "note",
      text: "Lily hates Korean food and does not like vegetables.",
      createdAt: "2026-07-01T12:00:00.000Z",
      updatedAt: "2026-07-01T12:00:00.000Z"
    }]
  };
  const dislikedContext = coach.buildCoachContext(dislikedPreferenceStore, "weight-1", { privateGoal: 117 });
  assert.equal(dislikedContext.preference, null, "negated food notes must never be rewritten as preferences");

  const mixedConstraintStore = {
    ...baselineStore,
    memories: [{
      id: "mixed-preference",
      kind: "note",
      text: "Lily doesn't like vegetables but wants them in every meal.",
      createdAt: "2026-07-01T12:00:00.000Z",
      updatedAt: "2026-07-01T12:00:00.000Z"
    }]
  };
  const mixedConstraintContext = coach.buildCoachContext(mixedConstraintStore, "weight-1", { privateGoal: 117 });
  assert.equal(mixedConstraintContext.preference?.id, "mixed-preference", "a later explicit want may safely override an earlier dislike in the same saved constraint");
  assert.match(mixedConstraintContext.action, /vegetables you said you want/i);

  const liveWeights = [
    ["2026-06-26", 149.4], ["2026-06-28", 148.5], ["2026-06-29", 147.4],
    ["2026-06-30", 149], ["2026-07-01", 149.4], ["2026-07-02", 149.4],
    ["2026-07-03", 148.8], ["2026-07-04", 149.9], ["2026-07-06", 150.7],
    ["2026-07-07", 149], ["2026-07-08", 147.5], ["2026-07-10", 150.3],
    ["2026-07-11", 150.5], ["2026-07-12", 149.9], ["2026-07-13", 150],
    ["2026-07-14", 147.7], ["2026-07-15", 149.4], ["2026-07-16", 150.3],
    ["2026-07-17", 149.9], ["2026-07-18", 149.4], ["2026-07-19", 148.5],
    ["2026-07-20", 149.9], ["2026-07-21", 149.9]
  ].map(([date, weight], index) => ({
    id: `live-weight-${index}`,
    weight,
    unit: "lb",
    createdAt: `${date}T16:00:00.000Z`,
    updatedAt: `${date}T16:00:00.000Z`
  }));
  const liveStore = {
    weights: liveWeights,
    memories: migrated.memories,
    trackerEvents: migrated.trackerEvents.filter((event) => event.id !== "period-current"),
    chats: [],
    coachMessages: []
  };
  const liveContext = coach.buildCoachContext(liveStore, liveWeights.at(-1).id, { privateGoal: 117 });
  assert.equal(Number(liveContext.previousOutlook.toFixed(1)), 144.7);
  assert.equal(Number(liveContext.outlook.toFixed(1)), 145.4);
  assert.equal(liveContext.outlookDirection, "worsened", "flat July 21 evidence must turn the coach outlook verdict upward");
  const liveFallback = coach.buildContextualFallback(liveContext);
  assert.match(liveFallback, /^NOT GOOD ENOUGH YET/);
  assert.match(liveFallback, /149\.9 lb is unchanged/);
  assert.match(liveFallback, /turned the wrong way to about 145 lb/);

  const fallback = coach.buildContextualFallback(context);
  const fallbackValidation = coach.validateCoachParagraph(fallback, context, [], { privateGoal: 117 });
  assert.equal(fallbackValidation.ok, true, fallbackValidation.errors.join(", "));
  assert(coach.coachWordCount(fallback) >= coach.COACH_MIN_WORDS && coach.coachWordCount(fallback) <= coach.COACH_MAX_WORDS);
  assert.equal((fallback.match(/[\r\n]/g) || []).length, 0, "fallback is exactly one paragraph");
  assert(!/[\u00e2\u00c3\u00c2\ufffd]/.test(fallback), "persisted fallback contains no mojibake");
  assert(!/goal|target weight|jyp|idol/i.test(fallback));
  assert(!/period.{0,30}(?:caused|made|explains)|(?:caused|made|explains).{0,30}period/i.test(fallback));

  const wrongNumber = fallback.replace(`${context.currentWeight} lb`, "999 lb");
  assert(coach.validateCoachParagraph(wrongNumber, context, [], { privateGoal: 117 }).errors.includes("unsupported-number"));
  const leakedGoal = fallback.replace(`about ${Math.round(context.outlook)} lb`, "about 117 lb");
  assert(coach.validateCoachParagraph(leakedGoal, context, [], { privateGoal: 117 }).errors.includes("goal-leak"));
  const leakedStrategy = fallback.replace("TURN THIS LINE AROUND", "SAFETY-HELD—TURN THIS LINE AROUND");
  assert(coach.validateCoachParagraph(leakedStrategy, context, [], { privateGoal: 117 }).errors.includes("private-strategy-leak"));
  const unsafe = fallback.replace(context.action, `${context.action} Fast tomorrow.`);
  assert(coach.validateCoachParagraph(unsafe, context, [], { privateGoal: 117 }).errors.includes("unsafe-language"));
  const privateTrackerLeak = fallback.replace("TURN THIS LINE AROUND", "OVULATION IS COMING—TURN THIS LINE AROUND");
  assert(coach.validateCoachParagraph(privateTrackerLeak, context, [], { privateGoal: 117 }).errors.includes("private-context-leak"));
  const extraAction = fallback.replace(context.action, `${context.action} Plan a walk.`);
  assert(coach.validateCoachParagraph(extraAction, context, [], { privateGoal: 117 }).errors.includes("extra-action"));
  const oppositeVerdict = fallback.replace(/^.*?—/, "AMAZING WORK—THIS IS A WIN—");
  assert(coach.validateCoachParagraph(oppositeVerdict, context, [], { privateGoal: 117 }).errors.includes("verdict"), "deterministic validation must reject approval for a negative verdict");
  assert(coach.validateCoachParagraph(`${fallback}\nSecond paragraph.`, context, [], { privateGoal: 117 }).errors.includes("multiline"));
  assert(coach.validateCoachParagraph(fallback.replace("—", "\u00e2\u20ac\u201d"), context, [], { privateGoal: 117 }).errors.includes("mojibake"));
  assert(coach.validateCoachParagraph(fallback, context, [{ text: fallback }], { privateGoal: 117 }).errors.includes("repetition"));

  const invalidGeneration = await coach.generateCoachParagraph(context, [], {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: queuedFetch([wrongNumber, wrongNumber]),
    timeoutMs: 50
  });
  assert.equal(invalidGeneration.status, "fallback-validation", "unsupported model numbers fall back deterministically");
  assert.equal(invalidGeneration.text, fallback);

  const unsafeGeneration = await coach.generateCoachParagraph(context, [], {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: queuedFetch([unsafe, unsafe]),
    timeoutMs: 50
  });
  assert.equal(unsafeGeneration.status, "fallback-validation", "unsafe model text never persists");

  const criticRejected = await coach.generateCoachParagraph(context, [], {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: queuedFetch([
      fallback,
      JSON.stringify({ approved: false, reason: "too generic" }),
      fallback,
      JSON.stringify({ approved: false, reason: "still too generic" })
    ]),
    timeoutMs: 50
  });
  assert.equal(criticRejected.status, "fallback-validation", "critic rejection triggers the contextual fallback");

  const timeoutGeneration = await coach.generateCoachParagraph(context, [], {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: async () => new Promise(() => {}),
    timeoutMs: 30
  });
  assert.equal(timeoutGeneration.status, "fallback-timeout", "model timeout returns the already-valid fallback");

  await coach.generateAndReplaceCoach("weight-5", {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: queuedFetch([wrongNumber, wrongNumber]),
    timeoutMs: 50
  });
  const fallbackStatusStore = await coach.readStore();
  assert.equal(coach.coachForWeight(fallbackStatusStore, "weight-5").status, "fallback-validation", "fallback rejection status is persisted without replacing its valid paragraph");

  const generated = await coach.generateAndReplaceCoach("weight-5", {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: queuedFetch([fallback, JSON.stringify({ approved: true, reason: "all checks pass" })]),
    timeoutMs: 50
  });
  assert.equal(generated.weightId, "weight-5");
  const generatedStore = await coach.readStore();
  assert.equal(coach.coachForWeight(generatedStore, "weight-5").status, "generated-and-critic-approved", "critic-approved draft atomically replaces the fallback");
  assert.equal(generatedStore.coachMessages.filter((message) => message.weightId === "weight-5").length, 1, "replacement does not duplicate the coach record");

  const withoutPreference = { ...generatedStore, memories: generatedStore.memories.filter((memory) => memory.id !== "preference-1") };
  const contextRefreshed = coach.refreshIfLatestCoachReferences(withoutPreference, "memory", "preference-1");
  const refreshedRecord = coach.coachForWeight(contextRefreshed, "weight-5");
  assert.equal(refreshedRecord.status, "fallback-weight-only-context-removed");
  assert(!refreshedRecord.evidenceReferences.some((reference) => reference.type === "memory" || reference.type === "tracker"), "context deletion produces a weight-only latest message");

  const recentConflictStore = coach.addFallbackCoachForWeight({
    ...liveStore,
    memories: [],
    trackerEvents: [{
      id: "conflict-recent",
      type: "conflict",
      dateKey: "2026-07-21",
      createdAt: "2026-07-21T10:00:00.000Z",
      updatedAt: "2026-07-21T10:00:00.000Z"
    }],
    coachMessages: []
  }, liveWeights.at(-1).id, "fallback-contextual", { privateGoal: 117 });
  const recentConflictRecord = coach.coachForWeight(recentConflictStore, liveWeights.at(-1).id);
  assert(recentConflictRecord.evidenceReferences.some((reference) => reference.type === "tracker" && reference.id === "conflict-recent"), "a conflict that changes the action must be an evidence reference");
  const conflictRemoved = coach.refreshIfLatestCoachReferences({ ...recentConflictStore, trackerEvents: [] }, "tracker", "conflict-recent");
  assert.equal(coach.coachForWeight(conflictRemoved, liveWeights.at(-1).id).status, "fallback-weight-only-context-removed", "deleting referenced conflict context must replace the latest message");

  const removedLatest = coach.removeWeightAndCoach(generatedStore, "weight-5");
  assert(!removedLatest.coachMessages.some((message) => message.weightId === "weight-5"), "deleting a weight deletes its attached coach message");
  assert.equal(coach.latestCoachPayload(removedLatest).weightId, "weight-4", "the remaining latest weight receives a recalculated coach");

  await assert.rejects(coach.writeStore(() => { throw new Error("intentional write failure"); }));
  await coach.writeStore((store) => ({ ...store, queueRecovered: true }));
  assert.equal((await coach.readStore()).queueRecovered, true, "a failed store mutation must not poison later writes");

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("coach-message-server verification passed");
}

run().catch((error) => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
