import assert from "node:assert/strict";
import test from "node:test";

import { emptyLock, parseLockFile, parseTestFile, serializeLockFile, type HealDecision, type HealRecord, type LockFile } from "@testsky/artifact";
import type {
  AssertResult,
  DeviceHandle,
  Engine,
  GroundResult,
  Observation,
  PlanRequest,
  PlanResult,
  Provenance,
  TreeNode,
} from "@testsky/engine-core";
import { fixtureScreen } from "@testsky/perception";
import { CostLedger } from "@testsky/router";

import { runTest, type RunEvent } from "./run.ts";

const DEVICE: DeviceHandle = { id: "emulator-5554", platform: "android", osVersion: "15", kind: "emulator" };
const PROVENANCE: Provenance = { tier: 1, model: "fake", usd: 0.002, latencyMs: 5, usedTree: false, channel: "vision" };

function button(label: string): TreeNode {
  return {
    ref: "b",
    role: "Button",
    label,
    identifier: "com.acme:id/next",
    bounds: { x: 60, y: 560, width: 240, height: 72 },
    enabled: true,
    interactive: true,
    children: [],
  };
}

function observation(label = "Continue"): Observation {
  return {
    frame: { bytes: Buffer.alloc(0), capturedAt: 0, size: { width: 360, height: 720 }, pixelRatio: 3 },
    visionBlind: false,
    visionStats: { meanLuma: 100, stdLuma: 30, uniqueColors: 90 },
    signature: { phash: "aaaabbbbccccdddd", treeHash: "screen-1", maskedRegions: [] },
    appContext: {},
    observedAt: Date.now(),
    tree: {
      platform: "android",
      capturedAt: 0,
      source: "uiautomator",
      truncated: false,
      captureMs: 2000,
      root: {
        ref: "root",
        role: "FrameLayout",
        bounds: { x: 0, y: 0, width: 360, height: 720 },
        enabled: true,
        interactive: false,
        children: [button(label)],
      },
    },
  };
}

interface Spy {
  actions: { name: string; x?: number }[];
  grounded: number;
  planned: number;
  treeReads?: number;
  /** Tree reads made before the first action was dispatched. */
  treeReadsBeforeAct?: number;
}

function fakeEngine(label: string, spy: Spy): Engine & { stepId?: string } {
  return {
    name: "fake",
    capabilities: { tree: true, frameStream: false, networkCapture: false, nativePlanning: false, appInstall: false },
    attach: async () => {},
    detach: async () => {},
    observe: async () => observation(label),
    openFrameStream: async () => undefined,
    ground: async (): Promise<GroundResult> => {
      spy.grounded += 1;
      return { point: { x: 180, y: 596 }, confidence: 0.9, anchor: { tree: { role: "Button", label, identifier: "com.acme:id/next", bounds: button(label).bounds } }, provenance: PROVENANCE };
    },
    act: async (req) => {
      spy.actions.push({ name: req.name, ...(req.target ? { x: req.target.x } : {}) });
      return { dispatchedAt: Date.now(), stale: false };
    },
    assert: async (): Promise<AssertResult> => ({ pass: true, reason: "it is there", provenance: PROVENANCE }),
    extract: (async () => ({ data: {}, provenance: PROVENANCE })) as Engine["extract"],
    plan: async (): Promise<PlanResult> => {
      spy.planned += 1;
      return { actions: [{ name: "tap", describeTarget: "the Continue button" }], done: false, provenance: PROVENANCE };
    },
    popup: async () => ({ found: false, provenance: PROVENANCE }),
    app: { launch: async () => {}, terminate: async () => {}, install: async () => {}, currentBuildId: async () => "com.acme@1.0+1" },
    logs: { open: async () => { throw new Error("no logs"); } },
  };
}

const TEST = parseTestFile(`
id: cached
targets: [{ platform: android, app: com.acme }]
steps:
  - id: press
    do: press continue
    expect: the next screen is visible
`);

