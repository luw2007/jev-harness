import { test } from "node:test";
import assert from "node:assert/strict";
import { createJevChoiceRouter } from "../examples/host/jev-choice.js";
import { routeTools } from "../src/routing/index.js";
import { DEMO_CATALOG, DEMO_POLICY } from "../examples/routing/scenarios.js";
import { sumCounts, attemptTotals, parseMeasurement } from "../examples/routing/measurement.js";

const input = { intent: "Read the synthetic file", availableIds: ["read_file"] };
const valid = () => ({ model: "jev-1.13.0", answers: { tool: { type: "choice", choice: "read_file", confidence: .9, probabilities: { read_file: .9, needs_clarification: .1 } } }, usage: { input_tokens: 100, output_tokens: 10 } });
const invalidSum = () => { const raw = valid(); raw.answers.tool.probabilities.needs_clarification = .09; return raw; };
const run = (handle: ReturnType<typeof createJevChoiceRouter>) => routeTools(DEMO_CATALOG, input, DEMO_POLICY, handle.router);

test("count totals retain exact safe boundaries and keep overflow unknown", () => {
  assert.equal(sumCounts([]), 0);
  assert.equal(sumCounts([Number.MAX_SAFE_INTEGER - 1, 1]), Number.MAX_SAFE_INTEGER);
  assert.equal(sumCounts([Number.MAX_SAFE_INTEGER, 0]), Number.MAX_SAFE_INTEGER);
  assert.equal(sumCounts([Number.MAX_SAFE_INTEGER, 1]), null);
  assert.equal(sumCounts([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1]), null);
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(sumCounts([value]), null);
});

test("mandatory request-byte totals fail explicitly when valid per-attempt counts overflow", async () => {
  let calls = 0;
  const handle = createJevChoiceRouter({ key: "<synthetic-test-key>", recovery: "probability_sum_only_v1",
    fetch: async () => Response.json(++calls === 1 ? invalidSum() : valid()),
  });
  const receipt = await run(handle);
  const measurement = structuredClone(handle.state.measurement!), ledger = measurement.attemptLedger!;
  for (const attempt of ledger.attempts) attempt.requestBytes = Math.floor(Number.MAX_SAFE_INTEGER / 2);
  measurement.requestBytes = Number.MAX_SAFE_INTEGER - 1;
  assert.equal(attemptTotals(ledger).requestBytes, measurement.requestBytes);
  assert.deepEqual(parseMeasurement(measurement, receipt.request.options.map(option => option.id), receipt.evidence), measurement);
  for (const attempt of ledger.attempts) attempt.requestBytes = Number.MAX_SAFE_INTEGER;
  measurement.requestBytes = Number.MAX_SAFE_INTEGER;
  assert.throws(() => attemptTotals(ledger), /request-byte total/);
  assert.throws(() => parseMeasurement(measurement, receipt.request.options.map(option => option.id), receipt.evidence), /request-byte total/);
  assert.ok(ledger.attempts.every(attempt => attempt.requestBytes === Number.MAX_SAFE_INTEGER));
});

