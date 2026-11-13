import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { emptyLock, parseTestFile, type LockFile, type TestFile } from "@testsky/artifact";
import type { AssertResult, DeviceHandle, Engine, GroundResult, Observation, PlanResult, Provenance, TreeNode } from "@testsky/engine-core";
import { CostLedger } from "@testsky/router";
import sharp from "sharp";

import { runTest, type RunEvent } from "./run.ts";

const DEVICE: DeviceHandle = { id: "emulator-5554", platform: "android", osVersion: "15", kind: "emulator" };
const PROVENANCE: Provenance = { tier: 1, model: "fake", usd: 0.002, latencyMs: 5, usedTree: false, channel: "vision" };
const BUTTON: TreeNode = {
  ref: "b",
  role: "Button",
  label: "Continue",
  identifier: "com.acme:id/next",
  bounds: { x: 60, y: 560, width: 240, height: 72 },
  enabled: true,
  interactive: true,
  children: [],
};

async function frame(body: string, width = 1080): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width * 2}">
    <rect width="100%" height="100%" fill="#f2f4f7"/>
    <text x="60" y="${width * 0.6}" font-family="Helvetica" font-size="54" fill="#111827">${body}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

interface Screen {
  bytes: Buffer;
  blind?: boolean;
}

let looks = 0;
function observation(screen: Screen): Observation {
  looks += 1;
  return {
    frame: { bytes: screen.bytes, capturedAt: 0, size: { width: 360, height: 720 }, pixelRatio: 3 },
    visionBlind: screen.blind === true,
    visionStats: { meanLuma: 200, stdLuma: 20, uniqueColors: 40 },
    // The cache's own coarse signature, as a real engine's: it moves when the picture does.
    signature: { phash: createHash("sha1").update(screen.bytes).digest("hex").slice(0, 16), treeHash: "screen-1", maskedRegions: [] },
    appContext: {},
    observedAt: Date.now() + looks,
    tree: {
      platform: "android",
      capturedAt: 0,
      source: "uiautomator",
      truncated: false,
      captureMs: 40,
      root: { ref: "root", role: "FrameLayout", bounds: { x: 0, y: 0, width: 360, height: 720 }, enabled: true, interactive: false, children: [BUTTON] },
    },
  };
}

interface Calls {
  asserted: number;
  grounded: number;
  planned: number;
}

/**
 * A device showing whatever \`screen\` holds, counting every question a model
 * would have been asked. Its print is what the real one's is made of: the
 * picture and the question, and nothing for a frame with no picture.
 */
function engine(screen: Screen, calls: Calls, pass: boolean | ((bytes: Buffer) => boolean) = true): Engine {
  return {
    name: "fake",
    capabilities: { tree: true, frameStream: false, networkCapture: false, nativePlanning: false, appInstall: false },
    attach: async () => {},
    detach: async () => {},
    observe: async () => observation(screen),
    openFrameStream: async () => undefined,
    ground: async (): Promise<GroundResult> => {
      calls.grounded += 1;
      return { point: { x: 180, y: 596 }, confidence: 0.9, anchor: { tree: { role: "Button", label: "Continue", identifier: "com.acme:id/next", bounds: BUTTON.bounds } }, provenance: PROVENANCE };
    },
    act: async () => ({ dispatchedAt: Date.now(), stale: false }),
    assert: async (req): Promise<AssertResult> => {
      calls.asserted += 1;
      const held = typeof pass === "function" ? pass(req.observation.frame.bytes) : pass;
      return { pass: held, reason: held ? "it is there" : "it is not there", provenance: PROVENANCE };
    },
    judgePrint: async (req) =>
      req.observation.visionBlind
        ? undefined
        : createHash("sha256").update(req.observation.frame.bytes).update(`\n${req.assertion}\n${req.channel ?? ""}`).digest("hex").slice(0, 32),
    extract: (async () => ({ data: {}, provenance: PROVENANCE })) as Engine["extract"],
    plan: async (): Promise<PlanResult> => {
      calls.planned += 1;
      return { actions: [{ name: "tap", describeTarget: "the Continue button" }], done: false, provenance: PROVENANCE };
    },
    popup: async () => ({ found: false, provenance: PROVENANCE }),
    app: { launch: async () => {}, terminate: async () => {}, install: async () => {}, currentBuildId: async () => "com.acme@1.0+1" },
    logs: { open: async () => { throw new Error("no logs"); } },
  };
}