function run(engine: Engine & { stepId?: string }, lock?: LockFile, healDecisions?: HealDecision[]) {
  return runTest({
    engine,
    test: TEST,
    device: DEVICE,
    ledger: new CostLedger(),
    settle: false,
    ...(lock ? { lock, appBuild: "com.acme@1.0+1" } : {}),
    ...(healDecisions ? { healDecisions } : {}),
  });
}

const newSpy = (): Spy => ({ actions: [], grounded: 0, planned: 0 });

/** Learn "Continue", then heal to "Devam et": the state a reviewer is asked about. */
async function healed(): Promise<LockFile> {
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  await run(fakeEngine("Continue", newSpy()), lock);
  const result = await run(fakeEngine("Devam et", newSpy()), lock);
  assert.equal(result.outcome, "HEALED_PASS");
  return lock;
}

/** A person's word on a heal, as it comes back from the control plane: through JSON. */
function decided(heal: HealRecord, status: HealDecision["status"]): HealDecision[] {
  return [JSON.parse(JSON.stringify({ step: heal.step, status, before: heal.before, after: heal.after }))];
}

test("the first run learns where the button is, and writes it down", async () => {
  const spy: Spy = { actions: [], grounded: 0, planned: 0 };
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  const result = await run(fakeEngine("Continue", spy), lock);

  assert.equal(result.outcome, "PASS");
  assert.equal(spy.grounded, 1, "it had to ask where the button was");
  const learned = lock.steps.press!;
  assert.deepEqual(learned.actions[0]!.point, { x: 180, y: 596 });
  assert.equal(learned.actions[0]!.anchor?.tree?.label, "Continue");
  assert.deepEqual(learned.stability, { runs: 1, passes: 1 });
  assert.equal(result.cache.replayed, 0);
});

test("the second run replays it and asks no model where to tap", async () => {
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  await run(fakeEngine("Continue", { actions: [], grounded: 0, planned: 0 }), lock);

  const spy: Spy = { actions: [], grounded: 0, planned: 0 };
  const result = await run(fakeEngine("Continue", spy), lock);

  assert.equal(result.outcome, "PASS");
  assert.equal(spy.grounded, 0, "nothing was asked -- this is the whole cost story");
  assert.equal(spy.planned, 0);
  assert.deepEqual(spy.actions, [{ name: "tap", x: 180 }], "and it still pressed the button");
  assert.equal(result.steps[0]!.fromCache, true);
  assert.equal(result.cache.replayed, 1);
  assert.deepEqual(lock.steps.press!.stability, { runs: 2, passes: 2 });
});

test("a renamed button heals: not a failure, and not a silent repair either", async () => {
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  await run(fakeEngine("Continue", { actions: [], grounded: 0, planned: 0 }), lock);

  // The app shipped a copy change. Same id, same place, different words.
  const spy: Spy = { actions: [], grounded: 0, planned: 0 };
  const result = await run(fakeEngine("Devam et", spy), lock);

  assert.equal(result.outcome, "HEALED_PASS", "green, but not silently green");
  assert.equal(spy.grounded, 1, "it worked the target out again");
  assert.equal(result.steps[0]!.healed, true);

  const heal = lock.heals[0]!;
  assert.equal(heal.step, "press");
  assert.match(heal.reason, /called "Devam et" now/);
  assert.equal(heal.before.anchor?.tree?.label, "Continue");
  assert.equal(heal.after.anchor?.tree?.label, "Devam et");
  assert.equal(heal.status, "pending_review", "a person decides whether this was a copy edit or a broken flow");
});

test("a new build keeps what was learned but re-checks it, rather than trusting or discarding it", async () => {
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  await run(fakeEngine("Continue", { actions: [], grounded: 0, planned: 0 }), lock);

  const spy: Spy = { actions: [], grounded: 0, planned: 0 };
  await runTest({
    engine: fakeEngine("Continue", spy),
    test: TEST,
    device: DEVICE,
    ledger: new CostLedger(),
    settle: false,
    lock,
    appBuild: "com.acme@1.1+2",
  });

  assert.equal(lock.appBuild, "com.acme@1.1+2");
  assert.equal(spy.grounded, 0, "the anchor still checks out, so the new build costs nothing");
});