test("recovered measurements round-trip when individually valid token counts overflow", async () => {
  for (const overflow of ["input_tokens", "output_tokens"] as const) {
    let calls = 0;
    const handle = createJevChoiceRouter({ key: "<synthetic-test-key>", recovery: "probability_sum_only_v1", fetch: async () => {
      const raw = ++calls === 1 ? invalidSum() : valid();
      raw.usage = { input_tokens: 5, output_tokens: 5 };
      raw.usage[overflow] = Number.MAX_SAFE_INTEGER;
      return Response.json(raw);
    } });
    const receipt = await run(handle), measurement = handle.state.measurement!, ledger = measurement.attemptLedger!;
    assert.equal(receipt.outcome, "selected");
    assert.deepEqual(ledger.attempts.map(attempt => attempt.status), ["invalid_sum", "valid"]);
    const totals = attemptTotals(ledger), metric = overflow === "input_tokens" ? "input" : "output";
    assert.deepEqual(totals[metric], { total: null, reported: null, unknown: 0 });
    assert.equal(measurement.inputTokens, metric === "input" ? null : 10);
    assert.equal(measurement.outputTokens, metric === "output" ? null : 10);
    assert.ok(ledger.attempts.every(attempt => (metric === "input" ? attempt.inputTokens : attempt.outputTokens) === Number.MAX_SAFE_INTEGER));
    assert.equal(totals.providerRequests, 2);
    assert.ok(measurement.responseBytes !== null && measurement.responseBytes > 0);
    assert.deepEqual(parseMeasurement(JSON.parse(JSON.stringify(measurement)), receipt.request.options.map(option => option.id), receipt.evidence), measurement);
  }
});

test("overflowed reported subtotals preserve independently missing attempt counts", async () => {
  let calls = 0;
  const handle = createJevChoiceRouter({ key: "<synthetic-test-key>", recovery: "probability_sum_only_v1", fetch: async () => {
    const raw = ++calls < 3 ? invalidSum() : valid();
    raw.usage.input_tokens = Number.MAX_SAFE_INTEGER;
    if (calls === 3) delete (raw.usage as Partial<typeof raw.usage>).input_tokens;
    return Response.json(raw);
  } });
  const receipt = await run(handle), measurement = handle.state.measurement!;
  assert.equal(receipt.outcome, "selected");
  assert.deepEqual(attemptTotals(measurement.attemptLedger!).input, { total: null, reported: null, unknown: 1 });
  assert.equal(measurement.inputTokens, null);
  assert.equal(measurement.outputTokens, 30);
  assert.deepEqual(parseMeasurement(measurement, receipt.request.options.map(option => option.id), receipt.evidence), measurement);
});

test("sum-only recovery records every identical dispatch and total usage", async () => {
  for (const failures of [1, 2, 3]) {
    const bodies: unknown[] = [], signals: unknown[] = [];
    const handle = createJevChoiceRouter({ key: "synthetic-test-credential", recovery: "probability_sum_only_v1", fetch: async (_url, init) => {
      bodies.push(init?.body); signals.push(init?.signal);
      return Response.json(bodies.length <= failures ? invalidSum() : valid());
    } });
    const receipt = await run(handle);
    assert.equal(bodies.length, Math.min(failures + 1, 3));
    assert.equal(receipt.outcome, failures === 3 ? "unavailable" : "selected");
    assert.equal(new Set(bodies).size, 1); assert.equal(new Set(signals).size, 1);
    const m = handle.state.measurement!;
    assert.equal(m.attemptLedger?.attempts.length, bodies.length);
    assert.equal(m.inputTokens, bodies.length * 100); assert.equal(m.outputTokens, bodies.length * 10);
    assert.equal(m.attemptLedger?.returnedAttempt, failures === 3 ? null : failures + 1);
    assert.equal(m.attemptLedger?.stopReason, failures === 3 ? "exhausted" : "valid");
  }
});

test("default adapter never retries and recovery stops at every valid or other invalid answer", async () => {
  const cases = [invalidSum(), valid(), { ...valid(), model: "other" }, { ...valid(), answers: { tool: { ...valid().answers.tool, confidence: -1 } } },
    { ...valid(), answers: { tool: { ...valid().answers.tool, choice: "needs_clarification", probabilities: { read_file: .1, needs_clarification: .9 } } } },
    { ...valid(), answers: { tool: { ...valid().answers.tool, confidence: .1 } } },
    { ...valid(), answers: { tool: { ...valid().answers.tool, probabilities: { read_file: .5, needs_clarification: .5 } } } },
    { ...valid(), answers: { tool: { ...invalidSum().answers.tool, choice: "needs_clarification" } } },
    { ...valid(), answers: { tool: { ...valid().answers.tool, probabilities: { read_file: .9, private_option: .09 } } } }];
  for (const [index, raw] of cases.entries()) {
    let calls = 0;
    const handle = createJevChoiceRouter({ key: "synthetic-test-credential", ...(index ? { recovery: "probability_sum_only_v1" as const } : {}), fetch: async () => { calls++; return Response.json(raw); } });
    await run(handle); assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(handle.state), /private_option|synthetic-test-credential|"other"/);
  }
});

