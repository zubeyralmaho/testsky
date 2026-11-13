import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { emptyLock, parseTestFile } from "@testsky/artifact";
import type {
  ActionResult,
  AssertResult,
  DeviceHandle,
  Engine,
  ExtractResult,
  GroundResult,
  Observation,
  PlanResult,
  Provenance,
} from "@testsky/engine-core";
import { CostLedger } from "@testsky/router";

import { namedActions, runTest, type RunEvent } from "./run.ts";

const DEVICE: DeviceHandle = { id: "emulator-5554", platform: "android", osVersion: "15", kind: "emulator" };

const PROVENANCE: Provenance = { tier: 1, model: "fake", usd: 0.001, latencyMs: 5, usedTree: false, channel: "vision" };

let screenCounter = 0;

/** A screen. By default every call is a *different* screen, so a fake never
 *  trips the loop guard by accident; tests that want a stuck screen pin it. */
function observation(phash = `screen-${(screenCounter += 1)}`): Observation {
  return {
    frame: { bytes: Buffer.alloc(0), capturedAt: Date.now(), size: { width: 360, height: 800 }, pixelRatio: 3 },
    visionBlind: false,
    visionStats: { meanLuma: 120, stdLuma: 40, uniqueColors: 9000 },
    signature: { phash, maskedRegions: [] },
    appContext: { appId: "com.acme.shop" },
    observedAt: Date.now(),
  };
}

interface FakeOverrides {
  plan?: () => Promise<PlanResult>;
  ground?: () => Promise<GroundResult>;
  assert?: () => Promise<AssertResult>;
  extract?: () => Promise<ExtractResult>;
  observe?: () => Promise<Observation>;
}

function fakeEngine(overrides: FakeOverrides = {}) {
  const actions: string[] = [];
  const engine: Engine & { stepId?: string; actions: string[] } = {
    name: "fake",
    capabilities: { tree: false, frameStream: false, networkCapture: false, nativePlanning: false, appInstall: false },
    actions,
    attach: async () => {},
    detach: async () => {},
    observe: overrides.observe ?? (async () => observation()),
    openFrameStream: async () => undefined,
    ground:
      overrides.ground ??
      (async (): Promise<GroundResult> => ({
        point: { x: 100, y: 200 },
        confidence: 0.5,
        anchor: {},
        provenance: PROVENANCE,
      })),
    act: async (req): Promise<ActionResult> => {
      actions.push(req.name);
      return { dispatchedAt: Date.now(), stale: false };
    },
    assert:
      overrides.assert ??
      (async (): Promise<AssertResult> => ({ pass: true, reason: "the cart shows one item", provenance: PROVENANCE })),
    // The real signature is generic; a fake does not need to be.
    extract: (overrides.extract ?? (async () => ({ data: {}, provenance: PROVENANCE }))) as Engine["extract"],
    plan:
      overrides.plan ??
      (async (): Promise<PlanResult> => ({
        actions: [{ name: "tap", describeTarget: "the cart icon" }],
        done: false,
        provenance: PROVENANCE,
      })),
    popup: async () => ({ found: false, provenance: PROVENANCE }),
    app: {
      launch: async () => {},
      terminate: async () => {},
      install: async () => {},
      currentBuildId: async () => "com.acme.shop@1.0+1",
    },
    logs: { open: async () => { throw new Error("no logs"); } },
  };
  return engine;
}

function testFile(body: string) {
  return parseTestFile(`
id: t
targets: [{ platform: android, app: com.acme.shop }]
${body}
`);
}

const ONE_STEP = testFile(`steps:
  - id: cart
    do: tap the cart icon
    expect: the cart shows at least one line item`);

function run(engine: ReturnType<typeof fakeEngine>, file = ONE_STEP) {
  return runTest({ engine, test: file, device: DEVICE, ledger: new CostLedger(), settle: false });
}

test("a step acts, then stops as soon as its own expectation holds", async () => {
  const engine = fakeEngine();
  const result = await run(engine);
  assert.equal(result.outcome, "PASS");
  // One action, not six: the authored expectation is the exit condition, so
  // the agent does not keep going until it runs out of budget.
  assert.deepEqual(engine.actions, ["tap"]);
  assert.equal(result.steps[0]!.detail, "the cart shows one item");
});

test("a step with `do` acts even when its expectation already holds", async () => {
  // Otherwise a broken button passes its own test: the end state looks right
  // on arrival, nobody presses anything, and the run goes green.
  const engine = fakeEngine();
  await run(engine);
  assert.equal(engine.actions.length, 1);
});

test("a false expectation is the one outcome that accuses the app", async () => {
  const engine = fakeEngine({
    plan: async () => ({ actions: [], done: true, provenance: PROVENANCE }),
    assert: async () => ({ pass: false, reason: "the cart is empty", provenance: PROVENANCE }),
  });

  const result = await run(engine);
  assert.equal(result.outcome, "FAIL_ASSERT");
  assert.equal(result.steps[0]!.detail, "the cart is empty");
});

test("an element we could not find is NOT reported as a failed expectation", async () => {
  const engine = fakeEngine({
    ground: async () => {
      throw new Error('could not find "the cart icon" on this screen');
    },
  });

  const result = await run(engine);
  assert.equal(result.outcome, "FAIL_GROUND");
  assert.match(result.steps[0]!.detail, /could not locate "the cart icon"/);
  // Nothing was dispatched: a tap at a coordinate we never resolved would be a
  // random tap, and a random tap on someone's app is worse than a red run.
  assert.deepEqual(engine.actions, []);
});