test("a new build is said, with the one before it; a lock that named no build is given the run's quietly", async () => {
  const notes = async (lock: LockFile, appBuild: string) => {
    const events: RunEvent[] = [];
    await runTest({ engine: fakeEngine("Continue", newSpy()), test: TEST, device: DEVICE, ledger: new CostLedger(), settle: false, lock, appBuild, onEvent: (event) => events.push(event) });
    return events.filter((event) => event.kind === "note").map((event) => event.message);
  };
  // Written by a playground before it kept the build: it was on no other one.
  const unnamed = emptyLock("cached", "android");
  assert.deepEqual((await notes(unnamed, "com.acme@1.0+1")).filter((note) => /build/.test(note)), []);
  assert.equal(unnamed.appBuild, "com.acme@1.0+1");

  const said = await notes(unnamed, "com.acme@1.1+2");
  assert.ok(said.some((note) => /^new build com\.acme@1\.1\+2 \(was com\.acme@1\.0\+1\)/.test(note)), said.join("\n"));
  assert.equal(unnamed.appBuild, "com.acme@1.1+2");
});

test("a rejected heal that happens again is red, and the memory is not taught the substitute", async () => {
  const lock = await healed();
  const rejected = decided(lock.heals[0]!, "rejected");

  const result = await run(fakeEngine("Devam et", newSpy()), lock, rejected);

  assert.equal(result.outcome, "FAIL_REJECTED_HEAL", "a person already said this is a real failure");
  assert.match(result.detail, /rejected this change, and it happened again: tap "Continue" became tap "Devam et"/);
  assert.notEqual(result.steps[0]!.healed, true, "refused, not healed");
  assert.equal(lock.heals.length, 1, "no second proposal for a diff that has been decided");
  assert.equal(lock.heals[0]!.status, "rejected");
  assert.equal(lock.steps.press!.actions[0]!.anchor?.tree?.label, "Continue", "the memory still wants the old target");
});

test("the rejection holds on the next run even when the control plane cannot be reached", async () => {
  const lock = await healed();
  await run(fakeEngine("Devam et", newSpy()), lock, decided(lock.heals[0]!, "rejected"));

  // No decisions this time: the runner could not fetch them, or this is a
  // local `testsky run` that never asks. The lock remembers what was said.
  const again = await run(fakeEngine("Devam et", newSpy()), lock);
  assert.equal(again.outcome, "FAIL_REJECTED_HEAL");

  // And once the app is fixed, the restored memory is what makes it green --
  // for free, replayed rather than worked out again.
  const fixed = newSpy();
  const green = await run(fakeEngine("Continue", fixed), lock);
  assert.equal(green.outcome, "PASS");
  assert.equal(green.steps[0]!.fromCache, true);
  assert.equal(fixed.grounded, 0);
});

test("an accepted heal leaves the run exactly as it would have been", async () => {
  const withDecision = await healed();
  const without = await healed();

  const accepted = await run(fakeEngine("Devam et", newSpy()), withDecision, decided(withDecision.heals[0]!, "accepted"));
  const untouched = await run(fakeEngine("Devam et", newSpy()), without);

  assert.equal(accepted.outcome, "PASS");
  assert.equal(accepted.outcome, untouched.outcome);
  assert.equal(accepted.steps[0]!.fromCache, untouched.steps[0]!.fromCache);
  assert.deepEqual(withDecision.steps, without.steps, "the memory is what the heal made it");
  assert.equal(withDecision.heals[0]!.status, "accepted", "and the heal is marked, so it is not proposed again");
});

test("a different change on a step with a rejected heal is a new heal, not the rejected one", async () => {
  const lock = await healed();
  const result = await run(fakeEngine("Weiter", newSpy()), lock, decided(lock.heals[0]!, "rejected"));

  assert.equal(result.outcome, "HEALED_PASS", "nobody has ruled on this one yet");
  assert.equal(lock.heals.length, 2);
  assert.equal(lock.heals[1]!.after.anchor?.tree?.label, "Weiter");
  assert.equal(lock.heals[1]!.status, "pending_review");
});

