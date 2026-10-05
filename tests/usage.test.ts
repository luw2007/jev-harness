import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeUsage, parseEntries, recordUsage, getUsage, clearUsage, type UsageEntry } from "../examples/routing/usage.js";
test("usage preserves partial and unknown calls without claiming zero cost", () => {
  const entries = parseEntries(JSON.stringify([
    { at: "2026-09-22T00:00:00Z", status: "success", input: 100, output: 20, latencyMs: 10, keySource: "personal" },
    { at: "2026-09-22T00:00:01Z", status: "failed", input: null, output: null, latencyMs: null, keySource: "host" },
  ]));
  assert.deepEqual(summarizeUsage(entries), { requests: 2, providerRequests: null, observedProviderRequests: 0, retryRequests: 0, input: 100, output: 20, unknown: 1 });
  assert.deepEqual(parseEntries('[{"input":-1}]'), []);
  assert.deepEqual(parseEntries('not json'), []);
});

test("legacy usage accepts independent unknown counts and fractional latency but rejects impossible counts", () => {
  const valid = { at: "2026-10-05T00:00:00Z", status: "success", input: 1, output: null, latencyMs: 0.25, keySource: "host" };
  const entries = [valid, ...[{ input: 0.5 }, { output: 1e308 }, { input: Number.MAX_SAFE_INTEGER + 1 }, { latencyMs: 86_400_001 }].map(change => ({ ...valid, ...change }))];
  assert.deepEqual(parseEntries(JSON.stringify(entries)), [valid]);
});

test("individually valid usage retains per-request counts when session totals overflow", () => {
  const entry = { at: "2026-10-05T00:00:00Z", status: "success" as const, input: Number.MAX_SAFE_INTEGER, output: 2, latencyMs: 1, keySource: "host" as const };
  const entries = parseEntries(JSON.stringify([entry, entry]));
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.input, Number.MAX_SAFE_INTEGER);
  const summary = summarizeUsage(entries);
  assert.equal(summary.input, null);
  assert.equal(summary.output, 4);
  assert.equal(summary.requests, 2);
});

test("usage writes and reads preserve detached whitelisted telemetry", () => {
  const storage = new Map<string, string>();
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), savedStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
  try {
    clearUsage();
    const measurement = { requestBytes: 10, responseBytes: 20, inputTokens: 1, outputTokens: null, latencyMs: 0.25, ignored: "synthetic-sensitive-metadata" };
    const entry = { at: "2026-10-05T00:00:00Z", status: "success" as const, input: 1, output: null, latencyMs: 0.25, keySource: "host" as const, measurement, ignored: "synthetic-sensitive-metadata" };
    recordUsage(entry);
    assert.equal([...storage.values()].some(raw => raw.includes("synthetic-sensitive-metadata")), false);
    entry.input = 99; measurement.inputTokens = 99;
    const first = getUsage();
    assert.equal(first[0]!.input, 1); assert.equal(first[0]!.measurement!.inputTokens, 1);
    first[0]!.input = 50; first[0]!.measurement!.inputTokens = 50; first.length = 0;
    assert.equal(getUsage().length, 1); assert.equal(getUsage()[0]!.input, 1); assert.equal(getUsage()[0]!.measurement!.inputTokens, 1);
    recordUsage({ ...entry, input: 0.5 } as UsageEntry);
    assert.equal(getUsage().length, 1, "invalid telemetry must preserve the prior cache");
  } finally {
    clearUsage();
    if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow); else Reflect.deleteProperty(globalThis, "window");
    if (savedStorage) Object.defineProperty(globalThis, "sessionStorage", savedStorage); else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
