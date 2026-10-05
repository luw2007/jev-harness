import { test } from "node:test";
import assert from "node:assert/strict";
import { ARENA_CASES } from "../examples/arena/cases";
import { ARENA_SETUP_VERSION, createRun, parseHistory, retainRuns, saveRun, readHistory, clearHistory, performanceSeries, runMetrics, type ArenaRun, HISTORY_KEY, MAX_RUNS, MAX_BYTES } from "../examples/arena/history";
import { routeTools } from "../src/routing";
import { readAssessments, saveAssessment } from "../examples/arena/assessments";
import * as demo from "../examples/routing/scenarios";

const { DEMO_CATALOG, DEMO_POLICY, SCENARIOS, scenarioRouter } = demo;

const fixture = ARENA_CASES[0];
const lane = { tools: ["read_file"], result: { status: "completed" as const, answer: "The result is 5.", durationMs: 1000, inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, toolCallCount: 1, traceTruncated: false, toolCalls: [{ tool: "read_file", status: "returned", at: "2026-09-22T00:00:00Z" }], error: null } };
function run(id = "one"): ArenaRun {
  return createRun({ id, startedAt: "2026-09-22T00:00:00Z", finishedAt: "2026-09-22T00:00:02Z", fixture, status: "complete", message: "Comparison finished.", lanes: { baseline: lane, integrated: lane }, receipt: null, jevUsage: { inputTokens: 20, outputTokens: 2, latencyMs: 200, requestBytes: 200, responseBytes: 20 } });
}
class Storage {
  data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

test("local snapshots round-trip evidence and exclude fields outside their schema", () => {
  const entry = run();
  const parsed = parseHistory(JSON.stringify({ version: 1, runs: [{ ...entry, credential: "synthetic-extra-field" }] }));
  assert.deepEqual(parsed.runs, [entry]);
  assert.equal(JSON.stringify(parsed).includes("synthetic-extra-field"), false);
  assert.equal(parsed.error, null);
});

test("history preserves v1/v2/v3/v4/v5 receipts while setup 7 excludes older and single-request control cohorts", async () => {
  assert.equal(ARENA_SETUP_VERSION, 7);
  const current = run("current");
  assert.equal(current.setupVersion, 7);
  current.receipt = await routeTools(DEMO_CATALOG, { intent: fixture.task, availableIds: DEMO_CATALOG.map(t => t.id) }, DEMO_POLICY, scenarioRouter(SCENARIOS[0]!));
  const oldReceipt = await routeTools(demo.DEMO_CATALOG_V1, { intent: fixture.task, availableIds: demo.DEMO_CATALOG_V1.map(t => t.id) }, DEMO_POLICY, scenarioRouter(SCENARIOS[0]!));
  const old = { ...run("v1"), setupVersion: 2, receipt: { ...oldReceipt, request: { ...oldReceipt.request, questionSetVersion: 1 as const } } };
  const v2 = { ...run("v2"), setupVersion: 3, receipt: { ...current.receipt, request: { ...current.receipt.request, questionSetVersion: 2 as const } } };
  const v3 = { ...run("v3"), setupVersion: 4, receipt: { ...current.receipt, request: { ...current.receipt.request, questionSetVersion: 3 as const } } };
  const v4 = { ...run("v4"), setupVersion: 5, receipt: { ...current.receipt, request: { ...current.receipt.request, questionSetVersion: 4 as const } } };
  // Historical snapshots predate transport markers; newly produced runs carry one.
  for (const historical of [old, v2, v3, v4]) delete historical.routingTransport;
  const control = { ...run("control"), setupVersion: 6, routingTransport: { version: 1 as const, recovery: "none" as const, maxAttempts: 1 as const, timeoutMs: 45_000 }, receipt: current.receipt };
  const runs = [old, v2, v3, v4, control, current];
  const before = JSON.stringify(runs);
  const parsed = parseHistory(JSON.stringify({ version: 1, runs }));
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.runs, runs);
  assert.equal(JSON.stringify(runs), before);
  assert.deepEqual(parsed.runs.map(r => r.receipt?.request.questionSetVersion), [1, 2, 3, 4, 5, 5]);
  const series = performanceSeries(parsed.runs, fixture, "input");
  assert.deepEqual(series.points.map(point => point.run.id), ["current"]);
  assert.equal(series.excluded, 5);
  assert.deepEqual(performanceSeries(parsed.runs, fixture, "input", 6).points.map(point => point.run.id), ["control"]);
  for (const version of [0, 6, "1", null]) {
    const invalid = { ...current, receipt: { ...current.receipt, request: { ...current.receipt.request, questionSetVersion: version } } };
    const result = parseHistory(JSON.stringify({ version: 1, runs: [invalid] }));
    assert.deepEqual(result.runs, []);
    assert.ok(result.error);
  }
});