// ── A review with no control plane: the lock edited by hand, then `testsky run` ──

/** The lock as a person leaves it: written out, one heal's status edited, read back by the next run. */
function edited(lock: LockFile, status: HealRecord["status"], from: HealRecord["status"] = "pending_review"): LockFile {
  const text = serializeLockFile(lock);
  assert.equal(text.split(`status: ${from}`).length, 2, "one heal to edit");
  return parseLockFile(text.replace(`status: ${from}`, `status: ${status}`))!;
}

/** A run with no decisions handed to it, and what it said. */
async function heard(engine: Engine & { stepId?: string }, lock: LockFile) {
  const events: RunEvent[] = [];
  const result = await runTest({ engine, test: TEST, device: DEVICE, ledger: new CostLedger(), settle: false, lock, appBuild: "com.acme@1.0+1", onEvent: (event) => events.push(event) });
  return { result, notes: events.filter((event) => event.kind === "note").map((event) => event.message) };
}

test("a heal rejected by hand in the lock fails the same change on the next run", async () => {
  const lock = edited(await healed(), "rejected");
  const { result, notes } = await heard(fakeEngine("Devam et", newSpy()), lock);

  assert.equal(result.outcome, "FAIL_REJECTED_HEAL", "the person's word, with no control plane to hand it over");
  assert.ok(notes.includes("a heal was rejected -- the memory is back to what it was, and the same change again will fail the run"), notes.join("\n"));
  assert.equal(lock.steps.press!.actions[0]!.anchor?.tree?.label, "Continue", "the memory wants the old target");
  assert.equal(lock.heals.length, 1, "no second proposal for a diff that has been decided");
  assert.equal(lock.heals[0]!.applied, "rejected");

  // Written back and read by the run after: acted on once, and still holding.
  const next = parseLockFile(serializeLockFile(lock))!;
  const again = await heard(fakeEngine("Devam et", newSpy()), next);
  assert.equal(again.result.outcome, "FAIL_REJECTED_HEAL");
  assert.ok(!again.notes.some((note) => /a heal was rejected/.test(note)), "not acted on a second time");

  // And once the app is fixed, the restored memory makes it green, replayed.
  const fixed = newSpy();
  const green = await run(fakeEngine("Continue", fixed), next);
  assert.equal(green.outcome, "PASS");
  assert.equal(green.steps[0]!.fromCache, true);
  assert.equal(fixed.grounded, 0);
});

test("a heal accepted by hand in the lock leaves the run as it would have been, and is marked", async () => {
  const lock = edited(await healed(), "accepted");
  const spy = newSpy();
  const { result, notes } = await heard(fakeEngine("Devam et", spy), lock);

  assert.equal(result.outcome, "PASS");
  assert.equal(result.steps[0]!.fromCache, true);
  assert.equal(spy.grounded, 0);
  assert.ok(notes.includes("a heal was accepted -- the app changed, and the memory already says so"), notes.join("\n"));
  assert.equal(lock.heals[0]!.applied, "accepted");
});

test("a rejection changed by hand to an acceptance is replayed on the next run, not healed again", async () => {
  const lock = edited(await healed(), "rejected");
  assert.equal((await run(fakeEngine("Devam et", newSpy()), lock)).outcome, "FAIL_REJECTED_HEAL");

  const changed = edited(lock, "accepted", "rejected");
  const spy = newSpy();
  const result = await run(fakeEngine("Devam et", spy), changed);
  assert.equal(result.outcome, "PASS", "the substitute is back in the memory, rather than one more heal to accept");
  assert.equal(spy.grounded, 0);
  assert.equal(changed.heals.length, 1);
});

