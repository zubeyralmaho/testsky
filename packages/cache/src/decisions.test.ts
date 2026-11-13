import assert from "node:assert/strict";
import test from "node:test";

import { emptyLock, parseLockFile, serializeLockFile, type HealDecision, type HealRecord, type LockFile, type ResolvedAction } from "@testsky/artifact";

import { applyHealDecisions, applyLockReviews, sameHeal, sameTarget } from "./decisions.ts";

function control(label: string, x = 60, identifier = "com.acme:id/next"): ResolvedAction {
  return {
    action: "tap",
    describeTarget: "the Continue button",
    point: { x: x + 120, y: 596 },
    anchor: { tree: { role: "Button", label, identifier, bounds: { x, y: 560, width: 240, height: 72 } } },
  };
}

const CONTINUE = control("Continue");
const DEVAM = control("Devam et");

/** A lock as a healed run leaves it: the substitute remembered, the heal pending. */
function healedLock(): LockFile {
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  lock.steps.press = {
    screen: { phash: "aaaabbbbccccdddd", treeHash: "screen-1" },
    actions: [structuredClone(DEVAM)],
    tier: 1,
    confidence: 0.9,
    stability: { runs: 2, passes: 2 },
  };
  lock.heals.push({
    step: "press",
    at: "2026-09-20T10:00:00.000Z",
    reason: 'it is called "Devam et" now, not "Continue"',
    before: structuredClone(CONTINUE),
    after: structuredClone(DEVAM),
    confidence: 0.9,
    status: "pending_review",
  });
  return lock;
}

/** What the control plane hands back: the same diff, after a trip through JSON. */
function decision(status: HealDecision["status"], heal: Pick<HealRecord, "before" | "after">, reviewedAt?: string): HealDecision {
  return JSON.parse(JSON.stringify({ step: "press", status, before: heal.before, after: heal.after, ...(reviewedAt ? { reviewedAt } : {}) }));
}

test("the same control grounded twice is the same target, a renamed one is not", () => {
  const jittered = control("Devam et", 66);
  jittered.point = { x: 190, y: 601 };
  assert.equal(sameTarget(DEVAM, jittered), true, "a few points of jitter must not defeat a rejection");
  assert.equal(sameTarget(CONTINUE, DEVAM), false, "different words, different control");
  assert.equal(sameTarget(DEVAM, control("Devam et", 60, "com.acme:id/other")), false);
  assert.equal(sameTarget(DEVAM, { ...DEVAM, action: "longPress" }), false);
  assert.equal(sameTarget({}, {}), true, "two steps that both passed without acting did the same nothing");
  assert.equal(sameTarget({}, DEVAM), false);
  assert.equal(sameTarget({ action: "tap", point: { x: 10, y: 10 } }, { action: "tap", point: { x: 20, y: 30 } }), true);
  assert.equal(sameTarget({ action: "tap", point: { x: 10, y: 10 } }, { action: "tap", point: { x: 200, y: 30 } }), false);
});

test("a rejection puts the remembered target back and marks the heal", () => {
  const lock = healedLock();
  const applied = applyHealDecisions(lock, [decision("rejected", lock.heals[0]!)]);

  assert.deepEqual(applied, [{ step: "press", status: "rejected", memory: "restored" }]);
  assert.equal(lock.steps.press!.actions[0]!.anchor?.tree?.label, "Continue");
  assert.equal(lock.heals[0]!.status, "rejected");
  assert.equal(lock.heals.length, 1);
});

test("a rejection applies once: re-reading it does not undo what the memory learned since", () => {
  const lock = healedLock();
  applyHealDecisions(lock, [decision("rejected", lock.heals[0]!)]);
  // Later the substitute came back by another route -- a newer heal somebody
  // accepted. The old rejection is still in every answer the control plane gives.
  lock.steps.press!.actions[0] = structuredClone(DEVAM);

  assert.deepEqual(applyHealDecisions(lock, [decision("rejected", lock.heals[0]!)]), []);
  assert.equal(lock.steps.press!.actions[0]!.anchor?.tree?.label, "Devam et");
});

test("an accepted heal changes nothing but its status", () => {
  const lock = healedLock();
  const memory = structuredClone(lock.steps);
  const applied = applyHealDecisions(lock, [decision("accepted", lock.heals[0]!)]);

  assert.deepEqual(applied, [{ step: "press", status: "accepted", memory: "unchanged" }]);
  assert.deepEqual(lock.steps, memory);
  assert.equal(lock.heals[0]!.status, "accepted");
});

