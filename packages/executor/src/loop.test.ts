/**
 * The step loop at its edges: where memory hands over to the agent, where
 * the test's time runs out, where the budget ends. Each test is a failure an
 * independent review reproduced against the loop as first written.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { emptyLock, parseTestFile, type LockFile } from "@testsky/artifact";
import type { AssertResult, DeviceHandle, Engine, GroundResult, Observation, PlanRequest, PlanResult, Provenance, TreeNode } from "@testsky/engine-core";
import { CostLedger } from "@testsky/router";

import { runTest } from "./run.ts";

const DEVICE: DeviceHandle = { id: "emulator-5554", platform: "android", osVersion: "15", kind: "emulator" };
const PROVENANCE: Provenance = { tier: 1, model: "fake", usd: 0.002, latencyMs: 5, usedTree: false, channel: "vision" };
const hex = (seed: string) => createHash("sha1").update(seed).digest("hex").slice(0, 16);
const START = "0000000000000000";
const BOUNDS = { x: 60, y: 560, width: 240, height: 72 };

function button(label: string): TreeNode {
  return { ref: "b", role: "Button", label, identifier: "com.acme:id/next", bounds: BOUNDS, enabled: true, interactive: true, children: [] };
}

function shot(phash: string, label: string): Observation {
  return {
    frame: { bytes: Buffer.alloc(0), capturedAt: 0, size: { width: 360, height: 720 }, pixelRatio: 3 },
    visionBlind: false,
    visionStats: { meanLuma: 100, stdLuma: 30, uniqueColors: 90 },
    signature: { phash, maskedRegions: [] },
    appContext: {},
    observedAt: Date.now(),
    tree: {
      platform: "android",
      capturedAt: 0,
      source: "uiautomator",
      truncated: false,
      captureMs: 10,
      root: { ref: "root", role: "FrameLayout", bounds: { x: 0, y: 0, width: 360, height: 720 }, enabled: true, interactive: false, children: [button(label)] },
    },
  } as Observation;
}

interface Spy {
  plans: PlanRequest[];
  acts: string[];
  asserts: string[];
}

function engineFor(
  spy: Spy,
  opts: { label?: string; screens: () => string; plan: (req: PlanRequest) => PlanResult; assert?: (assertion: string) => boolean },
): Engine & { stepId?: string } {
  const label = opts.label ?? "Continue";
  return {
    name: "fake",
    capabilities: { tree: true, frameStream: false, networkCapture: false, nativePlanning: false, appInstall: false },
    attach: async () => {},
    detach: async () => {},
    observe: async () => shot(opts.screens(), label),
    openFrameStream: async () => undefined,
    ground: async (): Promise<GroundResult> => ({
      point: { x: 180, y: 596 },
      confidence: 0.9,
      anchor: { tree: { role: "Button", label, identifier: "com.acme:id/next", bounds: BOUNDS } },
      provenance: PROVENANCE,
    }),
    act: async (req) => {
      spy.acts.push(req.name);
      (opts.screens as { advance?: () => void }).advance?.();
      return { dispatchedAt: Date.now(), stale: false };
    },
    assert: async (req): Promise<AssertResult> => {
      spy.asserts.push(req.assertion);
      const pass = opts.assert ? opts.assert(req.assertion) : true;
      return { pass, reason: pass ? "it holds" : "it does not hold", provenance: PROVENANCE };
    },
    extract: (async () => ({ data: {}, provenance: PROVENANCE })) as Engine["extract"],
    plan: async (req) => {
      spy.plans.push(structuredClone({ ...req, observation: undefined }) as never);
      return opts.plan(req);
    },
    popup: async () => ({ found: false, provenance: PROVENANCE }),
    app: { launch: async () => {}, terminate: async () => {}, install: async () => {}, currentBuildId: async () => "com.acme@1.0+1" },
    logs: {
      open: async () => {
        throw new Error("no logs");
      },
    },
  };
}

const spy = (): Spy => ({ plans: [], acts: [], asserts: [] });

/** A step learned as `swipes` swipes and, unless told not to, a tap on "Continue". */
function longMemory(swipes: number, withTap = true): LockFile {
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  lock.steps.press = {
    do: "press continue",
    screen: { phash: START },
    actions: [
      ...Array.from({ length: swipes }, () => ({ action: "swipe" as const, params: { direction: "down" } })),
      ...(withTap
        ? [
            {
              action: "tap" as const,
              describeTarget: "the Continue button",
              point: { x: 180, y: 596 },
              anchor: { tree: { role: "Button", label: "Continue", identifier: "com.acme:id/next", bounds: BOUNDS } },
            },
          ]
        : []),
    ],
    tier: 1,
    confidence: 0.9,
    stability: { runs: 3, passes: 3 },
  } as never;
  return lock;
}

