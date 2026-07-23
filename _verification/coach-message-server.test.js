const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-coach-server-"));
process.env.NODE_ENV = "test";
process.env.DATA_DIR = tempDir;
process.env.OPENAI_API_KEY = "";
process.env.LILY_INTERNAL_GOAL_LB = "117";

const coach = require("../server.js");

function response(text) {
  return { ok: true, json: async () => ({ output_text: text }) };
}

function queuedFetch(texts) {
  const queue = texts.slice();
  return async () => response(queue.shift() || "");
}

function criticPayload(approved, selectedIndex = approved ? 0 : -1, reasonCode = approved ? "approved" : "rejected") {
  return JSON.stringify({
    approved,
    selectedIndex,
    reasonCode,
    checks: {
      facts: approved,
      evidence: approved,
      verdict: approved,
      actionCompliance: approved,
      privacySafety: approved,
      originality: approved
    }
  });
}

function recordWeight(id, date, weight, timestampSuffix = "T16:00:00.000Z") {
  const createdAt = `${date}${timestampSuffix}`;
  return { id, weight, unit: "lb", createdAt, updatedAt: createdAt };
}

function liveWeights(idPrefix = "live-weight-", timestampSuffix = "T16:00:00.000Z") {
  const rows = [
    ["2026-06-26", 149.4], ["2026-06-28", 148.5], ["2026-06-29", 147.4],
    ["2026-06-30", 149], ["2026-07-01", 149.4], ["2026-07-02", 149.4],
    ["2026-07-03", 148.8], ["2026-07-04", 149.9], ["2026-07-06", 150.7],
    ["2026-07-07", 149], ["2026-07-08", 147.5], ["2026-07-10", 150.3],
    ["2026-07-11", 150.5], ["2026-07-12", 149.9], ["2026-07-13", 150],
    ["2026-07-14", 147.7], ["2026-07-15", 149.4], ["2026-07-16", 150.3],
    ["2026-07-17", 149.9], ["2026-07-18", 149.4], ["2026-07-19", 148.5],
    ["2026-07-20", 149.9], ["2026-07-21", 149.9], ["2026-07-22", 151]
  ];
  return rows.map(([date, weight], index) => recordWeight(`${idPrefix}${index}`, date, weight, timestampSuffix));
}

function savedContext() {
  return {
    memories: [
      {
        id: "preference-1",
        kind: "note",
        text: "She loves Korean food and said she wants vegetables in every meal.",
        createdAt: "2026-06-01T12:00:00.000Z",
        updatedAt: "2026-06-01T12:00:00.000Z"
      },
      {
        id: "private-contact",
        kind: "contact",
        text: "A private phone number that must never enter coaching.",
        createdAt: "2026-06-01T12:00:00.000Z",
        updatedAt: "2026-06-01T12:00:00.000Z"
      }
    ],
    trackerEvents: [
      {
        id: "period-july",
        type: "period",
        dateKey: "2026-07-03",
        periodEndDateKey: "2026-07-07",
        reportedHighDesireDateKey: "2026-07-15",
        createdAt: "2026-07-03T10:00:00.000Z",
        updatedAt: "2026-07-03T10:00:00.000Z"
      },
      {
        id: "conflict-july",
        type: "conflict",
        dateKey: "2026-07-10",
        createdAt: "2026-07-10T10:00:00.000Z",
        updatedAt: "2026-07-10T10:00:00.000Z"
      }
    ]
  };
}

function baseStore(weights, context = savedContext()) {
  return {
    weights,
    memories: context.memories || [],
    trackerEvents: context.trackerEvents || [],
    chats: [],
    coachMessages: []
  };
}

function assertParagraph(text, label = "coach paragraph") {
  const words = coach.coachWordCount(text);
  assert(words >= coach.COACH_MIN_WORDS && words <= coach.COACH_MAX_WORDS, `${label} has ${words} words`);
  assert(!/[\r\n]/.test(text), `${label} is one paragraph`);
  assert(!/[\u00e2\u00c3\u00c2\ufffd]/.test(text), `${label} has valid encoding`);
  assert(!/goal|target weight|jyp|idol|obese|fasting|skip(?:ping)? meals?|punish|compensat|diagnos/i.test(text), `${label} stays private and safe`);
}

function addAllFallbacks(store) {
  let next = store;
  const ordered = store.weights.slice().sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || String(left.id).localeCompare(String(right.id)));
  const durations = [];
  for (const weight of ordered) {
    const startedAt = Date.now();
    next = coach.addFallbackCoachForWeight(next, weight.id, "fallback-test");
    durations.push(Date.now() - startedAt);
    const record = coach.coachForWeight(next, weight.id);
    const context = coach.buildCoachContext(next, weight.id, { privateGoal: 117 });
    const previous = coach.causalPreviousCoachMessages(next, weight, 10);
    assertParagraph(record.text, `fallback for ${weight.createdAt}`);
    assert.deepEqual(coach.noveltyErrors(record.text, context, previous), [], `fallback for ${weight.createdAt} passes every originality gate`);
    for (const prior of previous.slice(0, 10)) {
      assert(coach.trigramSimilarity(record.text, prior.text, context) < 0.72, "prior-ten ordered trigram similarity stays below 0.72");
    }
    assert(!previous.slice(0, 6).some((prior) => coach.openingFingerprint(prior.text) === coach.openingFingerprint(record.text)), "opening is new within six");
    assert(!previous.slice(0, 6).some((prior) => coach.closingFingerprint(prior.text) === coach.closingFingerprint(record.text)), "closing is new within six");
    assert(!previous.slice(0, 3).some((prior) => prior.actionSemantic === record.actionSemantic), "action meaning is new within three");
    assert(!previous.slice(0, 3).some((prior) => prior.actionText === record.actionText), "action sentence is new within three");
  }
  return { store: next, durations };
}