test("changing one's mind about a rejection puts the substitute back in the memory", () => {
  const lock = healedLock();
  applyHealDecisions(lock, [decision("rejected", lock.heals[0]!, "2026-09-21T09:00:00.000Z")]);
  assert.equal(lock.steps.press!.actions[0]!.anchor?.tree?.label, "Continue");

  // A later run hears the newer word: the app did change after all.
  const accepted = decision("accepted", lock.heals[0]!, "2026-09-22T09:00:00.000Z");
  assert.deepEqual(applyHealDecisions(lock, [accepted]), [{ step: "press", status: "accepted", memory: "reapplied" }]);
  assert.equal(lock.steps.press!.actions[0]!.anchor?.tree?.label, "Devam et");
  assert.equal(lock.heals[0]!.status, "accepted");
  assert.deepEqual(applyHealDecisions(lock, [accepted]), [], "and hearing it again changes nothing");
});

test("only the latest word on a diff counts", () => {
  const lock = healedLock();
  const heal = lock.heals[0]!;
  applyHealDecisions(lock, [
    decision("rejected", heal, "2026-09-21T09:00:00.000Z"),
    decision("accepted", heal, "2026-09-22T09:00:00.000Z"),
  ]);

  assert.equal(lock.heals[0]!.status, "accepted");
  assert.equal(lock.steps.press!.actions[0]!.anchor?.tree?.label, "Devam et");
});

test("a rejection of a heal this lock never saw is kept, so an offline run still knows it", () => {
  const lock = healedLock();
  lock.heals = [];
  applyHealDecisions(lock, [decision("rejected", { before: CONTINUE, after: DEVAM })]);

  assert.equal(lock.heals.length, 1);
  assert.equal(lock.heals[0]!.status, "rejected");
  assert.equal(lock.steps.press!.actions[0]!.anchor?.tree?.label, "Continue", "and the substitute is not replayed");
});

test("a rejected heal of a typed value is forgotten, not replayed with nothing to type", () => {
  const lock = healedLock();
  const field: ResolvedAction = { ...control("Search", 20, "com.acme:id/search"), action: "input" };
  lock.heals[0]!.before = structuredClone(field);
  const applied = applyHealDecisions(lock, [decision("rejected", lock.heals[0]!)]);

  assert.deepEqual(applied, [{ step: "press", status: "rejected", memory: "forgotten" }]);
  assert.equal(lock.steps.press, undefined);
});

test("a rejected detour around a target never found is forgotten, not replayed as a tap with nowhere to land", () => {
  const lock = healedLock();
  // The agent could not find Save, tapped Devam et instead, and the step passed.
  lock.heals[0]!.before = { action: "tap", describeTarget: "the Save button" };
  const applied = applyHealDecisions(lock, [decision("rejected", lock.heals[0]!)]);

  assert.deepEqual(applied, [{ step: "press", status: "rejected", memory: "forgotten" }]);
  assert.equal(lock.steps.press, undefined, "worked out again next time, where the same detour is the failure it was called");
});

test("a detour around a target never found is the same detour, whatever the agent called the target", () => {
  const detour = (words: string) => ({ step: "press", before: { action: "tap" as const, describeTarget: words }, after: structuredClone(DEVAM) });
  assert.equal(sameHeal(detour("the Save button"), detour("Save button")), true, "the agent's words drift from run to run");
  assert.equal(sameHeal(detour("the Save button"), { ...detour("the Save button"), after: structuredClone(CONTINUE) }), false, "gone somewhere else is another detour");
  assert.equal(sameHeal(detour("the Save button"), { step: "press", before: structuredClone(CONTINUE), after: structuredClone(DEVAM) }), false, "and a remembered target is not a missed one");
});

test("a memory gone astray is never the same diff as a memory that passed without acting", () => {
  const before = { action: "input" as const, describeTarget: "the search box at the top", point: { x: 171, y: 132 } };
  const astray: HealRecord = { step: "open", at: "2026-10-27T00:00:00Z", reason: "went astray", before, after: {}, confidence: 0.9, status: "rejected", kind: "astray" };
  const idle: HealRecord = { step: "open", at: "2026-10-27T01:00:00Z", reason: "passed without acting", before, after: {}, confidence: 0.9, status: "pending_review" };
  assert.equal(sameHeal(astray, idle), false, "a rejection of one is no rejection of the other");
  assert.equal(sameHeal(astray, { step: "open", before, after: {}, kind: "astray" }), true);
});