test("pre-abort and local admission count no phantom requests; denied retry retains first usage", async () => {
  for (const allowed of [0, 1]) {
    let calls = 0;
    const handle = createJevChoiceRouter({ key: "synthetic-test-credential", recovery: "probability_sum_only_v1", beforeRequest: () => calls < allowed, fetch: async () => { calls++; return Response.json(invalidSum()); } });
    await run(handle); assert.equal(calls, allowed);
    assert.equal(handle.state.measurement!.attemptLedger?.stopReason, "local_limit");
    assert.equal(handle.state.measurement!.inputTokens, allowed * 100);
  }
  const handle = createJevChoiceRouter({ key: "synthetic-test-credential", signal: AbortSignal.abort(), fetch: async () => { assert.fail("must not dispatch"); } });
  await run(handle);
  assert.equal(handle.state.measurement?.attemptLedger?.attempts.length, 0);
});

test("observer exceptions cannot cause retries and a router cannot overwrite its first call", async () => {
  let calls = 0;
  const handle = createJevChoiceRouter({ key: "synthetic-test-credential", recovery: "probability_sum_only_v1", onMeasurement: () => { throw Error("observer failed"); }, fetch: async () => { calls++; return Response.json(valid()); } });
  assert.equal((await run(handle)).outcome, "selected");
  const before = JSON.stringify(handle.state); await run(handle);
  assert.equal(calls, 1); assert.equal(JSON.stringify(handle.state), before);
});

test("one original deadline bounds fetch and stalled body reads and cancels bodies", async () => {
  for (const mode of ["fetch", "body", "retry-body"] as const) {
    let calls = 0, cancelled = false;
    const started = performance.now();
    const handle = createJevChoiceRouter({ key: "synthetic-test-credential", recovery: "probability_sum_only_v1", timeoutMs: 45, fetch: async () => {
      calls++;
      if (mode === "fetch") return new Promise<Response>(() => {});
      if (mode === "retry-body" && calls === 1) { await new Promise(resolve => setTimeout(resolve, 25)); return Response.json(invalidSum()); }
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    } });
    // AbortSignal.timeout is unref'ed; keep this deliberately stalled fake alive.
    const keepAlive = setTimeout(() => {}, 1000);
    await run(handle); clearTimeout(keepAlive);
    assert.equal(handle.state.measurement?.attemptLedger?.stopReason, "timeout");
    assert.equal(calls, mode === "retry-body" ? 2 : 1);
    assert.ok(performance.now() - started < 500);
    if (mode !== "fetch") assert.equal(cancelled, true);
  }
});

test("caller abort during fetch/body or between attempts keeps exact observed dispatches", async () => {
  for (const phase of ["fetch", "body", "between"] as const) {
    const controller = new AbortController(); let calls = 0;
    const handle = createJevChoiceRouter({ key: "synthetic-test-credential", recovery: "probability_sum_only_v1", signal: controller.signal,
      onMeasurement: m => { if (phase === "between" && m.attemptLedger?.attempts[0]?.status === "invalid_sum") controller.abort(); },
      fetch: async () => { calls++; if (phase === "between") return Response.json(invalidSum());
        if (phase === "fetch") { controller.abort(); return new Promise<Response>(() => {}); }
        return new Response(new ReadableStream({ pull() { controller.abort(); } }));
      } });
    await run(handle); assert.equal(calls, 1);
    assert.equal(handle.state.measurement?.attemptLedger?.stopReason, "cancelled");
  }
});