test("an agent that keeps acting without satisfying the check runs out of budget, not credibility", async () => {
  const engine = fakeEngine({
    // Each action lands on a new screen, so this is progress that never
    // arrives -- not a loop.
    assert: async () => ({ pass: false, reason: "the cart is still empty", provenance: PROVENANCE }),
  });
  const result = await run(engine);
  // Not FAIL_ASSERT: the agent ran out of moves, which says nothing about the
  // app. Calling that a broken app is how a tool teaches people to ignore red.
  assert.equal(result.outcome, "BUDGET_EXHAUSTED");
  assert.equal(engine.actions.length, 6);
  assert.match(result.steps[0]!.detail, /never held/);
});

test("a check-only step that fails is a verdict about the app", async () => {
  const file = testFile(`steps:
  - id: confirm
    expect: an order confirmation is visible`);
  const engine = fakeEngine({
    assert: async () => ({ pass: false, reason: "the checkout page is still open", provenance: PROVENANCE }),
  });
  const result = await runTest({ engine, test: file, device: DEVICE, ledger: new CostLedger(), settle: false });
  assert.equal(result.outcome, "FAIL_ASSERT");
  assert.deepEqual(engine.actions, []);
});

test("a dead device is infrastructure, not a verdict about the app", async () => {
  const engine = fakeEngine({
    observe: async () => {
      throw new Error("device offline");
    },
  });
  const result = await run(engine);
  assert.equal(result.outcome, "DEVICE_ERROR");
  assert.equal(result.detail, "device offline");
});

test("a test out of time stops before the next step, and keeps what already passed", async () => {
  const file = testFile(`policy: { runs: 1, pass_threshold: 1, budget: { max_seconds: 0.001, max_usd: 1, max_steps: 10 } }
steps:
  - id: one
    expect: something is visible
  - id: two
    expect: something else is visible`);
  const engine = fakeEngine({
    assert: async () => {
      // Outlive the (deliberately tiny) time budget inside the first step.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { pass: true, reason: "it is visible", provenance: PROVENANCE };
    },
  });

  const result = await runTest({ engine, test: file, device: DEVICE, ledger: new CostLedger(), settle: false });
  assert.equal(result.outcome, "BUDGET_EXHAUSTED");
  assert.match(result.detail, /out of time at step "two"/);
  // The step that did finish keeps its verdict -- a run that ran out of time
  // is not a run that proved nothing.
  assert.equal(result.steps[0]!.outcome, "PASS");
  assert.equal(result.steps[1]!.outcome, "BUDGET_EXHAUSTED");
});

test("extracted values are attached to the step that read them", async () => {
  const file = testFile(`steps:
  - id: confirm
    expect: an order number is visible
    extract:
      order_number: the order number on the confirmation`);
  const engine = fakeEngine({
    extract: async () => ({ data: { order_number: "AC-1183" }, provenance: PROVENANCE }),
  });
  const result = await runTest({ engine, test: file, device: DEVICE, ledger: new CostLedger(), settle: false });
  assert.equal(result.outcome, "PASS");
  assert.deepEqual(result.steps[0]!.extracted, { order_number: "AC-1183" });
});

test("every model call is attributed to the step that made it", async () => {
  const ledger = new CostLedger();
  const engine = fakeEngine({ plan: async () => ({ actions: [], done: true, provenance: PROVENANCE }) });
  // The engine records under engine.stepId; the executor is what sets it.
  const seen: (string | undefined)[] = [];
  const original = engine.assert;
  engine.assert = async (req) => {
    seen.push(engine.stepId);
    return original(req);
  };
  await runTest({ engine, test: ONE_STEP, device: DEVICE, ledger, settle: false });
  assert.deepEqual(seen, ["cart"]);
});

test("the same action on the same screen three times is a loop, not a plan", async () => {
  // The real failure this came from: the agent swiped up, then down, then up
  // again in a Settings list, burning its whole budget going nowhere.
  const stuck = observation("one-screen-forever");
  const engine = fakeEngine({
    observe: async () => stuck,
    assert: async () => ({ pass: false, reason: "still not there", provenance: PROVENANCE }),
  });

  const result = await run(engine);
  assert.equal(result.outcome, "LOOP_DETECTED");
  // Stopped early rather than at the budget: three actions, not six.
  assert.equal(engine.actions.length, 2);
  assert.match(result.steps[0]!.detail, /repeated/);
});

test("actions that change nothing at all are a loop too, however varied they are", async () => {
  const stuck = observation("nothing-ever-moves");
  let n = 0;
  const engine = fakeEngine({
    observe: async () => stuck,
    assert: async () => ({ pass: false, reason: "still not there", provenance: PROVENANCE }),
    // A different target every time, so the oscillation guard stays quiet and
    // the no-progress guard is what has to notice.
    plan: async () => ({
      actions: [{ name: "tap", describeTarget: `thing ${(n += 1)}` }],
      done: false,
      provenance: PROVENANCE,
    }),
  });

  const result = await run(engine);
  assert.equal(result.outcome, "LOOP_DETECTED");
  assert.match(result.steps[0]!.detail, /changed nothing/);
});

