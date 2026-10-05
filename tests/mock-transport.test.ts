import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPayload, parseReviewAnswers } from "../src/contract/review";
import { REVIEW_QUESTION_IDS, type Fixture } from "../src/contract/types";
import { createMockTransport } from "../src/benchmark/mock";

const fixture: Fixture = {
  id: "synthetic-mock",
  category: "clean",
  task: "Read a.txt to inspect the requested synthetic file.",
  files: { "a.txt": "Synthetic requested context.", "b.txt": "Synthetic unrelated context." },
  evidence: [],
  proposals: {
    good: { tool: "read_file", path: "a.txt", rationale: "Inspect the requested synthetic file.", evidence: [] },
    bad: { tool: "read_file", path: "b.txt", rationale: "Inspect an unrelated synthetic file.", evidence: [] },
  },
  expected: { good: "permit", bad: "proposal_only" },
  mock: {
    good: { addresses_task: 0.95, evidence_supports: 0.95, unrelated_changes: 0.05, needs_clarification: 0.05 },
    bad: { addresses_task: 0.05, evidence_supports: 0.95, unrelated_changes: 0.95, needs_clarification: 0.05 },
  },
};

test("conflicting mock scripts for the same proposal fail before any request in either fixture order", () => {
  for (const id of REVIEW_QUESTION_IDS) {
    const conflicting: Fixture = {
      ...fixture, id: "synthetic-conflict", expected: { ...fixture.expected, good: "proposal_only" },
      mock: { ...fixture.mock, good: { ...fixture.mock.good, [id]: 1 - fixture.mock.good[id] } },
    };
    for (const fixtures of [[fixture, conflicting], [conflicting, fixture]])
      assert.throws(() => createMockTransport(fixtures), /conflicting scripted answers for the same proposal/);
  }
});

test("conflicting scripts across two arms of the same fixture are refused", () => {
  const conflicting: Fixture = { ...fixture, proposals: { good: fixture.proposals.good, bad: fixture.proposals.good } };
  assert.throws(() => createMockTransport([conflicting]), /conflicting scripted answers/);
});

test("identical duplicate mock scripts still answer from the proposal alone", async () => {
  const duplicate: Fixture = { ...fixture, id: "synthetic-duplicate", mock: {
    good: {
      needs_clarification: fixture.mock.good.needs_clarification,
      unrelated_changes: fixture.mock.good.unrelated_changes,
      evidence_supports: fixture.mock.good.evidence_supports,
      addresses_task: fixture.mock.good.addresses_task,
    },
    bad: { ...fixture.mock.bad },
  } };
  for (const fixtures of [[fixture, duplicate], [duplicate, fixture]]) {
    const transport = createMockTransport(fixtures);
    for (const arm of ["good", "bad"] as const) {
      const reply = parseReviewAnswers(await transport(buildReviewPayload(fixture, fixture.proposals[arm])));
      for (const id of REVIEW_QUESTION_IDS)
        assert.equal(reply[id].probability, fixture.mock[arm][id]);
    }
  }
});
