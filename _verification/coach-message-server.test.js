const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-coach-server-"));
process.env.NODE_ENV = "test";
process.env.DATA_DIR = tempDir;
process.env.OPENAI_API_KEY = "";
process.env.LILY_INTERNAL_GOAL_LB = "117";
process.env.LILY_PRIVATE_COACH_BLOCKED_TERMS = "private-sensitive-label";

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

function liveWeightsThroughJul30(idPrefix = "current-live-weight-") {
  const rows = [
    ["2026-06-26", 149.4], ["2026-06-28", 148.5], ["2026-06-29", 147.4], ["2026-06-30", 149],
    ["2026-07-01", 149.4], ["2026-07-02", 149.4], ["2026-07-03", 148.8], ["2026-07-04", 149.9],
    ["2026-07-06", 150.7], ["2026-07-07", 149], ["2026-07-08", 147.5], ["2026-07-10", 150.3],
    ["2026-07-11", 150.5], ["2026-07-12", 149.9], ["2026-07-13", 150], ["2026-07-14", 147.7],
    ["2026-07-15", 149.4], ["2026-07-16", 150.3], ["2026-07-17", 149.9], ["2026-07-18", 149.4],
    ["2026-07-19", 148.5], ["2026-07-20", 149.9], ["2026-07-21", 149.9], ["2026-07-22", 151],
    ["2026-07-23", 151.8], ["2026-07-24", 151.4], ["2026-07-25", 150.5], ["2026-07-26", 151.2],
    ["2026-07-27", 151.2], ["2026-07-28", 151.3], ["2026-07-29", 151.2], ["2026-07-30", 151]
  ];
  return rows.map(([date, weight], index) => recordWeight(
    `${idPrefix}${index}`,
    date,
    weight,
    date === "2026-07-30" ? "T21:30:30.660Z" : "T16:00:00.000Z"
  ));
}

function liveWeightsThroughAug2(idPrefix = "aug2-live-weight-") {
  return [
    ...liveWeightsThroughJul30(idPrefix),
    recordWeight(`${idPrefix}32`, "2026-08-01", 151.6),
    recordWeight(`${idPrefix}33`, "2026-08-02", 150.5, "T16:58:44.053Z")
  ];
}