test("an action keeps the screen it was decided on, where it pressed, and what the model was shown", async () => {
  const engine = fakeEngine({
    ground: async () => ({
      point: { x: 100, y: 200 },
      rect: { x: 60, y: 180, width: 80, height: 40 },
      confidence: 0.9,
      anchor: {},
      why: "the cart icon in the top bar",
      provenance: { ...PROVENANCE, usedTree: true, channel: "fused" },
    }),
    plan: async () => ({
      actions: [{ name: "tap", describeTarget: "the cart icon" }],
      done: false,
      reasoning: "the cart is one tap away",
      provenance: PROVENANCE,
    }),
  });
  const events: RunEvent[] = [];
  await runTest({ engine, test: ONE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false, onEvent: (event) => events.push(event) });
  const action = events.find((event) => event.kind === "action")!;
  assert.deepEqual(action.data, {
    target: { x: 100, y: 200 },
    moved: true,
    by: "model",
    seen: "fused",
    confidence: 0.9,
    box: { x: 60, y: 180, width: 80, height: 40 },
    why: "the cart icon in the top bar",
    thought: "the cart is one tap away",
    screen: { width: 360, height: 800 },
  });
  assert.ok(Buffer.isBuffer(action.screenshot), "the frame the tap was decided on");
  assert.equal(action.shotId, "cart.action-1");
});

test("a target found with the tree carries the tree lines the grounder read", async () => {
  const withTree = (): Observation => ({
    ...observation(),
    tree: {
      platform: "android",
      capturedAt: 0,
      source: "uiautomator",
      truncated: false,
      captureMs: 900,
      root: {
        ref: "root",
        role: "FrameLayout",
        bounds: { x: 0, y: 0, width: 360, height: 800 },
        enabled: true,
        interactive: false,
        children: [
          { ref: "cart", role: "Button", label: "Cart", bounds: { x: 300, y: 20, width: 48, height: 48 }, enabled: true, interactive: true, children: [] },
        ],
      },
    },
  });
  const engine = fakeEngine({
    observe: async () => withTree(),
    ground: async () => ({ point: { x: 324, y: 44 }, confidence: 0.9, anchor: {}, provenance: { ...PROVENANCE, usedTree: true, channel: "fused" } }),
  });
  const events: RunEvent[] = [];
  await runTest({ engine, test: ONE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false, onEvent: (event) => events.push(event) });
  const tree = events.find((event) => event.kind === "action")?.data?.tree;
  assert.equal(typeof tree, "string");
  assert.match(tree as string, /Cart/);
});

test("who found a target is said: both sources, on a capture with the tree read before grounding", async () => {
  const cart = {
    platform: "android" as const,
    capturedAt: 0,
    source: "uiautomator" as const,
    truncated: false,
    captureMs: 900,
    root: {
      ref: "root",
      role: "FrameLayout",
      bounds: { x: 0, y: 0, width: 360, height: 800 },
      enabled: true,
      interactive: false,
      children: [
        { ref: "cart", role: "Button", label: "Cart", bounds: { x: 300, y: 20, width: 48, height: 48 }, enabled: true, interactive: true, children: [] },
      ],
    },
  };
  let groundedOnTree = false;
  const engine = fakeEngine({
    ground: async () => ({
      point: { x: 324, y: 44 },
      rect: { x: 300, y: 20, width: 48, height: 48 },
      confidence: 0.95,
      anchor: {},
      why: 'the cart icon; the tree agrees: the tree has one Button called "Cart"',
      provenance: { ...PROVENANCE, usedTree: true, channel: "fused" },
      foundBy: "both",
    }),
  });
  const ground = engine.ground;
  const reading = {
    ...engine,
    capabilities: { ...engine.capabilities, tree: true },
    observe: async (req?: { tree?: boolean }) => ({ ...observation(), ...(req?.tree ? { tree: cart } : {}) }),
    ground: async (req: Parameters<typeof ground>[0]) => {
      groundedOnTree = Boolean(req.observation.tree);
      return ground(req);
    },
  };
  const events: RunEvent[] = [];
  await runTest({ engine: reading, test: ONE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false, onEvent: (event) => events.push(event) });
  const action = events.find((event) => event.kind === "action")!;
  assert.ok(groundedOnTree, "the picture and the tree were in hand together");
  assert.equal(action.data?.by, "both");
  assert.equal(action.data?.seen, "fused");
  assert.match(String(action.data?.tree), /Cart/, "the lines it was read from");
});

const SCREEN_A = "aaaaaaaaaaaaaaaa";
const SCREEN_B = "5555555555555555";

/** A field, focused, holding what each read of the tree says it holds. */
function fieldTree(holds: string) {
  return {
    platform: "android" as const,
    capturedAt: 0,
    source: "uiautomator" as const,
    truncated: false,
    captureMs: 900,
    root: {
      ref: "root",
      role: "FrameLayout",
      bounds: { x: 0, y: 0, width: 360, height: 800 },
      enabled: true,
      interactive: false,
      children: [
        { ref: "field", role: "EditText", ...(holds ? { label: holds } : {}), bounds: { x: 20, y: 180, width: 320, height: 48 }, enabled: true, interactive: true, focused: true, children: [] },
      ],
    },
  };
}

/** The screen once something was typed: the same screen, a few pixels different. */
const SCREEN_TYPED = "aaaaaaaaaaaaaaab";