async function run() {
  await coach.ensureDataDir();

  const productionWeights = liveWeights();
  const productionStore = baseStore(productionWeights);
  const july22 = coach.buildCoachContext(productionStore, productionWeights.at(-1).id, { privateGoal: 117 });
  assert.equal(july22.currentWeight, 151);
  assert.equal(Number(july22.latestDailyChange.toFixed(1)), 1.1);
  assert.equal(july22.strongestEvidence.kind, "window-acceleration");
  assert.equal(july22.strongestEvidence.windowDays, 3);
  assert.equal(Number(july22.strongestEvidence.movement.toFixed(1)), 2.5);
  assert.equal(Number(july22.strongestEvidence.previousMovement.toFixed(1)), 0.5);
  assert.equal(july22.evidenceRelation.kind, "strengthened");
  assert.equal(Number(july22.outlook.toFixed(3)), 146.177);
  assert.equal(Number(july22.outlookChange.toFixed(2)), 0.75);
  assert.equal(july22.outlookDirection, "worsened");
  assert.equal(july22.includeOutlook, true);
  assert(july22.evidenceReferences.some((reference) => reference.role === "selected-evidence-window" && reference.id === "live-weight-20"), "Jul 19 source evidence is retained for the three-day movement");
  assert(july22.analysisPlan.outlook && july22.analysisPlan.relationToPrior === "strengthened");

  const alternateGoal = coach.buildCoachContext(productionStore, productionWeights.at(-1).id, { privateGoal: 132 });
  assert.deepEqual(july22.forecastFingerprint, alternateGoal.forecastFingerprint, "private strategy cannot alter forecast history");
  assert.equal(july22.outlook, alternateGoal.outlook, "private strategy cannot alter the headline outlook");
  assert.notEqual(july22.hiddenStrategy, alternateGoal.hiddenStrategy, "private configuration is confined to hidden coaching strategy");

  const twoWeightStore = baseStore([
    recordWeight("two-1", "2026-07-21", 150),
    recordWeight("two-2", "2026-07-22", 151)
  ], { memories: [], trackerEvents: [] });
  const twoWeightContext = coach.buildCoachContext(twoWeightStore, "two-2", { privateGoal: 117 });
  assert.equal(twoWeightContext.evidenceRelation.kind, "new", "a missing prior window is new evidence, not an invented zero baseline");
  assert.equal(twoWeightContext.previousStrongestEvidence, null);

  const outlierWeights = [
    recordWeight("out-1", "2026-07-19", 150),
    recordWeight("out-2", "2026-07-20", 150.2),
    recordWeight("out-3", "2026-07-21", 150.1),
    recordWeight("out-4", "2026-07-22", 154)
  ];
  const outlierContext = coach.buildCoachContext(baseStore(outlierWeights, { memories: [], trackerEvents: [] }), "out-4");
  assert.equal(outlierContext.strongestEvidence.kind, "outlier");
  assert.equal(outlierContext.verdict, "verify");

  const reversalWeights = [
    recordWeight("rev-1", "2026-07-19", 151), recordWeight("rev-2", "2026-07-20", 150),
    recordWeight("rev-3", "2026-07-21", 149), recordWeight("rev-4", "2026-07-22", 150)
  ];
  const reversalContext = coach.buildCoachContext(baseStore(reversalWeights, { memories: [], trackerEvents: [] }), "rev-4");
  assert.equal(reversalContext.strongestEvidence.kind, "reversal");
  assert.equal(reversalContext.evidenceRelation.kind, "reversed");
  assert.equal(coach.validateCoachParagraph(coach.buildContextualFallback(reversalContext, []), reversalContext, []).ok, true);

  const noisyWeights = [
    recordWeight("noise-1", "2026-07-18", 150), recordWeight("noise-2", "2026-07-19", 150.1),
    recordWeight("noise-3", "2026-07-20", 149.9), recordWeight("noise-4", "2026-07-21", 150),
    recordWeight("noise-5", "2026-07-22", 150)
  ];
  const noisyContext = coach.buildCoachContext(baseStore(noisyWeights, { memories: [], trackerEvents: [] }), "noise-5");
  assert.equal(noisyContext.changeDirection, "unchanged");
  assert.equal(coach.validateCoachParagraph(coach.buildContextualFallback(noisyContext, []), noisyContext, []).ok, true);

  const fullFallbackRun = addAllFallbacks(productionStore);
  assert.equal(fullFallbackRun.store.coachMessages.length, 24, "the exact live history always has a valid fallback");
  assert(Math.max(...fullFallbackRun.durations) < 1000, "each fallback is ready inside one second locally");
  const finalFallback = coach.coachForWeight(fullFallbackRun.store, productionWeights.at(-1).id);
  assert.match(finalFallback.text, /151 lb/);
  assert.match(finalFallback.text, /3-day/);
  assert.match(finalFallback.text, /up 2\.5 lb/);
  assert.match(finalFallback.text, /accelerat/i);
  assert.match(finalFallback.text, /about 146 lb/);

  const electrolyteReaction = {
    id: "reaction-electrolytes",
    kind: "note",
    text: "she says shes trying to drink more electrolytes",
    createdAt: "2026-07-23T00:32:11.765Z",
    updatedAt: "2026-07-23T00:32:11.765Z"
  };
  const reactionBase = addAllFallbacks(baseStore(productionWeights, { memories: [], trackerEvents: [] })).store;
  const reactionWeight = productionWeights.at(-1);
  const beforeReactionCoach = coach.coachForWeight(reactionBase, reactionWeight.id);
  const priorReactionCoachesBefore = reactionBase.coachMessages.filter((message) => message.weightId !== reactionWeight.id);
  const withReaction = { ...reactionBase, memories: [electrolyteReaction] };
  const measurementOnlyContext = coach.buildCoachContext(withReaction, reactionWeight.id, { privateGoal: 117 });
  assert.equal(measurementOnlyContext.preference, null, "a note saved after the weigh-in cannot silently rewrite its causal context");
  const refreshedReaction = coach.refreshLatestCoachForSavedMemories(
    withReaction,
    [electrolyteReaction.id],
    Date.parse(electrolyteReaction.createdAt),
    "fallback-test-saved-reaction",
    Date.parse(electrolyteReaction.createdAt)
  );
  assert.equal(refreshedReaction.updated, true, "the exact saved electrolyte effort refreshes the latest screenshot coach once");
  const reactionCoach = coach.coachForWeight(refreshedReaction.store, reactionWeight.id);
  assert.equal(reactionCoach.id, beforeReactionCoach.id, "saved-reaction refresh preserves the coach id");
  assert.equal(reactionCoach.createdAt, beforeReactionCoach.createdAt, "saved-reaction refresh preserves coach creation time");
  assert.deepEqual(
    refreshedReaction.store.coachMessages.filter((message) => message.weightId !== reactionWeight.id),
    priorReactionCoachesBefore,
    "saved-reaction refresh leaves every earlier coach record byte-equivalent"
  );
  assert.equal(reactionCoach.actionSemantic, "acknowledged-hydration-effort");
  assert.match(reactionCoach.text, /hydration/i);
  assert.doesNotMatch(reactionCoach.text, /electrolyte/i, "raw saved wording never enters coaching copy");
  assert(reactionCoach.evidenceReferences.some((reference) => reference.type === "memory" && reference.id === electrolyteReaction.id && reference.role === "reported-hydration-effort"));
  const reactionContext = coach.buildCoachContext(refreshedReaction.store, reactionWeight.id, {
    privateGoal: 117,
    personalContextCutoff: Date.parse(electrolyteReaction.createdAt)
  });
  assert.equal(reactionContext.preference.kind, "reported-hydration-effort");
  assert.equal(reactionContext.analysisPlan.savedContext.transient, true);
  assert.equal(reactionContext.verdict, measurementOnlyContext.verdict);
  assert.equal(reactionContext.outlook, measurementOnlyContext.outlook);
  assert.deepEqual(reactionContext.forecastFingerprint, measurementOnlyContext.forecastFingerprint, "saved reactions cannot alter forecasts or chart geometry");
  assert(!JSON.stringify(coach.publicCoachFacts(reactionContext)).includes(electrolyteReaction.text), "raw reaction text never enters writer facts");
  const beforeReactionSnapshot = coach.coachRefreshPreservationSnapshot(withReaction, reactionWeight.id);
  const afterReactionSnapshot = coach.coachRefreshPreservationSnapshot(refreshedReaction.store, reactionWeight.id);
  assert.equal(coach.assertCoachRefreshPreserved(beforeReactionSnapshot, afterReactionSnapshot), true, "the maintenance refresh may change only the selected coach body");
  assert.equal(coach.assertExpectedCoachRefreshState(beforeReactionSnapshot, {
    weights: beforeReactionSnapshot.counts.weights,
    coachMessages: beforeReactionSnapshot.counts.coachMessages,
    memories: beforeReactionSnapshot.counts.memories,
    trackerEvents: beforeReactionSnapshot.counts.trackerEvents
  }, {
    id: beforeReactionSnapshot.targetCoachId,
    createdAt: beforeReactionSnapshot.targetCoachCreatedAt
  }), true, "the maintenance refresh fails closed against an exact live identity and count baseline");
  assert.throws(() => coach.assertCoachRefreshPreserved(
    beforeReactionSnapshot,
    coach.coachRefreshPreservationSnapshot({ ...refreshedReaction.store, weights: refreshedReaction.store.weights.slice(1) }, reactionWeight.id)
  ), /preservation check failed/i, "a concurrent weight change is detected rather than silently accepted");
  assert.throws(() => coach.assertExpectedCoachRefreshState(beforeReactionSnapshot, {
    weights: beforeReactionSnapshot.counts.weights + 1,
    coachMessages: beforeReactionSnapshot.counts.coachMessages,
    memories: beforeReactionSnapshot.counts.memories,
    trackerEvents: beforeReactionSnapshot.counts.trackerEvents
  }, {
    id: beforeReactionSnapshot.targetCoachId,
    createdAt: beforeReactionSnapshot.targetCoachCreatedAt
  }), /state changed/i, "a stale expected count blocks the maintenance refresh before mutation");

  const nextReactionWeight = recordWeight("reaction-next-weight", "2026-07-23", 150.8);
  const afterReactionStore = { ...refreshedReaction.store, weights: [...refreshedReaction.store.weights, nextReactionWeight] };
  const nextReactionContext = coach.buildCoachContext(afterReactionStore, nextReactionWeight.id, {
    privateGoal: 117,
    personalContextCutoff: Date.parse(nextReactionWeight.createdAt)
  });
  assert(!nextReactionContext.evidenceReferences.some((reference) => reference.type === "memory" && reference.id === electrolyteReaction.id), "a transient screenshot reaction is not reused on later weigh-ins");

  const unrelatedReaction = {
    ...electrolyteReaction,
    id: "reaction-unrelated",
    text: "she says she watched a movie",
    createdAt: "2026-07-23T00:33:11.765Z",
    updatedAt: "2026-07-23T00:33:11.765Z"
  };
  assert.equal(coach.refreshLatestCoachForSavedMemories(
    { ...reactionBase, memories: [unrelatedReaction] },
    [unrelatedReaction.id],
    Date.parse(unrelatedReaction.createdAt)
  ).updated, false, "unrelated comments stay saved without being forced into weight coaching");
  const unsafeReaction = {
    ...electrolyteReaction,
    id: "reaction-unsafe",
    text: "she says shes trying to skip meals and drink electrolytes",
    createdAt: "2026-07-23T00:34:11.765Z",
    updatedAt: "2026-07-23T00:34:11.765Z"
  };
  assert.equal(coach.refreshLatestCoachForSavedMemories(
    { ...reactionBase, memories: [unsafeReaction] },
    [unsafeReaction.id],
    Date.parse(unsafeReaction.createdAt)
  ).updated, false, "unsafe saved comments are never turned into coaching actions");
  for (const deniedEffort of [
    "she says she is not trying to drink more water",
    "she said she stopped trying to drink electrolytes",
    "Lily mentioned she cannot keep up the hydration routine"
  ]) {
    assert.equal(coach.reportedCoachEffort(deniedEffort), null, `negated or stopped effort stays excluded: ${deniedEffort}`);
  }
  const staleReaction = {
    ...electrolyteReaction,
    id: "reaction-stale",
    createdAt: "2026-07-01T00:32:11.765Z",
    updatedAt: "2026-07-01T00:32:11.765Z"
  };
  assert.equal(coach.refreshLatestCoachForSavedMemories(
    { ...reactionBase, memories: [staleReaction] },
    [staleReaction.id],
    Date.parse("2026-07-23T00:32:11.765Z")
  ).updated, false, "stale reactions are not treated as current screenshot feedback");
  const oldWeightStore = addAllFallbacks(baseStore([
    recordWeight("old-reaction-1", "2026-06-30", 150),
    recordWeight("old-reaction-2", "2026-07-01", 150.2)
  ], { memories: [electrolyteReaction], trackerEvents: [] })).store;
  assert.equal(coach.refreshLatestCoachForSavedMemories(
    oldWeightStore,
    [electrolyteReaction.id],
    Date.parse(electrolyteReaction.createdAt)
  ).updated, false, "a fresh note cannot rewrite a weeks-old weigh-in as today's coach read");
  const ancientCloseReaction = {
    ...electrolyteReaction,
    id: "reaction-ancient-close",
    createdAt: "2026-07-02T00:32:11.765Z",
    updatedAt: "2026-07-02T00:32:11.765Z"
  };
  const ancientCloseStore = addAllFallbacks(baseStore([
    recordWeight("ancient-close-1", "2026-07-01", 150),
    recordWeight("ancient-close-2", "2026-07-02", 150.2)
  ], { memories: [ancientCloseReaction], trackerEvents: [] })).store;
  assert.equal(coach.refreshLatestCoachForSavedMemories(
    ancientCloseStore,
    [ancientCloseReaction.id],
    Date.parse(ancientCloseReaction.createdAt),
    "fallback-test-ancient-close",
    Date.parse("2026-07-23T00:32:11.765Z")
  ).updated, false, "an old note saved close to an old weight cannot be presented as current screenshot feedback later");
  const vegetableReaction = {
    ...electrolyteReaction,
    id: "reaction-vegetables",
    text: "she says she likes vegetables and is trying to eat more vegetables"
  };
  const firstVegetableSelection = coach.selectSavedPreference(
    [vegetableReaction],
    Date.parse(vegetableReaction.createdAt),
    []
  );
  assert.equal(firstVegetableSelection?.kind, "reported-vegetable-effort");
  const usedVegetableSelection = coach.selectSavedPreference(
    [vegetableReaction],
    Date.parse(vegetableReaction.createdAt) + 24 * 60 * 60 * 1000,
    [{ evidenceReferences: [{ type: "memory", id: vegetableReaction.id, role: "reported-vegetable-effort" }] }]
  );
  assert.equal(usedVegetableSelection, null, "a used effort note cannot fall through into a reusable stable preference");
  const removedReactionStore = coach.refreshIfLatestCoachReferences(
    { ...refreshedReaction.store, memories: [] },
    "memory",
    electrolyteReaction.id
  );
  const removedReactionCoach = coach.coachForWeight(removedReactionStore, reactionWeight.id);
  assert.equal(removedReactionCoach.id, reactionCoach.id);
  assert(!removedReactionCoach.evidenceReferences.some((reference) => reference.type === "memory"), "deleting a used reaction returns the latest coach to weight-only context");

  const liveLatestFiveActions = productionWeights.slice(-5).map((weight) => {
    const message = coach.coachForWeight(fullFallbackRun.store, weight.id);
    return `${message.actionSemantic}|${message.actionText}`;
  });
  assert.equal(new Set(liveLatestFiveActions).size, 5, "the latest five causal messages use five distinct actions when valid alternatives exist");
  for (const weight of productionWeights) {
    const context = coach.buildCoachContext(fullFallbackRun.store, weight.id, { privateGoal: 117 });
    const previous = coach.causalPreviousCoachMessages(fullFallbackRun.store, weight, 10);
    const pool = coach.buildContextualFallbackCandidates(context, previous, 3, { writerSafe: true });
    assert.equal(pool.length, 3, `the live ${weight.createdAt.slice(0, 10)} writer pool has three critic-ready options`);
    for (const candidate of pool) assert.equal(coach.validateCoachParagraph(candidate.text, context, previous, { privateGoal: 117 }).ok, true);
  }
  const sixSafeClosingPriors = coach.WRITER_SAFE_CLOSINGS["not-good-enough"].slice(0, 6).map((closing, index) => ({
    id: `safe-closing-prior-${index}`,
    text: `Earlier evidence story ${index + 1} used a different argument and action. ${closing}`,
    actionSemantic: `historical-action-${index}`,
    actionText: `Historical action ${index}`
  }));
  const postCooldownWriterPool = coach.buildContextualFallbackCandidates(july22, sixSafeClosingPriors, 3, { writerSafe: true });
  assert.equal(postCooldownWriterPool.length, 3, "six recent writer-safe closings cannot exhaust the three-candidate writer pool");
  assert(postCooldownWriterPool.every((candidate) => coach.validateCoachParagraph(candidate.text, july22, sixSafeClosingPriors, { privateGoal: 117 }).ok), "post-cooldown writer candidates remain independently valid");
  const criticFacts = coach.criticCoachFacts(july22);
  assert(!JSON.stringify(criticFacts).toLowerCase().includes("snack"), "critic facts contain evidence but no duplicate action catalogs");
  assert(!JSON.stringify(criticFacts).includes("approvedRealizations"), "critic facts cannot duplicate candidate action sentences");
  assert.equal(new Set(coach.WRITER_SAFE_OPENINGS["not-good-enough"]).size, coach.WRITER_SAFE_OPENINGS["not-good-enough"].length, "writer-safe openings are unique");
  assert(coach.buildContextualFallbackCandidates(july22, [], 3, { writerSafe: true }).every((candidate) => coach.WRITER_SAFE_OPENINGS["not-good-enough"].some((opening) => candidate.text.startsWith(opening))), "writer candidates use declarative-only openings");
  const taggedCriticCandidate = coach.criticCandidatePayload(coach.buildContextualFallbackCandidates(july22, [], 1, { writerSafe: true })[0]);
  assert.equal((taggedCriticCandidate.annotatedText.match(/<approved_action>/g) || []).length, 1, "critic input marks one action exactly once without duplicating it");
  assert.equal((taggedCriticCandidate.annotatedText.match(/<\/approved_action>/g) || []).length, 1, "critic action annotation is balanced");

  const equivalentRows = productionWeights.slice(0, 8);
  const equivalentA = addAllFallbacks(baseStore(equivalentRows)).store.coachMessages
    .slice().sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))).map((message) => message.text);
  const equivalentBWeights = liveWeights("opaque-", "T16:00:00Z").slice(0, 8);
  const equivalentB = addAllFallbacks(baseStore(equivalentBWeights)).store.coachMessages
    .slice().sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))).map((message) => message.text);
  assert.deepEqual(equivalentA, equivalentB, "opaque IDs and equivalent timestamp serialization cannot change copy selection");

  const risingWeights = [recordWeight("rise-baseline", "2026-08-01", 150)];
  for (let index = 1; index <= 12; index += 1) {
    const date = new Date(Date.UTC(2026, 7, index + 1)).toISOString().slice(0, 10);
    risingWeights.push(recordWeight(`rise-${index}`, date, 150 + index * 0.2));
  }
  const risingRun = addAllFallbacks(baseStore(risingWeights, { memories: [], trackerEvents: [] }));
  const risingMessages = risingWeights.slice(1).map((weight) => coach.coachForWeight(risingRun.store, weight.id));
  assert(risingMessages.every((message) => message.verdict === "not-good-enough"), "twelve consecutive same-verdict weigh-ins remain distinct and valid");

  const fallback = coach.buildContextualFallback(july22, []);
  const fallbackValidation = coach.validateCoachParagraph(fallback, july22, [], { privateGoal: 117 });
  assert.equal(fallbackValidation.ok, true, fallbackValidation.errors.join(", "));
  assertParagraph(fallback);
  assert.equal(coach.identifyApprovedAction(fallback, july22)?.semantic, july22.actionSemantic);

  const acceptanceAction = july22.actionRealizations.slice().sort((left, right) => coach.coachWordCount(left.text) - coach.coachWordCount(right.text))[0].text;
  const acceptanceExample = `THIS IS MOVING THE WRONG WAY—151 lb is up 1.1 lb today. The 3-day weight change is up 2.5 lb and accelerated from the prior read. The 1-year trend outlook worsened to about 146 lb. ${acceptanceAction} THE RESPONSE STARTS NOW!!!`;
  const acceptanceValidation = coach.validateCoachParagraph(acceptanceExample, july22, [], { privateGoal: 117 });
  assert.equal(acceptanceValidation.ok, true, `a fresh semantic verdict must not be rejected as non-template copy: ${acceptanceValidation.errors.join(", ")}`);
  assertParagraph(acceptanceExample, "July 22 acceptance example");

  const wrongNumber = fallback.replace("151 lb", "999 lb");
  assert(coach.validateCoachParagraph(wrongNumber, july22, [], { privateGoal: 117 }).errors.includes("unsupported-number"));
  const leakedGoal = fallback.replace("about 146 lb", "about 117 lb");
  assert(coach.validateCoachParagraph(leakedGoal, july22, [], { privateGoal: 117 }).errors.includes("goal-leak"));
  const leakedPrivateContext = fallback.replace(/[^.!?]+!!!$/, "OVULATION EXPLAINS THIS!!!");
  assert(coach.validateCoachParagraph(leakedPrivateContext, july22, [], { privateGoal: 117 }).errors.includes("private-context-leak"));
  const periodCause = `${fallback} The period caused this.`;
  assert(coach.validateCoachParagraph(periodCause, july22, [], { privateGoal: 117 }).errors.includes("period-causality"));
  assert(coach.validateCoachParagraph(`${fallback}\nSecond paragraph.`, july22, [], { privateGoal: 117 }).errors.includes("multiline"));
  for (const unsafeClose of ["YOU ARE LAZY!!!", "SKIP A MEAL TO FIX IT!!!", "PUNISH THIS WITH COMPENSATORY EXERCISE!!!"]) {
    const unsafeCandidate = fallback.replace(/[^.!?]+!!!$/, unsafeClose);
    assert(coach.validateCoachParagraph(unsafeCandidate, july22, [], { privateGoal: 117 }).errors.includes("unsafe-language"), `unsafe coaching is rejected: ${unsafeClose}`);
  }

  const extraActions = [
    "Take the stairs now.", "Stand up after dinner.", "Call a friend for accountability.",
    "Breathe before ordering.", "Drink water now.", "A stair climb would help.",
    "Taking the stairs helps.", "Keep standing after dinner.", "For dinner, stand up."
  ];
  for (const extra of extraActions) {
    const candidate = fallback.replace(/[^.!?]+!!!$/, extra);
    assert(coach.validateCoachParagraph(candidate, july22, [], { privateGoal: 117 }).errors.includes("extra-action"), `extra action is rejected: ${extra}`);
  }

  const semanticBypasses = [
    "A short hike could work.", "Park farther away.", "A dance break could work.", "Dance after work.",
    "A salad could work.", "More steps tonight.", "Journal tonight.", "Meditation may help.",
    "Clean the scale.", "Reset the scale.", "Hold the scale.", "Trust the scale.",
    "Fight the scale.", "Attack the scale.", "Clean the next reading.", "Press the scale."
  ];
  for (const extra of semanticBypasses) {
    const candidate = acceptanceExample.replace(" THE RESPONSE STARTS", ` ${extra} THE RESPONSE STARTS`);
    const result = coach.validateCoachParagraph(candidate, july22, [], { privateGoal: 117 });
    assert(result.errors.some((error) => error.startsWith("closed-")), `closed component grammar rejects a hidden second recommendation: ${extra}`);
  }

  const falseEvidenceRelation = acceptanceExample.replace(
    "The 3-day weight change is up 2.5 lb and accelerated from the prior read.",
    "The 3-day weight change is up 2.5 lb and weaker than before. A worsened 1-year trend outlook reads about 146 lb."
  );
  assert(coach.validateCoachParagraph(falseEvidenceRelation, july22, [], { privateGoal: 117 }).errors.includes("evidence-claim"), "the outlook cannot satisfy a contradictory broader-evidence relation");

  for (const contradicted of [
    acceptanceExample.replace("151 lb is up 1.1 lb today", "151 lb is not up 1.1 lb today"),
    acceptanceExample.replace("is up 2.5 lb and accelerated", "is up 2.5 lb and not accelerated"),
    acceptanceExample.replace("outlook worsened", "outlook not worsened")
  ]) {
    const result = coach.validateCoachParagraph(contradicted, july22, [], { privateGoal: 117 });
    assert(result.errors.some((error) => error.startsWith("closed-") || error.endsWith("-claim")), "negation cannot coexist with a positively matched fact");
  }

  for (const falseArgument of [
    acceptanceExample.replace("today. The 3-day", "today because the 3-day"),
    acceptanceExample.replace("prior read. The 1-year", "prior read, so the 1-year"),
    acceptanceExample.replace("151 lb is up 1.1 lb today.", "151 lb is up 1.1 lb today?"),
    `THIS IS MOVING THE WRONG WAY—${acceptanceAction}. 151 lb is up 1.1 lb today. The 3-day weight change is up 2.5 lb and accelerated from the prior read. The 1-year trend outlook worsened to about 146 lb. THE RESPONSE STARTS NOW!!!`
  ]) {
    const result = coach.validateCoachParagraph(falseArgument, july22, [], { privateGoal: 117 });
    assert(result.errors.some((error) => error.startsWith("closed-")), "causal joins, factual questions, and action-first fragments are rejected");
  }

  const structureA = "WRONG WAY—151 lb is up 1.1 lb. The 3-day move is up 2.5 lb.";
  const structureB = "WRONG WAY—149 lb is up 0.7 lb. The 3-day move is up 1.2 lb.";
  assert.equal(coach.structuralFingerprint(structureA, july22), coach.structuralFingerprint(structureB, july22), "changing numbers inside a repeated argument is not original analysis");

  const writerRows = coach.buildContextualFallbackCandidates(july22, [], 3, { writerSafe: true });
  assert.equal(writerRows.length, 3, "the schema-enforced writer pool supplies several vetted paragraphs");
  assert.equal(new Set(writerRows.map((candidate) => coach.openingFingerprint(candidate.text))).size, 3, "writer-pool openings are distinct");
  assert.equal(new Set(writerRows.map((candidate) => coach.closingFingerprint(candidate.text))).size, 3, "writer-pool closings are distinct");
  const writerPayload = JSON.stringify({ candidates: writerRows.map((candidate) => ({ text: candidate.text })) });
  const approvedGeneration = await coach.generateCoachParagraph(july22, [], {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: queuedFetch([writerPayload, criticPayload(true, 1)]),
    timeoutMs: 3000
  });
  assert.equal(approvedGeneration.status, "generated-and-critic-approved");
  assert.equal(approvedGeneration.text, writerRows[1].text);
  assert.equal(approvedGeneration.criticResult.checks.originality, true);
  assert.equal(approvedGeneration.criticResult.reasonCode, "approved");

  const invalidWriter = await coach.generateCoachParagraph(july22, [], {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: queuedFetch([JSON.stringify({ candidates: [wrongNumber, wrongNumber.replace("999 lb", "998 lb"), wrongNumber.replace("999 lb", "997 lb")].map((text) => ({ text })) }), JSON.stringify({ candidates: [] })]),
    timeoutMs: 3000
  });
  assert.match(invalidWriter.status, /^fallback-writer-/);
  assert.equal(invalidWriter.text, fallback);
  assert(invalidWriter.diagnostics.rejectionCodes.includes("writer-outside-pool"));

  const duplicateWriterPayload = JSON.stringify({ candidates: [writerRows[0], writerRows[0], writerRows[0]].map((candidate) => ({ text: candidate.text })) });
  const duplicateWriter = await coach.generateCoachParagraph(july22, [], {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: queuedFetch([duplicateWriterPayload, duplicateWriterPayload]),
    timeoutMs: 3000
  });
  assert.equal(duplicateWriter.status, "fallback-writer-validation");
  assert(duplicateWriter.diagnostics.rejectionCodes.includes("writer-duplicate-candidates"));

  const rejectedCritic = await coach.generateCoachParagraph(july22, [], {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: queuedFetch([writerPayload, criticPayload(false), writerPayload, criticPayload(false)]),
    timeoutMs: 3000
  });
  assert.equal(rejectedCritic.status, "fallback-critic-rejected");
  assert.equal(rejectedCritic.text, fallback);
  assert.equal(rejectedCritic.criticResult.approved, false);

  const writerFormatFailure = await coach.generateCoachParagraph(july22, [], {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: queuedFetch(["not-json", JSON.stringify({ candidates: [] })]),
    timeoutMs: 3000
  });
  assert.equal(writerFormatFailure.status, "fallback-writer-format");
  assert.equal(writerFormatFailure.text, fallback);

  const criticFormatFailure = await coach.generateCoachParagraph(july22, [], {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: queuedFetch([writerPayload, JSON.stringify({ approved: "yes" }), writerPayload, "not-json"]),
    timeoutMs: 3000
  });
  assert.equal(criticFormatFailure.status, "fallback-critic-format");
  assert.equal(criticFormatFailure.text, fallback);

  const apiFailure = await coach.generateCoachParagraph(july22, [], {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: async () => { throw new Error("provider unavailable"); },
    timeoutMs: 3000
  });
  assert.equal(apiFailure.status, "fallback-api-error");
  assert.equal(apiFailure.text, fallback);

  const timeoutStartedAt = Date.now();
  const timeoutGeneration = await coach.generateCoachParagraph(july22, [], {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: async () => new Promise(() => {}),
    timeoutMs: 50
  });
  assert.equal(timeoutGeneration.status, "fallback-timeout");
  assert(Date.now() - timeoutStartedAt < 1000, "the total generation deadline includes the full pipeline");

  const noModel = await coach.generateCoachParagraph(july22, [], { apiKey: "", privateGoal: 117 });
  assert.equal(noModel.status, "fallback-no-model");
  assert.equal(noModel.text, fallback);

  const fixtureWeights = [
    recordWeight("weight-1", "2026-07-17", 151.2),
    recordWeight("weight-2", "2026-07-18", 150.3),
    recordWeight("weight-3", "2026-07-19", 148.5),
    recordWeight("weight-4", "2026-07-20", 149.9),
    recordWeight("weight-5", "2026-07-21", 149.9)
  ];
  const fixtureContext = savedContext();
  fixtureContext.trackerEvents.push({
    id: "period-current",
    type: "period",
    dateKey: "2026-07-21",
    periodEndDateKey: "2026-07-22",
    reportedHighDesireDateKey: "2026-07-29",
    createdAt: "2026-07-21T10:00:00.000Z",
    updatedAt: "2026-07-21T10:00:00.000Z"
  });
  await coach.writeStore(() => baseStore(fixtureWeights, fixtureContext));
  await coach.backfillCoachMessages();
  await coach.backfillCoachMessages();
  const migrated = await coach.readStore();
  assert.equal(migrated.weights.length, 5);
  assert.equal(migrated.coachMessages.length, 5, "backfill is idempotent and one-to-one");
  const latest = coach.latestCoachPayload(migrated);
  assert.deepEqual(Object.keys(latest).sort(), ["createdAt", "text", "weightId"]);
  assert(!JSON.stringify(latest).includes("117"), "private configuration never enters the public payload");
  const latestRecord = coach.coachForWeight(migrated, "weight-5");
  for (const key of [
    "analysisPlan", "analysisVersion", "actionId", "actionSemantic", "actionText", "contextHash", "createdAt",
    "criticPromptVersion", "criticResult", "diagnostics", "evidenceReferences", "fallbackVersion", "fingerprintHash",
    "generationVersion", "modelVersion", "nearestPriorMessageId", "nearestPriorSimilarity", "normalizedFingerprint",
    "promptVersion", "safetyVersion", "status", "text", "updatedAt", "validatorVersion", "verdict", "weightId", "writerPromptVersion"
  ]) assert(Object.prototype.hasOwnProperty.call(latestRecord, key), `private coach record includes ${key}`);
  assert(latestRecord.evidenceReferences.some((reference) => reference.type === "tracker" && reference.id === "period-current"));
  assert(!JSON.stringify(latestRecord).toLowerCase().includes("highdesire"));
  assert(!JSON.stringify(latestRecord).includes("2026-07-29"));

  const persistedContext = coach.buildCoachContext(migrated, "weight-5", { privateGoal: 117 });
  const persistedPrevious = coach.causalPreviousCoachMessages(migrated, fixtureWeights.at(-1), 10);
  const persistedWriterRows = coach.buildContextualFallbackCandidates(persistedContext, persistedPrevious, 3, { writerSafe: true });
  const persistedWriterPayload = JSON.stringify({ candidates: persistedWriterRows.map((candidate) => ({ text: candidate.text })) });
  const beforeGenerated = coach.coachForWeight(migrated, "weight-5");
  await coach.generateAndReplaceCoach("weight-5", {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: queuedFetch([persistedWriterPayload, criticPayload(true, 0)]),
    timeoutMs: 3000
  });
  const generatedStore = await coach.readStore();
  const generatedRecord = coach.coachForWeight(generatedStore, "weight-5");
  assert.equal(generatedRecord.status, "generated-and-critic-approved");
  assert.equal(generatedRecord.id, beforeGenerated.id);
  assert.equal(generatedRecord.createdAt, beforeGenerated.createdAt);
  assert.equal(generatedRecord.criticResult.approved, true);
  assert.equal(generatedRecord.criticResult.reasonCode, "approved");
  assert.equal(generatedRecord.modelVersion, "writer:gpt-4.1-nano;critic:gpt-4.1-mini");
  assert.equal(generatedStore.coachMessages.filter((message) => message.weightId === "weight-5").length, 1);
  assert(!generatedRecord.text.includes("999 lb"), "rejected draft copy is never persisted");
  assert(!Object.keys(generatedRecord).some((key) => /draft|raw/i.test(key)), "raw rejected draft fields are never persisted");

  const withoutPeriod = { ...generatedStore, trackerEvents: generatedStore.trackerEvents.filter((event) => event.id !== "period-current") };
  const refreshed = coach.refreshIfLatestCoachReferences(withoutPeriod, "tracker", "period-current");
  const refreshedRecord = coach.coachForWeight(refreshed, "weight-5");
  assert.equal(refreshedRecord.status, "fallback-weight-only-context-removed");
  assert(!refreshedRecord.evidenceReferences.some((reference) => reference.type === "memory" || reference.type === "tracker"));

  const removedLatest = coach.removeWeightAndCoach(generatedStore, "weight-5");
  assert(!removedLatest.coachMessages.some((message) => message.weightId === "weight-5"));
  assert.equal(coach.latestCoachPayload(removedLatest).weightId, "weight-4");

  await coach.writeStore(() => productionStore);
  await coach.backfillCoachMessages();
  const beforeRegeneration = await coach.readStore();
  const beforeWeights = JSON.stringify(beforeRegeneration.weights);
  const beforeCount = beforeRegeneration.coachMessages.length;
  const targetWeights = beforeRegeneration.weights.slice()
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .slice(0, 5)
    .reverse();
  const beforeByWeight = new Map(targetWeights.map((weight) => [weight.id, coach.coachForWeight(beforeRegeneration, weight.id)]));
  const outcomes = await coach.regenerateRecentCoachMessages({ count: 5, apiKey: "", privateGoal: 117 });
  const afterRegeneration = await coach.readStore();
  assert.deepEqual(outcomes.map((outcome) => outcome.weightId), targetWeights.map((weight) => weight.id), "recent five regenerate causally oldest to newest");
  assert(outcomes.every((outcome) => outcome.status === "fallback-no-model"));
  assert.equal(afterRegeneration.coachMessages.length, beforeCount);
  assert.equal(JSON.stringify(afterRegeneration.weights), beforeWeights);
  for (const weight of targetWeights) {
    const before = beforeByWeight.get(weight.id);
    const after = coach.coachForWeight(afterRegeneration, weight.id);
    assert.equal(after.id, before.id);
    assert.equal(after.weightId, before.weightId);
    assert.equal(after.createdAt, before.createdAt);
    assert(after.updatedAt >= before.updatedAt);
    assertParagraph(after.text, `regenerated ${weight.createdAt}`);
    const context = coach.buildCoachContext(afterRegeneration, weight.id, { privateGoal: 117 });
    const previous = coach.causalPreviousCoachMessages(afterRegeneration, weight, 10);
    assert.deepEqual(coach.noveltyErrors(after.text, context, previous), []);
  }

  await assert.rejects(coach.writeStore(() => { throw new Error("intentional write failure"); }));
  await coach.writeStore((store) => ({ ...store, queueRecovered: true }));
  assert.equal((await coach.readStore()).queueRecovered, true, "a failed mutation cannot poison later writes");

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("coach-message-server verification passed");
}

run().catch((error) => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