test("HTTP, transport, empty, JSON and body-limit failures are terminal and sanitized", async () => {
  for (const [status, response] of [
    ["http_error", () => new Response("private", { status: 429 })],
    ["transport_error", () => { throw Error("private"); }],
    ["empty_body", () => new Response("")],
    ["invalid_json", () => new Response("private not JSON")],
    ["body_limit", () => new Response("x".repeat(64_001))],
  ] as const) {
    let calls = 0;
    const handle = createJevChoiceRouter({ key: "synthetic-test-credential", recovery: "probability_sum_only_v1", fetch: async () => { calls++; return response(); } });
    await run(handle); assert.equal(calls, 1);
    assert.equal(handle.state.measurement?.attemptLedger?.attempts[0]?.status, status);
    assert.doesNotMatch(JSON.stringify(handle.state), /private/);
    if (status === "invalid_json") assert.equal(handle.state.measurement?.responseBytes, 16);
  }
});

test("choice transport refuses redirects and records one terminal failure without retry", async () => {
  let calls = 0, redirectMode: RequestRedirect | undefined;
  const handle = createJevChoiceRouter({ key: "synthetic-test-credential", recovery: "probability_sum_only_v1", fetch: async (_url, init) => {
    calls++; redirectMode = init?.redirect;
    // Fetch rejects before following the redirect when redirect is set to error.
    throw TypeError("synthetic-private-redirect-location");
  } });
  const receipt = await run(handle), ledger = handle.state.measurement!.attemptLedger!;
  assert.equal(redirectMode, "error");
  assert.equal(calls, 1);
  assert.equal(receipt.outcome, "unavailable");
  assert.equal(ledger.complete, true);
  assert.equal(ledger.attempts.length, 1);
  assert.equal(ledger.attempts[0]!.status, "transport_error");
  assert.equal(ledger.stopReason, "failure");
  assert.equal(ledger.returnedAttempt, null);
  assert.doesNotMatch(JSON.stringify(handle.state), /synthetic-private-redirect-location|synthetic-test-credential/);
});

test("strict ledger replay rejects transitions, projection, usage and totals tampering", async () => {
  const { parseMeasurement, attemptTotals } = await import("../examples/routing/measurement.js");
  let calls = 0;
  const handle = createJevChoiceRouter({ key: "synthetic-test-credential", recovery: "probability_sum_only_v1", fetch: async () => {
    calls++; const raw = calls < 3 ? invalidSum() : valid();
    if (calls === 2) delete (raw.usage as Partial<typeof raw.usage>).input_tokens;
    return Response.json(raw);
  } });
  const receipt = await run(handle), m = handle.state.measurement!;
  assert.equal(m.inputTokens, null); assert.equal(m.outputTokens, 30);
  assert.deepEqual(attemptTotals(m.attemptLedger!).input, { total: null, reported: 200, unknown: 1 });
  assert.deepEqual(parseMeasurement(m, ["read_file", "needs_clarification"], receipt.evidence), m);
  for (const mutate of [
    (v: typeof m) => { v.inputTokens = 200; },
    (v: typeof m) => { v.attemptLedger!.attempts[1]!.index = 3; },
    (v: typeof m) => { v.attemptLedger!.attempts[0]!.status = "invalid_other"; },
    (v: typeof m) => { v.attemptLedger!.attempts[0]!.projection!.probabilities.private = .1; },
    (v: typeof m) => { v.attemptLedger!.attempts[0]!.diagnostic!.unexpectedOptions = 1; },
    (v: typeof m) => { v.attemptLedger!.maxAttempts = 1; },
    (v: typeof m) => { v.attemptLedger!.returnedAttempt = 1; },
    (v: typeof m) => { v.attemptLedger!.complete = false; },
  ]) { const value = structuredClone(m); mutate(value); assert.throws(() => parseMeasurement(value, ["read_file", "needs_clarification"], receipt.evidence)); }
  assert.throws(() => parseMeasurement(m, ["read_file", "needs_clarification"], { ...receipt.evidence!, confidence: .8 }));
});