/** An engine that reads trees, typing into a field that holds `reads` in turn after each input. */
function typingEngine(
  reads: string[],
  plan = { name: "input" as const, describeTarget: "the message field", params: { value: "hello" } as Record<string, unknown> },
  typedScreen = SCREEN_TYPED,
) {
  const base = fakeEngine({
    plan: async () => ({ actions: [plan], done: false, provenance: PROVENANCE }),
  });
  let typed = 0;
  const treeReads: number[] = [];
  const inputs: Record<string, unknown>[] = [];
  const engine = {
    ...base,
    capabilities: { ...base.capabilities, tree: true },
    observe: async (req?: { tree?: boolean }) => {
      // Typing changes the screen a little, as it does on a phone.
      const seen = observation(typed ? typedScreen : SCREEN_A);
      if (!req?.tree) return seen;
      treeReads.push(typed);
      return { ...seen, tree: fieldTree(typed ? (reads[Math.min(typed, reads.length) - 1] ?? "") : "") };
    },
    act: async (req: Parameters<typeof base.act>[0]) => {
      base.actions.push(req.name);
      if (req.name === "input") {
        typed += 1;
        inputs.push(req.params ?? {});
      }
      return { dispatchedAt: Date.now(), stale: false };
    },
  };
  return { engine, inputs, treeReads };
}

const TYPE_STEP = testFile(`steps:
  - id: say
    do: type "hello" into the message field
    expect: the message field says hello`);

test("typed text is read back: a field holding exactly it is left alone", async () => {
  const { engine, inputs } = typingEngine(["hello"]);
  const events: RunEvent[] = [];
  await runTest({ engine, test: TYPE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false, onEvent: (event) => events.push(event) });
  assert.equal(inputs.length, 1);
  assert.equal(events.some((event) => /the field holds/.test(event.message)), false);
  assert.ok(events.some((event) => event.message === 'read back from the tree: exactly "hello"'), "and the check is in the report");
});

test("typing to be sent is read back first, then sent with Enter while its keyboard is up", async () => {
  const sending = typingEngine(["hello"], { name: "input", describeTarget: "the search field", params: { value: "hello", submit: true } });
  const order: string[] = [];
  const act = sending.engine.act;
  sending.engine.act = async (req) => {
    order.push(req.name === "keyPress" ? `keyPress ${String(req.params?.key)}` : req.name);
    return act(req);
  };
  const observe = sending.engine.observe;
  sending.engine.observe = async (req) => {
    if (req?.tree) order.push("read back");
    return observe(req);
  };
  await runTest({ engine: sending.engine, test: TYPE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false });
  const typedAt = order.indexOf("input");
  const sentAt = order.indexOf("keyPress Enter");
  assert.ok(typedAt < sentAt && order.slice(typedAt + 1, sentAt).includes("read back"), order.join(", "));
  assert.deepEqual(sending.inputs, [{ value: "hello", submit: true }], "the engine is told, and keeps its keyboard up");

  const kept = typingEngine(["hello"]);
  const pressed: string[] = [];
  const keptAct = kept.engine.act;
  kept.engine.act = async (req) => {
    pressed.push(req.name);
    return keptAct(req);
  };
  await runTest({ engine: kept.engine, test: TYPE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false });
  assert.equal(pressed.includes("keyPress"), false, "typing not to be sent is not sent");
});

test("a field holding something else is typed into once more, and said if it still does", async () => {
  const fixed = typingEngine(["helo", "hello"]);
  const events: RunEvent[] = [];
  await runTest({ engine: fixed.engine, test: TYPE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false, onEvent: (event) => events.push(event) });
  assert.equal(fixed.inputs.length, 2, "typed once more");
  assert.ok(events.some((event) => event.message === 'the field held "helo" after typing "hello"; typing it once more'), "and said so");
  assert.equal(events.some((event) => /but the field holds/.test(event.message)), false, "then it held it");

  const stuck = typingEngine(["helo", "helo"]);
  const said: RunEvent[] = [];
  await runTest({ engine: stuck.engine, test: TYPE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false, onEvent: (event) => said.push(event) });
  assert.equal(stuck.inputs.length >= 2, true);
  assert.ok(said.some((event) => event.kind === "note" && event.message === 'typed "hello", but the field holds "helo"'));
});

test("a keyboard that only changed the case is said, not fought: typing again would change it again", async () => {
  const { engine, inputs } = typingEngine(["Hello"]);
  const events: RunEvent[] = [];
  await runTest({ engine, test: TYPE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false, onEvent: (event) => events.push(event) });
  assert.equal(inputs.length, 1);
  assert.ok(events.some((event) => event.message === 'typed "hello", but the field holds "Hello"'));
});

test("a plan made for a screen that has moved on is made again, not carried out on the new one", async () => {
  let plans = 0;
  let treeReads = 0;
  const base = fakeEngine({
    plan: async () => {
      plans += 1;
      return { actions: [{ name: "tap", describeTarget: "the cart icon" }], done: false, provenance: PROVENANCE };
    },
  });
  const engine = {
    ...base,
    capabilities: { ...base.capabilities, tree: true },
    observe: async (req?: { tree?: boolean }) => {
      if (!req?.tree) return observation(SCREEN_A);
      treeReads += 1;
      // The first read finds a dialog opened while the plan was being made.
      return { ...observation(treeReads === 1 ? SCREEN_B : SCREEN_A), tree: fieldTree("") };
    },
  };
  const events: RunEvent[] = [];
  await runTest({ engine, test: ONE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false, onEvent: (event) => events.push(event) });
  assert.ok(events.some((event) => /the screen changed while deciding to tap/.test(event.message)));
  assert.ok(plans >= 2, "planned again on the screen as it is");
  assert.equal(base.actions[0], "tap", "and then carried out");
});