test("a word on a memory gone astray marks the heal and leaves the memory to the run", () => {
  const before = { action: "input" as const, describeTarget: "the search box at the top", point: { x: 171, y: 132 } };
  const lock = emptyLock("browser", "ios");
  lock.steps.open = { screen: { phash: "0000000000000000" }, actions: [{ ...before, params: { value: "https://www.google.com" } }], tier: 1, confidence: 0.9, stability: { runs: 4, passes: 4 } };
  lock.heals.push({ step: "open", at: "2026-10-27T00:00:00Z", reason: "went astray", before, after: {}, confidence: 0.9, status: "pending_review", kind: "astray" });
  const applied = applyHealDecisions(lock, [{ step: "open", status: "accepted", before, after: {}, kind: "astray", reviewedAt: "2026-10-27T08:00:00Z" }]);
  assert.deepEqual(applied, [{ step: "open", status: "accepted", kind: "astray", memory: "unchanged" }]);
  assert.equal(lock.heals[0]!.status, "accepted");
  assert.ok(lock.steps.open, "forgotten by the run that reaches the step, while it still holds what went astray");

  // Heard of, never seen here: kept as what it was.
  const elsewhere = emptyLock("browser", "ios");
  applyHealDecisions(elsewhere, [{ step: "open", status: "rejected", before, after: {}, kind: "astray" }]);
  assert.equal(elsewhere.heals[0]!.kind, "astray");
});

test("a word with no kind on a memory gone astray is a word on that memory, from a store that keeps none", () => {
  const before = { action: "input" as const, describeTarget: "the search box at the top", point: { x: 171, y: 132 } };
  const lock = emptyLock("browser", "ios");
  lock.heals.push({ step: "open", at: "2026-10-27T00:00:00Z", reason: "went astray", before, after: {}, confidence: 0.9, status: "pending_review", kind: "astray" });
  applyHealDecisions(lock, [{ step: "open", status: "rejected", before, after: {}, reviewedAt: "2026-10-27T08:00:00Z" }]);
  assert.equal(lock.heals.length, 1, "no rejection of another kind is added");
  assert.equal(lock.heals[0]!.status, "rejected");
  assert.equal(lock.heals[0]!.kind, "astray");
});

// ── A review with no control plane: the word written into the lock by hand ──

/** The lock as a person leaves it: written out, one heal's status edited, read back. */
function edited(lock: LockFile, status: HealRecord["status"], from: HealRecord["status"] = "pending_review"): LockFile {
  const text = serializeLockFile(lock);
  assert.equal(text.split(`status: ${from}`).length, 2, "one heal to edit");
  return parseLockFile(text.replace(`status: ${from}`, `status: ${status}`))!;
}

test("a rejection written into the lock by hand puts the remembered target back, once", () => {
  const lock = edited(healedLock(), "rejected");
  assert.deepEqual(applyLockReviews(lock), [{ step: "press", status: "rejected", memory: "restored" }]);
  assert.equal(lock.steps.press!.actions[0]!.anchor?.tree?.label, "Continue");
  assert.equal(lock.heals[0]!.status, "rejected");
  assert.equal(lock.heals[0]!.applied, "rejected", "and the lock says it was acted on");

  // Written back and read again: the same word is not acted on a second
  // time, even once the memory has learned the substitute by another route.
  const again = parseLockFile(serializeLockFile(lock))!;
  again.steps.press!.actions[0] = structuredClone(DEVAM);
  assert.deepEqual(applyLockReviews(again), []);
  assert.equal(again.steps.press!.actions[0]!.anchor?.tree?.label, "Devam et");
});

test("an acceptance written into the lock by hand changes nothing but the record of it", () => {
  const lock = edited(healedLock(), "accepted");
  const memory = structuredClone(lock.steps);
  assert.deepEqual(applyLockReviews(lock), [{ step: "press", status: "accepted", memory: "unchanged" }]);
  assert.deepEqual(lock.steps, memory);
  assert.equal(lock.heals[0]!.applied, "accepted");
  assert.deepEqual(applyLockReviews(lock), []);
});

test("a mind changed in the lock is acted on each time: the substitute comes back, and goes again", () => {
  const lock = edited(healedLock(), "rejected");
  applyLockReviews(lock);

  const accepted = edited(lock, "accepted", "rejected");
  assert.deepEqual(applyLockReviews(accepted), [{ step: "press", status: "accepted", memory: "reapplied" }]);
  assert.equal(accepted.steps.press!.actions[0]!.anchor?.tree?.label, "Devam et");

  const rejected = edited(accepted, "rejected", "accepted");
  assert.deepEqual(applyLockReviews(rejected), [{ step: "press", status: "rejected", memory: "restored" }]);
  assert.equal(rejected.steps.press!.actions[0]!.anchor?.tree?.label, "Continue");
});

test("a word a control plane handed back is not acted on again from the lock", () => {
  const lock = healedLock();
  applyHealDecisions(lock, [decision("rejected", lock.heals[0]!)]);
  assert.equal(lock.heals[0]!.applied, "rejected");
  lock.steps.press!.actions[0] = structuredClone(DEVAM);

  assert.deepEqual(applyLockReviews(lock), []);
  assert.equal(lock.steps.press!.actions[0]!.anchor?.tree?.label, "Devam et");
});