test("provider option order cannot change canonical sum classification or ledger replay", async () => {
  const { parseMeasurement } = await import("../examples/routing/measurement.js");
  const handle = createJevChoiceRouter({ key: "synthetic-test-credential", fetch: async () => Response.json({ model: "jev-1.13.0", answers: { tool: { type: "choice", choice: "needs_clarification", confidence: .7, probabilities: { needs_clarification: .7, propose_patch: .2, read_file: .1 } } } }) });
  const receipt = await routeTools(DEMO_CATALOG, { ...input, availableIds: ["read_file", "propose_patch"] }, DEMO_POLICY, handle.router);
  assert.equal(receipt.outcome, "needs_clarification");
  const boundary = createJevChoiceRouter({ key: "synthetic-test-credential", recovery: "probability_sum_only_v1", fetch: async () => Response.json({ model: "jev-1.13.0", answers: { tool: { type: "choice", choice: "propose_patch", confidence: .9, probabilities: { needs_clarification: .000001, propose_patch: .9, read_file: .1 } } } }) });
  const accepted = await routeTools(DEMO_CATALOG, { ...input, availableIds: ["read_file", "propose_patch"] }, DEMO_POLICY, boundary.router);
  assert.equal(accepted.outcome, "selected"); assert.equal(boundary.state.measurement?.attemptLedger?.attempts.length, 1);
  assert.deepEqual(parseMeasurement(boundary.state.measurement!, accepted.request.options.map(o => o.id), accepted.evidence), boundary.state.measurement);
  assert.deepEqual(parseMeasurement(handle.state.measurement!, receipt.request.options.map(o => o.id), receipt.evidence), handle.state.measurement);
});

test("an eventually resolved aborted fetch has its unused response body cancelled", async () => {
  const controller = new AbortController(); let cancelled = false;
  const handle = createJevChoiceRouter({ key: "synthetic-test-credential", signal: controller.signal, fetch: async () => {
    controller.abort(); await Promise.resolve();
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  } });
  await run(handle); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cancelled, true);
});

test("observer-triggered abort consumes a rejecting dispatched fetch", async () => {
  const controller = new AbortController();
  const unhandled: unknown[] = [], listener = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", listener);
  try {
    const handle = createJevChoiceRouter({ key: "synthetic-test-credential", signal: controller.signal,
      onMeasurement: m => { if (m.attemptLedger?.attempts[0]?.status === "pending") controller.abort(); },
      fetch: (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(Error("synthetic fetch aborted")), { once: true })) });
    await run(handle); await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(unhandled, []); assert.equal(handle.state.measurement?.attemptLedger?.stopReason, "cancelled");
  } finally { process.off("unhandledRejection", listener); }
});

test("ledger parser rejects incomplete request sets and impossible status/diagnostic combinations", async () => {
  const { parseMeasurement, measureLedger } = await import("../examples/routing/measurement.js");
  const make = async (response: () => Response) => { const h = createJevChoiceRouter({ key: "synthetic-test-credential", fetch: async () => response() }); await run(h); return h.state.measurement!; };
  const good = await make(() => Response.json(valid()));
  assert.throws(() => parseMeasurement(good, ["read_file", "needs_clarification", "propose_patch"]));
  assert.throws(() => parseMeasurement(good, input.availableIds));
  assert.throws(() => parseMeasurement(good, ["read_file", "needs_clarification"], null));
  const json = await make(() => new Response("not JSON"));
  json.attemptLedger!.attempts[0]!.httpStatus = 500;
  assert.throws(() => parseMeasurement(json));
  const sum = await make(() => Response.json(invalidSum()));
  sum.attemptLedger!.stopReason = "cancelled";
  assert.throws(() => parseMeasurement(sum));
  const wrong = await make(() => Response.json({ ...valid(), model: "wrong" }));
  wrong.attemptLedger!.attempts[0]!.diagnostic!.probabilitySum = 999;
  assert.throws(() => parseMeasurement(measureLedger(wrong.attemptLedger!, wrong.latencyMs)));
});