test("a tree that cannot be read leaves the picture to find the target alone", async () => {
  let groundedWithTree: boolean | undefined;
  const base = fakeEngine({
    ground: async () => ({ point: { x: 100, y: 200 }, confidence: 0.9, anchor: {}, provenance: PROVENANCE }),
  });
  const engine = {
    ...base,
    capabilities: { ...base.capabilities, tree: true },
    observe: async (req?: { tree?: boolean }) => {
      if (req?.tree) throw new Error("uiautomator dump failed");
      return observation(SCREEN_A);
    },
    ground: async (req: Parameters<typeof base.ground>[0]) => {
      groundedWithTree = Boolean(req.observation.tree);
      return base.ground(req);
    },
  };
  const events: RunEvent[] = [];
  const result = await runTest({ engine, test: ONE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false, onEvent: (event) => events.push(event) });
  assert.equal(groundedWithTree, false);
  assert.equal(base.actions[0], "tap");
  assert.ok(events.some((event) => /the accessibility tree could not be read \(uiautomator dump failed\)/.test(event.message)));
  assert.equal(result.outcome, "PASS", "a device that will not describe itself is not an app that failed");
});

test("typing again only where it cannot hurt: not on a screen that moved on, not over text that would not clear", async () => {
  // A six-digit code that submitted itself: the next screen is not the field.
  const submitted = typingEngine(["6"], undefined, SCREEN_B);
  const events: RunEvent[] = [];
  await runTest({ engine: submitted.engine, test: TYPE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false, onEvent: (event) => events.push(event) });
  assert.equal(submitted.inputs.length, 1, "nothing typed into the next screen");

  // The old text would not clear: typing again would only add another copy.
  const stuck = typingEngine(["oldhello"]);
  const said: RunEvent[] = [];
  await runTest({ engine: stuck.engine, test: TYPE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false, onEvent: (event) => said.push(event) });
  assert.equal(stuck.inputs.length, 1);
  assert.ok(said.some((event) => event.message === 'typed "hello", but the field holds "oldhello"'));
});

test("added to what a field holds, the text goes in at its end", async () => {
  const pressed: { x: number; y: number }[] = [];
  const base = fakeEngine({
    plan: async () => ({ actions: [{ name: "input", describeTarget: "the note", params: { value: "!", append: true } }], done: false, provenance: PROVENANCE }),
    ground: async () => ({ point: { x: 180, y: 204 }, rect: { x: 20, y: 180, width: 320, height: 48 }, confidence: 0.9, anchor: {}, provenance: PROVENANCE }),
  });
  const engine = {
    ...base,
    act: async (req: Parameters<typeof base.act>[0]) => {
      if (req.target) pressed.push(req.target);
      return base.act(req);
    },
  };
  await runTest({ engine, test: TYPE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false });
  assert.deepEqual(pressed[0], { x: 328, y: 204 }, "near the right edge of the field, not its middle");
});

test("a model that cannot be asked stops the run as tooling, not as a missing target", async () => {
  const { ModelError } = await import("@testsky/router");
  const engine = fakeEngine({
    ground: async () => {
      throw new ModelError("qwen at https://openrouter.ai/api/v1 returned 401: invalid key", 401);
    },
  });
  const result = await runTest({ engine, test: ONE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false });
  assert.equal(result.outcome, "DEVICE_ERROR");
  assert.match(result.detail, /returned 401/);
});

test("found in two places is not missing: the agent is told so, and nothing was pressed", async () => {
  const { SourcesDisagreeError } = await import("@testsky/router");
  let grounds = 0;
  const engine = fakeEngine({
    ground: async () => {
      grounds += 1;
      throw new SourcesDisagreeError('the model and the tree disagree about "the cart icon"; nothing was pressed');
    },
  });
  const events: RunEvent[] = [];
  const result = await runTest({ engine, test: ONE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false, onEvent: (event) => events.push(event) });
  assert.equal(engine.actions.length, 0, "nothing was pressed");
  assert.ok(events.some((event) => /found it in different places, so nothing was pressed/.test(event.message)));
  assert.equal(events.some((event) => /is not on this screen/.test(event.message)), false);
  assert.equal(result.outcome, "FAIL_GROUND");
  assert.ok(grounds >= 2, "asked again before giving up");
});

test("a step that ran out of moves without doing what it says has not done it, whatever the screen shows", async () => {
  let dispatched = 0;
  const base = fakeEngine({ assert: async () => ({ pass: true, reason: "the cart shows one item", provenance: PROVENANCE }) });
  const engine = {
    ...base,
    // The screen moves on every time, so every tap is dropped before it lands.
    act: async () => {
      dispatched += 1;
      return { dispatchedAt: Date.now(), stale: true };
    },
  };
  const result = await runTest({ engine, test: ONE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false });
  assert.ok(dispatched > 1, "it kept trying");
  assert.equal(result.outcome, "BUDGET_EXHAUSTED", "and an expectation that held is not the action done");
  assert.match(result.detail, /never carried out "tap the cart icon"/);
});

