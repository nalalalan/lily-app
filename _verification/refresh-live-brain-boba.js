"use strict";

const apiBase = String(process.env.LILY_API_BASE || "https://lily-api-production.up.railway.app").replace(/\/+$/, "");
const pin = String(process.env.LILY_PIN || "");

async function readJson(response, stage) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${stage} returned ${response.status}: ${String(payload.error || "request failed")}`);
  return payload;
}

async function run() {
  if (!pin) throw new Error("LILY_PIN is required");
  const expected = JSON.parse(String(process.env.LILY_REFRESH_EXPECTED || ""));
  const auth = await readJson(await fetch(`${apiBase}/api/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin })
  }), "auth");
  const result = await readJson(await fetch(`${apiBase}/api/coach/refresh-brain-relationship`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(expected)
  }), "refresh");
  const safe = {
    updated: result.updated === true,
    alreadyCurrent: result.alreadyCurrent === true,
    brainReferenced: result.brainReferenced === true,
    preserved: result.preserved === true,
    countsMatch: Object.entries(expected.expected || {}).every(([key, value]) => result.counts?.[key] === value)
  };
  const ok = (safe.updated || safe.alreadyCurrent) && safe.brainReferenced && safe.preserved && safe.countsMatch;
  console.log(JSON.stringify({ ok, ...safe }));
  if (!ok) throw new Error("live Brain refresh verification failed");
}

run().catch((error) => {
  console.error(String(error?.message || "live Brain refresh failed"));
  process.exitCode = 1;
});