test("invalid, future and malformed local data do not become results", () => {
  for (const raw of ["broken", JSON.stringify({ version: 2, runs: [run()] }), JSON.stringify({ version: 1, runs: [{ ...run(), lanes: { baseline: { ...lane, result: { ...lane.result, inputTokens: -1 } } } }] })]) {
    const result = parseHistory(raw);
    assert.equal(result.runs.length, 0);
    assert.ok(result.error);
  }
  assert.deepEqual(parseHistory(null), { runs: [], error: null });
});

test("history preserves zero, unknown, partial outcomes and complete answer text", () => {
  const entry = run();
  entry.lanes.integrated!.result = { ...lane.result, status: "cancelled", inputTokens: null, answer: "a".repeat(20000), toolCallCount: 0, toolCalls: [] };
  entry.status = "cancelled";
  const result = parseHistory(JSON.stringify({ version: 1, runs: [entry] })).runs[0]!;
  assert.equal(result.lanes.integrated!.result.inputTokens, null);
  assert.equal(result.lanes.integrated!.result.toolCallCount, 0);
  assert.equal(result.lanes.integrated!.result.answer.length, 20000);
  assert.equal(result.status, "cancelled");
});

test("retention deduplicates and bounds both count and serialized storage", () => {
  const entries = Array.from({ length: MAX_RUNS + 5 }, (_, i) => ({ ...run(String(i)), finishedAt: new Date(Date.UTC(2026, 8, 22, 0, i)).toISOString() }));
  const kept = retainRuns([entries[0]!, ...entries]);
  assert.equal(kept.length, MAX_RUNS);
  assert.equal(new Set(kept.map(entry => entry.id)).size, MAX_RUNS);
  assert.equal(kept[0]!.id, String(MAX_RUNS + 4));
  for (const entry of entries) entry.lanes.baseline!.result.answer = "測".repeat(30000);
  assert.ok(new TextEncoder().encode(JSON.stringify({ version: 1, runs: retainRuns(entries) })).length <= MAX_BYTES);
});

test("save merges existing runs, survives reload and clears only history", () => {
  const storage = new Storage(); storage.setItem("unrelated", "retained");
  assert.equal(saveRun(storage, run()).saved, true);
  assert.equal(saveRun(storage, run("two")).saved, true);
  assert.equal(saveRun(storage, run("two")).runs.length, 2);
  assert.equal(readHistory(storage).runs.length, 2);
  assert.equal(clearHistory(storage), null);
  assert.equal(storage.getItem(HISTORY_KEY), null);
  assert.equal(storage.getItem("unrelated"), "retained");
});

test("equivalent same-ID saves and duplicate reads preserve original evidence despite object key order", async () => {
  const entry = run();
  entry.fixture.files["src/other.ts"] = "export const other = 0;\n";
  entry.receipt = await routeTools(DEMO_CATALOG, { intent: fixture.task, availableIds: DEMO_CATALOG.map(t => t.id) }, DEMO_POLICY, scenarioRouter(SCENARIOS[0]!));
  const reverseKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseKeys)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)])) : value;
  const reordered = reverseKeys(entry) as ArenaRun;
  assert.notEqual(JSON.stringify(entry), JSON.stringify(reordered));
  const storage = new Storage(); saveRun(storage, entry);
  const before = storage.getItem(HISTORY_KEY);
  storage.setItem = () => { throw Error("An identical save needs no write"); };
  assert.equal(saveRun(storage, reordered).saved, true);
  assert.equal(storage.getItem(HISTORY_KEY), before);
  assert.deepEqual(readHistory(storage).runs, [entry]);
  const duplicate = parseHistory(JSON.stringify({ version: 1, runs: [entry, reordered, entry] }));
  assert.equal(duplicate.error, null);
  assert.deepEqual(duplicate.runs, [entry]);
});

