const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-coach-essential-"));
process.env.NODE_ENV = "test";
process.env.DATA_DIR = testDataDir;

const coach = require("../server.js");

function weightRecord(weight, index, options = {}) {
  const createdAt = options.createdAt || new Date(Date.UTC(2026, 7, 1 + index, 12)).toISOString();
  return { id: options.id || `weight-${index}`, weight, unit: options.unit || "lb", createdAt, updatedAt: createdAt };
}

function fixtureStore(values, options = {}) {
  const chronological = values.map((value, index) => weightRecord(value, index, {
    unit: options.unit,
    createdAt: options.createdAts?.[index]
  }));
  return {
    weights: chronological.slice().reverse(),
    coachMessages: [],
    memories: options.memories || [],
    trackerEvents: options.trackerEvents || [],
    chats: [],
    bobaReward: options.bobaReward || null
  };
}

function latestContext(store, options = {}) {
  const weight = store.weights.slice().sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
  return coach.buildCoachContext(store, weight.id, options);
}

function sentenceCount(text) {
  return String(text).split(/(?:[!?]+|(?<!\d)\.(?!\d))/).map((part) => part.trim()).filter(Boolean).length;
}

function actionMatches(text) {
  return [...coach.PREFERENCE_ACTIONS, ...coach.COACH_ACTION_CATALOG].filter((action) => text.includes(action.text));
}

function displayPounds(value) {
  return Number(Number(value).toFixed(1)).toString();
}

function assertEssentialMemo(context, label) {
  const first = coach.composeDeterministicCoachMemo(context);
  const second = coach.composeDeterministicCoachMemo(context);
  assert.equal(first.text, second.text, `${label} is deterministic`);
  assert.equal(first.status, "deterministic", `${label} uses the single deterministic composer`);
  assert.equal(first.structureId, "essential-v1", `${label} uses the essential memo structure`);
  assert(coach.coachWordCount(first.text) <= 42, `${label} stays at or below 42 words`);
  assert(sentenceCount(first.text) >= 2 && sentenceCount(first.text) <= 3, `${label} has two or three sentences`);
  assert(first.text.includes(`${displayPounds(context.currentWeight)} lb`), `${label} includes canonical pounds`);
  assert.match(first.text, /seven-day/i, `${label} includes one seven-day read`);
  assert.equal(actionMatches(first.text).length, 1, `${label} contains exactly one approved action`);
  assert.equal(actionMatches(first.text)[0].text, first.action.text, `${label} persists the visible action`);
  assert.doesNotMatch(first.text, /\b(?:anyway|story|signal|slogan|metaphor)\b|\b(?:weight|trend|data|progress)\s+line\b/i, `${label} has no artificial framing`);
  assert.doesNotMatch(first.text, /^(?:good sign|biggest watchout|best move|recommendation|main concern|next|action|reason|blunt read|honest read|improvement)\s*:/i, `${label} has no role prefix`);
  assert.doesNotMatch(first.text, /\b(?:Alan|Brain|saved (?:entry|thought|note|memory)|source (?:entry|thought|note|memory)|my mind|my thoughts?|got distracted|thinking about)\b/i, `${label} keeps source plumbing private`);
  assert.doesNotMatch(first.text, /\b(?:obese|fat|lazy|disgusting|worthless|fasting|starv\w*|skip(?:ping)? meals?|purge|compensat\w*|punish\w*|restrict\w*|diagnos\w*)\b/i, `${label} stays safe`);
  assert((first.text.match(/!/g) || []).length <= 1, `${label} avoids exclamation overload`);
  const validation = coach.validateCoachParagraph(first.text, context);
  assert.equal(validation.ok, true, `${label} passes validation: ${validation.errors.join(", ")}`);
  return first;
}