const checkout = (items: number): TestFile =>
  parseTestFile(
    `
id: checkout
title: Checkout
targets:
  - { platform: android, app: com.acme.shop }
steps:
  - id: next
    do: tap Continue
    expect: the cart shows ${items} items
  - id: cart
    expect: the cart shows ${items} items
`,
    "checkout.testsky.yaml",
  );

async function run(screen: Screen, lock: LockFile, pass: boolean | ((bytes: Buffer) => boolean) = true, test = checkout(3)) {
  const calls: Calls = { asserted: 0, grounded: 0, planned: 0 };
  const events: RunEvent[] = [];
  const result = await runTest({ engine: engine(screen, calls, pass), test, device: DEVICE, ledger: new CostLedger(), lock, settle: false, onEvent: (event) => events.push(event) });
  return { result, calls, events };
}

test("a check a model passed twice on this very question is answered from memory after that", async () => {
  const lock = emptyLock("checkout", "android");
  const screen = { bytes: await frame("3 items in your cart") };
  assert.equal((await run(screen, lock)).calls.asserted, 2, "the first run's checks are a model's");
  assert.equal((await run(screen, lock)).calls.asserted, 2, "and so are the second's: one yes from an inconsistent judge is not enough");
  const third = await run(screen, lock);
  assert.equal(third.result.outcome, "PASS");
  assert.deepEqual(third.calls, { asserted: 0, grounded: 0, planned: 0 }, "the tap is remembered, and so is what it led to");
  assert.equal(third.events.filter((event) => event.kind === "assertion" && event.message.startsWith("held, remembered")).length, 2);
});

test("a screen that differs by one digit is shown to the model again", async () => {
  const lock = emptyLock("checkout", "android");
  const three = { bytes: await frame("3 items in your cart") };
  await run(three, lock);
  await run(three, lock);
  assert.equal((await run({ bytes: await frame("2 items in your cart") }, lock)).calls.asserted, 2);
});

test("the same screen asked something else is a new question", async () => {
  const lock = emptyLock("checkout", "android");
  const screen = { bytes: await frame("3 items in your cart") };
  await run(screen, lock);
  await run(screen, lock);
  // The test edited, the step ids kept: "3 items" became "4 items".
  assert.equal((await run(screen, lock, true, checkout(4))).calls.asserted, 2, "and a model is asked it, not told the old answer");
});

test("a question a model says no to is forgotten, whatever it said before and whatever passes next", async () => {
  const lock = emptyLock("cart", "android");
  const cart = parseTestFile("id: cart\ntitle: Cart\ntargets:\n  - { platform: android, app: com.acme.shop }\nsteps:\n  - id: cart\n    expect: the cart shows 3 items\n", "cart.testsky.yaml");
  const p = { bytes: await frame("3 items in your cart") };
  const q = { bytes: await frame("3 items in your cart", 720) }; // another phone of the layout
  await run(p, lock, true, cart);
  await run(p, lock, true, cart);
  // Due for another look, and this time the model says no.
  for (const entry of lock.verdicts!.cart!.prints) entry.since = 10;
  await run(p, lock, false, cart);
  assert.equal(lock.verdicts?.cart, undefined, "forgotten");
  // Another phone's screen passes; the no stands for the first.
  await run(q, lock, true, cart);
  await run(q, lock, true, cart);
  assert.equal((await run(p, lock, true, cart)).calls.asserted, 1, "asked again, not answered from memory");
});