test("typing replayed from memory is read back too", async () => {
  const lock = emptyLock("t", "android", "com.acme.shop@1.0+1");
  const learned = typingEngine(["hello"]);
  await runTest({ engine: learned.engine, test: TYPE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false, lock, appBuild: "com.acme.shop@1.0+1" });
  assert.equal(lock.steps.say?.actions[0]?.action, "input", "the typing was remembered");

  const replayed = typingEngine(["helo", "hello"]);
  const events: RunEvent[] = [];
  await runTest({ engine: replayed.engine, test: TYPE_STEP, device: DEVICE, ledger: new CostLedger(), settle: false, lock, appBuild: "com.acme.shop@1.0+1", onEvent: (event) => events.push(event) });
  const typed = events.find((event) => event.kind === "action");
  assert.equal(typed?.data?.by, "memory");
  assert.equal(typed?.message, 'input "hello" the message field', "the remembered text is in the report");
  assert.ok(events.some((event) => event.message === 'the field held "helo" after typing "hello"; typing it once more'));
  assert.ok(events.some((event) => event.message === 'read back from the tree: exactly "hello"'));
});

test("a test that fails still undoes what its teardown says: the device is somebody's", async () => {
  const engine = fakeEngine({ assert: async () => ({ pass: false, reason: "the cart is empty", provenance: PROVENANCE }) });
  const terminated: string[] = [];
  engine.app.terminate = async (id: string) => {
    terminated.push(id);
  };
  const failing = testFile(`steps:
  - id: cart
    expect: the cart shows one item
teardown:
  - terminate app`);
  const result = await runTest({ engine, test: failing, device: DEVICE, ledger: new CostLedger(), settle: false });
  assert.equal(result.outcome, "FAIL_ASSERT");
  assert.deepEqual(terminated, ["com.acme.shop"]);
});

test("told nothing has been done yet, a planner whose goal already holds may say done again, and nothing is pressed", async () => {
  const told: string[] = [];
  const engine = fakeEngine();
  engine.plan = async (req) => {
    told.push(req.history.map((entry) => entry.outcome).join(" / "));
    return { actions: [], done: true, reasoning: "the list is already showing", provenance: PROVENANCE };
  };
  const until = testFile(`steps:
  - id: top
    do: go back until the top-level list is showing
    expect: the top-level list is showing`);
  const result = await runTest({ engine, test: until, device: DEVICE, ledger: new CostLedger(), settle: false });
  assert.equal(engine.actions.length, 0, "zero backs is what 'until it shows' means when it already shows");
  assert.equal(result.outcome, "PASS");
  assert.match(told[1] ?? "", /if it only asks to reach a state that this screen already shows, answer done again/);
});

test("an expectation is judged with the tree beside the picture, unless the step asked for the picture alone", async () => {
  let given: { tree?: unknown; evidenceTree?: unknown } | undefined;
  const base = fakeEngine();
  const engine = {
    ...base,
    capabilities: { ...base.capabilities, tree: true },
    observe: async (req?: { tree?: boolean }) => ({ ...observation(SCREEN_A), ...(req?.tree ? { tree: fieldTree("") } : {}) }),
    assert: async (req: Parameters<typeof base.assert>[0]) => {
      given = { tree: req.observation.tree, evidenceTree: req.evidenceTree };
      return base.assert(req);
    },
  };
  const page = testFile(`steps:
  - id: wifi
    expect: the Wi-Fi page is open`);
  await runTest({ engine, test: page, device: DEVICE, ledger: new CostLedger(), settle: false });
  assert.ok(given?.tree, "the judge sees the screen both ways");
  assert.equal(given?.evidenceTree, undefined, "and needs no second read to check a pass against");

  const pictureAlone = testFile(`steps:
  - id: wifi
    expect: the Wi-Fi page is open
    channel: vision`);
  await runTest({ engine, test: pictureAlone, device: DEVICE, ledger: new CostLedger(), settle: false });
  assert.equal(given?.tree, undefined, "a step that asked for the picture is judged on the picture");
  assert.ok(given?.evidenceTree, "and the tree still goes along to check a pass against");

  const plain = testFile(`steps:
  - id: list
    expect: a list of settings is visible
    channel: vision`);
  await runTest({ engine, test: plain, device: DEVICE, ledger: new CostLedger(), settle: false });
  assert.equal(given?.evidenceTree, undefined, "nothing the tree could check: no tree read");
});

// ── The loop: what done means, how far it has got, and what it earns ─────

const FORGET_ALL = testFile(`steps:
  - id: forget
    do: forget every saved Wi-Fi network`);

/** Screens as a device hashes them: sixteen hex digits, each call a screen not seen before. */
function freshScreens(): () => Promise<Observation> {
  let n = 0;
  return async () => observation(createHash("sha1").update(`fresh-${(n += 1)}`).digest("hex").slice(0, 16));
}

/** The same few screens, round and round. */
function cycleOf(names: string[]): () => Promise<Observation> {
  let n = 0;
  const hashes = names.map((name) => createHash("sha1").update(name).digest("hex").slice(0, 16));
  return async () => observation(hashes[n++ % hashes.length]);
}

/** A planner that works through a list one action at a time, saying what each will do. */
function listWorker(options: { items: number; came?: "as expected" | "something else" | "nothing"; doneWhen?: string }) {
  const asked: Parameters<Engine["plan"]>[0][] = [];
  let turn = 0;
  const plan = async (req: Parameters<Engine["plan"]>[0]): Promise<PlanResult> => {
    asked.push(structuredClone({ ...req, observation: undefined }) as never);
    turn += 1;
    const said = turn > 1 ? { last: options.came ?? "as expected" } : {};
    if (turn > options.items) return { actions: [], done: true, ...said, provenance: PROVENANCE };
    return {
      actions: [{ name: "tap", describeTarget: `the saved network number ${turn}`, effect: `network ${turn} leaves the list` }],
      done: false,
      ...(turn === 1 && options.doneWhen ? { doneWhen: options.doneWhen } : {}),
      progress: `${turn - 1} of ${options.items} forgotten`,
      ...said,
      provenance: PROVENANCE,
    };
  };
  return { asked, plan };
}