test("a rejection taken back to pending_review in the lock keeps the old target: the next run heals again, HEALED_PASS", async () => {
  const lock = edited(await healed(), "rejected");
  assert.equal((await run(fakeEngine("Devam et", newSpy()), lock)).outcome, "FAIL_REJECTED_HEAL");

  const undecided = edited(lock, "pending_review", "rejected");
  const spy = newSpy();
  const { result, notes } = await heard(fakeEngine("Devam et", spy), undecided);
  assert.ok(notes.includes("a word on a heal was taken back -- the memory is left as it is, and the heal waits for review again"), notes.join("\n"));
  assert.equal(result.outcome, "HEALED_PASS", "the change is up for review again, not a quiet PASS on a substitute nobody accepted");
  assert.equal(spy.grounded, 1, "worked out again from the old target");
  assert.equal(undecided.heals.length, 1, "the heal waiting for review is the one already filed");
  assert.deepEqual([undecided.heals[0]!.status, undecided.heals[0]!.applied], ["pending_review", undefined]);
});

// ── Flat pixels and no tree: how iOS hands a list row over ─────────────────

/** The same screen with no tree: what iOS gives unless one is asked for. */
function bare(label: string): Observation {
  const { tree: _tree, signature, ...rest } = observation(label);
  return { ...rest, signature: { phash: signature.phash, maskedRegions: signature.maskedRegions } };
}

/**
 * A target on flat pixels with no tree in hand: grounding hands back nothing
 * it could check next time, the way a list row does on iOS. `moved` makes the
 * screen change between the grounding and the tree read.
 */
function flatEngine(spy: Spy, at = { x: 180, y: 596 }, moved = false): Engine & { stepId?: string } {
  return {
    ...fakeEngine("Genel", spy),
    observe: async (opts) => {
      if (!opts?.tree) return bare("Genel");
      spy.treeReads = (spy.treeReads ?? 0) + 1;
      const full = observation("Genel");
      return moved ? { ...full, signature: { ...full.signature, phash: "ffff0000ffff0000" } } : full;
    },
    ground: async (): Promise<GroundResult> => {
      spy.grounded += 1;
      return { point: at, confidence: 0.9, anchor: {}, provenance: PROVENANCE };
    },
    act: async (req) => {
      spy.treeReadsBeforeAct ??= spy.treeReads ?? 0;
      spy.actions.push({ name: req.name, ...(req.target ? { x: req.target.x } : {}) });
      return { dispatchedAt: Date.now(), stale: false };
    },
  };
}

/** The lock a run on the old code left behind: a point and nothing to check it by. */
async function rememberedBlind(point: { x: number; y: number }): Promise<LockFile> {
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  await run(flatEngine(newSpy()), lock);
  const tap = lock.steps.press!.actions[0]!;
  tap.point = point;
  tap.anchor = {};
  return lock;
}

test("a target on flat pixels is remembered by its control, and the next run asks no model", async () => {
  const first = newSpy();
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  assert.equal((await run(flatEngine(first), lock)).outcome, "PASS");
  // Before the tap, not after it: a tree read later belongs to another screen.
  assert.equal(first.treeReadsBeforeAct, 2, "the plan's look, and one at the press to find the control where it is now");
  assert.deepEqual(lock.steps.press!.actions[0]!.anchor?.tree, {
    role: "Button",
    label: "Genel",
    identifier: "com.acme:id/next",
    bounds: { x: 60, y: 560, width: 240, height: 72 },
  });

  const second = newSpy();
  const result = await run(flatEngine(second), lock);
  assert.equal(result.outcome, "PASS");
  assert.equal(second.grounded, 0, "the memory checked out without a model");
  assert.equal(result.steps[0]!.fromCache, true);
  assert.deepEqual(lock.heals, []);
});

test("the tree is read before grounding, so the control comes from the capture the target was found on", async () => {
  const spy = newSpy();
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  await run(flatEngine(spy, { x: 180, y: 596 }, true), lock);
  assert.equal(spy.treeReadsBeforeAct, 3, "the plan's look, again when the picture said the screen had moved, and at the press");
  assert.equal(lock.steps.press!.actions[0]!.anchor?.tree?.label, "Genel", "frame and tree were one capture");
});

