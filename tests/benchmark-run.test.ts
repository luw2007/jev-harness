import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFixtures } from "../src/benchmark/load";
import { createMockTransport } from "../src/benchmark/mock";
import { FixtureProposer } from "../src/benchmark/proposer";
import { runProposalReview } from "../src/benchmark/run";

const fixture = loadFixtures().find(f => f.category === "clean")!;

test("invalid reviewed thresholds fail before proposing or dispatching in explicit and default modes", async () => {
  let proposals = 0, calls = 0;
  const proposer = { name: "counted-fixture", async propose() { proposals++; return fixture.proposals.good; } };
  const transport = createMockTransport([fixture]);
  const counted = async (...args: Parameters<typeof transport>) => { calls++; return transport(...args); };
  for (const threshold of [-1, 0.49, 1.01, Number.NaN, Infinity, -Infinity]) {
    await assert.rejects(runProposalReview(fixture, proposer, counted,
      { arm: "good", mode: "plus_jev", source: "mock", threshold }), /between 0.5 and 1/);
    await assert.rejects(runProposalReview(fixture, proposer, counted,
      { arm: "good", source: "mock", threshold }), /between 0.5 and 1/);
  }
  assert.equal(proposals, 0);
  assert.equal(calls, 0);
});

test("reviewed threshold endpoints remain inclusive and validate-only mode ignores reviewer thresholds", async () => {
  const proposer = new FixtureProposer();
  let calls = 0;
  const transport = createMockTransport([fixture]);
  const counted = async (...args: Parameters<typeof transport>) => { calls++; return transport(...args); };
  for (const [threshold, verdict] of [[0.5, "permit"], [1, "proposal_only"]] as const) {
    const { receipt } = await runProposalReview(fixture, proposer, counted,
      { arm: "good", source: "mock", threshold });
    assert.equal(receipt.verdict, verdict);
    assert.equal(receipt.execution.applied, false);
  }
  assert.equal(calls, 2);
  const { receipt } = await runProposalReview(fixture, proposer, counted,
    { arm: "good", mode: "base", threshold: Number.NaN });
  assert.equal(receipt.verdict, "permit");
  assert.equal(receipt.jev, null);
  assert.equal(calls, 2);
});