test("a step whose actions keep doing what it said they would earns more than six of them", async () => {
  const worker = listWorker({ items: 10, doneWhen: "no saved networks are listed" });
  const engine = fakeEngine({ plan: worker.plan as never, observe: freshScreens() });
  const result = await run(engine, FORGET_ALL);
  assert.equal(result.outcome, "PASS", result.detail);
  assert.equal(engine.actions.length, 10, "ten networks, ten actions, none cut off at six");
});

test("a step whose actions do not come true stops at six, as it always did", async () => {
  const worker = listWorker({ items: 10, came: "something else", doneWhen: "no saved networks are listed" });
  const engine = fakeEngine({ plan: worker.plan as never, observe: freshScreens() });
  const result = await run(engine, FORGET_ALL);
  assert.equal(result.outcome, "BUDGET_EXHAUSTED");
  assert.equal(engine.actions.length, 6);
});

test("an agent going round screens it has stood on earns nothing for them", async () => {
  const worker = listWorker({ items: 1000, doneWhen: "no saved networks are listed" });
  // Three screens, round and round, every action called as expected: the
  // first pass reaches two screens not seen before and earns 3 + 3; after
  // that nothing is new. Six actions and six earned, where an agent that
  // kept reaching new screens would run to the ceiling.
  const engine = fakeEngine({ plan: worker.plan as never, observe: cycleOf(["list", "network", "confirm"]) });
  const result = await run(engine, FORGET_ALL);
  assert.equal(result.outcome, "BUDGET_EXHAUSTED");
  assert.equal(engine.actions.length, 12);
});

test("a list that comes back one row shorter each pass earns its way through", async () => {
  // Forgetting a network: the list, its page, the confirmation, and the list
  // again without it. Pages and confirmations look alike from one network to
  // the next; the shorter list is new each time, and pays for the pass.
  const worker = listWorker({ items: 15, doneWhen: "no saved networks are listed" });
  let n = 0;
  const hash = (name: string) => createHash("sha1").update(name).digest("hex").slice(0, 16);
  const observe = async () => {
    const at = n++;
    const phase = at % 3;
    return observation(phase === 0 ? hash(`list-with-${15 - at / 3}`) : phase === 1 ? hash("network page") : hash("confirmation"));
  };
  const engine = fakeEngine({ plan: worker.plan as never, observe });
  const result = await run(engine, FORGET_ALL);
  assert.equal(result.outcome, "PASS", result.detail);
  assert.equal(engine.actions.length, 15);
});

test("a calculator's keys never change, and each press that changes what it shows earns its way", async () => {
  // Seven presses on one screen: the same controls every time, and the
  // display -- 1, 10, 100, 1.000, ... -- saying something new after each.
  const worker = listWorker({ items: 7, doneWhen: "the display shows 125" });
  let shown = 0;
  const keys = createHash("sha1").update("calculator keys").digest("hex").slice(0, 16);
  const observe = async () => {
    // The display's few pixels move the frame's hash; the keys keep the tree's.
    const seen = observation(createHash("sha1").update(`display ${shown + 1}`).digest("hex").slice(0, 16));
    seen.signature.treeHash = keys;
    seen.tree = {
      platform: "ios",
      capturedAt: Date.now(),
      source: "xcuitest",
      truncated: false,
      captureMs: 1,
      root: {
        ref: "root",
        role: "Window",
        bounds: { x: 0, y: 0, width: 360, height: 800 },
        enabled: true,
        interactive: false,
        children: [{ ref: "display", role: "StaticText", label: `display ${(shown += 1)}`, bounds: { x: 0, y: 100, width: 360, height: 80 }, enabled: true, interactive: false, children: [] }],
      },
    };
    return seen;
  };
  const engine = fakeEngine({ plan: worker.plan as never, observe });
  const result = await run(engine, FORGET_ALL);
  assert.equal(result.outcome, "PASS", result.detail);
  assert.equal(engine.actions.length, 7, "seven presses, none cut off at six");
});

test("a step gets as many actions as it spells out, when that is more than six", () => {
  assert.equal(namedActions("calculate 1000 ÷ 8 by pressing 1, 0, 0, 0, the divide key, 8 and the equals key"), 7);
  assert.equal(namedActions("forget every saved Wi-Fi network"), 1);
  assert.equal(namedActions('type "a, b, c and d" into the note'), 1, "what is quoted is what is typed");
  assert.equal(namedActions(undefined), 0);
});

test("seven presses spelled out on a screen that never looks new are all made", async () => {
  // No tree, and a display that changes a bit or two of the frame's hash:
  // every press moves the screen, and none reaches one not seen before.
  const PRESSES = testFile(`steps:
  - id: divide
    do: calculate 1000 ÷ 8 by pressing 1, 0, 0, 0, the divide key, 8 and the equals key`);
  const worker = listWorker({ items: 7, doneWhen: "the display shows 125" });
  let n = 0;
  const observe = async () => observation((n++).toString(16).padStart(16, "0"));
  const engine = fakeEngine({ plan: worker.plan as never, observe });
  const result = await run(engine, PRESSES);
  assert.equal(result.outcome, "PASS", result.detail);
  assert.equal(engine.actions.length, 7);
});