test("a step that asked for the picture reads the tree after grounding, and trusts it only on the same screen", async () => {
  const vision = parseTestFile(`
id: cached
targets: [{ platform: android, app: com.acme }]
steps:
  - id: press
    do: press continue
    expect: the next screen is visible
    channel: vision
`);
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  await runTest({ engine: flatEngine(newSpy(), { x: 180, y: 596 }, true), test: vision, device: DEVICE, ledger: new CostLedger(), settle: false, lock, appBuild: "com.acme@1.0+1" });
  assert.equal(lock.steps.press!.actions[0]!.anchor?.tree, undefined, "a control from another screen is not this target");
});

test("a memory with nothing to check, re-found where it pointed, is a cache miss rather than a heal", async () => {
  // Found a few points from where it was remembered: grounding jitters.
  const lock = await rememberedBlind({ x: 186, y: 599 });
  const spy = newSpy();
  const result = await run(flatEngine(spy), lock);

  assert.equal(result.outcome, "PASS", "the app did not change, so neither does the verdict");
  assert.equal(spy.grounded, 1, "it had to ask, because nothing could be checked");
  assert.deepEqual(lock.heals, [], "and it files no card for a reviewer to click through");
  assert.equal(lock.steps.press!.actions[0]!.anchor?.tree?.label, "Genel", "the memory can be checked from now on");
});

test("a memory with nothing to check, re-found somewhere else, is still a heal", async () => {
  const lock = await rememberedBlind({ x: 180, y: 100 });
  const result = await run(flatEngine(newSpy()), lock);

  assert.equal(result.outcome, "HEALED_PASS");
  const heal = lock.heals[0]!;
  assert.equal(heal.reason, "nothing was remembered about this target");
  assert.deepEqual(heal.before.point, { x: 180, y: 100 });
  assert.deepEqual(heal.after.point, { x: 180, y: 596 });
});

test("…and anywhere on the same control, however far along a row grounding lands this time", async () => {
  // Remembered near the button's left edge, found near its right: 220 points
  // apart, and still the tap the memory meant.
  const lock = await rememberedBlind({ x: 70, y: 570 });
  const result = await run(flatEngine(newSpy(), { x: 290, y: 620 }), lock);

  assert.equal(result.outcome, "PASS");
  assert.deepEqual(lock.heals, []);
});

test("pixels that changed under a remembered point are a heal, even when the target is re-found in place", async () => {
  // The memory kept only pixels -- what iOS leaves when no tree came with the
  // frame -- and they no longer match. That might be a repaint or a rename;
  // with no control on the remembered side, a person has to say which.
  const fixture = await fixtureScreen();
  const lock = await rememberedBlind({ x: 180, y: 596 });
  lock.steps.press!.actions[0]!.anchor = { patchPhash: "0f0f0f0f0f0f0f0f" };
  const flat = flatEngine(newSpy());
  const withPixels: Engine & { stepId?: string } = {
    ...flat,
    observe: async (opts) => {
      const seen = await flat.observe(opts);
      return { ...seen, frame: { ...seen.frame, bytes: fixture.png, size: fixture.size, pixelRatio: fixture.pixelRatio } };
    },
  };
  const result = await run(withPixels, lock);

  assert.equal(result.outcome, "HEALED_PASS");
  assert.match(lock.heals[0]!.reason, /what is under that point changed/);
  assert.equal(lock.heals[0]!.after.anchor?.tree?.label, "Genel", "the card shows the control that was found");
});


test("a memory doubted part of the way through is checked only once the agent has acted", async () => {
  // Remembered: a swipe, then Continue. Continue is called Next now, and a
  // lenient judge would pass the screen as it is after the swipe alone.
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  lock.steps.press = {
    screen: { phash: "aaaabbbbccccdddd", treeHash: "screen-1" },
    actions: [
      { action: "swipe", params: { direction: "down" } },
      { action: "tap", describeTarget: "the Continue button", point: { x: 180, y: 596 }, anchor: { tree: { role: "Button", label: "Continue", identifier: "com.acme:id/next", bounds: button("Continue").bounds } } },
    ],
    tier: 1,
    confidence: 0.9,
    stability: { runs: 3, passes: 3 },
  };
  const spy = newSpy();
  const result = await run(fakeEngine("Next", spy), lock);
  assert.equal(spy.planned, 1, "the agent works the doubted action out");
  assert.deepEqual(spy.actions.map((action) => action.name), ["swipe", "tap"], "and does it before anything is checked");
  assert.equal(result.outcome, "HEALED_PASS");
  assert.equal(lock.heals.at(-1)?.after.action, "tap", "the card shows what was pressed, not a step that passed without acting");
});