test("where the control plane and the file both have a word on a heal, the control plane's is kept", () => {
  const lock = edited(healedLock(), "rejected");
  applyHealDecisions(lock, [decision("accepted", lock.heals[0]!, "2026-09-22T09:00:00.000Z")]);

  assert.deepEqual(applyLockReviews(lock), []);
  assert.equal(lock.heals[0]!.status, "accepted");
  assert.equal(lock.steps.press!.actions[0]!.anchor?.tree?.label, "Devam et", "never put back only to be taken out again");
});

test("a word written by hand reaches the heal it was written on, beside a memory gone astray with the same sides", () => {
  const before = { action: "input" as const, describeTarget: "the search box at the top", point: { x: 171, y: 132 } };
  const lock = emptyLock("browser", "ios");
  lock.heals.push(
    { step: "open", at: "2026-10-27T00:00:00Z", reason: "went astray", before, after: {}, confidence: 0.9, status: "pending_review", kind: "astray" },
    { step: "open", at: "2026-10-27T01:00:00Z", reason: "passed without acting", before, after: {}, confidence: 0.9, status: "rejected" },
  );
  applyLockReviews(lock);
  assert.equal(lock.heals[0]!.status, "pending_review", "not the astray one's");
  assert.equal(lock.heals[1]!.applied, "rejected");
});

test("a word written by hand on a memory gone astray is marked, and left to the run", () => {
  const before = { action: "input" as const, describeTarget: "the search box at the top", point: { x: 171, y: 132 } };
  const lock = emptyLock("browser", "ios");
  lock.steps.open = { screen: { phash: "0000000000000000" }, actions: [{ ...before, params: { value: "https://www.google.com" } }], tier: 1, confidence: 0.9, stability: { runs: 4, passes: 4 } };
  lock.heals.push({ step: "open", at: "2026-10-27T00:00:00Z", reason: "went astray", before, after: {}, confidence: 0.9, status: "accepted", kind: "astray" });
  assert.deepEqual(applyLockReviews(lock), [{ step: "open", status: "accepted", kind: "astray", memory: "unchanged" }]);
  assert.equal(lock.heals[0]!.applied, "accepted");
  assert.ok(lock.steps.open, "forgotten by the run that reaches the step");
});

test("a rejection taken back to pending_review leaves the memory on the old target, and forgets only the rejection", () => {
  const lock = edited(healedLock(), "rejected");
  applyLockReviews(lock);
  const undecided = edited(lock, "pending_review", "rejected");
  assert.deepEqual(applyLockReviews(undecided), [{ step: "press", status: "pending_review", memory: "unchanged" }]);
  assert.equal(undecided.steps.press!.actions[0]!.anchor?.tree?.label, "Continue", "no substitute put back that nobody accepted");
  assert.equal(undecided.heals[0]!.applied, undefined);
  assert.deepEqual(applyLockReviews(undecided), [], "taken back once");

  // Runs of the still-changed app heal the step again, and the person
  // rejects it once more: a word written afresh, acted on afresh.
  undecided.steps.press!.actions[0] = structuredClone(DEVAM);
  const again = edited(undecided, "rejected");
  assert.deepEqual(applyLockReviews(again), [{ step: "press", status: "rejected", memory: "restored" }]);
  assert.equal(again.steps.press!.actions[0]!.anchor?.tree?.label, "Continue");
});

test("an acceptance taken back to pending_review changes nothing in the memory", () => {
  const lock = edited(healedLock(), "accepted");
  applyLockReviews(lock);
  const memory = structuredClone(lock.steps);
  const undecided = edited(lock, "pending_review", "accepted");
  assert.deepEqual(applyLockReviews(undecided), [{ step: "press", status: "pending_review", memory: "unchanged" }]);
  assert.deepEqual(undecided.steps, memory);
  assert.equal(undecided.heals[0]!.applied, undefined);
});

test("a word taken back on one heal of a diff is taken back on every heal of it", () => {
  const lock = healedLock();
  lock.heals.push({ ...structuredClone(lock.heals[0]!), at: "2026-09-25T10:00:00.000Z" });
  for (const heal of lock.heals) heal.status = "rejected";
  applyLockReviews(lock);
  assert.deepEqual(lock.heals.map((heal) => heal.applied), ["rejected", "rejected"]);

  lock.heals[1]!.status = "pending_review";
  applyLockReviews(lock);
  assert.deepEqual(lock.heals.map((heal) => [heal.status, heal.applied]), [["pending_review", undefined], ["pending_review", undefined]], "the older one would still fail the change");
});

test("a status misspelt in the lock is no word, and nothing is acted on", () => {
  const lock = healedLock();
  (lock.heals[0] as { status: string }).status = "reject";
  const memory = structuredClone(lock.steps);
  assert.deepEqual(applyLockReviews(lock), []);
  assert.deepEqual(lock.steps, memory, "not read as the rejection it may have meant");
  assert.equal(lock.heals[0]!.applied, undefined);
});
