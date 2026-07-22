process.env.LILY_COACH_CLI = "1";

const coach = require("./server.js");

function requestedCount(argv) {
  const index = argv.indexOf("--count");
  if (index === -1) return 5;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error("--count must be an integer from 1 through 5");
  return value;
}

async function main() {
  const count = requestedCount(process.argv.slice(2));
  await coach.ensureDataDir();
  const before = await coach.readStore();
  const eligibleCount = Math.min(count, (before.weights || []).length);
  const outcomes = await coach.regenerateRecentCoachMessages({ count });
  if (outcomes.length !== eligibleCount || outcomes.some((outcome) => outcome.status === "missing")) {
    throw new Error(`regeneration incomplete: expected ${eligibleCount}, updated ${outcomes.length}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, requestedCount: count, regeneratedCount: outcomes.length, outcomes })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || "coach regeneration failed") })}\n`);
  process.exitCode = 1;
});
