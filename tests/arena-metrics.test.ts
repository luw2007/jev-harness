import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArenaAccounting, ArenaResults, type ArenaLane } from "../components/arena-results";
import type { RouterMeasurement } from "../examples/routing/measurement";

function lane(inputTokens: number | null): ArenaLane {
  return { tools: ["read_file"], result: { status: "completed", answer: "Synthetic result.", durationMs: 100, inputTokens, cachedInputTokens: 0, outputTokens: 1, toolCallCount: 0, traceTruncated: false, toolCalls: [], error: null } };
}
function render(input: number | null, router: number | null) {
  const lanes = { baseline: lane(100), integrated: lane(input) };
  const jevUsage: RouterMeasurement = { requestBytes: 100, responseBytes: 10, inputTokens: router, outputTokens: 1, latencyMs: 1 };
  return {
    results: renderToStaticMarkup(createElement(ArenaResults, { lanes, receipt: null, jevUsage, pending: false, progress: {}, finished: true })),
    accounting: renderToStaticMarkup(createElement(ArenaAccounting, { lanes, jevUsage })),
  };
}
const display = (value: number | null) => value === null ? "Unknown" : value.toLocaleString();

test("arena input totals render exact safe boundaries and zero", () => {
  for (const [input, router, total] of [[Number.MAX_SAFE_INTEGER - 1, 1, Number.MAX_SAFE_INTEGER], [Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER], [0, 0, 0]] as const) {
    const { results, accounting } = render(input, router);
    const integrated = results.split('class="result arena-lane integrated"')[1]!;
    assert.ok(integrated.includes(`<dt>Input tokens</dt><dd><strong>${display(total)}</strong>`));
    assert.ok(accounting.includes(`<td>Total reported input tokens</td><td>100</td><td>${display(total)}</td>`));
    assert.ok(accounting.includes(`<span>With Jev</span><strong>${display(total)} tokens</strong>`));
  }
});

test("overflowed arena totals stay unknown while individual CLI and Jev counts remain visible", () => {
  const input = Number.MAX_SAFE_INTEGER, router = 1;
  const { results, accounting } = render(input, router);
  const integrated = results.split('class="result arena-lane integrated"')[1]!;
  assert.ok(results.includes("Usage incomplete"));
  assert.ok(integrated.includes("<dt>Input tokens</dt><dd><strong>Unknown</strong>"));
  assert.ok(integrated.includes(`${display(input)} CLI + ${display(router)} Jev`));
  assert.ok(accounting.includes("<td>Total reported input tokens</td><td>100</td><td>Unknown</td>"));
  assert.ok(accounting.includes(`<td>CLI input tokens</td><td>100</td><td>${display(input)}</td>`));
  assert.ok(accounting.includes("<td>Jev input tokens</td><td>Not called</td><td>1</td>"));
  assert.ok(accounting.includes('<span>With Jev</span><strong>Unknown tokens</strong></div><div class="token-track" aria-hidden="true"></div>'));
  for (const html of [results, accounting]) assert.ok(!html.includes(display(input + router)), "rounded overflow is never displayed as a measured total");
});

test("either missing input component leaves the arena total unknown without hiding its reported peer", () => {
  for (const [input, router] of [[null, 20], [100, null]] as const) {
    const { results, accounting } = render(input, router);
    const integrated = results.split('class="result arena-lane integrated"')[1]!;
    assert.ok(results.includes("Usage incomplete"));
    assert.ok(integrated.includes("<dt>Input tokens</dt><dd><strong>Unknown</strong>"));
    assert.ok(integrated.includes(`${display(input)} CLI + ${display(router)} Jev`));
    assert.ok(accounting.includes("<td>Total reported input tokens</td><td>100</td><td>Unknown</td>"));
    assert.ok(accounting.includes(`<td>CLI input tokens</td><td>100</td><td>${display(input)}</td>`));
    assert.ok(accounting.includes(`<td>Jev input tokens</td><td>Not called</td><td>${display(router)}</td>`));
  }
});