test("each remembered question is put to a model again after ten answers from memory, on its own count", async () => {
  const lock = emptyLock("checkout", "android");
  const a = { bytes: await frame("3 items in your cart") };
  const b = { bytes: await frame("3 items in your cart", 720) };
  for (const screen of [a, a, b, b]) await run(screen, lock);
  // B runs far more often than A; A's count is its own.
  for (let i = 0; i < 10; i += 1) assert.equal((await run(b, lock)).calls.asserted, 0);
  assert.equal((await run(b, lock)).calls.asserted, 2, "B's eleventh is a model's again");
  for (let i = 0; i < 10; i += 1) assert.equal((await run(a, lock)).calls.asserted, 0, "and A still has all ten of its own");
  assert.equal((await run(a, lock)).calls.asserted, 2);
});

test("a screen still settling is looked at again, and what is judged and remembered is the one at rest", async () => {
  const lock = emptyLock("checkout", "android");
  const rest = await frame("3 items in your cart");
  const fading = await frame("3 items in your cart ."); // a scroll bar still fading
  // Each run: the first look after the tap catches it settling; the next, at rest.
  const settling = () => {
    let seen = 0;
    return { get bytes() { seen += 1; return seen === 1 || seen === 3 ? fading : rest; } };
  };
  await run(settling() as Screen, lock);
  await run(settling() as Screen, lock);
  assert.equal((await run(settling() as Screen, lock)).calls.asserted, 0, "the screen at rest is the one remembered, and the one met again");
});

test("a screen never at rest makes a bounded number of calls, however the agent loops", async () => {
  const lock = emptyLock("checkout", "android");
  let frameNo = 0;
  const spinning = { get bytes() { frameNo += 1; return Buffer.from(`frame ${frameNo}`); } };
  // A check that never holds, and an agent that keeps naming a pop-up nothing answers.
  const calls: Calls = { asserted: 0, grounded: 0, planned: 0 };
  const device = engine(spinning as Screen, calls, false);
  device.plan = async (): Promise<PlanResult> => {
    calls.planned += 1;
    return { actions: [], done: false, popup: { kind: "rating" }, provenance: PROVENANCE };
  };
  await runTest({ engine: device, test: checkout(3), device: DEVICE, ledger: new CostLedger(), lock, settle: false });
  assert.ok(calls.asserted + calls.planned <= 12, `bounded, not a loop: ${calls.asserted} checks and ${calls.planned} plans`);
  assert.equal(lock.verdicts, undefined, "and a check that never held is not remembered");
});

test("whether a screen is at rest is asked of its picture: a screen that never rests costs no tree reads in the looking", async () => {
  // On an iPhone SE a tree read is 3 s, and four of them went before every
  // check of a screen that animates.
  const lock = emptyLock("cart", "android");
  const cart = parseTestFile("id: cart\ntitle: Cart\ntargets:\n  - { platform: android, app: com.acme.shop }\nsteps:\n  - id: cart\n    expect: the cart shows 3 items\n", "cart.testsky.yaml");
  let frameNo = 0;
  const spinning = { get bytes() { frameNo += 1; return Buffer.from(`frame ${frameNo}`); } };
  const calls: Calls = { asserted: 0, grounded: 0, planned: 0 };
  const device = engine(spinning as Screen, calls, true);
  const looks = { tree: 0, picture: 0 };
  const observe = device.observe.bind(device);
  device.observe = async (opts) => {
    if (opts?.tree === true) looks.tree += 1;
    else looks.picture += 1;
    return observe(opts);
  };
  await runTest({ engine: device, test: cart, device: DEVICE, ledger: new CostLedger(), lock, settle: false });
  assert.ok(looks.picture >= 4, `looked at again by its picture: ${looks.picture}`);
  assert.ok(looks.tree <= 1, `the tree read for the step, not for each look: ${looks.tree}`);
});

test("a black frame is never remembered, however alike two of them are", async () => {
  const lock = emptyLock("checkout", "android");
  const blind = { bytes: await frame(""), blind: true };
  await run(blind, lock);
  await run(blind, lock);
  assert.equal(lock.verdicts, undefined);
  assert.equal((await run(blind, lock)).calls.asserted, 2);
});

test("an expectation that did not hold is not remembered as one that did", async () => {
  const lock = emptyLock("checkout", "android");
  const failed = await run({ bytes: await frame("0 items in your cart") }, lock, false);
  assert.notEqual(failed.result.outcome, "PASS");
  assert.equal(lock.verdicts?.next, undefined);
});

