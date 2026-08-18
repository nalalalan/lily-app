"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const dataDir = path.join(os.tmpdir(), `lily-weight-api-${process.pid}-${Date.now()}`);
process.env.NODE_ENV = "test";
process.env.DATA_DIR = dataDir;
process.env.LILY_PIN = "123456";
process.env.SESSION_SECRET = "lily-weight-api-test-secret";
delete process.env.OPENAI_API_KEY;

const { ensureDataDir, server } = require("../server.js");

function emptyStore(weights = []) {
  return {
    memories: [],
    weights,
    chats: [],
    trackerEvents: [],
    coachMessages: [],
    bobaReward: null
  };
}

function historyAt(pounds) {
  return Array.from({ length: 7 }, (_, index) => ({
    id: `history-${index}`,
    weight: pounds,
    unit: "lb",
    createdAt: `2026-08-${String(index + 10).padStart(2, "0")}T12:00:00.000Z`,
    updatedAt: `2026-08-${String(index + 10).padStart(2, "0")}T12:00:00.000Z`
  }));
}

async function resetStore(store) {
  await fs.writeFile(path.join(dataDir, "store.json"), JSON.stringify(store, null, 2));
}

async function jsonRequest(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const body = await response.json();
  return { response, body };
}

async function run() {
  await ensureDataDir();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const authResult = await jsonRequest(base, "/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "123456" })
  });
  assert.equal(authResult.response.status, 200);
  const headers = {
    authorization: `Bearer ${authResult.body.token}`,
    "content-type": "application/json"
  };

  await resetStore(emptyStore());
  const automaticKg = await jsonRequest(base, "/api/weights", {
    method: "POST",
    headers,
    body: JSON.stringify({ weight: 68, unit: "auto" })
  });
  assert.equal(automaticKg.response.status, 201);
  assert.deepEqual(automaticKg.body.weight.unit, "lb");
  assert.equal(automaticKg.body.weight.weight, 149.91);
  assert.deepEqual(automaticKg.body.conversion, {
    inputWeight: 68,
    requestedUnit: "auto",
    detectedUnit: "kg",
    source: "threshold",
    converted: true,
    weightLb: 149.91
  });
  let diskStore = JSON.parse(await fs.readFile(path.join(dataDir, "store.json"), "utf8"));
  assert.equal(diskStore.weights[0].weight, 149.91, "converted pounds are what the durable record stores");
  assert.equal(diskStore.weights[0].unit, "lb");

  await resetStore(emptyStore());
  const belowBoundary = await jsonRequest(base, "/api/weights", {
    method: "POST",
    headers,
    body: JSON.stringify({ weight: 99.9 })
  });
  assert.equal(belowBoundary.response.status, 201);
  assert.equal(belowBoundary.body.conversion.detectedUnit, "kg");
  assert.equal(belowBoundary.body.weight.weight, 220.24);

  await resetStore(emptyStore());
  const atBoundary = await jsonRequest(base, "/api/weights", {
    method: "POST",
    headers,
    body: JSON.stringify({ weight: 100 })
  });
  assert.equal(atBoundary.response.status, 201);
  assert.equal(atBoundary.body.conversion.detectedUnit, "lb");
  assert.equal(atBoundary.body.weight.weight, 100);

  await resetStore(emptyStore(historyAt(150)));
  const historyKg = await jsonRequest(base, "/api/weights", {
    method: "POST",
    headers,
    body: JSON.stringify({ weight: 68, unit: "auto" })
  });
  assert.equal(historyKg.response.status, 201);
  assert.equal(historyKg.body.conversion.source, "history");
  assert.equal(historyKg.body.conversion.detectedUnit, "kg");
  const historyLb = await jsonRequest(base, "/api/weights", {
    method: "POST",
    headers,
    body: JSON.stringify({ weight: 149.8, unit: "auto" })
  });
  assert.equal(historyLb.response.status, 201);
  assert.equal(historyLb.body.conversion.detectedUnit, "lb");
  assert.equal(historyLb.body.weight.weight, 149.8);

  const ambiguous = await jsonRequest(base, "/api/weights", {
    method: "POST",
    headers,
    body: JSON.stringify({ weight: 100, unit: "auto" })
  });
  assert.equal(ambiguous.response.status, 422);
  assert.equal(ambiguous.body.code, "weight_unit_ambiguous");
  assert.equal(ambiguous.body.candidates.lb.weightLb, 100);
  assert.equal(ambiguous.body.candidates.kg.weightLb, 220.46);
  const beforeOverride = JSON.parse(await fs.readFile(path.join(dataDir, "store.json"), "utf8")).weights.length;

  const explicitOverride = await jsonRequest(base, "/api/weights", {
    method: "POST",
    headers,
    body: JSON.stringify({ weight: 100, unit: "lb" })
  });
  assert.equal(explicitOverride.response.status, 201);
  assert.equal(explicitOverride.body.weight.weight, 100);
  assert.equal(explicitOverride.body.conversion.source, "explicit");

  const invalidUnit = await jsonRequest(base, "/api/weights", {
    method: "POST",
    headers,
    body: JSON.stringify({ weight: 68, unit: "stone" })
  });
  assert.equal(invalidUnit.response.status, 400);
  assert.equal(invalidUnit.body.code, "invalid_weight_unit");
  diskStore = JSON.parse(await fs.readFile(path.join(dataDir, "store.json"), "utf8"));
  assert.equal(diskStore.weights.length, beforeOverride + 1, "ambiguous and invalid requests do not create measurements");

  const legacyCreatedAt = "2026-08-18T12:00:00.000Z";
  await resetStore(emptyStore([{
    id: "legacy-kg",
    weight: 68.0388555,
    unit: "kg",
    createdAt: legacyCreatedAt,
    updatedAt: legacyCreatedAt
  }]));
  const legacyRead = await jsonRequest(base, "/api/weights", { headers });
  assert.equal(legacyRead.response.status, 200);
  assert.deepEqual(legacyRead.body.weights[0], {
    id: "legacy-kg",
    weight: 150,
    unit: "lb",
    createdAt: legacyCreatedAt,
    updatedAt: legacyCreatedAt
  });
  diskStore = JSON.parse(await fs.readFile(path.join(dataDir, "store.json"), "utf8"));
  assert.equal(diskStore.weights[0].id, "legacy-kg");
  assert.equal(diskStore.weights[0].unit, "kg", "legacy storage is not migrated during a read");
  assert.equal(diskStore.weights[0].createdAt, legacyCreatedAt);

  console.log("weight API verification passed");
}

run()
  .finally(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