test("conflicting same-ID saves preserve the original run and its human assessment", () => {
  const storage = new Storage(), original = run(); original.lanes.baseline!.tools = ["read_file", "propose_patch"]; saveRun(storage, original);
  const assessment = { runId: original.id, baseline: "pass" as const, integrated: "pass" as const, note: "Assessment of the original task", updatedAt: "2026-09-22T00:00:03Z" };
  assert.equal(saveAssessment(storage, assessment, [original.id], undefined).saved, true);
  const before = [...storage.data];
  for (const change of [
    (entry: ArenaRun) => { entry.fixture.task = "A different synthetic task"; },
    (entry: ArenaRun) => { entry.lanes.baseline!.result.inputTokens = 5; },
    (entry: ArenaRun) => { entry.lanes.baseline!.result.answer = "Different synthetic evidence"; },
    (entry: ArenaRun) => { entry.lanes.baseline!.tools = ["propose_patch", "read_file"]; },
  ]) {
    const replacement = structuredClone(original); change(replacement);
    const result = saveRun(storage, replacement);
    assert.equal(result.saved, false);
    assert.match(result.error!, /Different evidence.*run ID/);
    assert.deepEqual(result.runs, [original]);
    assert.deepEqual([...storage.data], before);
    assert.deepEqual(readAssessments(storage).entries, [assessment]);
  }
});

test("conflicting duplicate IDs are excluded visibly without choosing evidence for an assessment", () => {
  const original = run(), replacement = run(); replacement.fixture.task = "A different synthetic task";
  const unaffected = run("unaffected");
  for (const entries of [[original, replacement, original, unaffected], [replacement, original, unaffected]]) {
    const storage = new Storage(), raw = JSON.stringify({ version: 1, runs: entries }); storage.setItem(HISTORY_KEY, raw);
    const parsed = readHistory(storage);
    assert.match(parsed.error!, /conflicting IDs/);
    assert.deepEqual(parsed.runs, [unaffected]);
    assert.equal(saveRun(storage, run("new")).saved, false);
    assert.equal(storage.getItem(HISTORY_KEY), raw);
  }
});

test("quota and unavailable storage are visible without destroying the previous cache", () => {
  const storage = new Storage(); saveRun(storage, run());
  const prior = storage.getItem(HISTORY_KEY);
  storage.setItem = () => { throw Error("quota"); };
  const result = saveRun(storage, run("two"));
  assert.equal(result.saved, false);
  assert.ok(result.error);
  assert.equal(storage.getItem(HISTORY_KEY), prior);
  const blocked = { getItem() { throw Error(); }, setItem() { throw Error(); }, removeItem() { throw Error(); } };
  assert.ok(readHistory(blocked).error);
  assert.ok(clearHistory(blocked));
});

test("oversized runs are not silently truncated or called saved", () => {
  const entry = run(); entry.lanes.baseline!.result.answer = "x".repeat(MAX_BYTES + 1);
  const storage = new Storage();
  const result = saveRun(storage, entry);
  assert.equal(result.saved, false);
  assert.ok(result.error);
  assert.equal(storage.getItem(HISTORY_KEY), null);
});

test("time series uses complete same-fixture same-setup pairs and includes Jev overhead", () => {
  const first = run(), later = { ...run("later"), finishedAt: "2026-09-22T00:10:00Z" };
  const unknown = run("unknown"); unknown.jevUsage = null;
  const partial = run("partial"); partial.status = "partial";
  const different = run("different"); different.fixture = { ...fixture, task: "Changed task" };
  const oldSetup = run("old"); oldSetup.setupVersion = 0;
  const series = performanceSeries([later, first, unknown, partial, different, oldSetup], fixture, "input");
  assert.deepEqual(series.points.map(point => [point.run.id, point.baseline, point.integrated]), [["one", 100, 120], ["later", 100, 120]]);
  assert.equal(series.excluded, 4);
  assert.equal(performanceSeries([first], fixture, "duration").points[0]!.integrated, 1200);
  assert.equal(performanceSeries([first], fixture, "input").points[0]!.baseline, 100);
});