test("a remembered control a replayed swipe left elsewhere is pressed where it is, with no model and no heal", async () => {
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  lock.steps.press = {
    screen: { phash: "aaaabbbbccccdddd", treeHash: "screen-1" },
    actions: [
      { action: "swipe", params: { direction: "down" } },
      // Learned where the swipe happened to leave it last time: 300 points lower.
      { action: "tap", describeTarget: "the Continue button", point: { x: 180, y: 896 }, anchor: { tree: { role: "Button", label: "Continue", identifier: "com.acme:id/next", bounds: { x: 60, y: 860, width: 240, height: 72 } } } },
    ],
    tier: 1,
    confidence: 0.9,
    stability: { runs: 3, passes: 3 },
  };
  const spy = newSpy();
  const result = await run(fakeEngine("Continue", spy), lock);
  assert.equal(result.outcome, "PASS");
  assert.deepEqual(spy.actions, [{ name: "swipe" }, { name: "tap", x: 180 }]);
  assert.deepEqual([spy.planned, spy.grounded, lock.heals.length], [0, 0, 0]);
});

test("a replayed tap says it came from memory and what checked it, on the screen it was pressed on", async () => {
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  await run(fakeEngine("Continue", newSpy()), lock);
  const events: RunEvent[] = [];
  await runTest({
    engine: fakeEngine("Continue", newSpy()),
    test: TEST,
    device: DEVICE,
    ledger: new CostLedger(),
    settle: false,
    lock,
    appBuild: "com.acme@1.0+1",
    onEvent: (event) => events.push(event),
  });
  const action = events.find((event) => event.kind === "action")!;
  assert.equal(action.data?.by, "memory");
  assert.equal(action.data?.checkedBy, "tree", "the remembered control was found in the tree, at no cost");
  assert.deepEqual(action.data?.screen, { width: 360, height: 720 });
  assert.equal(action.shotId, "press.action-1");
});

const DO_ONLY = parseTestFile(`
id: cached
targets: [{ platform: android, app: com.acme }]
steps:
  - id: press
    do: press continue
`);

/**
 * A planner that taps once and then, told it has, says the goal is reached --
 * or, with `more`, taps that many times again first. What it was asked is kept.
 */
function tapsOnce(engine: Engine & { stepId?: string }, asked: PlanRequest[] = [], more = 0): Engine & { stepId?: string } {
  return {
    ...engine,
    plan: async (req) => {
      asked.push(req);
      await engine.plan(req);
      return req.history.length > more
        ? { actions: [], done: true, provenance: PROVENANCE }
        : { actions: [{ name: "tap", describeTarget: "the Continue button" }], done: false, provenance: PROVENANCE };
    },
  };
}

function runDoOnly(engine: Engine & { stepId?: string }, lock: LockFile, events: RunEvent[] = [], test = DO_ONLY) {
  return runTest({ engine, test, device: DEVICE, ledger: new CostLedger(), settle: false, lock, appBuild: "com.acme@1.0+1", onEvent: (event) => events.push(event) });
}