const file = (body: string) =>
  parseTestFile(`
id: cached
targets: [{ platform: android, app: com.acme }]
${body}
`);
const WITH_EXPECT = file(`steps:
  - id: press
    do: press continue
    expect: the next screen is visible`);
const DO_ONLY = file(`steps:
  - id: press
    do: press continue`);

/** The remembered start, then a screen not seen before on every look. */
/** Starts on START, and each action leads to a screen not seen before. */
function fromStart(): (() => string) & { advance: () => void } {
  let n = 0;
  const screen = () => (n === 0 ? START : hex(`s${n}`));
  screen.advance = () => {
    n += 1;
  };
  return screen;
}

const tapNext = (): PlanResult => ({
  actions: [{ name: "tap", describeTarget: "the Next button", effect: "the next screen opens" }],
  done: false,
  doneWhen: "the next screen is visible",
  provenance: PROVENANCE,
});

test("a long memory doubted at its last action leaves the agent its own actions, and the heal says what it found", async () => {
  const seen = spy();
  const lock = longMemory(7);
  // The button is now "Next": the memory's tap no longer checks out.
  const result = await runTest({
    engine: engineFor(seen, { label: "Next", screens: fromStart(), plan: tapNext }),
    test: WITH_EXPECT,
    device: DEVICE,
    ledger: new CostLedger(),
    settle: false,
    lock,
    appBuild: "com.acme@1.0+1",
  });
  assert.ok(seen.plans.length >= 1, "the agent is asked: seven replayed swipes are not its actions to spend");
  assert.equal(seen.acts.filter((name) => name === "tap").length, 1, "and the tap the memory doubted is carried out");
  assert.equal(result.outcome, "HEALED_PASS");
  const heal = lock.heals.at(-1);
  assert.ok(heal?.after.action, `the heal names what was done instead, not "passed without acting": ${heal?.reason}`);
  assert.doesNotMatch(heal?.reason ?? "", /passed without acting/);
});

test("the same, with an expectation that is false: the agent works, and it is the budget that runs out, not the agent's turn", async () => {
  const seen = spy();
  const result = await runTest({
    engine: engineFor(seen, { label: "Next", screens: fromStart(), plan: tapNext, assert: () => false }),
    test: WITH_EXPECT,
    device: DEVICE,
    ledger: new CostLedger(),
    settle: false,
    lock: longMemory(7),
    appBuild: "com.acme@1.0+1",
  });
  assert.ok(seen.plans.length >= 1);
  assert.equal(seen.acts.filter((name) => name === "tap").length, 6, "the agent's own six");
  assert.equal(result.outcome, "BUDGET_EXHAUSTED");
});

test("a step learned in ten actions and replayed to another end is put to the agent", async () => {
  const lock = longMemory(10, false);
  lock.steps.press!.end = { phash: "ffffffffffffffff" };
  const seen = spy();
  const result = await runTest({
    engine: engineFor(seen, { screens: fromStart(), plan: () => ({ actions: [], done: true, provenance: PROVENANCE }) }),
    test: DO_ONLY,
    device: DEVICE,
    ledger: new CostLedger(),
    settle: false,
    lock,
    appBuild: "com.acme@1.0+1",
  });
  assert.equal(seen.plans.length, 1, "asked once, and it says done");
  assert.equal(result.outcome, "PASS", result.steps[0]?.detail);
});

test("a step whose one action outlasts the test's time is still checked, and passes if it held", async () => {
  const seen = spy();
  const engine = engineFor(seen, { screens: fromStart(), plan: tapNext });
  const plan = engine.plan.bind(engine);
  engine.plan = async (req) => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return plan(req);
  };
  const result = await runTest({
    engine,
    test: file(`policy: { budget: { max_seconds: 0.05 } }
steps:
  - id: press
    do: press continue
    expect: the next screen is visible`),
    device: DEVICE,
    ledger: new CostLedger(),
    settle: false,
  });
  assert.equal(result.outcome, "PASS", result.steps[0]?.detail);
  assert.equal(seen.asserts.length, 1);
});