test("overflowed integrated input remains unknown without losing its saved per-provider values", () => {
  const entry = run("overflow");
  entry.lanes.integrated!.result.inputTokens = Number.MAX_SAFE_INTEGER;
  entry.jevUsage!.inputTokens = Number.MAX_SAFE_INTEGER;
  const parsed = parseHistory(JSON.stringify({ version: 1, runs: [entry] }));
  assert.equal(parsed.error, null);
  assert.equal(parsed.runs.length, 1);
  assert.equal(parsed.runs[0]!.lanes.integrated!.result.inputTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(runMetrics(parsed.runs[0]!, "input").integrated, null);
  assert.equal(performanceSeries(parsed.runs, fixture, "input").points.length, 0);
});

test("corrupt measurement counts and durations never enter a trend", () => {
  for (const value of [1e308, .5, -1]) {
    const entry = run(); entry.lanes.baseline!.result.inputTokens = value;
    assert.equal(parseHistory(JSON.stringify({ version: 1, runs: [entry] })).runs.length, 0);
  }
  const entry = run(); entry.jevUsage!.latencyMs = 1e308;
  assert.equal(parseHistory(JSON.stringify({ version: 1, runs: [entry] })).runs.length, 0);
  entry.lanes.integrated!.result.durationMs = 1e308;
  assert.equal(performanceSeries([entry], fixture, "duration").points.length, 0);
});

test("contradictory cached input and fixture trace accounting are excluded from saved evidence", () => {
  const changes = [
    { cachedInputTokens: 101 },
    { toolCallCount: 0 },
    { toolCallCount: 2 },
    { traceTruncated: true },
    { toolCallCount: 101, traceTruncated: true },
    { toolCallCount: 100, traceTruncated: true, toolCalls: Array.from({ length: 100 }, () => lane.result.toolCalls[0]!) },
    { toolCallCount: 101, toolCalls: Array.from({ length: 100 }, () => lane.result.toolCalls[0]!) },
  ];
  for (const change of changes) {
    const entry = run("contradictory");
    Object.assign(entry.lanes.baseline!.result, change);
    const parsed = parseHistory(JSON.stringify({ version: 1, runs: [entry] }));
    assert.deepEqual(parsed.runs, []);
    assert.ok(parsed.error);
    assert.equal(performanceSeries(parsed.runs, fixture, "input").points.length, 0);
    const storage = new Storage(); saveRun(storage, run("original"));
    const previous = storage.getItem(HISTORY_KEY);
    assert.equal(saveRun(storage, entry).saved, false);
    assert.equal(storage.getItem(HISTORY_KEY), previous);
  }
});

test("history retains consistent trace boundaries and independently missing input metrics", () => {
  const variants = [
    { inputTokens: 0, cachedInputTokens: 0, toolCallCount: 0, toolCalls: [] },
    { cachedInputTokens: 100 },
    { inputTokens: null, cachedInputTokens: 100 },
    { cachedInputTokens: null },
    { toolCallCount: 100, toolCalls: Array.from({ length: 100 }, () => lane.result.toolCalls[0]!) },
    { toolCallCount: 101, traceTruncated: true, toolCalls: Array.from({ length: 100 }, () => lane.result.toolCalls[0]!) },
  ];
  for (const change of variants) {
    const entry = run(); Object.assign(entry.lanes.baseline!.result, change);
    const parsed = parseHistory(JSON.stringify({ version: 1, runs: [entry] }));
    assert.equal(parsed.error, null);
    assert.deepEqual(parsed.runs, [entry]);
  }
});

test("unreadable history is preserved until the user explicitly clears it", () => {
  const storage = new Storage(); const raw = JSON.stringify({ version: 999, runs: [run()] });
  storage.setItem(HISTORY_KEY, raw);
  assert.equal(saveRun(storage, run("new")).saved, false);
  assert.equal(storage.getItem(HISTORY_KEY), raw);
});

test("a run excluded by retention is not reported as saved", () => {
  const storage = new Storage();
  const entries = Array.from({ length: MAX_RUNS }, (_, i) => ({ ...run(String(i)), finishedAt: new Date(Date.UTC(2026, 8, 23, 0, i)).toISOString() }));
  storage.setItem(HISTORY_KEY, JSON.stringify({ version: 1, runs: entries }));
  assert.equal(saveRun(storage, run("older")).saved, false);
  assert.equal(readHistory(storage).runs.length, MAX_RUNS);
});