const CART = parseTestFile(
  "id: cart\ntitle: Cart\ntargets:\n  - { platform: android, app: com.acme.shop }\nsteps:\n  - id: cart\n    expect: the message was delivered\n",
  "cart.testsky.yaml",
);

test("memory is not taken on one look: a remembered screen that turns into another is judged at rest", async () => {
  const lock = emptyLock("cart", "android");
  const sent = await frame("Sent");
  const failed = await frame("Not delivered");
  await run({ bytes: sent }, lock, true, CART);
  await run({ bytes: sent }, lock, true, CART);
  // Met first as it was remembered, and a moment later as it really is.
  let seen = 0;
  const turning = { get bytes() { seen += 1; return seen === 1 ? sent : failed; } };
  const { result, calls } = await run(turning as Screen, lock, (bytes) => bytes.equals(sent), CART);
  assert.equal(result.outcome, "FAIL_ASSERT", "not passed from memory on its first frame");
  assert.ok(calls.asserted >= 1);
});

test("a model's no is kept, even when the step then ends in an error", async () => {
  const lock = emptyLock("cart", "android");
  const screen = { bytes: await frame("Delivered") };
  await run(screen, lock, true, CART);
  // The model says no, and the device goes away while the step gives the screen time.
  const calls: Calls = { asserted: 0, grounded: 0, planned: 0 };
  const device = engine(screen, calls, false);
  let looked = 0;
  device.observe = async () => {
    looked += 1;
    if (looked > 3) throw new Error("the device went away");
    return observation(screen);
  };
  const broken = await runTest({ engine: device, test: CART, device: DEVICE, ledger: new CostLedger(), lock, settle: false });
  assert.equal(broken.outcome, "DEVICE_ERROR");
  assert.equal(calls.asserted, 1, "the model did say no");
  assert.equal(lock.verdicts?.cart, undefined, "and the no was kept");
  // So the next yes is a first, not a second.
  await run(screen, lock, true, CART);
  assert.equal((await run(screen, lock, true, CART)).calls.asserted, 1, "asked again, not answered from memory");
});

test("a place that did not come to rest gets one look the next time", async () => {
  const pictures = await Promise.all(Array.from({ length: 12 }, (_, at) => frame(`frame ${at}`)));
  let shown = 0;
  const playing = { get bytes() { shown += 1; return pictures[shown % pictures.length]!; } };
  const device = engine(playing as Screen, { asserted: 0, grounded: 0, planned: 0 });
  let observed = 0;
  const look = device.observe;
  device.observe = async (options) => {
    observed += 1;
    return look(options);
  };
  const playingTwice = parseTestFile(
    "id: two\ntitle: Two\ntargets:\n  - { platform: android, app: com.acme.shop }\nsteps:\n  - id: first\n    expect: it plays\n  - id: second\n    expect: it still plays\n",
    "two.testsky.yaml",
  );
  const result = await runTest({ engine: device, test: playingTwice, device: DEVICE, ledger: new CostLedger(), settle: false, lock: emptyLock("two", "android") });
  assert.equal(result.outcome, "PASS", result.detail);
  assert.equal(observed, 1 + 4 + 1 + 1, "each step's own look, then four more on the first and one on the second");
});

test("a step's wait is the time it says, with no model asked for it", async () => {
  const calls: Calls = { asserted: 0, grounded: 0, planned: 0 };
  const device = engine({ bytes: await frame("playing") }, calls);
  const soak = parseTestFile(
    "id: soak\ntitle: Soak\ntargets:\n  - { platform: android, app: com.acme.shop }\nsteps:\n  - id: watch\n    wait: 1s\n  - id: still\n    wait: 1s\n    expect: it still plays\n",
    "soak.testsky.yaml",
  );
  const started = Date.now();
  const result = await runTest({ engine: device, test: soak, device: DEVICE, ledger: new CostLedger(), settle: false });
  assert.equal(result.outcome, "PASS", result.detail);
  assert.ok(Date.now() - started >= 2000, "both waits were waited");
  assert.deepEqual(calls, { asserted: 1, grounded: 0, planned: 0 }, "only the check is put to a model");
});