test("at the limit, an empty answer to the turn owed a verdict is out of actions, not a finished step to accuse", async () => {
  let turn = 0;
  const seen = spy();
  const engine = engineFor(seen, {
    screens: fromStart(),
    plan: () => {
      turn += 1;
      return turn <= 6
        ? ({ actions: [{ name: "swipe", params: { direction: "down" }, effect: "more rows" }], done: false, last: "something else", provenance: PROVENANCE } as PlanResult)
        : { actions: [], done: false, last: "something else", provenance: PROVENANCE };
    },
    assert: () => false,
  });
  const result = await runTest({ engine, test: WITH_EXPECT, device: DEVICE, ledger: new CostLedger(), settle: false });
  assert.equal(seen.acts.length, 6);
  assert.equal(result.outcome, "BUDGET_EXHAUSTED", "an agent with nothing more to do in its budget has not shown the app is broken");
});

test("a step that earned and learned eight actions, replayed on a variant that ends one screen off, is worked out by the agent", async () => {
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  let turn = 0;
  const planner = (req: PlanRequest): PlanResult => {
    turn += 1;
    if (turn <= 8) {
      return {
        actions: [{ name: "tap", describeTarget: "the Continue button", effect: "the next row opens" }],
        done: false,
        ...(turn === 1 ? { doneWhen: "the last row is open" } : {}),
        ...(req.history.length ? { last: "as expected" as const } : {}),
        provenance: PROVENANCE,
      };
    }
    return { actions: [], done: true, last: "as expected", provenance: PROVENANCE };
  };
  const learn = spy();
  const first = await runTest({ engine: engineFor(learn, { screens: fromStart(), plan: planner }), test: DO_ONLY, device: DEVICE, ledger: new CostLedger(), settle: false, lock, appBuild: "com.acme@1.0+1" });
  assert.equal(first.outcome, "PASS", first.steps[0]?.detail);
  assert.equal(lock.steps.press?.actions.length, 8, "eight actions earned, and learned");

  // The variant: the same start, other screens after it, so the replay ends
  // somewhere the step was not done last time.
  turn = 8;
  let m = 0;
  const variant = () => (m++ === 0 ? START : hex(`variant${m}`));
  const replay = spy();
  const second = await runTest({ engine: engineFor(replay, { screens: variant, plan: planner }), test: DO_ONLY, device: DEVICE, ledger: new CostLedger(), settle: false, lock, appBuild: "com.acme@1.0+1" });
  assert.ok(replay.plans.length >= 1, "the agent is asked, with its own actions to spend");
  assert.equal(second.outcome, "PASS", second.steps[0]?.detail);
});

test("a memory replayed whole that still needed the agent is kept as it was, never lengthened run after run", async () => {
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  const lengths: number[] = [];
  for (let run = 1; run <= 5; run += 1) {
    // The same start, other screens after it: every replay ends somewhere
    // the step was not done last time, as flung swipes do.
    let n = 0;
    const screens = () => (n++ === 0 ? START : hex(`run${run}-${n}`));
    let mine = 0;
    const planner = (req: PlanRequest): PlanResult => {
      mine += 1;
      return mine <= 4
        ? ({
            actions: [{ name: "swipe", params: { direction: mine % 2 ? "down" : "up" }, effect: "the list moves" }],
            done: false,
            ...(req.history.length ? { last: "as expected" } : {}),
            provenance: PROVENANCE,
          } as PlanResult)
        : ({ actions: [], done: true, last: "as expected", provenance: PROVENANCE } as PlanResult);
    };
    const result = await runTest({ engine: engineFor(spy(), { screens, plan: planner }), test: DO_ONLY, device: DEVICE, ledger: new CostLedger(), settle: false, lock, appBuild: "com.acme@1.0+1" });
    assert.equal(result.outcome, "PASS", `run ${run}: ${result.steps[0]?.detail}`);
    lengths.push(lock.steps.press?.actions.length ?? 0);
  }
  assert.deepEqual(lengths, [4, 4, 4, 4, 4]);
});

