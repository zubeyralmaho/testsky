import assert from "node:assert/strict";
import test from "node:test";

import { accusesApp, blocksMerge, describeOutcome, isFailure, type Outcome } from "./outcome.ts";

const ALL: Outcome[] = [
  "PASS",
  "HEALED_PASS",
  "FAIL_ASSERT",
  "FAIL_REJECTED_HEAL",
  "FAIL_GROUND",
  "BUDGET_EXHAUSTED",
  "LOOP_DETECTED",
  "DEVICE_ERROR",
  "VACUOUS_ASSERT",
];

test("only a verdict about the app is allowed to block a merge", () => {
  // The point of the taxonomy: a stuck agent, a dead emulator or an exhausted
  // budget must never read as "your app is broken".
  assert.equal(blocksMerge("FAIL_ASSERT"), true);
  assert.equal(blocksMerge("FAIL_REJECTED_HEAL"), true);
  for (const outcome of ["FAIL_GROUND", "BUDGET_EXHAUSTED", "LOOP_DETECTED", "DEVICE_ERROR", "VACUOUS_ASSERT"] as Outcome[]) {
    assert.equal(blocksMerge(outcome), false, outcome);
    assert.equal(isFailure(outcome), true, outcome);
  }
  assert.equal(blocksMerge("PASS"), true);
  assert.equal(blocksMerge("HEALED_PASS"), true);
  assert.equal(isFailure("HEALED_PASS"), false);
  assert.equal(isFailure("FAIL_REJECTED_HEAL"), true);
});

test("every outcome has words a person can act on, and only the verdicts accuse the app", () => {
  const accusing = ALL.filter((outcome) => /app may be broken/.test(describeOutcome(outcome)));
  assert.deepEqual(accusing, ["FAIL_ASSERT", "FAIL_REJECTED_HEAL"]);
  // The words and the predicate are the same claim, made twice; they may not drift.
  assert.deepEqual(ALL.filter(accusesApp), accusing);
});