function savedContext() {
  return {
    memories: [
      {
        id: "anchor-league",
        kind: "quote",
        text: "Lily said League nights are one of her favorite shared things.",
        createdAt: "2026-05-28T12:00:00.000Z",
        updatedAt: "2026-05-28T12:00:00.000Z"
      },
      {
        id: "anchor-music",
        kind: "note",
        text: "A saved note says music matters in Lily's daily life.",
        createdAt: "2026-05-29T12:00:00.000Z",
        updatedAt: "2026-05-29T12:00:00.000Z"
      },
      {
        id: "anchor-travel",
        kind: "quote",
        text: "Lily shared a travel thought about a trip she wants someday.",
        createdAt: "2026-05-30T12:00:00.000Z",
        updatedAt: "2026-05-30T12:00:00.000Z"
      },
      {
        id: "anchor-cats",
        kind: "note",
        text: "A saved note remembers that cats make Lily smile.",
        createdAt: "2026-05-31T12:00:00.000Z",
        updatedAt: "2026-05-31T12:00:00.000Z"
      },
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

function substantialAnchorMemories(prefix = "anchor") {
  const rows = [
    ["league", "quote", "Lily said League nights are one of her favorite shared things."],
    ["music", "note", "A saved note says music matters in Lily's daily life."],
    ["travel", "quote", "Lily shared a travel thought about a trip she wants someday."],
    ["cats", "note", "A saved note remembers that cats make Lily smile."]
  ];
  return rows.map(([suffix, kind, text], index) => ({
    id: `${prefix}-${suffix}`,
    kind,
    text,
    createdAt: `2026-05-${String(25 + index).padStart(2, "0")}T11:00:00.000Z`,
    updatedAt: `2026-05-${String(25 + index).padStart(2, "0")}T11:00:00.000Z`
  }));
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
  assert(words >= coach.COACH_MIN_WORDS && words <= coach.COACH_RELATIONSHIP_MAX_WORDS, `${label} has ${words} words`);
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

function verifyWeightPersistsWhenCoachFallbackThrows() {
  const childDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-coach-save-failure-"));
  const serverPath = path.join(__dirname, "..", "server.js");
  const childSource = String.raw`
    const fs = require("node:fs");
    const lily = require(${JSON.stringify(serverPath)});

    (async () => {
      await lily.ensureDataDir();
      await lily.writeStore(() => ({
        weights: [],
        coachMessages: [],
        chats: [],
        trackerEvents: [],
        memories: [{
          id: "forced-fallback-anchor",
          kind: "note",
          text: "Alan saved a League-night detail about Lily.",
          createdAt: "2026-07-28T12:00:00.000Z",
          updatedAt: "2026-07-28T12:00:00.000Z"
        }]
      }));
      await new Promise((resolve) => lily.server.listen(0, "127.0.0.1", resolve));
      const base = "http://127.0.0.1:" + lily.server.address().port;
      const authResponse = await fetch(base + "/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: process.env.LILY_PIN, remember: false })
      });
      const auth = await authResponse.json();
      const headers = { authorization: "Bearer " + auth.token, "content-type": "application/json" };
      const postResponse = await fetch(base + "/api/weights", {
        method: "POST",
        headers,
        body: JSON.stringify({ weight: 151.3, unit: "lb" })
      });
      const postBody = await postResponse.json();
      const readResponse = await fetch(base + "/api/weights", { headers });
      const readBody = await readResponse.json();
      console.log("__LILY_SAVE_RESULT__" + JSON.stringify({
        postStatus: postResponse.status,
        postBody,
        readStatus: readResponse.status,
        readBody
      }));
      await new Promise((resolve) => lily.server.close(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;
  const child = spawnSync(process.execPath, ["-e", childSource], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATA_DIR: childDataDir,
      LILY_PIN: "coach-save-test-pin",
      OPENAI_API_KEY: "",
      LILY_PRIVATE_COACH_BLOCKED_TERMS: "alan"
    }
  });
  fs.rmSync(childDataDir, { recursive: true, force: true });
  assert.equal(child.status, 0, `forced coach-failure child exits cleanly: ${child.stderr}`);
  const resultLine = String(child.stdout || "").split(/\r?\n/).find((line) => line.startsWith("__LILY_SAVE_RESULT__"));
  assert(resultLine, `forced coach-failure child returns an auditable result: ${child.stdout}`);
  const result = JSON.parse(resultLine.slice("__LILY_SAVE_RESULT__".length));
  assert.equal(result.postStatus, 201, "a valid weight save succeeds even when every coach fallback candidate is rejected");
  assert.equal(result.postBody.weight.weight, 151.3, "the successful response returns the exact saved measurement");
  assert(result.postBody.latestCoach, "a forced fallback failure still returns a safe pending coach instead of null");
  assert.equal(result.postBody.latestCoach.weightId, result.postBody.weight.id, "the pending coach belongs to the newly saved weight");
  assert.match(result.postBody.latestCoach.text, /safely saved|still being prepared|measurement is secure/i, "the returned pending copy confirms the save without inventing analysis");
  assert.doesNotMatch(result.postBody.latestCoach.text, /unavailable|null|no coach message|no compliant|invariant|word-count|evidence-claim/i, "the browser never falls into unavailable copy or raw diagnostics");
  assert.equal(result.readStatus, 200);
  assert.equal(result.readBody.weights.length, 1, "the failed coach path cannot roll back the measurement");
  assert.equal(result.readBody.weights[0].weight, 151.3, "the persisted measurement survives an authenticated reread");
  assert(result.readBody.latestCoach, "the pending coach survives an authenticated reread");
  assert.equal(result.readBody.latestCoach.weightId, result.postBody.weight.id, "the reread coach stays paired with the exact saved weight");
  assert.equal(result.readBody.latestCoach.text, result.postBody.latestCoach.text, "the safe pending copy is durably persisted rather than synthesized in the browser");
  assert.doesNotMatch(
    JSON.stringify({ postBody: result.postBody, readBody: result.readBody }),
    /no compliant contextual fallback invariant|word-count=|evidence-claim=|outlook-weight=|outlook-claim=|verdict=/i,
    "internal coach-validator diagnostics never enter the browser response"
  );
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

  const july28PriorWeights = [
    ...productionWeights,
    recordWeight("live-weight-24", "2026-07-23", 151.8),
    recordWeight("live-weight-25", "2026-07-24", 151.4),
    recordWeight("live-weight-26", "2026-07-25", 150.5),
    recordWeight("live-weight-27", "2026-07-26", 151.2),
    recordWeight("live-weight-28", "2026-07-27", 151.2)
  ];
  assert.equal(july28PriorWeights.length, 29, "the Jul 28 regression carries the complete live-equivalent 29-weigh-in causal prefix");
  const july28PriorRun = addAllFallbacks(baseStore(july28PriorWeights));
  assert.equal(july28PriorRun.store.coachMessages.length, 29, "every prior live-equivalent weigh-in has its causal persisted coach history");
  const july28Weight = recordWeight("live-weight-29", "2026-07-28", 151.3);
  const july28Store = {
    ...july28PriorRun.store,
    weights: [july28Weight, ...july28PriorRun.store.weights]
  };
  const july28 = coach.buildCoachContext(july28Store, "live-weight-29", { privateGoal: 117 });
  assert.equal(Number(july28.latestDailyChange.toFixed(1)), 0.1);
  assert.equal(july28.strongestEvidence.kind, "window-acceleration");
  assert.equal(july28.strongestEvidence.windowDays, 3);
  assert.equal(Number(july28.strongestEvidence.movement.toFixed(1)), 0.8);
  assert.equal(Number(july28.strongestEvidence.previousMovement.toFixed(1)), -0.2);
  assert.equal(july28.evidenceRelation.kind, "reversed", "the Jul 28 three-day acceleration is explicitly a reversal, not merely more acceleration");
  const july28Previous = coach.causalPreviousCoachMessages(july28Store, july28Weight, 10);
  assert.equal(july28Previous.length, 10, "the Jul 28 fallback is compared with the complete prior-ten originality window");
  const july28WeightById = new Map(july28Store.weights.map((weight) => [weight.id, weight]));
  assert(july28Previous.every((message) => {
    const sourceWeight = july28WeightById.get(message.weightId);
    return message.weightId !== july28Weight.id && sourceWeight && Date.parse(sourceWeight.createdAt) < Date.parse(july28Weight.createdAt);
  }), "only causal earlier coaches can constrain Jul 28 copy");
  const july28Fallbacks = coach.buildContextualFallbackCandidates(july28, july28Previous, 3, { writerSafe: true });
  assert.equal(july28Fallbacks.length, 3, "the exact Jul 28 reversed-acceleration case always has several compliant fallbacks");
  for (const candidate of july28Fallbacks) {
    const validation = coach.validateCoachParagraph(candidate.text, july28, july28Previous, { privateGoal: 117 });
    assert.equal(validation.ok, true, `Jul 28 fallback is compliant: ${validation.errors.join(", ")}`);
    assert.match(candidate.text, /revers|flipp|turn/i, "the fallback states that the three-day evidence reversed");
    assert.deepEqual(coach.noveltyErrors(candidate.text, july28, july28Previous, candidate.action), [], "Jul 28 fallback passes every prior-ten novelty and cooldown gate");
    assert(july28Previous.slice(0, 10).every((prior) => coach.trigramSimilarity(candidate.text, prior.text, july28) < 0.72), "Jul 28 fallback stays below the prior-ten trigram threshold");
    assert(!july28Previous.slice(0, 6).some((prior) => coach.openingFingerprint(prior.text) === coach.openingFingerprint(candidate.text)), "Jul 28 opening is new within six");
    assert(!july28Previous.slice(0, 6).some((prior) => coach.closingFingerprint(prior.text) === coach.closingFingerprint(candidate.text)), "Jul 28 closing is new within six");
    assert(!july28Previous.slice(0, 3).some((prior) => prior.actionSemantic === candidate.action.semantic || prior.actionText === candidate.action.text), "Jul 28 action meaning and sentence both clear the three-entry cooldown");
  }
  verifyWeightPersistsWhenCoachFallbackThrows();

  const recoverableWeight = recordWeight("recoverable-primary-weight", "2026-08-01", 151.3);
  const forcedFallbackError = new Error("no compliant contextual fallback invariant: word-count=999,evidence-claim=999");
  const reportedFallbackFailures = [];
  let recoverableStore = baseStore([]);
  const persistedAfterHardFallback = await coach.persistWeightWithRecoverableCoach(recoverableWeight, {
    persist: async (mutator) => {
      recoverableStore = await mutator(recoverableStore);
      return recoverableStore;
    },
    attachFallback: () => {
      throw forcedFallbackError;
    },
    reportFallbackError: (error) => reportedFallbackFailures.push(error)
  });
  assert.equal(recoverableStore.weights.length, 1, "an unconditional fallback exception still leaves exactly one primary weight");
  assert.equal(recoverableStore.weights.filter((weight) => weight.id === recoverableWeight.id).length, 1, "the recovery path cannot duplicate the saved measurement");
  assert.equal(persistedAfterHardFallback.weights.length, 1, "the helper returns the same durable one-weight state");
  assert.equal(reportedFallbackFailures.length, 1, "the hard fallback exception is reported exactly once");
  assert.equal(reportedFallbackFailures[0], forcedFallbackError, "the single private failure callback receives the original exception");
  assert.equal(recoverableStore.coachMessages.length, 1, "the hard fallback exception produces exactly one persisted pending coach");
  const recoveredPendingCoach = coach.coachForWeight(recoverableStore, recoverableWeight.id);
  assert(recoveredPendingCoach, "the recovered coach cannot be null or unavailable");
  assert.equal(recoveredPendingCoach.weightId, recoverableWeight.id, "the recovered coach belongs to the primary weight");
  assert.match(recoveredPendingCoach.status, /^pending-/, "the recovered record remains explicitly repairable");
  assert.match(recoveredPendingCoach.text, /safely saved|still being prepared|measurement is secure/i, "pending copy confirms durable data without fabricating a verdict");
  assert.doesNotMatch(recoveredPendingCoach.text, /unavailable|null|no coach message|no compliant|invariant|word-count|evidence-claim/i, "pending copy contains neither unavailable state nor raw diagnostics");
  assert.doesNotMatch(JSON.stringify(recoveredPendingCoach), /word-count=999|evidence-claim=999|no compliant contextual fallback invariant/i, "the private pending record does not persist the thrown diagnostic payload");
  const publicRecoveredPending = coach.publicCoach(recoveredPendingCoach);
  assert.deepEqual(Object.keys(publicRecoveredPending).sort(), ["createdAt", "text", "weightId"], "the browser payload contains only the established latestCoach interface");
  assert.equal(publicRecoveredPending.weightId, recoverableWeight.id);
  assert.equal(publicRecoveredPending.text, recoveredPendingCoach.text);
  assert.equal(recoverableStore.coachMessages.filter((message) => message.weightId === recoverableWeight.id).length, 1, "the recovered coach is not duplicated");

  const noAnchorWeight = recordWeight("no-anchor-primary-weight", "2026-08-02", 150.8);
  let noAnchorPersistedStore = baseStore([], { memories: [], trackerEvents: [] });
  const noAnchorFailures = [];
  const noAnchorResult = await coach.persistWeightWithRecoverableCoach(noAnchorWeight, {
    persist: async (mutator) => {
      noAnchorPersistedStore = await mutator(noAnchorPersistedStore);
      return noAnchorPersistedStore;
    },
    reportFallbackError: (error) => noAnchorFailures.push(error)
  });
  assert.equal(noAnchorFailures.length, 0, "an absent personal anchor is a normal pending state, not a fallback exception");
  assert.equal(noAnchorPersistedStore.weights.length, 1, "a no-anchor save persists exactly one primary weight");
  assert.equal(noAnchorPersistedStore.weights[0].id, noAnchorWeight.id);
  assert.equal(noAnchorPersistedStore.coachMessages.length, 1, "a non-throwing no-anchor fallback still creates one safe pending coach");
  const noAnchorPendingCoach = coach.coachForWeight(noAnchorPersistedStore, noAnchorWeight.id);
  assert(noAnchorPendingCoach && coach.coachNeedsRepair(noAnchorPendingCoach), "the no-anchor coach is present and explicitly repairable");
  assert.equal(noAnchorPendingCoach.weightId, noAnchorWeight.id);
  assert.match(noAnchorPendingCoach.text, /safely saved|still being prepared|measurement is secure/i);
  assert.doesNotMatch(noAnchorPendingCoach.text, /unavailable|null|no coach message|no compliant|invariant|word-count|evidence-claim/i);
  assert.equal(noAnchorResult.coachMessages.filter((message) => message.weightId === noAnchorWeight.id).length, 1, "the returned no-anchor state contains no duplicate coach");

  const scheduledCallbacks = [];
  const generatedWeightIds = [];
  const scheduleOptions = {
    schedule: (callback) => scheduledCallbacks.push(callback),
    generate: (weightId) => {
      generatedWeightIds.push(weightId);
      return Promise.resolve();
    }
  };
  const dedupeWeightId = "post-get-dedupe-weight";
  assert.equal(coach.scheduleCoachGeneration(dedupeWeightId, 1_000_000, scheduleOptions), true, "the POST-equivalent call schedules the first generation attempt");
  assert.equal(coach.scheduleCoachGeneration(dedupeWeightId, 1_000_001, scheduleOptions), false, "an immediate GET-equivalent repair request is deduplicated");
  assert.equal(scheduledCallbacks.length, 1, "POST plus immediate GET creates only one scheduled callback");
  scheduledCallbacks[0]();
  assert.deepEqual(generatedWeightIds, [dedupeWeightId], "the one scheduled callback generates the exact saved weight once");

  assert.equal(typeof coach.publicApiErrorMessage, "function", "server errors need one auditable public-message boundary");
  const internalInvariant = "no compliant contextual fallback invariant: word-count=5106,evidence-claim=1038,outlook-weight=142,outlook-claim=142,verdict=97";
  const safeInternalMessage = coach.publicApiErrorMessage(new Error(internalInvariant));
  assert.equal(typeof safeInternalMessage, "string");
  assert(safeInternalMessage.trim(), "an internal failure still produces a useful browser message");
  assert.doesNotMatch(safeInternalMessage, /no compliant|invariant|word-count|evidence-claim|outlook-(?:weight|claim)|verdict=/i, "internal invariant details stay server-side");
  assert.match(safeInternalMessage, /try again|could not|went wrong|temporar/i, "the browser receives a concise recovery-oriented message");
  assert.equal(
    coach.publicApiErrorMessage(Object.assign(new Error("Enter a valid weight."), { status: 400 })),
    "Enter a valid weight.",
    "intentional validation guidance remains specific"
  );

  const storeBeforePendingRepair = await coach.readStore();
  try {
    const pendingRepairSeed = baseStore([], {
      memories: [{
        id: "pending-repair-league-anchor",
        kind: "note",
        text: "Lily said that a shared League night matters to her.",
        createdAt: "2026-08-02T12:00:00.000Z",
        updatedAt: "2026-08-02T12:00:00.000Z"
      }],
      trackerEvents: []
    });
    await coach.writeStore(() => pendingRepairSeed);
    const pendingRepairWeight = recordWeight("pending-repair-weight", "2026-08-03", 150.6);
    const pendingCreationFailures = [];
    const pendingSavedStore = await coach.persistWeightWithRecoverableCoach(pendingRepairWeight, {
      attachFallback: () => {
        throw new Error("forced initial fallback failure for pending repair");
      },
      reportFallbackError: (error) => pendingCreationFailures.push(error)
    });
    assert.equal(pendingCreationFailures.length, 1);
    const pendingBeforeRepair = coach.coachForWeight(pendingSavedStore, pendingRepairWeight.id);
    assert(pendingBeforeRepair && coach.coachNeedsRepair(pendingBeforeRepair), "repair acceptance starts from a real persisted pending coach");
    assert.equal(pendingSavedStore.coachMessages.filter((message) => message.weightId === pendingRepairWeight.id).length, 1);
    const pendingContext = coach.buildCoachContext(pendingSavedStore, pendingRepairWeight.id, { privateGoal: 117 });
    assert(pendingContext.personalAnchor, "the saved Lily context is available for actual repair");
    const weightCountBeforeRepair = pendingSavedStore.weights.length;
    const weightIdsBeforeRepair = pendingSavedStore.weights.map((weight) => weight.id);
    const weightHashBeforeRepair = crypto.createHash("sha256").update(JSON.stringify(pendingSavedStore.weights)).digest("hex");
    const pendingCoachId = pendingBeforeRepair.id;
    const pendingCoachCreatedAt = pendingBeforeRepair.createdAt;

    const repairedPublicCoach = await coach.generateAndReplaceCoach(pendingRepairWeight.id, {
      apiKey: "",
      privateGoal: 117,
      relationshipSupport: pendingContext.personalAnchor,
      operationalNow: Date.parse("2026-08-03T16:01:00.000Z")
    });
    const repairedStore = await coach.readStore();
    const repairedCoach = coach.coachForWeight(repairedStore, pendingRepairWeight.id);
    const weightHashAfterRepair = crypto.createHash("sha256").update(JSON.stringify(repairedStore.weights)).digest("hex");
    assert.equal(repairedStore.weights.length, weightCountBeforeRepair, "repair preserves the exact weight count");
    assert.deepEqual(repairedStore.weights.map((weight) => weight.id), weightIdsBeforeRepair, "repair preserves every weight ID and order");
    assert.equal(weightHashAfterRepair, weightHashBeforeRepair, "repair leaves the full measured-weight payload byte-stable");
    assert.equal(repairedStore.coachMessages.filter((message) => message.weightId === pendingRepairWeight.id).length, 1, "repair replaces in place instead of appending a duplicate coach");
    assert(repairedCoach, "actual repair leaves one visible coach");
    assert.equal(repairedCoach.id, pendingCoachId, "pending repair preserves coach identity");
    assert.equal(repairedCoach.createdAt, pendingCoachCreatedAt, "pending repair preserves the original creation time");
    assert.equal(coach.coachNeedsRepair(repairedCoach), false, "the repaired coach no longer carries pending status");
    assert.equal(repairedCoach.status, "fallback-no-model", "no-model repair ends in a validated non-pending fallback");
    assert(repairedPublicCoach && repairedPublicCoach.weightId === pendingRepairWeight.id, "generateAndReplaceCoach returns the repaired same-weight public coach");
    assert.equal(repairedPublicCoach.text, repairedCoach.text);
    assertParagraph(repairedCoach.text, "actual pending-to-final repair");
    assert.doesNotMatch(repairedCoach.text, /safely saved|still being prepared|measurement is secure|unavailable|null|no compliant|invariant/i, "the finished paragraph fully replaces pending and diagnostic copy");
    const repairedContext = coach.buildCoachContext(repairedStore, pendingRepairWeight.id, {
      privateGoal: 117,
      relationshipSupport: pendingContext.personalAnchor
    });
    const repairedPrevious = coach.causalPreviousCoachMessages(repairedStore, pendingRepairWeight, 10);
    assert.equal(coach.validateCoachParagraph(repairedCoach.text, repairedContext, repairedPrevious, { privateGoal: 117 }).ok, true, "the repaired paragraph passes the full deterministic validator");
  } finally {
    await coach.writeStore(() => storeBeforePendingRepair);
  }
  assert.deepEqual(await coach.readStore(), storeBeforePendingRepair, "the pending-repair integration test restores the shared temporary test store exactly");

  const alternateGoal = coach.buildCoachContext(productionStore, productionWeights.at(-1).id, { privateGoal: 132 });
  assert.deepEqual(july22.forecastFingerprint, alternateGoal.forecastFingerprint, "private strategy cannot alter forecast history");
  assert.equal(july22.outlook, alternateGoal.outlook, "private strategy cannot alter the headline outlook");
  assert.notEqual(july22.hiddenStrategy, alternateGoal.hiddenStrategy, "private configuration is confined to hidden coaching strategy");

  const mixedSensitiveLeague = {
    id: "mixed-sensitive-league",
    kind: "quote",
    text: "A private-sensitive-label belongs in the private note, but Lily said that League night mattered to her.",
    createdAt: "2026-07-21T12:00:00.000Z",
    updatedAt: "2026-07-21T12:00:00.000Z"
  };
  const mixedLeagueAnchor = coach.memoryPersonalAnchor(mixedSensitiveLeague, { cutoff: Date.parse("2026-07-22T12:00:00.000Z"), seed: "stable" });
  assert.equal(mixedLeagueAnchor.kind, "lily-league", "a safe concrete topic survives reduction even when another source clause is sensitive");
  assert.match(mixedLeagueAnchor.text, /League night/);
  assert.doesNotMatch(mixedLeagueAnchor.text, /private-sensitive-label|diagnos|dysphoria/i, "only the approved League meaning survives");

  const moodCareAnchor = coach.memoryPersonalAnchor({
    id: "mood-care",
    kind: "note",
    text: "Alan noticed Lily seemed off and quieter than usual after being criticized; he wants her to feel seen.",
    createdAt: "2026-07-21T13:00:00.000Z"
  }, { cutoff: Date.parse("2026-07-22T12:00:00.000Z"), seed: "stable" });
  assert.equal(moodCareAnchor.kind, "lily-mood-care");
  assert.match(moodCareAnchor.text, /Alan (?:noticed|remembers).*(?:felt off|things felt off|beside you)/i);
  assert.doesNotMatch(moodCareAnchor.text, /criticiz|quiet|diagnos/i, "the safe mood-care meaning omits the raw private detail");

  const topicCases = [
    ["cats", "Lily smiles about cats.", "lily-cats"],
    ["french", "A French-language detail matters to Lily.", "lily-french"],
    ["hydration", "Lily mentioned hydration and water.", "lily-hydration"],
    ["protein", "Lily mentioned a protein detail.", "lily-protein"],
    ["cycle", "Lily logged period and cycle context.", "lily-cycle"]
  ];
  for (const [id, text, expectedKind] of topicCases) {
    const anchor = coach.memoryPersonalAnchor({ id, kind: "note", text, createdAt: "2026-07-20T12:00:00.000Z" }, { cutoff: Date.parse("2026-07-22T12:00:00.000Z"), seed: "stable" });
    assert.equal(anchor.kind, expectedKind);
    assert(!anchor.text.includes(text), `${expectedKind} is a semantic reduction, not copied source prose`);
  }
  const longThoughtAnchor = coach.memoryPersonalAnchor({
    id: "long-thought",
    kind: "note",
    text: "An unfiltered long letter that Alan wanted to preserve. ".repeat(14),
    createdAt: "2026-07-20T12:00:00.000Z"
  }, { cutoff: Date.parse("2026-07-22T12:00:00.000Z"), seed: "stable" });
  assert.equal(longThoughtAnchor.kind, "lily-authentic-voice");
  assert.doesNotMatch(longThoughtAnchor.text, /An unfiltered long letter that Alan wanted to preserve/i);
  assert.equal(coach.memoryPersonalAnchor({ id: "generic-photo", kind: "photo", text: "", createdAt: "2026-07-20T12:00:00.000Z" }, { cutoff: Date.parse("2026-07-22T12:00:00.000Z") }), null, "a generic source shell cannot pretend to be substantial personal context");

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
  const reversalContext = coach.buildCoachContext(baseStore(reversalWeights), "rev-4");
  assert.equal(reversalContext.strongestEvidence.kind, "reversal");
  assert.equal(reversalContext.evidenceRelation.kind, "reversed");
  assert.equal(coach.validateCoachParagraph(coach.buildContextualFallback(reversalContext, []), reversalContext, []).ok, true);

  const noisyWeights = [
    recordWeight("noise-1", "2026-07-18", 150), recordWeight("noise-2", "2026-07-19", 150.1),
    recordWeight("noise-3", "2026-07-20", 149.9), recordWeight("noise-4", "2026-07-21", 150),
    recordWeight("noise-5", "2026-07-22", 150)
  ];
  const noisyContext = coach.buildCoachContext(baseStore(noisyWeights), "noise-5");
  assert.equal(noisyContext.changeDirection, "unchanged");
  assert.equal(coach.validateCoachParagraph(coach.buildContextualFallback(noisyContext, []), noisyContext, []).ok, true);

  const fullFallbackRun = addAllFallbacks(productionStore);
  assert.equal(fullFallbackRun.store.coachMessages.length, 24, "the exact live history always has a valid fallback");
  assert(Math.max(...fullFallbackRun.durations) < 1000, "each fallback is ready inside one second locally");
  const finalFallback = coach.coachForWeight(fullFallbackRun.store, productionWeights.at(-1).id);
  assert.match(finalFallback.text, /151 lb/);
  assert.match(finalFallback.text, /3(?:-day| days)/);
  assert.match(finalFallback.text, /up 2\.5 lb/);
  assert.match(finalFallback.text, /accelerat/i);
  assert.match(finalFallback.text, /about 146 lb/i);
  assert.deepEqual(Object.keys(finalFallback.personalAnchor).sort(), ["approvedText", "id", "semanticAnchorId", "sourceHash", "sourceTimestamp", "sourceType", "specificity"].sort(), "private records retain only the approved anchor and opaque provenance needed for deterministic repair");
  assert(finalFallback.text.includes(finalFallback.personalAnchor.approvedText));
  assert.equal(coach.personalAnchorFromCoachRecord(finalFallback).text, finalFallback.personalAnchor.approvedText);
  assert(!JSON.stringify(finalFallback.personalAnchor).includes(productionStore.memories[0].text), "raw Lily source text is never persisted with the coach anchor");

  const electrolyteReaction = {
    id: "reaction-electrolytes",
    kind: "note",
    text: "she says shes trying to drink more electrolytes",
    createdAt: "2026-07-23T00:32:11.765Z",
    updatedAt: "2026-07-23T00:32:11.765Z"
  };
  const reactionBase = addAllFallbacks(baseStore(productionWeights, { memories: substantialAnchorMemories("reaction-base"), trackerEvents: [] })).store;
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

  const observedMoodNote = {
    id: "observer-mood-note",
    kind: "note",
    text: "Alan noticed Lily seems off today. He is not sure whether it is related to the conflict, and he wants her to know he notices and hopes she feels seen.",
    createdAt: "2026-07-23T00:42:11.765Z",
    updatedAt: "2026-07-23T00:42:11.765Z"
  };
  assert.deepEqual(coach.observerCareSignal(observedMoodNote.text), {
    kind: "observer-mood-support",
    actionId: "observer-mood-support",
    actionSemantic: "noticed-mood-support"
  }, "an explicitly attributed, non-clinical mood observation becomes one safe support action");
  const observedMoodSelection = coach.selectSavedPreference(
    [observedMoodNote],
    Date.parse(observedMoodNote.createdAt),
    []
  );
  assert.equal(observedMoodSelection?.kind, "observer-mood-support", "uncertain conflict language does not suppress the independently supported mood observation");
  const observedMoodBase = addAllFallbacks(baseStore(productionWeights, { memories: substantialAnchorMemories("mood-base"), trackerEvents: [] })).store;
  const withObservedMood = { ...observedMoodBase, memories: [observedMoodNote] };
  const observedMoodRefresh = coach.refreshLatestCoachForSavedMemories(
    withObservedMood,
    [observedMoodNote.id],
    Date.parse(observedMoodNote.createdAt),
    "fallback-test-observer-care",
    Date.parse(observedMoodNote.createdAt)
  );
  assert.equal(observedMoodRefresh.updated, true, "the attributed care observation refreshes only the timely latest coach");
  const observedMoodCoach = coach.coachForWeight(observedMoodRefresh.store, reactionWeight.id);
  assert.equal(observedMoodCoach.actionSemantic, "noticed-mood-support");
  assert.match(observedMoodCoach.text, /Alan noticed/i);
  assert.match(observedMoodCoach.text, /seem|feel/i);
  assert(observedMoodCoach.evidenceReferences.some((reference) => reference.type === "memory" && reference.id === observedMoodNote.id && reference.role === "observer-mood-support"));
  const observedMoodContext = coach.buildCoachContext(observedMoodRefresh.store, reactionWeight.id, {
    privateGoal: 117,
    personalContextCutoff: Date.parse(observedMoodNote.createdAt)
  });
  assert.equal(observedMoodContext.verdict, measurementOnlyContext.verdict, "care context cannot soften or harden the weight verdict");
  assert.equal(observedMoodContext.outlook, measurementOnlyContext.outlook, "care context cannot alter the forecast");
  assert.deepEqual(observedMoodContext.forecastFingerprint, measurementOnlyContext.forecastFingerprint, "care context cannot alter chart geometry");
  assert(!JSON.stringify(coach.publicCoachFacts(observedMoodContext)).includes(observedMoodNote.text), "raw care-note text never reaches the writer");

  const rawMixedBrainEntry = "A pasted third-party transcript includes private-sensitive-label and diagnosis details, then turns into a concrete research and app-building thought.";
  const mixedBrainAnchor = coach.brainThoughtAnchorFromFile({
    id: "brain-mixed-entry",
    name: "uploaded-notes.txt",
    kind: "upload",
    mime: "text/plain",
    sourceText: rawMixedBrainEntry,
    createdAt: "2020-01-01T12:00:00.000Z"
  }, { cutoff: Date.parse("2026-07-22T12:00:00.000Z"), seed: "stable" });
  assert.equal(mixedBrainAnchor.kind, "brain-thought-research-apps", "every Alan-entered Brain item is authentic even when its transport, age, or mixed clauses would fail the old authorship gate");
  assert.match(mixedBrainAnchor.text, /research|app-building/i);
  assert.doesNotMatch(mixedBrainAnchor.text, /transcript|third-party|private-sensitive-label|diagnos/i, "only the concrete safe topic survives reduction");
  const sensitiveOnlyBrainAnchor = coach.brainThoughtAnchorFromFile({
    id: "brain-private-entry",
    sourceText: "A private-sensitive-label and third-party diagnosis are the whole short entry.",
    createdAt: "2020-01-02T12:00:00.000Z"
  }, { cutoff: Date.parse("2026-07-22T12:00:00.000Z"), seed: "stable" });
  assert.equal(sensitiveOnlyBrainAnchor.kind, "brain-thought-letter", "a sensitive-only authentic entry reduces to a safe long-thought and trust meaning rather than being rejected");
  assert.match(sensitiveOnlyBrainAnchor.text, /Brain|Alan/);
  assert.doesNotMatch(sensitiveOnlyBrainAnchor.text, /private-sensitive-label|third-party|diagnos/i);
  assert.equal(coach.brainThoughtAnchorFromFile({
    id: "brain-photo-shell",
    name: "Photo 1.jpg",
    title: "Photo 1",
    createdAt: "2026-07-22T15:30:00.000Z"
  }, { cutoff: Date.parse("2026-07-22T16:05:00.000Z") }), null, "a media filename/title shell is not substantial personal context");

  const specificFigureThought = coach.brainThoughtAnchorFromFile({
    id: "brain-specific-figure",
    sourceText: "I am debating the loading and unloading hysteresis for the constrained 3x3 module in Figure 2, especially whether the bottom row should have two plots or three plots.",
    sourceCreatedAt: "2026-07-30T21:48:03.114Z"
  }, { cutoff: Date.parse("2026-07-30T22:00:00.000Z") });
  const specificAppThought = coach.brainThoughtAnchorFromFile({
    id: "brain-specific-app",
    sourceText: "I am fixing Virtual Violin bow tracking so the cursor follows the played string instead of jumping to the neighboring string.",
    lifeLeverageHighlightText: "Virtual Violin bow tracking follows the played string",
    sourceCreatedAt: "2026-07-30T21:49:03.114Z"
  }, { cutoff: Date.parse("2026-07-30T22:00:00.000Z") });
  assert.equal(specificFigureThought.specificity, "source-specific");
  assert.match(specificFigureThought.text, /3x3|hysteresis|Figure 2/i, "a safe Brain reduction retains the actual research decision instead of only its broad topic");
  assert.match(specificFigureThought.text, /two-versus-three-plot bottom row/i);
  assert.match(specificFigureThought.text, /same close attention is here with you/i, "the safe concrete detail carries an explicit care meaning instead of becoming decorative retrieval proof");
  assert.doesNotMatch(specificFigureThought.text, /;/, "source-specific care framing is a complete human sentence, not semicolon glue");
  assert.match(specificAppThought.text, /Virtual Violin bow tracking/i, "a second same-family note retains its own concrete subject");
  assert.notEqual(specificFigureThought.text, specificAppThought.text);
  assert(!Object.values(coach.BRAIN_THOUGHT_ANCHOR_COPY).flat().includes(specificFigureThought.text), "source-specific Brain context is not one of the fixed topic sentences");
  const migratedSpecificAnchor = coach.personalAnchorFromCoachRecord({
    personalAnchor: {
      sourceType: "brain-thought-anchor",
      id: "legacy-specific-figure",
      sourceTimestamp: "2026-07-30T21:48:03.114Z",
      sourceHash: "legacy-safe-hash",
      semanticAnchorId: "brain-thought-research",
      approvedText: "Alan is in Brain thinking through the constrained 3x3 loading/unloading hysteresis plot and whether figure 2 needs two bottom-row plots or three",
      specificity: "source-specific"
    }
  });
  assert.match(migratedSpecificAnchor.text, /Figure 2's constrained 3x3 loading\/unloading hysteresis and a two-versus-three-plot bottom row/i, "a private legacy sanitized anchor upgrades without needing the raw Brain note");
  assert.match(migratedSpecificAnchor.text, /same close attention is here with you/i);

  const currentLiveWeights = liveWeightsThroughJul30();
  const currentLiveHistory = addAllFallbacks(baseStore(currentLiveWeights, { memories: substantialAnchorMemories("current-live"), trackerEvents: savedContext().trackerEvents })).store;
  const currentLiveLatest = currentLiveWeights.at(-1);
  const currentLiveContext = coach.buildCoachContext(currentLiveHistory, currentLiveLatest.id, { relationshipSupport: specificFigureThought });
  const currentLivePrevious = coach.causalPreviousCoachMessages(currentLiveHistory, currentLiveLatest, 10);
  const currentLiveFallback = coach.buildContextualFallbackResult(currentLiveContext, currentLivePrevious);
  assert(currentLiveFallback.text.startsWith(specificFigureThought.text), "the exact current 32-weight history has a compliant Brain-led fallback instead of failing live refresh");
  assert.match(currentLiveFallback.text, /151 lb/);
  assert.match(currentLiveFallback.text, /about 156 lb/i);
  assert(currentLiveFallback.text.indexOf(currentLiveFallback.action.text) > currentLiveFallback.text.toLowerCase().indexOf("outlook"), "the exact current Brain-led fallback finishes the analysis before giving its one action");
  assert.deepEqual(coach.validateCoachParagraph(currentLiveFallback.text, currentLiveContext, currentLivePrevious, { privateGoal: 117 }).errors, []);

  const aug2Weights = liveWeightsThroughAug2();
  assert.equal(aug2Weights.length, 34, "the Aug 2 regression carries the complete 34-weigh-in causal history");
  const aug2Store = baseStore(aug2Weights, { memories: substantialAnchorMemories("aug2"), trackerEvents: savedContext().trackerEvents });
  const aug2Latest = aug2Weights.at(-1);
  const aug2Context = coach.buildCoachContext(aug2Store, aug2Latest.id, { privateGoal: 117 });
  assert.equal(aug2Context.currentWeight, 150.5);
  assert.equal(Number(aug2Context.latestDailyChange.toFixed(1)), -1.1, "Aug 2 is a meaningful one-day correction, not another wrong-way result");
  assert.equal(Number(aug2Context.movements.days3.toFixed(1)), -0.5);
  assert.equal(Number(aug2Context.movements.days28.toFixed(1)), 1.3);
  assert.equal(aug2Context.strongestEvidence.kind, "short-broad-contrast", "the fresh three-day correction wins over another recycled one-day-reversal argument");
  assert.equal(aug2Context.strongestEvidence.windowDays, 3);
  assert.equal(Number(aug2Context.strongestEvidence.movement.toFixed(1)), -0.5);
  assert.equal(aug2Context.strongestEvidence.comparisonWindowDays, 28);
  assert.equal(Number(aug2Context.strongestEvidence.comparisonMovement.toFixed(1)), 1.3);
  assert.equal(aug2Context.verdict, "good-progress", "today's real correction is approved without pretending the broad trend is fixed");
  assert.equal(aug2Context.analysisPlan.verdict, "good-progress");
  assert.equal(Number(aug2Context.outlook.toFixed(1)), 157.4);
  assert.equal(Number(aug2Context.outlookChange.toFixed(2)), 0.75);
  assert.equal(aug2Context.outlookDirection, "worsened");
  assert.equal(aug2Context.outlookEvidenceRelation, "contradicts", "the slow outlook honestly contradicts the fresh correction instead of changing its verdict");
  const aug2HomologousWeights = aug2Weights.slice(-29);
  const aug2HomologousContext = coach.buildCoachContext(
    baseStore(aug2HomologousWeights, { memories: substantialAnchorMemories("aug2-homologous"), trackerEvents: savedContext().trackerEvents }),
    aug2HomologousWeights.at(-1).id,
    { privateGoal: 117 }
  );
  assert.equal(aug2HomologousContext.strongestEvidence.kind, "short-broad-contrast", "the same causal evidence keeps the same story without a magic 30-entry gate");
  assert.equal(Number(aug2HomologousContext.strongestEvidence.movement.toFixed(1)), -0.5);
  assert.equal(Number(aug2HomologousContext.strongestEvidence.comparisonMovement.toFixed(1)), 1.3);

  const aug2DragonAnchor = coach.brainThoughtAnchorFromFile({
    id: "5f127289-5d50-4d53-9f19-ef878114662f",
    sourceText: "if we know where the enemy team is, we can do dragon if its safe",
    sourceCreatedAt: "2026-07-31T02:10:27.128Z"
  }, { cutoff: Date.parse("2026-08-02T16:58:44.053Z") });
  assert(aug2DragonAnchor, "the newest safe Brain thought produces a usable personal anchor");
  assert.equal(aug2DragonAnchor.specificity, "source-specific");
  assert.match(aug2DragonAnchor.text, /enemy (?:team )?position|dragon call|dragon.*safe/i, "the approved anchor keeps the concrete League decision rather than collapsing to a generic topic");
  assert.doesNotMatch(aug2DragonAnchor.text, /;/, "the approved personal detail is already a natural standalone sentence");
  const aug2PersonalContext = coach.buildCoachContext(aug2Store, aug2Latest.id, { privateGoal: 117, relationshipSupport: aug2DragonAnchor });
  const aug2PersonalFallback = coach.buildContextualFallbackResult(aug2PersonalContext, []);
  assert.equal(aug2PersonalFallback.text.indexOf(aug2DragonAnchor.text), 0, "the newest specific Brain thought leads the Aug 2 memo");
  assert.match(aug2PersonalFallback.text.slice(aug2DragonAnchor.text.length), /^[.!?]\s+/, "the Brain anchor ends as its own sentence before measurement analysis begins");
  assertParagraph(aug2PersonalFallback.text, "Aug 2 specific-Brain fallback");
  assert.equal(coach.validateCoachParagraph(aug2PersonalFallback.text, aug2PersonalContext, [], { privateGoal: 117 }).ok, true);
  const aug2NaturalCandidate = `${aug2DragonAnchor.text}. Real progress: 150.5 lb is 1.1 lb lower today. Over 3 days, weight fell 0.5 lb, while the 28-day view is 1.3 lb higher. The 1-year outlook edged upward to about 157 lb. ${aug2PersonalContext.actionRealizations[0].text} More is possible.`;
  assert.deepEqual(
    coach.validateCoachParagraph(aug2NaturalCandidate, aug2PersonalContext, [], { privateGoal: 117, allowNaturalProse: true }).errors,
    [],
    "natural Aug 2 prose accepts grounded while/edged-upward language without loosening the exact Brain anchor, action, or numbers"
  );
  const misplacedAug2Anchor = `Today, ${aug2NaturalCandidate}`;
  const misplacedAug2Errors = coach.validateCoachParagraph(misplacedAug2Anchor, aug2PersonalContext, [], { privateGoal: 117, allowNaturalProse: true }).errors;
  assert(misplacedAug2Errors.includes("personal-anchor-not-leading") || misplacedAug2Errors.includes("personal-anchor-glued"), "source-specific Brain context cannot be demoted behind generic copy");
  const paraphrasedAug2Action = aug2NaturalCandidate.replace(aug2PersonalContext.actionRealizations[0].text, "Take a comfortable walk after eating.");
  const paraphrasedAug2Errors = coach.validateCoachParagraph(paraphrasedAug2Action, aug2PersonalContext, [], { privateGoal: 117, allowNaturalProse: true }).errors;
  assert(paraphrasedAug2Errors.includes("required-action-realization") || paraphrasedAug2Errors.includes("extra-action"), "the writer cannot paraphrase or add to the single approved action");

  const formerlyExhaustingAnchor = {
    id: "aug2-formerly-exhausting-anchor",
    sourceType: "brain-thought-anchor",
    kind: "brain-thought-games",
    text: "Alan is still weighing the thought if we know where the enemy team is, we can do dragon if its safe in Brain and that same close attention is here with you",
    createdAt: "2026-07-31T02:10:27.128Z",
    sourceHash: "aug2-formerly-exhausting-hash",
    specificity: "source-specific"
  };
  assert.equal(coach.coachWordCount(formerlyExhaustingAnchor.text), 32, "the regression retains the exact long-anchor pressure that exhausted all 4,608 old arrangements");
  const formerlyExhaustingContext = coach.buildCoachContext(aug2Store, aug2Latest.id, { privateGoal: 117, relationshipSupport: formerlyExhaustingAnchor });
  const formerlyExhaustingFallback = coach.buildContextualFallbackResult(formerlyExhaustingContext, []);
  assertParagraph(formerlyExhaustingFallback.text, "formerly exhausting Aug 2 fallback");
  assert(formerlyExhaustingFallback.text.startsWith(formerlyExhaustingAnchor.text), "the long authentic anchor survives fallback compaction");
  assert.match(formerlyExhaustingFallback.text.slice(formerlyExhaustingAnchor.text.length), /^[.!?]\s+/, "even the long anchor remains a standalone sentence");
  assert.equal(coach.validateCoachParagraph(formerlyExhaustingFallback.text, formerlyExhaustingContext, [], { privateGoal: 117 }).ok, true, "the old word-count exhaustion now produces a fully validated fallback");
  let formerlyExhaustingWriterCalls = 0;
  const formerlyExhaustingGeneration = await coach.generateCoachParagraph(formerlyExhaustingContext, [], {
    apiKey: "test-key",
    privateGoal: 117,
    timeoutMs: 3000,
    fetchImpl: async () => {
      formerlyExhaustingWriterCalls += 1;
      return response(JSON.stringify({ candidates: [] }));
    }
  });
  assert(formerlyExhaustingWriterCalls > 0, "even a fallback-construction edge case cannot prevent the writer request from running");
  assert.match(formerlyExhaustingGeneration.status, /^fallback-writer-/);
  assertParagraph(formerlyExhaustingGeneration.text, "formerly exhausting generated fallback");

  const overwrittenAug2Text = "The trend moved against the plan. Alan noticed things felt off and wants this check-in to feel like he is beside you, not judging you. Today lands at 150.5 lb and is down 1.1 lb. A 1-day move of down 1.1 lb reversed the earlier direction. A worsened 1-year trend outlook now reads about 157 lb. Give yourself one easy walk after eating next. This number cannot define you!";
  const overwrittenAug2Action = coach.COACH_ACTION_CATALOG.find((action) => action.text === "Give yourself one easy walk after eating next.");
  assert(overwrittenAug2Action, "the exact failed live action remains identifiable for signature-only archival");
  const aug2FirstAccepted = coach.createCoachMessageRecord(
    aug2PersonalContext,
    overwrittenAug2Text,
    "fallback-contextual",
    "2026-08-02T16:58:44.196Z",
    null,
    { action: overwrittenAug2Action, structureId: "historic-aug2-failure", previousMessages: [] }
  );
  const aug2Replacement = coach.createCoachMessageRecord(
    aug2PersonalContext,
    aug2PersonalFallback.text,
    "generated-and-critic-approved",
    "2026-08-02T16:59:02.000Z",
    aug2FirstAccepted,
    { action: aug2PersonalFallback.action, structureId: aug2PersonalFallback.structureId, previousMessages: [aug2FirstAccepted] }
  );
  assert.notEqual(coach.openingFingerprint(aug2Replacement.text), coach.openingFingerprint(aug2FirstAccepted.text));
  assert.notEqual(coach.closingFingerprint(aug2Replacement.text), coach.closingFingerprint(aug2FirstAccepted.text));
  assert(Array.isArray(aug2Replacement.acceptedCopyHistory) && aug2Replacement.acceptedCopyHistory.length >= 1, "replacement preserves bounded signatures for accepted copy that is no longer visible");
  const archivedAug2Copy = aug2Replacement.acceptedCopyHistory.find((entry) => (
    entry.openingFingerprint === coach.openingFingerprint(aug2FirstAccepted.text)
    && entry.closingFingerprint === coach.closingFingerprint(aug2FirstAccepted.text)
  ));
  assert(archivedAug2Copy, "the overwritten Aug 2 opening and closing remain in originality memory");
  assert.deepEqual(Object.keys(archivedAug2Copy).sort(), ["argumentFingerprint", "closingFingerprint", "normalizedFingerprint", "openingFingerprint", "orderedTrigrams"].sort(), "accepted-copy history stores signatures only, never the replaced paragraph");
  assert(!JSON.stringify(aug2Replacement.acceptedCopyHistory).includes(aug2FirstAccepted.text), "accepted-copy history does not retain full private coaching prose");
  assert.equal(archivedAug2Copy.openingFingerprint, "the trend moved against the plan", "the exact failed live opening remains blocked after replacement");
  assert.equal(archivedAug2Copy.closingFingerprint, "this number cannot define you", "the exact failed live closing remains blocked after replacement");
  const archivedReplayErrors = coach.noveltyErrors(aug2FirstAccepted.text, aug2PersonalContext, [aug2Replacement], overwrittenAug2Action);
  assert(archivedReplayErrors.includes("repeat-opening"), "an overwritten opening cannot return after a coach refresh");
  assert(archivedReplayErrors.includes("repeat-closing"), "an overwritten closing cannot return after a coach refresh");

  assert.equal(coach.coachNeedsRepair({
    status: "fallback-contextual",
    diagnostics: { stage: "fallback-created", attemptCount: 0 }
  }), true, "an attempt-zero contextual fallback remains eligible for checked generation and cannot become permanently stuck");
  const retryContextA = coach.buildCoachContext(aug2Store, aug2Latest.id, { privateGoal: 100, relationshipSupport: aug2DragonAnchor });
  const retryContextB = coach.buildCoachContext(aug2Store, aug2Latest.id, { privateGoal: 149, relationshipSupport: aug2DragonAnchor });
  const retryInitial = coach.createCoachMessageRecord(retryContextA, aug2PersonalFallback.text, "fallback-contextual", "2026-08-02T17:00:00.000Z", null, {
    action: aug2PersonalFallback.action,
    structureId: aug2PersonalFallback.structureId,
    previousMessages: [],
    diagnostics: { stage: "fallback-created", attemptCount: 0, rejectionCodes: [], latencyMs: 0 }
  });
  const retryGoalVariant = coach.createCoachMessageRecord(retryContextB, aug2PersonalFallback.text, "fallback-contextual", "2026-08-02T17:00:01.000Z", null, {
    action: aug2PersonalFallback.action,
    structureId: aug2PersonalFallback.structureId,
    previousMessages: [],
    diagnostics: { stage: "fallback-created", attemptCount: 0, rejectionCodes: [], latencyMs: 0 }
  });
  assert.equal(retryInitial.generationInputHash, retryGoalVariant.generationInputHash, "the private goal cannot change retry identity or generation behavior");
  const retryOnce = coach.createCoachMessageRecord(retryContextA, aug2PersonalFallback.text, "fallback-timeout", "2026-08-02T17:00:02.000Z", retryInitial, {
    action: aug2PersonalFallback.action,
    structureId: aug2PersonalFallback.structureId,
    previousMessages: [retryInitial],
    diagnostics: { stage: "timeout", attemptCount: 1, rejectionCodes: ["timeout"], latencyMs: 8000 }
  });
  const retryTwice = coach.createCoachMessageRecord(retryContextA, aug2PersonalFallback.text, "fallback-timeout", "2026-08-02T17:00:03.000Z", retryOnce, {
    action: aug2PersonalFallback.action,
    structureId: aug2PersonalFallback.structureId,
    previousMessages: [retryOnce],
    diagnostics: { stage: "timeout", attemptCount: 1, rejectionCodes: ["timeout"], latencyMs: 8000 }
  });
  assert.equal(retryOnce.diagnostics.attemptCount, 1);
  assert.equal(retryTwice.diagnostics.attemptCount, 2, "same-input writer attempts accumulate instead of resetting to one forever");
  assert.equal(coach.coachNeedsRepair(retryOnce), true);
  assert.equal(coach.coachNeedsRepair(retryTwice), false, "two failed attempts stop the background retry loop");
  const changedAnchor = { ...aug2DragonAnchor, id: "aug2-new-anchor", createdAt: "2026-08-02T17:01:00.000Z", sourceHash: "aug2-new-anchor-hash" };
  const changedContext = coach.buildCoachContext(aug2Store, aug2Latest.id, { privateGoal: 100, relationshipSupport: changedAnchor });
  const changedAttempt = coach.createCoachMessageRecord(changedContext, coach.buildContextualFallbackResult(changedContext, []).text, "fallback-timeout", "2026-08-02T17:01:01.000Z", retryTwice, {
    diagnostics: { stage: "timeout", attemptCount: 1, rejectionCodes: ["timeout"], latencyMs: 8000 }
  });
  assert.equal(changedAttempt.diagnostics.attemptCount, 1, "a genuinely new approved context earns a fresh bounded generation attempt");

  const cooldownWeights = [
    recordWeight("cooldown-prior", "2026-07-21", 150),
    recordWeight("cooldown-current", "2026-07-22", 150.2)
  ];
  const cooldownStore = {
    ...baseStore(cooldownWeights, { memories: substantialAnchorMemories("cooldown"), trackerEvents: [] }),
    coachMessages: [{
      id: "cooldown-coach",
      weightId: "cooldown-prior",
      text: "prior",
      createdAt: "2026-07-21T16:00:00.000Z",
      updatedAt: "2026-07-21T16:00:00.000Z",
      evidenceReferences: [{ type: "brain-letter", id: "same-source", role: "boyfriend-yap" }]
    }]
  };
  const sameSourceFile = { id: "same-source", sourceText: "A research app thought.", createdAt: "2026-07-22T15:00:00.000Z" };
  const freshSourceFile = { id: "fresh-source", sourceText: "A music thought.", createdAt: "2026-07-22T14:00:00.000Z" };
  const freshBrainSelection = await coach.fetchLatestBrainThoughtAnchor(cooldownStore, {
    apiBase: "https://brain.test",
    weightId: "cooldown-current",
    cutoff: Date.parse("2026-07-22T16:05:00.000Z"),
    fetchImpl: async () => ({ ok: true, json: async () => ({ files: [sameSourceFile, freshSourceFile] }) })
  });
  assert.equal(freshBrainSelection.id, "fresh-source", "cooldown follows the opaque source across brain-letter and brain-thought roles");
  const cooledOnlySelection = await coach.fetchLatestBrainThoughtAnchor(cooldownStore, {
    apiBase: "https://brain.test",
    weightId: "cooldown-current",
    cutoff: Date.parse("2026-07-22T16:05:00.000Z"),
    fetchImpl: async () => ({ ok: true, json: async () => ({ files: [sameSourceFile] }) })
  });
  assert.equal(cooledOnlySelection, null, "a selector never falls back to an anchor still on cooldown");
  const semanticCooldownStore = {
    ...cooldownStore,
    coachMessages: [{
      ...cooldownStore.coachMessages[0],
      id: "semantic-cooldown-coach",
      evidenceReferences: [{ type: "memory-personal-anchor", id: "lily-cat-source", role: "lily-cats" }]
    }]
  };
  const semanticallyCooledSelection = await coach.fetchLatestBrainThoughtAnchor(semanticCooldownStore, {
    apiBase: "https://brain.test",
    weightId: "cooldown-current",
    cutoff: Date.parse("2026-07-22T16:05:00.000Z"),
    fetchImpl: async () => ({ ok: true, json: async () => ({ files: [{ id: "different-cat-source", sourceText: "A saved thought about cats.", createdAt: "2026-07-22T15:05:00.000Z" }] }) })
  });
  assert.equal(semanticallyCooledSelection, null, "semantic cooldown rotates a cats anchor even when Lily and Brain use different source types and ids");
  const sameTopicBrainStore = {
    ...cooldownStore,
    coachMessages: [{
      ...cooldownStore.coachMessages[0],
      id: "same-topic-brain-coach",
      evidenceReferences: [{ type: "brain-thought-anchor", id: "older-app-source", role: "brain-thought-apps" }]
    }]
  };
  const newerSameTopicSelection = await coach.fetchLatestBrainThoughtAnchor(sameTopicBrainStore, {
    apiBase: "https://brain.test",
    weightId: "cooldown-current",
    cutoff: Date.parse("2026-07-22T16:05:00.000Z"),
    fetchImpl: async () => ({ ok: true, json: async () => ({ files: [{
      id: "newer-app-source",
      sourceText: "I am changing Virtual Violin bow tracking so the active string stays visible.",
      lifeLeverageHighlightText: "Virtual Violin bow tracking keeps the active string visible",
      createdAt: "2026-07-22T15:08:00.000Z"
    }] }) })
  });
  assert.equal(newerSameTopicSelection.id, "newer-app-source", "a genuinely new Brain source is not discarded merely because an older note shared its broad topic");

  const rawBrainLetter = [
    "Dear Lily, I am your boyfriend and I love you.",
    "I am the nerdy PhD boyfriend who likes to yap honestly about everything because that is how I show you my real self.",
    "You told me the yapping feels genuine, and I want us to be happy and keep enjoying League together.",
    "This private source also contains depression, anxiety, self-harm, sexual attraction, breakup fears, and other details that must never enter a weight memo."
  ].join(" ");
  const brainFile = {
    id: "brain-letter-one",
    name: "brain-text-20260722-160100.pdf",
    mime: "application/pdf",
    kind: "generated pdf",
    generatedNoteLayoutVersion: "test-authored-note-v1",
    sourceText: rawBrainLetter,
    sourceCreatedAt: "2026-07-22T16:01:02.459Z",
    createdAt: "2026-07-22T16:01:02.459Z"
  };
  const brainSupport = coach.brainRelationshipSupportFromFile(brainFile, {
    cutoff: Date.parse("2026-07-22T16:02:00.000Z"),
    operationalNow: Date.parse("2026-07-22T16:02:00.000Z")
  });
  assert.deepEqual(brainSupport, {
    id: brainFile.id,
    sourceType: "brain-letter",
    kind: "boyfriend-yap-phd-league",
    text: coach.BRAIN_RELATIONSHIP_COPY["boyfriend-yap-phd-league"],
    createdAt: brainFile.createdAt,
    sourceHash: require("node:crypto").createHash("sha256").update(rawBrainLetter).digest("hex")
  }, "an Alan-authored Lily letter becomes only a bounded, approved relationship sentence plus source identity");
  assert.doesNotMatch(brainSupport.text, /depress|anxi|self-harm|sex|attract|breakup|weight/i, "sensitive raw letter material cannot enter the approved sentence");

  const brainBaseCoach = coach.coachForWeight(observedMoodBase, reactionWeight.id);
  const brainRefresh = coach.refreshLatestCoachForBrainRelationship(
    observedMoodBase,
    brainSupport,
    "fallback-test-brain-relationship",
    Date.parse("2026-07-22T16:02:00.000Z")
  );
  assert.equal(brainRefresh.updated, true, "a fresh letter can add one relationship-safe sentence to the latest coach");
  const brainCoach = coach.coachForWeight(brainRefresh.store, reactionWeight.id);
  assert.equal(brainCoach.id, brainBaseCoach.id, "Brain warmth refresh preserves the coach id");
  assert.equal(brainCoach.createdAt, brainBaseCoach.createdAt, "Brain warmth refresh preserves coach creation time");
  assert.equal((brainCoach.text.match(/Your nerdy PhD boyfriend/g) || []).length, 1);
  assert(brainCoach.evidenceReferences.some((reference) => reference.type === "brain-letter" && reference.id === brainFile.id && reference.sourceHash === brainSupport.sourceHash && reference.sourceCreatedAt === brainSupport.createdAt));
  assert(!JSON.stringify(brainCoach).includes(rawBrainLetter), "the raw Brain letter is never persisted in the coach record");
  const brainContext = coach.buildCoachContext(brainRefresh.store, reactionWeight.id, {
    privateGoal: 117,
    personalContextCutoff: Date.parse(observedMoodNote.createdAt),
    relationshipSupport: brainSupport
  });
  const brainPreviousMessages = coach.causalPreviousCoachMessages(brainRefresh.store, reactionWeight, 10);
  const brainValidation = coach.validateCoachParagraph(brainCoach.text, brainContext, brainPreviousMessages, { privateGoal: 117 });
  assert.equal(brainValidation.ok, true, brainValidation.errors.join(", "));
  assert(brainValidation.wordCount >= coach.COACH_RELATIONSHIP_MIN_WORDS && brainValidation.wordCount <= coach.COACH_RELATIONSHIP_MAX_WORDS);
  assert.equal(brainContext.verdict, observedMoodContext.verdict, "relationship warmth cannot change the weight verdict");
  assert.equal(brainContext.outlook, observedMoodContext.outlook, "relationship warmth cannot change the outlook");
  assert.deepEqual(brainContext.forecastFingerprint, observedMoodContext.forecastFingerprint, "relationship warmth cannot change chart geometry");
  assert(!JSON.stringify(coach.publicCoachFacts(brainContext)).includes(rawBrainLetter), "the raw letter never enters writer or critic facts");
  assert.equal(brainContext.analysisPlan.relationshipSupport.kind, "boyfriend-yap-phd-league");
  assert(!JSON.stringify(brainContext.analysisPlan).includes(brainSupport.sourceHash), "source hashes stay out of the writer analysis plan");
  assert.equal(brainCoach.personalAnchor.semanticAnchorId, "boyfriend-yap-phd-league");
  assert.equal(brainCoach.personalAnchor.approvedText, brainSupport.text);
  const staleBrainCoach = { ...brainCoach, styleVersion: "coach-style-before-personal-anchor" };
  const staleBrainStore = {
    ...brainRefresh.store,
    coachMessages: [staleBrainCoach, ...brainRefresh.store.coachMessages.filter((message) => message.id !== brainCoach.id)]
  };
  const refreshedBrainStyle = coach.refreshLatestCoachStyleInStore(staleBrainStore, "fallback-test-brain-style", Date.parse("2026-07-22T16:04:00.000Z"));
  assert.equal(refreshedBrainStyle.updated, true, "style repair can rebuild a Brain-anchored coach without silently selecting a different Lily anchor");
  const refreshedBrainStyleRecord = coach.coachForWeight(refreshedBrainStyle.store, reactionWeight.id);
  assert.deepEqual(refreshedBrainStyleRecord.personalAnchor, brainCoach.personalAnchor, "sanitized Brain anchor provenance and approved text survive style repair exactly");
  const reconstructedBrainAnchor = coach.personalAnchorFromCoachRecord(refreshedBrainStyleRecord);
  const reconstructedBrainContext = coach.buildCoachContext(refreshedBrainStyle.store, reactionWeight.id, {
    privateGoal: 117,
    personalContextCutoff: Date.parse(observedMoodNote.createdAt),
    relationshipSupport: reconstructedBrainAnchor
  });
  const reconstructedBrainValidation = coach.validateCoachParagraph(refreshedBrainStyleRecord.text, reconstructedBrainContext, brainPreviousMessages, { privateGoal: 117 });
  assert.equal(reconstructedBrainValidation.ok, true, `persisted approved anchor reconstructs the exact validation context: ${reconstructedBrainValidation.errors.join(", ")}`);
  assert.equal(coach.brainRelationshipSupportAvailable(brainRefresh.store, brainSupport, "different-weight"), false, "one Brain letter cannot be reused by another weight memo");
  const repeatedBrainRefresh = coach.refreshLatestCoachForBrainRelationship(
    brainRefresh.store,
    brainSupport,
    "fallback-test-brain-relationship",
    Date.parse("2026-07-22T16:03:00.000Z")
  );
  assert.equal(repeatedBrainRefresh.updated, false);
  assert.equal(repeatedBrainRefresh.alreadyCurrent, true, "the same Brain relationship refresh is idempotent");
  const mockedBrainFetch = async () => ({ ok: true, json: async () => ({ files: [brainFile] }) });
  assert.equal(coach.resolveBrainApiBase(undefined, "https://brain.test/"), "https://brain.test", "an omitted per-call override must retain the configured Brain service instead of becoming the literal string undefined");
  assert.equal(await coach.fetchLatestBrainRelationshipSupport(brainRefresh.store, {
    apiBase: "https://brain.test",
    fetchImpl: mockedBrainFetch,
    cutoff: Date.parse("2026-07-22T16:02:00.000Z"),
    operationalNow: Date.parse("2026-07-22T16:02:00.000Z")
  }), null, "a Brain letter already used once is skipped on future coaching");
  assert.equal(await coach.fetchLatestBrainRelationshipSupport(observedMoodRefresh.store, {
    apiBase: "https://brain.test",
    fetchImpl: async () => { throw new Error("offline"); },
    cutoff: Date.parse("2026-07-22T16:02:00.000Z"),
    operationalNow: Date.parse("2026-07-22T16:02:00.000Z")
  }), null, "Brain downtime leaves the ordinary coach path available without leaking an error");
  assert.equal(coach.brainRelationshipSupportFromFile({ ...brainFile, id: "unrelated", sourceText: "A long unrelated note without Lily relationship signals. ".repeat(8) }, {
    cutoff: Date.parse("2026-07-22T16:02:00.000Z"),
    operationalNow: Date.parse("2026-07-22T16:02:00.000Z")
  }), null, "an unrelated Brain note cannot become relationship copy");
  assert.equal(coach.brainRelationshipSupportFromFile({
    ...brainFile,
    id: "uploaded-transcript",
    name: "uploaded-interview.pdf",
    kind: "file",
    generatedNoteLayoutVersion: "",
    sourceText: "I can yap about a game and my random thoughts for a long time. ".repeat(8)
  }, {
    cutoff: Date.parse("2026-07-22T16:02:00.000Z"),
    operationalNow: Date.parse("2026-07-22T16:02:00.000Z")
  }), null, "uploaded or third-party text cannot masquerade as Alan-authored Brain yapping");
  assert.equal(coach.brainRelationshipSupportFromFile({
    ...brainFile,
    id: "sensitive-generic-yap",
    sourceText: "I am yapping about my depression and weight because I have a lot of random thoughts about medication. ".repeat(5)
  }, {
    cutoff: Date.parse("2026-07-22T16:02:00.000Z"),
    operationalNow: Date.parse("2026-07-22T16:02:00.000Z")
  }), null, "a generic yap with sensitive context is excluded instead of generating invented relationship copy");
  assert.equal(coach.brainRelationshipSupportFromFile({
    ...brainFile,
    id: "third-party-generic-yap",
    sourceText: "I started yapping about my coworker and what he said, then I kept rambling about his private situation. ".repeat(5)
  }, {
    cutoff: Date.parse("2026-07-22T16:02:00.000Z"),
    operationalNow: Date.parse("2026-07-22T16:02:00.000Z")
  }), null, "a generic third-party story cannot be converted into boyfriend-authenticity copy");

  const delayedWeight = recordWeight("delayed-brain-weight", "2026-07-25", 150.5, "T19:23:00.749Z");
  const authenticGameYapText = [
    "I started with one small game thought and somehow turned it into a full yap.",
    "That is honestly how my brain works: I keep following a random thought until it becomes a whole story.",
    "I like sharing the unpolished version instead of pretending every thought arrived perfectly organized.",
    "The point is not the game itself; it is that the rambling is part of my real voice."
  ].join(" ");
  const delayedBrainFile = {
    id: "brain-authentic-yap-delayed",
    name: "brain-text-20260725-192351.pdf",
    mime: "application/pdf",
    kind: "generated pdf",
    generatedNoteLayoutVersion: "test-authored-note-v1",
    sourceText: authenticGameYapText,
    sourceCreatedAt: "2026-07-25T19:23:51.301Z",
    createdAt: "2026-07-25T19:23:51.301Z"
  };
  const delayedBrainSupport = coach.brainRelationshipSupportFromFile(delayedBrainFile, {
    earliest: Date.parse(delayedWeight.createdAt) - coach.BRAIN_WEIGHT_CONTEXT_LOOKBACK_MS,
    cutoff: Date.parse(delayedWeight.createdAt) + coach.BRAIN_WEIGHT_INDEX_GRACE_MS,
    operationalNow: Date.parse("2026-07-25T19:24:00.000Z")
  });
  assert.equal(delayedBrainSupport.kind, "boyfriend-authentic-game-yap", "ordinary first-person game yapping becomes a safe authentic connection cue without requiring love-letter keywords");
  assert(coach.BRAIN_RELATIONSHIP_COPY[delayedBrainSupport.kind].includes(delayedBrainSupport.text));
  assert.equal(coach.brainSourceWithinWeightWindow(delayedWeight, delayedBrainSupport, Date.parse("2026-07-25T19:24:00.000Z")), true, "a Brain upload finishing 51 seconds after its weight remains in the indexing grace window");
  assert.equal(coach.brainSourceWithinWeightWindow(delayedWeight, { ...delayedBrainSupport, createdAt: "2026-07-25T19:29:01.000Z" }, Date.parse("2026-07-25T19:30:00.000Z")), false, "an unrelated later Brain source cannot drift into the weigh-in");

  const delayedBase = addAllFallbacks(baseStore([...productionWeights, delayedWeight], { memories: substantialAnchorMemories("delayed-base"), trackerEvents: [] })).store;
  const delayedBefore = coach.coachRefreshPreservationSnapshot(delayedBase, delayedWeight.id);
  const delayedRefresh = coach.refreshLatestCoachForBrainRelationship(
    delayedBase,
    delayedBrainSupport,
    "fallback-test-delayed-brain-authenticity",
    Date.parse("2026-07-25T19:24:00.000Z")
  );
  assert.equal(delayedRefresh.updated, true, "the late-indexed Brain entry repairs the latest weight memo instead of leaving weight-only copy");
  const delayedCoach = coach.coachForWeight(delayedRefresh.store, delayedWeight.id);
  assert(delayedCoach.text.includes(delayedBrainSupport.text));
  assert(delayedCoach.evidenceReferences.some((reference) => reference.type === "brain-letter" && reference.id === delayedBrainFile.id));
  assert(!JSON.stringify(delayedCoach).includes(authenticGameYapText), "the delayed raw Brain entry is never persisted");
  assert.equal(coach.assertCoachRefreshPreserved(delayedBefore, coach.coachRefreshPreservationSnapshot(delayedRefresh.store, delayedWeight.id)), true);
  const delayedContext = coach.buildCoachContext(delayedRefresh.store, delayedWeight.id, { privateGoal: 117, relationshipSupport: delayedBrainSupport });
  const delayedValidation = coach.validateCoachParagraph(delayedCoach.text, delayedContext, coach.causalPreviousCoachMessages(delayedRefresh.store, delayedWeight, 10), { privateGoal: 117 });
  assert.equal(delayedValidation.ok, true, delayedValidation.errors.join(", "));

  const olderBrainFile = {
    ...delayedBrainFile,
    id: "brain-authentic-yap-before-weight",
    name: "brain-text-20260725-192200.pdf",
    sourceText: `${authenticGameYapText} This was the earlier version of my thought.`,
    sourceCreatedAt: "2026-07-25T19:22:00.000Z",
    createdAt: "2026-07-25T19:22:00.000Z"
  };
  const olderBrainSupport = coach.brainRelationshipSupportFromFile(olderBrainFile, {
    earliest: Date.parse(delayedWeight.createdAt) - coach.BRAIN_WEIGHT_CONTEXT_LOOKBACK_MS,
    cutoff: Date.parse(delayedWeight.createdAt),
    operationalNow: Date.parse("2026-07-25T19:23:01.000Z")
  });
  const newerThoughtFile = {
    id: "brain-newer-dragon-thought",
    name: "ordinary-dragon-note.txt",
    kind: "upload",
    mime: "text/plain",
    sourceText: "if we know where the enemy team is, we can do dragon if its safe",
    sourceCreatedAt: "2026-07-25T19:22:30.000Z",
    createdAt: "2026-07-25T19:22:30.000Z"
  };
  const newestAcrossTypes = await coach.fetchLatestBrainPersonalAnchor(delayedBase, {
    apiBase: "https://brain.test",
    weight: delayedWeight,
    weightId: delayedWeight.id,
    excludedWeightId: delayedWeight.id,
    earliest: Date.parse(delayedWeight.createdAt) - coach.BRAIN_WEIGHT_CONTEXT_LOOKBACK_MS,
    cutoff: Date.parse(delayedWeight.createdAt) + coach.BRAIN_WEIGHT_INDEX_GRACE_MS,
    thoughtCutoff: Date.parse("2026-07-25T19:24:00.000Z"),
    operationalNow: Date.parse("2026-07-25T19:24:00.000Z"),
    fetchImpl: async () => ({ ok: true, json: async () => ({ files: [olderBrainFile, newerThoughtFile] }) })
  });
  assert.equal(newestAcrossTypes.id, newerThoughtFile.id, "newest eligible context wins by source timestamp instead of an older letter winning by type");
  const olderRefresh = coach.refreshLatestCoachForBrainRelationship(
    delayedBase,
    olderBrainSupport,
    "fallback-test-earlier-brain-context",
    Date.parse("2026-07-25T19:23:01.000Z")
  );
  assert.equal(olderRefresh.updated, true);
  assert(coach.coachForWeight(olderRefresh.store, delayedWeight.id).text.includes(olderBrainSupport.text));
  const newerThoughtRefresh = coach.refreshLatestCoachForBrainRelationship(
    olderRefresh.store,
    newestAcrossTypes,
    "fallback-test-newest-cross-type-context",
    Date.parse("2026-07-25T19:24:00.000Z")
  );
  assert.equal(newerThoughtRefresh.updated, true, "a newer thought replaces an older attached letter instead of being blocked by source type");
  assert.equal(coach.coachForWeight(newerThoughtRefresh.store, delayedWeight.id).personalAnchor.sourceType, "brain-thought-anchor");
  await coach.writeStore(() => olderRefresh.store);
  let delayedFetchCount = 0;
  const reconciled = await coach.reconcileLatestCoachBrainContext({
    operationalNow: Date.parse("2026-07-25T19:24:00.000Z"),
    bypassCooldown: true,
    awaitGeneration: true,
    apiBase: "https://brain.test",
    fetchImpl: async (url) => {
      delayedFetchCount += 1;
      assert.equal(url, "https://brain.test/api/files");
      return { ok: true, json: async () => ({ files: [olderBrainFile, delayedBrainFile] }) };
    }
  });
  assert.deepEqual(
    { updated: reconciled.updated, status: reconciled.status, weightId: reconciled.weightId, sourceKind: reconciled.sourceKind },
    { updated: true, status: "reconciled", weightId: delayedWeight.id, sourceKind: "boyfriend-authentic-game-yap" },
    "the full read-fetch-write-generation path upgrades an earlier cue when the intended delayed Brain entry arrives"
  );
  assert.equal(delayedFetchCount, 1);
  const reconciledStore = await coach.readStore();
  const reconciledCoach = coach.coachForWeight(reconciledStore, delayedWeight.id);
  assert(reconciledCoach.text.includes(delayedBrainSupport.text), "the final persisted memo keeps the authentic connection after generation");
  assert(reconciledCoach.evidenceReferences.some((reference) => reference.type === "brain-letter" && reference.id === delayedBrainFile.id));
  assert(!reconciledCoach.evidenceReferences.some((reference) => reference.type === "brain-letter" && reference.id === olderBrainFile.id), "the earlier provisional cue cannot block the newer adjacent entry");
  assert(!JSON.stringify(reconciledStore).includes(authenticGameYapText), "the full reconciliation path never persists raw Brain text");
  assert.equal(coach.assertCoachRefreshPreserved(delayedBefore, coach.coachRefreshPreservationSnapshot(reconciledStore, delayedWeight.id)), true);

  const idempotentReconcile = await coach.reconcileLatestCoachBrainContext({
    operationalNow: Date.parse("2026-07-25T19:24:10.000Z"),
    bypassCooldown: true,
    awaitGeneration: true,
    apiBase: "https://brain.test",
    fetchImpl: async () => ({ ok: true, json: async () => ({ files: [olderBrainFile, delayedBrainFile] }) })
  });
  assert.equal(idempotentReconcile.updated, false);
  assert.equal(idempotentReconcile.status, "already-current", "reconciliation stays idempotent once the newest eligible source is attached");

  const genericWeight = recordWeight("generic-brain-weight", "2026-07-26", 151.2, "T19:17:18.336Z");
  const olderLilyMood = {
    id: "older-lily-mood",
    kind: "note",
    text: "Alan noticed Lily seems off and wants her to feel seen.",
    createdAt: "2026-07-25T05:11:13.966Z",
    updatedAt: "2026-07-25T05:11:13.966Z"
  };
  const genericBrainRaw = "One private-sensitive-label sits beside my newest app and game thought.";
  const genericBrainFile = {
    id: "generic-brain-after-lily",
    name: "ordinary-entry.txt",
    kind: "upload",
    mime: "text/plain",
    sourceText: genericBrainRaw,
    sourceCreatedAt: "2026-07-25T19:23:51.301Z",
    createdAt: "2026-07-25T19:23:51.301Z"
  };
  let genericBase = baseStore([genericWeight], { memories: [olderLilyMood], trackerEvents: [] });
  genericBase = coach.addFallbackCoachForWeight(genericBase, genericWeight.id, "fallback-generic-brain-base");
  const genericBeforeCoach = coach.coachForWeight(genericBase, genericWeight.id);
  assert.equal(genericBeforeCoach.personalAnchor.semanticAnchorId, "lily-mood-care");
  const genericBrainAnchor = coach.brainThoughtAnchorFromFile(genericBrainFile, {
    cutoff: Date.parse(genericWeight.createdAt) + coach.BRAIN_WEIGHT_INDEX_GRACE_MS,
    seed: "production-shaped"
  });
  assert.equal(genericBrainAnchor.kind, "brain-thought-apps-games", "a short arbitrary mixed Brain entry safely reduces to its concrete topics");
  assert.equal(coach.brainRelationshipSupportFromFile(genericBrainFile, {
    earliest: Date.parse(genericWeight.createdAt) - coach.BRAIN_WEIGHT_CONTEXT_LOOKBACK_MS,
    cutoff: Date.parse(genericWeight.createdAt) + coach.BRAIN_WEIGHT_INDEX_GRACE_MS,
    operationalNow: Date.parse("2026-07-26T20:00:00.000Z")
  }), null, "the production-shaped generic entry does not masquerade as a strict relationship letter");
  assert.equal(coach.brainSourceWithinWeightWindow(genericWeight, genericBrainAnchor, Date.parse("2026-07-26T20:00:00.000Z")), false, "the roughly 24-hour-pre-weight generic thought is outside the strict letter window");
  assert.equal(coach.newestPersonalAnchor(genericBrainAnchor, coach.personalAnchorFromCoachRecord(genericBeforeCoach)).id, genericBrainFile.id, "newest source timestamp lets the generic Brain thought beat the older Lily anchor");
  const newerLilyAnchor = { ...coach.personalAnchorFromCoachRecord(genericBeforeCoach), id: "newer-lily", createdAt: "2026-07-25T20:00:00.000Z" };
  assert.equal(coach.newestPersonalAnchor(genericBrainAnchor, newerLilyAnchor).id, newerLilyAnchor.id, "a genuinely newer Lily source still beats an older generic Brain thought");
  const tiedLilyAnchor = { ...newerLilyAnchor, createdAt: genericBrainAnchor.createdAt };
  assert.equal(
    coach.newestPersonalAnchor(genericBrainAnchor, tiedLilyAnchor).id,
    coach.newestPersonalAnchor(tiedLilyAnchor, genericBrainAnchor).id,
    "equal timestamps resolve deterministically instead of depending on input order"
  );

  await coach.writeStore(() => genericBase);
  let newestGenerationFetches = 0;
  await coach.generateAndReplaceCoach(genericWeight.id, {
    apiBase: "https://brain.test",
    operationalNow: Date.parse("2026-07-26T20:00:00.000Z"),
    fetchImpl: async () => {
      newestGenerationFetches += 1;
      return { ok: true, json: async () => ({ files: [genericBrainFile] }) };
    }
  });
  assert.equal(newestGenerationFetches, 1, "initial generation resolves strict and generic Brain candidates from one bounded read");
  const newestGenerationStore = await coach.readStore();
  const newestGenerationCoach = coach.coachForWeight(newestGenerationStore, genericWeight.id);
  assert.equal(newestGenerationCoach.personalAnchor.sourceType, "brain-thought-anchor");
  assert.equal(newestGenerationCoach.personalAnchor.semanticAnchorId, "brain-thought-apps-games", "generateAndReplaceCoach persists the newest generic Brain anchor instead of blindly preferring recent Lily context");
  assert.equal(newestGenerationCoach.id, genericBeforeCoach.id);
  assert.equal(newestGenerationCoach.createdAt, genericBeforeCoach.createdAt);
  assert(!JSON.stringify(newestGenerationCoach).includes(genericBrainRaw), "initial generation persists only the approved reduction, never raw mixed Brain text");

  await coach.writeStore(() => genericBase);
  const genericBefore = coach.coachRefreshPreservationSnapshot(genericBase, genericWeight.id);
  const notIndexedYet = await coach.reconcileLatestCoachBrainContext({
    operationalNow: Date.parse("2026-07-26T19:18:00.000Z"),
    bypassCooldown: true,
    awaitGeneration: true,
    apiBase: "https://brain.test",
    fetchImpl: async () => ({ ok: true, json: async () => ({ files: [] }) })
  });
  assert.equal(notIndexedYet.updated, false, "the memo remains on its valid Lily anchor while the newest Brain entry has not indexed yet");
  assert.equal(coach.assertCoachRefreshPreserved(genericBefore, coach.coachRefreshPreservationSnapshot(await coach.readStore(), genericWeight.id)), true);
  let genericReconcileFetches = 0;
  const genericReconciled = await coach.reconcileLatestCoachBrainContext({
    operationalNow: Date.parse("2026-07-26T20:00:00.000Z"),
    bypassCooldown: true,
    awaitGeneration: true,
    apiBase: "https://brain.test",
    fetchImpl: async () => {
      genericReconcileFetches += 1;
      return { ok: true, json: async () => ({ files: [genericBrainFile] }) };
    }
  });
  assert.equal(genericReconcileFetches, 1, "late generic reconciliation uses one bounded Brain read");
  assert.equal(genericReconciled.updated, true, "a generic Brain thought indexed after the weigh-in upgrades the older Lily anchor");
  assert.equal(genericReconciled.sourceKind, "brain-thought-apps-games");
  const genericReconciledStore = await coach.readStore();
  const genericReconciledCoach = coach.coachForWeight(genericReconciledStore, genericWeight.id);
  assert.equal(genericReconciledCoach.id, genericBeforeCoach.id, "generic reconciliation preserves coach identity");
  assert.equal(genericReconciledCoach.createdAt, genericBeforeCoach.createdAt, "generic reconciliation preserves coach creation time");
  assert.equal(genericReconciledCoach.personalAnchor.sourceType, "brain-thought-anchor");
  assert.equal(genericReconciledCoach.personalAnchor.semanticAnchorId, "brain-thought-apps-games");
  assert(genericReconciledCoach.text.includes(genericReconciledCoach.personalAnchor.approvedText));
  assert(!JSON.stringify(genericReconciledStore).includes(genericBrainRaw), "delayed reconciliation never persists raw mixed Brain text");
  assert.equal(coach.assertCoachRefreshPreserved(genericBefore, coach.coachRefreshPreservationSnapshot(genericReconciledStore, genericWeight.id)), true, "delayed generic repair preserves every count, identity, forecast, media, tracker, and unrelated hash");
  const genericIdempotent = await coach.reconcileLatestCoachBrainContext({
    operationalNow: Date.parse("2026-07-26T20:00:10.000Z"),
    bypassCooldown: true,
    awaitGeneration: true,
    apiBase: "https://brain.test",
    fetchImpl: async () => ({ ok: true, json: async () => ({ files: [genericBrainFile] }) })
  });
  assert.equal(genericIdempotent.updated, false);
  assert.equal(genericIdempotent.status, "already-current", "generic reconciliation is idempotent once the newest source is attached");

  const lateThoughtWeight = recordWeight("late-thought-weight", "2026-07-30", 151, "T21:30:30.660Z");
  let lateThoughtStore = baseStore([lateThoughtWeight], { memories: substantialAnchorMemories("late-thought"), trackerEvents: [] });
  lateThoughtStore = coach.addFallbackCoachForWeight(lateThoughtStore, lateThoughtWeight.id, "fallback-before-late-thought");
  const lateThoughtBeforeCoach = coach.coachForWeight(lateThoughtStore, lateThoughtWeight.id);
  const lateThoughtFile = {
    id: "late-specific-brain-thought",
    kind: "generated pdf",
    mime: "application/pdf",
    name: "brain-text-20260730-174803.pdf",
    generatedNoteLayoutVersion: "test-v1",
    sourceText: "I am debating the loading and unloading hysteresis for the constrained 3x3 module in Figure 2, especially whether the bottom row should have two plots or three plots.",
    sourceCreatedAt: "2026-07-30T21:48:03.114Z",
    createdAt: "2026-07-30T21:48:03.114Z"
  };
  await coach.writeStore(() => lateThoughtStore);
  const lateThoughtBaseline = coach.coachRefreshPreservationSnapshot(lateThoughtStore, lateThoughtWeight.id);
  const futureThoughtBlocked = await coach.reconcileLatestCoachBrainContext({
    operationalNow: Date.parse("2026-07-30T21:40:00.000Z"),
    bypassCooldown: true,
    awaitGeneration: true,
    apiBase: "https://brain.test",
    fetchImpl: async () => ({ ok: true, json: async () => ({ files: [lateThoughtFile] }) })
  });
  assert.equal(futureThoughtBlocked.updated, false, "a Brain thought cannot be used before its real source timestamp");
  const lateThoughtReconciled = await coach.reconcileLatestCoachBrainContext({
    operationalNow: Date.parse("2026-07-30T21:50:00.000Z"),
    bypassCooldown: true,
    awaitGeneration: true,
    apiBase: "https://brain.test",
    fetchImpl: async () => ({ ok: true, json: async () => ({ files: [lateThoughtFile] }) })
  });
  assert.equal(lateThoughtReconciled.updated, true, "a generic Brain thought saved more than five minutes after the weigh-in still upgrades the current memo");
  const lateThoughtFinalStore = await coach.readStore();
  const lateThoughtCoach = coach.coachForWeight(lateThoughtFinalStore, lateThoughtWeight.id);
  assert.equal(lateThoughtCoach.id, lateThoughtBeforeCoach.id);
  assert.equal(lateThoughtCoach.createdAt, lateThoughtBeforeCoach.createdAt);
  assert.equal(lateThoughtCoach.personalAnchor.id, lateThoughtFile.id);
  assert.equal(lateThoughtCoach.personalAnchor.specificity, "source-specific");
  assert.match(lateThoughtCoach.text, /3x3|hysteresis|Figure 2/i);
  assert(lateThoughtCoach.text.startsWith(lateThoughtCoach.personalAnchor.approvedText), "the newest source-specific Brain thought visibly leads the memo");
  assert(lateThoughtCoach.text.indexOf(lateThoughtCoach.personalAnchor.approvedText) < lateThoughtCoach.text.indexOf("151 lb"), "the authentic thought and care frame arrive before the weight analysis");
  assert.match(lateThoughtCoach.text, /same close attention is here with you/i);
  assert.equal(coach.assertCoachRefreshPreserved(lateThoughtBaseline, coach.coachRefreshPreservationSnapshot(lateThoughtFinalStore, lateThoughtWeight.id)), true, "late-source reconciliation preserves every non-target record and target identity");

  const authenticVariants = new Set();
  for (let index = 0; index < 30; index += 1) {
    const support = coach.brainRelationshipSupportFromFile({
      ...delayedBrainFile,
      id: `brain-authentic-variant-${index}`,
      sourceText: `${authenticGameYapText} Variation ${index}.`
    }, {
      cutoff: Date.parse("2026-07-25T19:25:00.000Z"),
      operationalNow: Date.parse("2026-07-25T19:25:00.000Z")
    });
    authenticVariants.add(support.text);
  }
  assert(authenticVariants.size >= 3, "source-hash selection keeps successive authentic-yap notes from collapsing to one canned sentence");
  const staleStyleStore = {
    ...observedMoodRefresh.store,
    coachMessages: observedMoodRefresh.store.coachMessages.map((message) => message.weightId === reactionWeight.id
      ? { ...message, styleVersion: "coach-style-old", text: "TODAY'S DATA IS A WARNING. The number moved the wrong way. FIGHT FOR THE TURN!!!" }
      : message)
  };
  const beforeStyleRefresh = coach.coachRefreshPreservationSnapshot(staleStyleStore, reactionWeight.id);
  const styleRefresh = coach.refreshLatestCoachStyleInStore(staleStyleStore, "fallback-test-style-refresh", Date.parse(observedMoodNote.createdAt) + 1000);
  assert.equal(styleRefresh.updated, true, "a stale latest coach is rewritten through the supportive style path");
  assert.equal(coach.assertCoachRefreshPreserved(beforeStyleRefresh, coach.coachRefreshPreservationSnapshot(styleRefresh.store, reactionWeight.id)), true);
  const refreshedStyleCoach = coach.coachForWeight(styleRefresh.store, reactionWeight.id);
  assert.equal(refreshedStyleCoach.id, observedMoodCoach.id, "style refresh preserves the coach identity");
  assert.equal(refreshedStyleCoach.createdAt, observedMoodCoach.createdAt, "style refresh preserves the coach creation time");
  assert.equal(refreshedStyleCoach.styleVersion, coach.COACH_STYLE_VERSION);
  assert.match(refreshedStyleCoach.text, /Alan noticed/i, "the current one-use care context survives the same-message style refresh");
  assert.deepEqual(coach.supportiveCoachStyleErrors(refreshedStyleCoach.text), []);
  assert.doesNotMatch(refreshedStyleCoach.text, /not good enough|warning|red alert|fight|attack|earn|prove|!{2,}/i);
  assert.doesNotMatch(refreshedStyleCoach.text, /private-sensitive-label|diagnos\w*|clinical label/i);
  const idempotentStyleRefresh = coach.refreshLatestCoachStyleInStore(styleRefresh.store, "fallback-test-style-refresh", Date.parse(observedMoodNote.createdAt) + 2000);
  assert.equal(idempotentStyleRefresh.updated, false);
  assert.equal(idempotentStyleRefresh.alreadyCurrent, true, "the style refresh is idempotent once the latest coach is current");
  const nextObservedMoodContext = coach.buildCoachContext(
    { ...observedMoodRefresh.store, weights: [...observedMoodRefresh.store.weights, nextReactionWeight] },
    nextReactionWeight.id,
    { privateGoal: 117, personalContextCutoff: Date.parse(nextReactionWeight.createdAt) }
  );
  assert(!nextObservedMoodContext.evidenceReferences.some((reference) => reference.type === "memory" && reference.id === observedMoodNote.id), "the observed mood acknowledgment is consumed after one coach message");
  for (const excludedObservation of [
    "Alan clicked conflict for Lily today.",
    "Alan noticed Lily seems off and calls it a private-sensitive-label.",
    "I do not think Lily seems off today.",
    "Alan noticed Lily seems off and thinks she should skip meals."
  ]) {
    assert.equal(coach.observerCareSignal(excludedObservation), null, `unsupported, clinical, withdrawn, or unsafe observation stays excluded: ${excludedObservation}`);
  }

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
  ], { memories: [...substantialAnchorMemories("old-reaction"), electrolyteReaction], trackerEvents: [] })).store;
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
  ], { memories: [...substantialAnchorMemories("ancient-close"), ancientCloseReaction], trackerEvents: [] })).store;
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
  assert.equal(removedReactionCoach, null, "deleting the only authentic context source leaves the memo pending instead of publishing weight-only copy");

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
  const risingRun = addAllFallbacks(baseStore(risingWeights));
  const risingMessages = risingWeights.slice(1).map((weight) => coach.coachForWeight(risingRun.store, weight.id));
  assert(risingMessages.every((message) => message.verdict === "not-good-enough"), "twelve consecutive same-verdict weigh-ins remain distinct and valid");

  const fallback = coach.buildContextualFallback(july22, []);
  const fallbackValidation = coach.validateCoachParagraph(fallback, july22, [], { privateGoal: 117 });
  assert.equal(fallbackValidation.ok, true, fallbackValidation.errors.join(", "));
  assertParagraph(fallback);
  assert.equal(coach.identifyApprovedAction(fallback, july22)?.semantic, july22.actionSemantic);
  assert(fallback.includes(july22.personalAnchor.text), "every finalized fallback visibly carries its approved personal anchor");
  const noAnchorStore = baseStore([recordWeight("no-anchor-weight", "2026-07-22", 150)], { memories: [], trackerEvents: [] });
  const noAnchorContext = coach.buildCoachContext(noAnchorStore, "no-anchor-weight");
  assert.equal(noAnchorContext.personalAnchor, null);
  assert.equal(coach.coachForWeight(coach.addFallbackCoachForWeight(noAnchorStore, "no-anchor-weight"), "no-anchor-weight"), null, "a context-free fallback stays pending instead of becoming visible copy");
  const missingAnchorContext = { ...july22, personalAnchor: null, relationshipSupport: null, personalAnchorRequired: true };
  const actionOnlyCandidate = fallback.replace(`${july22.personalAnchor.text}. `, "");
  const actionOnlyErrors = coach.validateCoachParagraph(actionOnlyCandidate, missingAnchorContext, [], { privateGoal: 117 }).errors;
  assert(actionOnlyErrors.includes("missing-personal-anchor"), "a generic health action cannot masquerade as substantial personal context");

  const acceptanceAction = july22.actionRealizations.slice().sort((left, right) => coach.coachWordCount(left.text) - coach.coachWordCount(right.text))[0].text;
  const acceptanceFacts = coach.fallbackFactClauseVariants(july22);
  const acceptanceExample = coach.normalizeCoachParagraph(coach.FALLBACK_STRUCTURES[0](
    coach.WRITER_SAFE_OPENINGS["not-good-enough"][0],
    acceptanceFacts.current[0],
    acceptanceFacts.evidence[0],
    acceptanceFacts.outlook[0],
    acceptanceAction,
    coach.WRITER_SAFE_CLOSINGS["not-good-enough"][0],
    july22.personalAnchor.text
  ));
  const acceptanceValidation = coach.validateCoachParagraph(acceptanceExample, july22, [], { privateGoal: 117 });
  assert.equal(acceptanceValidation.ok, true, `a supportive evidence-first paragraph must pass every deterministic gate: ${acceptanceValidation.errors.join(", ")}`);
  assertParagraph(acceptanceExample, "July 22 acceptance example");
  assert.deepEqual(coach.supportiveCoachStyleErrors(acceptanceExample), []);
  assert.doesNotMatch(acceptanceExample, /not good enough|warning|red alert|fight|attack|earn|prove|!{2,}/i);
  assert.doesNotMatch(acceptanceExample, /private-sensitive-label|diagnos\w*|clinical label/i);
  const gluedAnchor = acceptanceExample.replace(`. ${july22.personalAnchor.text}.`, `; ${july22.personalAnchor.text};`);
  assert(coach.validateCoachParagraph(gluedAnchor, july22, [], { privateGoal: 117 }).errors.includes("personal-anchor-glued"), "personal context must remain a complete human sentence instead of semicolon glue");

  const wrongNumber = fallback.replace("151 lb", "999 lb");
  assert(coach.validateCoachParagraph(wrongNumber, july22, [], { privateGoal: 117 }).errors.includes("unsupported-number"));
  const leakedGoal = fallback.replace(/about 146 lb/i, "about 117 lb");
  assert(coach.validateCoachParagraph(leakedGoal, july22, [], { privateGoal: 117 }).errors.includes("goal-leak"));
  const fallbackClosing = coach.FALLBACK_CLOSINGS[july22.verdict].find((closing) => fallback.endsWith(closing));
  assert(fallbackClosing, "the fallback ends with one approved supportive closing");
  const leakedPrivateContext = fallback.replace(fallbackClosing, "Ovulation explains this.");
  assert(coach.validateCoachParagraph(leakedPrivateContext, july22, [], { privateGoal: 117 }).errors.includes("private-context-leak"));
  const leakedPrivateLabel = fallback.replace(fallbackClosing, "This is a private-sensitive-label.");
  assert(coach.validateCoachParagraph(leakedPrivateLabel, july22, [], { privateGoal: 117 }).errors.includes("unsafe-language"));
  const periodCause = `${fallback} The period caused this.`;
  assert(coach.validateCoachParagraph(periodCause, july22, [], { privateGoal: 117 }).errors.includes("period-causality"));
  assert(coach.validateCoachParagraph(`${fallback}\nSecond paragraph.`, july22, [], { privateGoal: 117 }).errors.includes("multiline"));
  for (const unsafeClose of ["You are lazy.", "Skip a meal to fix it.", "Punish this with compensatory exercise."]) {
    const unsafeCandidate = fallback.replace(fallbackClosing, unsafeClose);
    assert(coach.validateCoachParagraph(unsafeCandidate, july22, [], { privateGoal: 117 }).errors.includes("unsafe-language"), `unsafe coaching is rejected: ${unsafeClose}`);
  }

  const extraActions = [
    "Take the stairs now.", "Stand up after dinner.", "Call a friend for accountability.",
    "Breathe before ordering.", "Drink water now.", "A stair climb would help.",
    "Taking the stairs helps.", "Keep standing after dinner.", "For dinner, stand up."
  ];
  for (const extra of extraActions) {
    const candidate = fallback.replace(fallbackClosing, `${extra} ${fallbackClosing}`);
    assert(coach.validateCoachParagraph(candidate, july22, [], { privateGoal: 117 }).errors.includes("extra-action"), `extra action is rejected: ${extra}`);
  }

  const semanticBypasses = [
    "A short hike could work.", "Park farther away.", "A dance break could work.", "Dance after work.",
    "A salad could work.", "More steps tonight.", "Journal tonight.", "Meditation may help.",
    "Clean the scale.", "Reset the scale.", "Hold the scale.", "Trust the scale.",
    "Fight the scale.", "Attack the scale.", "Clean the next reading.", "Press the scale."
  ];
  for (const extra of semanticBypasses) {
    const acceptanceClosing = coach.WRITER_SAFE_CLOSINGS["not-good-enough"][0];
    const candidate = acceptanceExample.replace(acceptanceClosing, `${extra} ${acceptanceClosing}`);
    const result = coach.validateCoachParagraph(candidate, july22, [], { privateGoal: 117 });
    assert(result.errors.some((error) => error.startsWith("closed-")), `closed component grammar rejects a hidden second recommendation: ${extra}`);
  }

  const falseEvidenceRelation = acceptanceExample.replace(
    acceptanceFacts.evidence[0],
    "3-day evidence is up 2.5 lb and weaker than before"
  );
  assert(coach.validateCoachParagraph(falseEvidenceRelation, july22, [], { privateGoal: 117 }).errors.includes("evidence-claim"), "the outlook cannot satisfy a contradictory broader-evidence relation");

  for (const contradicted of [
    acceptanceExample.replace(acceptanceFacts.current[0], "151 lb is not up 1.1 lb today"),
    acceptanceExample.replace(acceptanceFacts.evidence[0], "3-day evidence is up 2.5 lb and not accelerated"),
    acceptanceExample.replace(acceptanceFacts.outlook[0], "The 1-year outlook not worsened to about 146 lb")
  ]) {
    const result = coach.validateCoachParagraph(contradicted, july22, [], { privateGoal: 117 });
    assert(result.errors.some((error) => error.startsWith("closed-") || error.endsWith("-claim")), "negation cannot coexist with a positively matched fact");
  }

  for (const falseArgument of [
    acceptanceExample.replace(`${acceptanceFacts.current[0]}.`, `${acceptanceFacts.current[0]} because`),
    acceptanceExample.replace(`${acceptanceFacts.evidence[0]}.`, `${acceptanceFacts.evidence[0]}, so`),
    acceptanceExample.replace(`${acceptanceFacts.current[0]}.`, `${acceptanceFacts.current[0]}?`),
    `${coach.WRITER_SAFE_OPENINGS["not-good-enough"][0]}—${acceptanceAction}. ${acceptanceFacts.current[0]}. ${acceptanceFacts.evidence[0]}. ${acceptanceFacts.outlook[0]}. ${coach.WRITER_SAFE_CLOSINGS["not-good-enough"][0]}`
  ]) {
    const result = coach.validateCoachParagraph(falseArgument, july22, [], { privateGoal: 117 });
    assert(result.errors.some((error) => error.startsWith("closed-")), "causal joins, factual questions, and action-first fragments are rejected");
  }

  const structureA = "WRONG WAY—151 lb is up 1.1 lb. The 3-day move is up 2.5 lb.";
  const structureB = "WRONG WAY—149 lb is up 0.7 lb. The 3-day move is up 1.2 lb.";
  assert.equal(coach.structuralFingerprint(structureA, july22), coach.structuralFingerprint(structureB, july22), "changing numbers inside a repeated argument is not original analysis");

  const sameFrameActionA = july22.actionRealizations[0].text;
  const sameFrameActionB = july22.actionRealizations[1].text;
  const sameFrameA = coach.FALLBACK_STRUCTURES[0](
    coach.WRITER_SAFE_OPENINGS["not-good-enough"][0], acceptanceFacts.current[0], acceptanceFacts.evidence[0], acceptanceFacts.outlook[0],
    sameFrameActionA, coach.WRITER_SAFE_CLOSINGS["not-good-enough"][0], july22.personalAnchor.text
  );
  const sameFrameB = coach.FALLBACK_STRUCTURES[0](
    coach.WRITER_SAFE_OPENINGS["not-good-enough"][1], acceptanceFacts.current[1], acceptanceFacts.evidence[1], acceptanceFacts.outlook[1],
    sameFrameActionB, coach.WRITER_SAFE_CLOSINGS["not-good-enough"][1], july22.personalAnchor.text
  );
  assert.equal(coach.semanticArgumentFingerprint({ text: sameFrameA, actionText: sameFrameActionA }, july22), coach.semanticArgumentFingerprint({ text: sameFrameB, actionText: sameFrameActionB }, july22), "semantic framing identifies the repeated reasoning beneath different surface copy");
  assert(coach.trigramSimilarity(sameFrameA, sameFrameB, july22) < 0.72, "the repeated reasoning fixture stays below the old lexical-only threshold");
  assert(coach.noveltyErrors(sameFrameB, july22, [{ text: sameFrameA, actionText: sameFrameActionA }], { text: sameFrameActionB, id: "test", semantic: "test" }).includes("repeat-argument-frame"), "a repeated argument sequence fails even when its numbers and wording change");

  const writerRows = coach.buildContextualFallbackCandidates(july22, [], 12, { writerSafe: true })
    .filter((candidate) => candidate.wordCount < coach.COACH_RELATIONSHIP_MAX_WORDS)
    .slice(0, 3);
  assert.equal(writerRows.length, 3, "the schema-enforced writer pool supplies several vetted paragraphs");
  assert.equal(new Set(writerRows.map((candidate) => coach.openingFingerprint(candidate.text))).size, 3, "writer-pool openings are distinct");
  assert.equal(new Set(writerRows.map((candidate) => coach.closingFingerprint(candidate.text))).size, 3, "writer-pool closings are distinct");
  const naturalActionA = july22.actionRealizations[0].text;
  const naturalActionB = july22.actionRealizations[1].text;
  const modelWrittenRows = [
    `The newest result needs a correction: at 151 lb, today is 1.1 lb higher. ${july22.personalAnchor.text}. Over three days, weight increased 2.5 lb and the move accelerated from the prior read. The one-year outlook worsened to about 146 lb. ${naturalActionA} There is still room to turn the direction.`,
    `This is an unhelpful turn, with 151 lb up 1.1 lb today. ${july22.personalAnchor.text}. The 3-day line rose 2.5 lb, a stronger signal than before. The one-year outlook moved the wrong way to about 146 lb. ${naturalActionB} A better direction remains possible.`,
    `The line moved away from the plan: 151 lb is 1.1 lb higher today. Across the three-day window, there was an increase of 2.5 lb, accelerated versus the earlier read. ${july22.personalAnchor.text}. About 146 lb is the worsened one-year outlook. ${naturalActionA} The path forward is still open.`
  ].map((text, index) => ({ text, structureId: `handwritten-natural-${index + 1}` }));
  assert(modelWrittenRows.every((candidate) => !writerRows.some((row) => row.text === candidate.text)), "the natural-writer fixture is genuinely hand-written rather than a punctuated fallback template");
  const modelWrittenValidations = modelWrittenRows.map((candidate) => coach.validateCoachParagraph(candidate.text, july22, [], { privateGoal: 117, allowNaturalProse: true }));
  assert(modelWrittenValidations.every((validation) => validation.ok), `genuinely natural factual prose passes the deterministic gates: ${JSON.stringify(modelWrittenValidations.map((validation) => validation.errors))}`);
  const inventedPersonalState = modelWrittenRows[0].text.replace("There is still room to turn the direction.", "Alan knows you felt rejected today.");
  assert(coach.validateCoachParagraph(inventedPersonalState, july22, [], { privateGoal: 117, allowNaturalProse: true }).errors.includes("unsupported-personal-state"), "a writer cannot invent Lily's private emotional state outside the approved source sentence");
  const writerBrief = coach.writerLeadFacts(july22);
  const writerLeads = ["This needs a correction", "An unhelpful turn", "The line moved away"];
  const renderedWriterLeads = writerLeads.map((lead, index) => coach.renderWriterLead(lead, july22, index));
  assert(renderedWriterLeads.every((rendered) => rendered.ok), `all protected lead compositions render: ${JSON.stringify(renderedWriterLeads.map((rendered) => rendered.errors))}`);
  const renderedWriterValidations = renderedWriterLeads.map((rendered) => coach.validateCoachParagraph(rendered.text, july22, [], { privateGoal: 117, allowNaturalProse: true }));
  assert(renderedWriterValidations.every((validation) => validation.ok), `the composed leads pass every final fact and safety gate: ${JSON.stringify(renderedWriterValidations.map((validation) => validation.errors))}`);
  assert(coach.writerLeadErrors("Correction").errors.includes("writer-lead-word-count"), "a one-word model fragment cannot masquerade as analyzed coaching");
  assert(coach.writerLeadErrors("Progress at 999 lb").errors.includes("writer-lead-format"), "the model cannot inject or alter a protected number");
  assert(coach.writerLeadErrors("Take a walk now").errors.includes("writer-lead-action"), "the model cannot add a second action");
  assert(coach.writerLeadErrors("Steady improvement today", aug2PersonalContext).errors.includes("writer-lead-overclaim"), "a one-day correction cannot be inflated into a steady trend when the broad outlook contradicts it");
  const unsafeWriterLead = coach.renderWriterLead("Worthless failure today", july22, 0);
  assert(unsafeWriterLead.ok, "lead composition itself remains independent from prose safety");
  assert(coach.validateCoachParagraph(unsafeWriterLead.text, july22, [], { privateGoal: 117, allowNaturalProse: true }).errors.includes("unsafe-language"), "unsafe generated lead prose still fails the final validator");
  const writerPayload = JSON.stringify({ candidates: writerLeads.map((text) => ({ text })) });
  const writerRequestBodies = [];
  const approvedQueue = [writerPayload, criticPayload(true, 0)];
  const approvedGeneration = await coach.generateCoachParagraph(july22, [], {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: async (_url, init) => {
      writerRequestBodies.push(JSON.parse(init.body));
      return response(approvedQueue.shift() || "");
    },
    timeoutMs: 3000
  });
  assert.equal(approvedGeneration.status, "generated-and-critic-approved");
  assert.equal(approvedGeneration.text, renderedWriterLeads[0].text);
  assert.equal(approvedGeneration.criticResult.checks.originality, true);
  assert.equal(approvedGeneration.criticResult.reasonCode, "approved");
  assert.equal(writerRequestBodies.length, 2, "the writer and critic each run once for approved natural prose");
  assert(!JSON.stringify(writerRequestBodies[0]).includes("approvedCopyComponents"), "the writer receives a compact story brief and protected slots, never canned openings or closings");
  const writerRequestText = JSON.stringify(writerRequestBodies[0]);
  assert(writerRequestText.includes("three distinct 2-to-7-word verdict leads only"), "the writer receives only the compact story-and-tone task");
  assert(!writerRequestText.includes(july22.personalAnchor.text) && !writerRequestText.includes(naturalActionA) && !writerRequestText.includes("151 lb"), "the writer cannot paraphrase protected context, action, or measurements because those values never enter its request");
  assert(!/orderedTrigrams|recentActionSentences|structuralFingerprints/.test(writerRequestText), "opaque deterministic novelty data no longer overwhelms the writer prompt");

  const partialWriterPayload = JSON.stringify({ candidates: [
    { text: writerLeads[0] },
    { text: wrongNumber },
    { text: wrongNumber.replace("999 lb", "998 lb") }
  ] });
  const partialApprovedGeneration = await coach.generateCoachParagraph(july22, [], {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: queuedFetch([partialWriterPayload, criticPayload(true, 0)]),
    timeoutMs: 3000
  });
  assert.equal(partialApprovedGeneration.status, "generated-and-critic-approved", "one fully validated original candidate reaches the critic without an unnecessary second writer round");
  assert.equal(partialApprovedGeneration.text, renderedWriterLeads[0].text);
  assert.equal(partialApprovedGeneration.diagnostics.validCandidateCount, 1);

  const invalidWriter = await coach.generateCoachParagraph(july22, [], {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: queuedFetch([JSON.stringify({ candidates: [wrongNumber, wrongNumber.replace("999 lb", "998 lb"), wrongNumber.replace("999 lb", "997 lb")].map((text) => ({ text })) }), JSON.stringify({ candidates: [] })]),
    timeoutMs: 3000
  });
  assert.match(invalidWriter.status, /^fallback-writer-/);
  assert.equal(invalidWriter.text, fallback);
  assert(invalidWriter.diagnostics.rejectionCodes.includes("writer-lead-format"), "unprotected model-written facts are rejected before they can alter a measurement");

  const duplicateWriterPayload = JSON.stringify({ candidates: [writerLeads[0], writerLeads[0], writerLeads[0]].map((text) => ({ text })) });
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
    reportedNextPeriodDateKey: "2026-07-29",
    reportedNextHighDesireDateKey: "2026-08-11",
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
    "generationInputHash", "generationVersion", "modelVersion", "nearestPriorMessageId", "nearestPriorSimilarity", "normalizedFingerprint",
    "promptVersion", "safetyVersion", "status", "styleVersion", "text", "updatedAt", "validatorVersion", "verdict", "weightId", "writerPromptVersion"
  ]) assert(Object.prototype.hasOwnProperty.call(latestRecord, key), `private coach record includes ${key}`);
  assert(latestRecord.evidenceReferences.some((reference) => reference.type === "tracker" && reference.id === "period-current"));
  assert(!JSON.stringify(latestRecord).toLowerCase().includes("highdesire"));
  assert(!JSON.stringify(latestRecord).includes("2026-07-29"));
  assert(!JSON.stringify(latestRecord).toLowerCase().includes("reportednext"));
  assert(!JSON.stringify(latestRecord).includes("2026-08-11"));

  const persistedContext = coach.buildCoachContext(migrated, "weight-5", { privateGoal: 117 });
  const persistedPrevious = coach.causalPreviousCoachMessages(migrated, fixtureWeights.at(-1), 10);
  const beforeGenerated = coach.coachForWeight(migrated, "weight-5");
  const persistedGenerationHistory = [beforeGenerated, ...persistedPrevious];
  const persistedWriterLeads = ["This needs a response", "An unhelpful turn", "The line moved away"];
  const persistedRenderedLeads = persistedWriterLeads.map((lead, index) => coach.renderWriterLead(lead, persistedContext, index, persistedGenerationHistory));
  const persistedLeadValidations = persistedRenderedLeads.map((rendered) => rendered.ok
    ? coach.validateCoachParagraph(rendered.text, persistedContext, persistedGenerationHistory, { privateGoal: 117, allowNaturalProse: true })
    : rendered);
  assert(persistedLeadValidations.some((validation) => validation.ok), `same-weight generated leads retain at least one original valid composition: ${JSON.stringify(persistedLeadValidations.map((validation) => validation.errors))}`);
  const persistedWriterPayload = JSON.stringify({ candidates: persistedWriterLeads.map((text) => ({ text })) });
  const persistedRequestBodies = [];
  const persistedResponseQueue = [persistedWriterPayload, criticPayload(true, 0)];
  await coach.generateAndReplaceCoach("weight-5", {
    apiKey: "test-key",
    privateGoal: 117,
    fetchImpl: async (_url, init) => {
      persistedRequestBodies.push(JSON.parse(init.body));
      return response(persistedResponseQueue.shift() || "");
    },
    timeoutMs: 3000
  });
  const generatedStore = await coach.readStore();
  const generatedRecord = coach.coachForWeight(generatedStore, "weight-5");
  assert.equal(generatedRecord.status, "generated-and-critic-approved");
  assert.equal(generatedRecord.id, beforeGenerated.id);
  assert.equal(generatedRecord.createdAt, beforeGenerated.createdAt);
  assert.equal(generatedRecord.criticResult.approved, true);
  assert.equal(generatedRecord.criticResult.reasonCode, "approved");
  assert.equal(generatedRecord.modelVersion, "writer:gpt-4.1-mini;critic:gpt-4.1-mini");
  assert(!JSON.stringify(persistedRequestBodies[0]).includes(beforeGenerated.text), "same-weight copy history stays in deterministic novelty checks instead of overwhelming the writer prompt");
  assert(JSON.stringify(persistedRequestBodies[0]).includes("verdict leads only"), "same-weight regeneration gives the writer only a compact story brief");
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
    const regeneratedNoveltyErrors = coach.noveltyErrors(after.text, context, previous);
    assert.deepEqual(regeneratedNoveltyErrors, [], `regenerated ${weight.id} remains original: ${JSON.stringify(regeneratedNoveltyErrors)}`);
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