test("a step with nothing to check, replayed to the screen it was done on, is done with no model asked", async () => {
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  assert.equal((await runDoOnly(tapsOnce(fakeEngine("Continue", newSpy())), lock)).outcome, "PASS");
  assert.equal(lock.steps.press?.do, "press continue", "remembered with the words it was learned for");
  assert.deepEqual(lock.steps.press?.end, { phash: "aaaabbbbccccdddd", treeHash: "screen-1" }, "and the screen it was done on");

  const spy = newSpy();
  const events: RunEvent[] = [];
  const result = await runDoOnly(tapsOnce(fakeEngine("Continue", spy)), lock, events);
  assert.equal(result.outcome, "PASS");
  assert.deepEqual(spy.actions, [{ name: "tap", x: 180 }], "it still pressed the button");
  assert.deepEqual([spy.planned, spy.grounded], [0, 0], "and asked nothing: where it ended says the step is done");
  assert.equal(result.steps[0]!.fromCache, true);
  assert.ok(events.some((event) => event.kind === "note" && /done on last time -- done, from memory/.test(event.message)));
});

test("a replay that ends somewhere else is put to the agent, and the agent is told what the replay did", async () => {
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  await runDoOnly(tapsOnce(fakeEngine("Continue", newSpy())), lock);
  lock.steps.press!.end = { phash: "ffffffffffffffff" };

  const spy = newSpy();
  const asked: PlanRequest[] = [];
  const result = await runDoOnly(tapsOnce(fakeEngine("Continue", spy), asked), lock);
  assert.equal(result.outcome, "PASS");
  assert.equal(spy.planned, 1, "a screen it was not done on is the agent's to judge");
  // Told nothing, it would read a goal already reached as one not begun, and
  // -- shown the steps to come -- start on the next one.
  assert.equal(asked[0]!.history.length, 1);
  assert.match(asked[0]!.history[0]!.outcome, /^carried out as in the last run; the screen did not change$/);
  assert.equal(asked[0]!.history[0]!.action, "tap");
  assert.deepEqual(spy.actions, [{ name: "tap", x: 180 }], "and nothing pressed twice");
  assert.equal(result.steps[0]!.fromCache, true, "the memory was all it took");
});

test("a replay the agent had to carry on from is a step worked out again, not one from memory", async () => {
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  await runDoOnly(tapsOnce(fakeEngine("Continue", newSpy())), lock);
  lock.steps.press!.end = { phash: "ffffffffffffffff" };

  const spy = newSpy();
  const result = await runDoOnly(tapsOnce(fakeEngine("Continue", spy), [], 1), lock);
  assert.equal(result.outcome, "PASS");
  assert.equal(spy.actions.length, 2);
  assert.equal(result.steps[0]!.fromCache, undefined);
  assert.equal(result.cache.replayed, 0);
});

test("a step reworded under the same id is worked out again: the old taps would check out on the old target", async () => {
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  await runDoOnly(tapsOnce(fakeEngine("Continue", newSpy())), lock);

  const reworded = parseTestFile(`
id: cached
targets: [{ platform: android, app: com.acme }]
steps:
  - id: press
    do: press  continue   and wait
`);
  const spy = newSpy();
  const events: RunEvent[] = [];
  const result = await runDoOnly(tapsOnce(fakeEngine("Continue", spy)), lock, events, reworded);
  assert.equal(result.outcome, "PASS");
  assert.equal(spy.grounded, 1, "worked out again, not replayed");
  assert.equal(result.steps[0]!.fromCache, undefined);
  assert.equal(lock.heals.length, 0, "and no heal: the app did not change, the test did");
  assert.ok(events.some((event) => event.kind === "note" && event.message === 'this step\'s words changed since it was learned ("press continue") -- working it out again'));
  assert.equal(lock.steps.press?.do, "press  continue   and wait", "remembered for its new words from now on");

  // Spacing is not wording.
  const respaced = parseTestFile(`
id: cached
targets: [{ platform: android, app: com.acme }]
steps:
  - id: press
    do: press continue and wait
`);
  const again = newSpy();
  assert.equal((await runDoOnly(tapsOnce(fakeEngine("Continue", again)), lock, [], respaced)).steps[0]!.fromCache, true);
  assert.equal(again.grounded, 0);

  // A memory kept before the words were is replayed as it always was.
  delete lock.steps.press!.do;
  const older = newSpy();
  assert.equal((await runDoOnly(tapsOnce(fakeEngine("Continue", older)), lock, [], reworded)).steps[0]!.fromCache, true);
  assert.equal(older.grounded, 0);
});