(async () => {
  assert.equal(coach.COACH_STYLE_VERSION, "coach-style-essential-v1");
  assert.equal(coach.COACH_MAX_WORDS, 42);

  const baselineContext = latestContext(fixtureStore([150]));
  const baseline = assertEssentialMemo(baselineContext, "baseline memo");
  assert.match(baseline.text, /no earlier daily reading/i);
  assert.match(baseline.text, /not enough history for a seven-day pattern/i);

  const improvingStore = fixtureStore([152, 151.6, 151.2, 150.8, 150.4, 150, 149.6]);
  const improvingContext = latestContext(improvingStore);
  const improving = assertEssentialMemo(improvingContext, "improving memo");
  assert.match(improving.text, /down 0\.4 lb from the previous daily reading/i);
  assert.match(improving.text, /seven-day movement is also down/i);
  assert.match(improving.text, /worth celebrating/i);

  const worseningContext = latestContext(fixtureStore([148, 148.4, 148.8, 149.2, 149.6, 150, 150.4]));
  const worsening = assertEssentialMemo(worseningContext, "worsening memo");
  assert.match(worsening.text, /up 0\.4 lb from the previous daily reading/i);
  assert.match(worsening.text, /seven-day movement is also up/i);
  assert.match(worsening.text, /does not define the week/i);

  const mixedContext = latestContext(fixtureStore([150, 149, 150, 149.5, 150.5, 149.8, 150]));
  const mixed = assertEssentialMemo(mixedContext, "mixed memo");
  assert.match(mixed.text, /150 lb today, up 0\.2 lb/i);
  assert.match(mixed.text, /seven-day movement/i);

  const reversalContext = latestContext(fixtureStore([150, 151, 152, 153, 152]));
  const reversal = assertEssentialMemo(reversalContext, "reversal memo");
  assert.match(reversal.text, /down 1 lb from the previous daily reading, while seven-day movement is up 2 lb/i);

  const outlierContext = latestContext(fixtureStore([150, 149.9, 150.1, 149.8, 150, 149.9, 145]));
  const outlier = assertEssentialMemo(outlierContext, "outlier memo");
  assert.equal(outlierContext.verdict, "verify");
  assert.match(outlier.text, /down 4\.9 lb from the previous daily reading/i);
  assert.match(outlier.text, /same scale|follow-up|confirm/i);
  assert.match(outlier.text, /does not deserve a verdict/i);

  const earnedContext = { ...improvingContext, bobaReward: { ...improvingContext.bobaReward, earnedForWeightId: 1 } };
  const earned = assertEssentialMemo(earnedContext, "reward-earned memo");
  assert.match(earned.text, /A boba is earned—enjoy it!/);
  assert.equal((earned.text.match(/boba/gi) || []).length, 1, "only one compact boba fact is included");

  const personalMemory = {
    id: "memory-fruit",
    kind: "note",
    text: "Lily likes fruit.",
    createdAt: "2026-08-02T11:00:00.000Z",
    updatedAt: "2026-08-02T11:00:00.000Z"
  };
  const personalStore = fixtureStore([152, 151.5, 151], { memories: [personalMemory] });
  const personalContext = latestContext(personalStore, { includePersonalContext: true });
  assert(personalContext.personalAnchor, "approved context can still be reduced privately");
  const personalMemo = assertEssentialMemo(personalContext, "optional-context memo");
  assert(!personalMemo.text.includes(personalContext.personalAnchor.text), "personal context is not forced into copy");
  const contextRefresh = coach.refreshLatestCoachForSavedMemories(personalStore, [personalMemory.id], Date.parse(personalMemory.createdAt));
  assert.equal(contextRefresh.updated, false, "saved context cannot trigger a context-only rewrite");
  assert.strictEqual(contextRefresh.store, personalStore, "context-only refresh leaves the store untouched");

  const unsafe = improving.text.replace(improving.action.text, "Skip meals tomorrow.");
  const unsafeValidation = coach.validateCoachParagraph(unsafe, improvingContext);
  assert.equal(unsafeValidation.ok, false);
  assert(unsafeValidation.errors.includes("unsafe-language"));
  assert(unsafeValidation.errors.includes("required-action-realization"));
  assert(coach.validateCoachParagraph(`Recommendation: ${improving.text}`, improvingContext).errors.includes("role-prefix"));
  assert(coach.validateCoachParagraph(`${improving.text} ${"Extra filler ".repeat(20)}`, improvingContext).errors.includes("word-count"));

  const kgStore = fixtureStore([68, 67.8, 67.6], { unit: "kg" });
  const lbStore = fixtureStore([68, 67.8, 67.6].map((kg) => kg * 2.2046226218), { unit: "lb" });
  const kgContext = latestContext(kgStore);
  const lbContext = latestContext(lbStore);
  assert(Math.abs(kgContext.currentWeight - lbContext.currentWeight) < 0.02, "legacy kg and equivalent lb records normalize to the same current pounds");
  assert(Math.abs(kgContext.latestDailyChange - lbContext.latestDailyChange) < 0.02, "legacy kg and equivalent lb records normalize to the same daily change");
  assertEssentialMemo(kgContext, "legacy kg memo");
  assertEssentialMemo(lbContext, "equivalent lb memo");

  await coach.ensureDataDir();
  await coach.writeStore(() => improvingStore);
  const created = weightRecord(149.2, 20, { id: "weight-persisted", createdAt: "2026-08-20T12:00:00.000Z" });
  const savedStore = await coach.persistWeightWithRecoverableCoach(created);
  const savedRecord = coach.coachForWeight(savedStore, created.id);
  assert(savedStore.weights.some((record) => record.id === created.id), "the primary weight is durable");
  assert(savedRecord, "the deterministic memo is persisted with the weight");
  assertEssentialMemo(coach.buildCoachContext(savedStore, created.id), "persisted memo context");
  assert.deepEqual(Object.keys(coach.publicCoach(savedRecord)).sort(), ["createdAt", "text", "weightId"], "latestCoach public shape is unchanged");
  assert.equal(savedRecord.styleVersion, coach.COACH_STYLE_VERSION);
  assert.equal(savedRecord.generationVersion, "coach-deterministic-v1");
  for (const retiredField of ["writerPromptVersion", "criticPromptVersion", "modelVersion", "criticResult", "promptVersion"]) {
    assert(!Object.prototype.hasOwnProperty.call(savedRecord, retiredField), `new records omit retired ${retiredField}`);
  }

  let isolatedStore = fixtureStore([151]);
  let reportedFailure = "";
  const isolatedCreated = weightRecord(150.5, 30, { id: "weight-isolated", createdAt: "2026-08-30T12:00:00.000Z" });
  const isolatedResult = await coach.persistWeightWithRecoverableCoach(isolatedCreated, {
    persist: async (mutate) => {
      isolatedStore = await mutate(isolatedStore);
      return isolatedStore;
    },
    attachFallback: () => { throw new Error("forced derived failure"); },
    reportFallbackError: (error) => { reportedFailure = error.message; }
  });
  assert.equal(reportedFailure, "forced derived failure");
  assert.equal(isolatedResult.weights.filter((record) => record.id === isolatedCreated.id).length, 1, "derived failure cannot roll back or duplicate the weight");
  assert.equal(isolatedResult.weights.find((record) => record.id === isolatedCreated.id).createdAt, isolatedCreated.createdAt, "the primary timestamp is preserved");
  assert(coach.publicCoach(coach.coachForWeight(isolatedResult, isolatedCreated.id)), "safe deterministic repair remains available");

  const originalId = savedRecord.id;
  const originalCreatedAt = savedRecord.createdAt;
  const staleStore = {
    ...savedStore,
    coachMessages: savedStore.coachMessages.map((message) => message.id === originalId
      ? { ...message, text: "Legacy memo copy.", styleVersion: "legacy-style" }
      : message)
  };
  const beforeRefresh = coach.coachRefreshPreservationSnapshot(staleStore, created.id);
  const refreshed = coach.refreshLatestCoachStyleInStore(staleStore, "deterministic-style-test", Date.parse("2026-08-31T12:00:00.000Z"));
  assert.equal(refreshed.updated, true, "stale visible copy refreshes immediately");
  const refreshedRecord = coach.coachForWeight(refreshed.store, created.id);
  assert.equal(refreshedRecord.id, originalId, "style refresh preserves identity");
  assert.equal(refreshedRecord.createdAt, originalCreatedAt, "style refresh preserves creation time");
  assert.equal(refreshedRecord.styleVersion, coach.COACH_STYLE_VERSION);
  coach.assertCoachRefreshPreserved(beforeRefresh, coach.coachRefreshPreservationSnapshot(refreshed.store, created.id));
  assertEssentialMemo(coach.buildCoachContext(refreshed.store, created.id), "style-refreshed memo context");

  await coach.writeStore(() => refreshed.store);
  let externalCalls = 0;
  await coach.generateAndReplaceCoach(created.id, {
    apiKey: "must-not-be-used",
    fetchImpl: async () => {
      externalCalls += 1;
      throw new Error("deterministic memo attempted an external request");
    }
  });
  const generatedStore = await coach.readStore();
  const regeneratedRecord = coach.coachForWeight(generatedStore, created.id);
  assert.equal(externalCalls, 0, "memo generation makes no writer, critic, or context request");
  assert.equal(regeneratedRecord.id, originalId, "deterministic regeneration preserves identity");
  assert.equal(regeneratedRecord.createdAt, originalCreatedAt, "deterministic regeneration preserves creation time");
  assert.equal(regeneratedRecord.status, "deterministic-refreshed");

  const reconcileResult = await coach.reconcileLatestCoachBrainContext({
    fetchImpl: async () => {
      externalCalls += 1;
      throw new Error("optional context reconciliation should not fetch");
    }
  });
  assert.equal(reconcileResult.updated, false);
  assert.equal(reconcileResult.status, "personal-context-optional");
  assert.equal(externalCalls, 0, "optional context does not create a delayed rewrite request");

  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.doesNotMatch(serverSource, /OPENAI_COACH_WRITER_MODEL|OPENAI_CRITIC_MODEL|requestCoachResponse|composeFallbackParagraph|FALLBACK_STRUCTURES|function parseCriticResult|function writerLeadFacts/);
  assert.doesNotMatch(serverSource, /;\s*anyway,/i, "the rejected forced transition is removed from source");
  const weightGetStart = serverSource.indexOf('pathname === "/api/weights" && req.method === "GET"');
  const weightGetEnd = serverSource.indexOf('pathname === "/api/coach/refresh-saved-context"', weightGetStart);
  assert(weightGetStart > 0 && weightGetEnd > weightGetStart);
  assert.doesNotMatch(serverSource.slice(weightGetStart, weightGetEnd), /reconcileLatestCoachBrainContext/, "authenticated reads never trigger context reconciliation");

  console.log("coach-message-server essential memo verification passed");
})()
  .finally(() => fs.rmSync(testDataDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