test("response byte accounting uses received bytes even for invalid UTF-8 JSON", async () => {
  const handle = createJevChoiceRouter({ key: "synthetic-test-credential", fetch: async () => new Response(new Uint8Array([0xff])) });
  await run(handle);
  assert.equal(handle.state.measurement?.responseBytes, 1);
  assert.equal(handle.state.measurement?.attemptLedger?.attempts[0]?.status, "invalid_json");
});

test("subset telemetry still requires the mandatory clarification option", async () => {
  const { parseMeasurement, measureLedger } = await import("../examples/routing/measurement.js");
  const handle = createJevChoiceRouter({ key: "synthetic-test-credential", fetch: async () => Response.json(valid()) });
  await run(handle);
  const ledger = structuredClone(handle.state.measurement!.attemptLedger!);
  ledger.optionIds = ["read_file"];
  ledger.attempts[0]!.projection!.probabilities = { read_file: 1 };
  ledger.attempts[0]!.diagnostic!.probabilitySum = 1;
  assert.throws(() => parseMeasurement(measureLedger(ledger, handle.state.measurement!.latencyMs), ["read_file", "needs_clarification"], undefined, true));
});

test("diagnostic object key order does not change ledger replay or same-ID history", async () => {
  const { parseMeasurement } = await import("../examples/routing/measurement.js");
  const { createRun, parseHistory, saveRun, HISTORY_KEY } = await import("../examples/arena/history.js");
  const { ARENA_CASES } = await import("../examples/arena/cases.js");
  const fixture = ARENA_CASES[0]!;
  const handle = createJevChoiceRouter({ key: "<synthetic-test-key>", fetch: async () => Response.json(valid()) });
  const receipt = await routeTools(DEMO_CATALOG, { intent: fixture.task, availableIds: input.availableIds }, DEMO_POLICY, handle.router);
  const original = handle.state.measurement!, optionIds = receipt.request.options.map(option => option.id);
  const run = createRun({ id: "diagnostic-order", startedAt: "2026-10-05T00:00:00Z", finishedAt: "2026-10-05T00:00:01Z", fixture, status: "failed", message: "Synthetic", lanes: {}, receipt, jevUsage: original });
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) };
  assert.equal(saveRun(storage, run).saved, true);
  const stored = storage.getItem(HISTORY_KEY);
  const reverseKeys = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).reverse()) as T;
  for (const nested of [false, true]) {
    const reordered = structuredClone(original);
    if (nested) reordered.attemptLedger!.attempts[0]!.diagnostic = reverseKeys(reordered.attemptLedger!.attempts[0]!.diagnostic!);
    else reordered.diagnostic = reverseKeys(reordered.diagnostic!);
    assert.deepEqual(parseMeasurement(reordered, optionIds, receipt.evidence), original);
    const equivalent = { ...run, jevUsage: reordered };
    assert.equal(saveRun(storage, equivalent).saved, true);
    assert.equal(storage.getItem(HISTORY_KEY), stored, "equivalent evidence needs no storage rewrite");
    const duplicate = parseHistory(JSON.stringify({ version: 1, runs: [run, equivalent] }));
    assert.equal(duplicate.error, null);
    assert.deepEqual(duplicate.runs, [run]);
    reordered.diagnostic!.probabilitySum = 0.5;
    assert.throws(() => parseMeasurement(reordered, optionIds, receipt.evidence));
  }
  assert.throws(() => parseMeasurement(original, [...optionIds].reverse(), receipt.evidence), "option arrays retain their order");
});
