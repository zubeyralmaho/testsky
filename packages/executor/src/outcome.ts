/**
 * What a step or a test actually did.
 *
 * This enum is the most important decision in the schema, and it is here in
 * week one on purpose. Measurements of GUI agents put budget exhaustion at
 * roughly half of all failures; a product that reports those as "test failed"
 * is telling the customer their app is broken in half the cases where it is
 * not. Once people learn that red means nothing, the tool is dead -- and no
 * model upgrade brings that trust back.
 *
 * So: only a verdict means "your app may be broken", and only a verdict ever
 * blocks a merge. There are exactly two, and nothing else may join them:
 *
 *  - FAIL_ASSERT: an expectation the author wrote was checked and was false.
 *  - FAIL_REJECTED_HEAL: the memory stopped checking out, and what was found
 *    instead is a change a person has already looked at and called a failure.
 *
 * They are kept apart because the evidence and the remedy differ. In the
 * second, the step's own expectation usually held -- the flow still "works"
 * -- and folding it into FAIL_ASSERT would print "an expectation was false"
 * beside a step whose expectation visibly passed. The accusation comes from a
 * reviewer, re-applied to the same diff, and the report has to say so.
 */

export type Outcome =
  | "PASS"
  | "HEALED_PASS"
  | "FAIL_ASSERT"
  | "FAIL_REJECTED_HEAL"
  | "FAIL_GROUND"
  | "BUDGET_EXHAUSTED"
  | "LOOP_DETECTED"
  | "DEVICE_ERROR"
  | "VACUOUS_ASSERT"
  // Given by the control plane, never by a runner: the run's runner went
  // quiet, or started again, before the run finished. Nothing it did after
  // its last word is known, so this says nothing about the app or the test.
  | "RUNNER_LOST";

/** Only a verdict -- an evaluated expectation, or a person's -- is about the app. */
export function accusesApp(outcome: Outcome): boolean {
  return outcome === "FAIL_ASSERT" || outcome === "FAIL_REJECTED_HEAL";
}

/** Passes and verdicts count toward a merge; "we could not tell" never does. */
export function blocksMerge(outcome: Outcome): boolean {
  return outcome === "PASS" || outcome === "HEALED_PASS" || accusesApp(outcome);
}

export function isFailure(outcome: Outcome): boolean {
  return outcome !== "PASS" && outcome !== "HEALED_PASS";
}

/** What the report says, in words a person can act on. */
export function describeOutcome(outcome: Outcome): string {
  switch (outcome) {
    case "PASS":
      return "Passed";
    case "HEALED_PASS":
      return "Passed, but a step had to be re-resolved -- review the heal";
    case "FAIL_ASSERT":
      return "An expectation was checked and was false: your app may be broken";
    case "FAIL_REJECTED_HEAL":
      return "A change a person already rejected happened again: your app may be broken";
    case "FAIL_GROUND":
      return "The test could not find an element it was told to act on";
    case "BUDGET_EXHAUSTED":
      return "The agent ran out of budget before finishing";
    case "LOOP_DETECTED":
      return "The agent got stuck repeating itself";
    case "DEVICE_ERROR":
      return "The device or its tooling failed";
    case "VACUOUS_ASSERT":
      return "An expectation could never have failed -- rewrite it";
    case "RUNNER_LOST":
      return "The runner stopped reporting before the run finished -- this says nothing about the app";
  }
}