test("however much a step earns, it stops at the ceiling", async () => {
  const worker = listWorker({ items: 1000, doneWhen: "no saved networks are listed" });
  const engine = fakeEngine({ plan: worker.plan as never, observe: freshScreens() });
  const result = await run(engine, FORGET_ALL);
  assert.equal(result.outcome, "BUDGET_EXHAUSTED");
  assert.equal(engine.actions.length, 30);
});

test("the planner is asked what done means, and is handed it back with its count every turn after", async () => {
  const worker = listWorker({ items: 3, doneWhen: "no saved networks are listed" });
  const engine = fakeEngine({ plan: worker.plan as never });
  await run(engine, FORGET_ALL);
  assert.equal(worker.asked[0]!.understand, true);
  assert.equal(worker.asked[0]!.ledger, undefined, "nothing established before the first answer");
  assert.equal(worker.asked[1]!.understand, undefined, "asked once it said");
  assert.deepEqual(worker.asked[1]!.ledger, { doneWhen: "no saved networks are listed", progress: "0 of 3 forgotten" });
  assert.equal(worker.asked[1]!.history[0]!.expected, "network 1 leaves the list", "the history says what each action was to do");
  assert.deepEqual(worker.asked[3]!.ledger?.progress, "2 of 3 forgotten");
});

test("with no expectation of the author's, the agent's done is put to the judge as what it said done means", async () => {
  const worker = listWorker({ items: 2, doneWhen: "no saved networks are listed" });
  const judged: string[] = [];
  const engine = fakeEngine({
    plan: worker.plan as never,
    assert: async (req?: { assertion: string }) => {
      judged.push(req!.assertion);
      return { pass: true, reason: "the list is empty", provenance: PROVENANCE };
    },
  } as never);
  const result = await run(engine, FORGET_ALL);
  assert.equal(result.outcome, "PASS");
  assert.deepEqual(judged, ["no saved networks are listed"]);
});

test("a done that does not hold is told to the agent once, and not taken the second time", async () => {
  const told: string[] = [];
  let turn = 0;
  const engine = fakeEngine({
    plan: (async (req: Parameters<Engine["plan"]>[0]): Promise<PlanResult> => {
      turn += 1;
      told.push(req.history.map((entry) => entry.outcome).join(" | "));
      if (turn === 1) return { actions: [{ name: "tap", describeTarget: "Forget", effect: "the network leaves the list" }], done: false, doneWhen: "no saved networks are listed", provenance: PROVENANCE };
      return { actions: [], done: true, last: "as expected", provenance: PROVENANCE };
    }) as never,
    assert: async () => ({ pass: false, reason: "two networks are still listed", provenance: PROVENANCE }),
  });
  const result = await run(engine, FORGET_ALL);
  assert.equal(result.outcome, "BUDGET_EXHAUSTED");
  assert.match(result.steps[0]!.detail, /said "forget every saved Wi-Fi network" was done 2 times, and "no saved networks are listed" never held: two networks are still listed/);
  assert.match(told[2] ?? "", /you answered done, but "no saved networks are listed" does not hold on this screen \(two networks are still listed\)/);
});

test("a step with the author's own expectation is judged on that, never on the agent's done-when", async () => {
  const judged: string[] = [];
  const worker = listWorker({ items: 1, doneWhen: "the cart is open" });
  const engine = fakeEngine({
    plan: worker.plan as never,
    assert: async (req?: { assertion: string }) => {
      judged.push(req!.assertion);
      return { pass: true, reason: "one item", provenance: PROVENANCE };
    },
  } as never);
  const result = await run(engine);
  assert.equal(result.outcome, "PASS");
  assert.ok(judged.every((assertion) => assertion === "the cart shows at least one line item"), judged.join(", "));
});

test("a step that earns its actions still stops when the test runs out of time", async () => {
  const worker = listWorker({ items: 1000, doneWhen: "no saved networks are listed" });
  const engine = fakeEngine({
    plan: (async (req: Parameters<Engine["plan"]>[0]) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return worker.plan(req);
    }) as never,
    observe: freshScreens(),
  });
  const file = testFile(`policy: { budget: { max_seconds: 0.5 } }
steps:
  - id: forget
    do: forget every saved Wi-Fi network`);
  const result = await run(engine, file);
  assert.equal(result.outcome, "BUDGET_EXHAUSTED");
  assert.match(result.steps[0]!.detail, /the test ran out of time, while working on "forget every saved Wi-Fi network"/);
  assert.ok(engine.actions.length < 30);
});

test("an agent that says done on its last action, and is right, has finished, not run out", async () => {
  let turn = 0;
  const engine = fakeEngine({
    plan: (async (): Promise<PlanResult> => {
      turn += 1;
      // Six actions that say what they will do, and never a verdict on them:
      // nothing earned, and done is said on the very turn the sixth is owed.
      if (turn <= 6) {
        return {
          actions: [{ name: "tap", describeTarget: `row ${turn}`, effect: `row ${turn} opens` }],
          done: false,
          ...(turn === 1 ? { doneWhen: "the last row is open" } : {}),
          provenance: PROVENANCE,
        };
      }
      return { actions: [], done: true, provenance: PROVENANCE };
    }) as never,
    observe: freshScreens(),
  });
  const result = await run(engine, FORGET_ALL);
  assert.equal(engine.actions.length, 6);
  assert.equal(result.outcome, "PASS", result.detail);
});