test("a done refused on a screen that does not move is judged once, not once per look", async () => {
  let turn = 0;
  let n = 0;
  const seen = spy();
  const result = await runTest({
    engine: engineFor(seen, {
      // The start, then one screen that never moves again: where done is said, both times.
      screens: () => (n++ < 1 ? hex("start") : hex("static")),
      plan: () => {
        turn += 1;
        return turn === 1
          ? { actions: [{ name: "tap", describeTarget: "Forget", effect: "the list" }], done: false, doneWhen: 'the "Kayıtlı ağlar" page lists one network', provenance: PROVENANCE }
          : { actions: [], done: true, provenance: PROVENANCE };
      },
      assert: () => false,
    }),
    test: file(`steps:
  - id: press
    do: forget every saved Wi-Fi network`),
    device: DEVICE,
    ledger: new CostLedger(),
    settle: false,
  });
  assert.equal(result.outcome, "BUDGET_EXHAUSTED");
  assert.equal(seen.asserts.length, 1, "the same screen, the same answer: two refusals, one question");
});

test("after a memory doubted part of the way, an agent that says done without doing anything is told so once", async () => {
  const lock = emptyLock("cached", "android", "com.acme@1.0+1");
  lock.steps.press = {
    do: "press continue",
    screen: { phash: START },
    actions: [
      { action: "swipe", params: { direction: "down" } },
      { action: "tap", describeTarget: "the Continue button", point: { x: 180, y: 596 }, anchor: { tree: { role: "Button", label: "Continue", identifier: "com.acme:id/next", bounds: BOUNDS } } },
    ],
    tier: 1,
    confidence: 0.9,
    stability: { runs: 3, passes: 3 },
  } as never;
  const seen = spy();
  await runTest({
    engine: engineFor(seen, { label: "Next", screens: fromStart(), plan: () => ({ actions: [], done: true, provenance: PROVENANCE }) }),
    test: WITH_EXPECT,
    device: DEVICE,
    ledger: new CostLedger(),
    settle: false,
    lock,
    appBuild: "com.acme@1.0+1",
  });
  assert.equal(seen.plans.length, 2);
  assert.match(seen.plans[1]!.history.at(-1)!.outcome, /what was remembered stopped checking out .*, and nothing has been done since/);
});

test("a done refused at the limit gets the turn it was told to answer in", async () => {
  let turn = 0;
  const seen = spy();
  const result = await runTest({
    engine: engineFor(seen, {
      screens: fromStart(),
      plan: () => {
        turn += 1;
        // Six actions with no verdict on them, then done twice: the second
        // done is heard, even though the step is at its limit.
        if (turn <= 6) {
          return {
            actions: [{ name: "tap", describeTarget: `row ${turn}`, effect: `row ${turn} opens` }],
            done: false,
            ...(turn === 1 ? { doneWhen: "the last row is open" } : {}),
            provenance: PROVENANCE,
          };
        }
        return { actions: [], done: true, provenance: PROVENANCE };
      },
      assert: () => false,
    }),
    test: DO_ONLY,
    device: DEVICE,
    ledger: new CostLedger(),
    settle: false,
  });
  assert.equal(seen.acts.length, 6);
  assert.equal(turn, 8, "the done after the refusal is asked for, and given");
  assert.equal(result.outcome, "BUDGET_EXHAUSTED");
  assert.match(result.steps[0]!.detail, /was done 2 times/);
});

test("a long memory that outlasts the test's time stops while replaying", async () => {
  const seen = spy();
  const engine = engineFor(seen, { screens: fromStart(), plan: tapNext });
  const act = engine.act.bind(engine);
  engine.act = async (req) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return act(req);
  };
  const result = await runTest({
    engine,
    test: file(`policy: { budget: { max_seconds: 0.1 } }
steps:
  - id: press
    do: press continue`),
    device: DEVICE,
    ledger: new CostLedger(),
    settle: false,
    lock: longMemory(20, false),
    appBuild: "com.acme@1.0+1",
  });
  assert.equal(result.outcome, "BUDGET_EXHAUSTED");
  assert.match(result.steps[0]!.detail, /the test ran out of time, while replaying "press continue" from memory/);
  assert.ok(seen.acts.length < 20);
});
