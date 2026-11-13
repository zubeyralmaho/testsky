/**
 * `within`: an expectation given time to come true -- a network joined, a
 * page loaded -- without a model call a look, and never less right than the
 * same step without it.
 *
 * The engine here is the real ones' shape: a tree only when one is asked for
 * (and a dump that can fail), a judge print over the picture's bytes and any
 * tree the judge is shown, a model and a phone that take time.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { parseTestFile } from "@testsky/artifact";
import type { AssertResult, DeviceHandle, Engine, GroundResult, Observation, PlanResult, Provenance, TreeNode } from "@testsky/engine-core";
import { CostLedger } from "@testsky/router";

import { runTest, type RunEvent } from "./run.ts";

const DEVICE: DeviceHandle = { id: "emulator-5554", platform: "android", osVersion: "15", kind: "emulator" };
const PROVENANCE: Provenance = { tier: 1, model: "fake", usd: 0.002, latencyMs: 5, usedTree: false, channel: "vision" };
/** A picture hash that does not move for one word in a row -- measured: it mostly does not. */
const STILL = "00000000000000ff";

const text = (label: string, y: number): TreeNode => ({
  ref: `t${y}`,
  role: "TextView",
  label,
  bounds: { x: 20, y, width: 320, height: 40 },
  enabled: true,
  interactive: false,
  children: [],
});

/** The Wi-Fi page: its controls never change, only the line under the network does. */
function wifiTree(status: string): Observation["tree"] {
  return {
    platform: "android",
    capturedAt: 0,
    source: "uiautomator",
    truncated: false,
    captureMs: 10,
    root: {
      ref: "root",
      role: "FrameLayout",
      bounds: { x: 0, y: 0, width: 360, height: 720 },
      enabled: true,
      interactive: false,
      children: [text("Wi-Fi", 40), { ...text("Lab", 200), role: "Button", interactive: true }, text(status, 240), { ...text("Guest", 300), role: "Button", interactive: true }],
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Seen {
  looks: number;
  asserts: number;
  /** Asks a model was shown a tree with. */
  assertsWithTree: number;
  judged: string[];
  acts: string[];
}

function engineFor(opts: {
  /** The screen at `t` ms since the engine was made: the network's status line, and the picture's hash. */
  screen: (t: number, look: number) => { status: string; phash?: string };
  plan?: (turn: number, status: string) => Omit<PlanResult, "provenance">;
  assertMs?: number;
  /** The first look takes this long, to set the test's clock against the wait. */
  firstLookMs?: number;
  /** A tree dump that fails, as uiautomator's does. */
  treeThrows?: boolean;
}): { engine: Engine & { stepId?: string }; seen: Seen } {
  const seen: Seen = { looks: 0, asserts: 0, assertsWithTree: 0, judged: [], acts: [] };
  const started = Date.now();
  let turns = 0;
  const engine: Engine & { stepId?: string } = {
    name: "fake",
    capabilities: { tree: true, frameStream: false, networkCapture: false, nativePlanning: false, appInstall: false },
    attach: async () => {},
    detach: async () => {},
    observe: async (options) => {
      seen.looks += 1;
      if (seen.looks === 1 && opts.firstLookMs) await sleep(opts.firstLookMs);
      const now = opts.screen(Date.now() - started, seen.looks);
      if (options?.tree && opts.treeThrows) throw new Error("Unable to capture Android UI tree after 3 attempt(s)");
      return {
        // The picture carries the status line, as a real one does, whatever its hash says.
        frame: { bytes: Buffer.from(`picture:${now.status}`), capturedAt: Date.now(), size: { width: 360, height: 720 }, pixelRatio: 3 },
        visionBlind: false,
        visionStats: { meanLuma: 100, stdLuma: 30, uniqueColors: 90 },
        signature: { phash: now.phash ?? STILL, maskedRegions: [] },
        appContext: {},
        observedAt: Date.now(),
        ...(options?.tree ? { tree: wifiTree(now.status) } : {}),
      } as Observation;
    },
    openFrameStream: async () => undefined,
    ground: async (): Promise<GroundResult> => ({
      point: { x: 180, y: 220 },
      confidence: 0.9,
      anchor: { tree: { role: "Button", label: "Lab", bounds: { x: 20, y: 200, width: 320, height: 40 } } },
      provenance: PROVENANCE,
    }),
    act: async (req) => {
      seen.acts.push(req.name);
      return { dispatchedAt: Date.now(), stale: false };
    },
    // A model that reads the picture: "Connected" holds, anything else does not.
    assert: async (req): Promise<AssertResult> => {
      seen.asserts += 1;
      if (req.observation.tree) seen.assertsWithTree += 1;
      if (opts.assertMs) await sleep(opts.assertMs);
      const status = String(req.observation.frame.bytes).slice("picture:".length);
      seen.judged.push(status);
      const pass = status === "Connected";
      return { pass, reason: pass ? "the network is connected" : `the network says ${status}`, provenance: PROVENANCE };
    },
    // As the router's: the expectation, any tree the judge would be shown, and the picture.
    judgePrint: async (req) =>
      createHash("sha256")
        .update(`${req.assertion}\n${req.observation.tree ? JSON.stringify(req.observation.tree.root) : ""}\n`)
        .update(req.observation.frame.bytes)
        .digest("hex")
        .slice(0, 32),
    extract: (async () => ({ data: {}, provenance: PROVENANCE })) as Engine["extract"],
    plan: async (req): Promise<PlanResult> => {
      turns += 1;
      const status = String(req.observation.frame.bytes).slice("picture:".length);
      return { ...(opts.plan ? opts.plan(turns, status) : { actions: [], done: true, reasoning: "done" }), provenance: PROVENANCE };
    },
    popup: async () => ({ found: false, provenance: PROVENANCE }),
    app: { launch: async () => {}, terminate: async () => {}, install: async () => {}, currentBuildId: async () => "com.android.settings@15" },
    logs: {
      open: async () => {
        throw new Error("no logs");
      },
    },
  };
  return { engine, seen };
}

async function run(engine: Engine & { stepId?: string }, step: string, maxSeconds = 30) {
  const test = parseTestFile(`
id: wifi
targets: [{ platform: android, app: com.android.settings }]
policy: { runs: 1, pass_threshold: 1, budget: { max_steps: 20, max_usd: 1, max_seconds: ${maxSeconds} } }
steps:
${step}
`);
  const events: RunEvent[] = [];
  const result = await runTest({ engine, test, device: DEVICE, ledger: new CostLedger(), settle: false, onEvent: (event) => events.push(event) });
  return { result, detail: result.steps[0]?.detail ?? result.detail, notes: events.filter((event) => event.kind === "note").map((event) => event.message) };
}

const CONNECTED = `expect: 'the network "Lab" shows "Connected"'`;
const waitStep = (within = "3s") => `  - { id: joined, ${CONNECTED}, within: ${within} }`;

test("a wait on a screen that does not change asks a model once, shows it the tree, and fails when the time is up", async () => {
  const { engine, seen } = engineFor({ screen: () => ({ status: "Connecting…" }) });
  const { result, detail, notes } = await run(engine, waitStep());
  assert.equal(result.outcome, "FAIL_ASSERT");
  assert.match(detail, /did not hold within 3 s: the network says Connecting…/);
  assert.equal(seen.asserts, 1, "the same question is not put to a model twice");
  assert.equal(seen.assertsWithTree, 1, "and it is the question a step without a wait would put");
  assert.ok(seen.looks > 20, "but the screen was looked at all along");
  assert.ok(notes.some((note) => note.startsWith('waiting up to 3 s for "the network "Lab" shows "Connected""')));
});

test("a status line that changes under a picture hash that does not is seen", async () => {
  const { engine, seen } = engineFor({ screen: (t) => ({ status: t < 300 ? "Connecting…" : "Connected" }) });
  assert.equal((await run(engine, waitStep())).result.outcome, "PASS");
  assert.deepEqual(seen.judged, ["Connecting…", "Connected"]);
});

test("an engine with no tree to read sees the change in the question itself", async () => {
  const { engine, seen } = engineFor({ screen: (t) => ({ status: t < 300 ? "Connecting…" : "Connected" }) });
  (engine.capabilities as { tree: boolean }).tree = false;
  assert.equal((await run(engine, waitStep())).result.outcome, "PASS");
  assert.equal(seen.asserts, 2);
});

test("a tree that cannot be read while waiting does not end the run", async () => {
  const { engine } = engineFor({ screen: (t) => ({ status: t < 300 ? "Connecting…" : "Connected" }), treeThrows: true });
  assert.equal((await run(engine, waitStep())).result.outcome, "PASS");
});

test("a screen that keeps changing is judged every few looks, not every look", async () => {
  const { engine, seen } = engineFor({ screen: (_t, look) => ({ status: `Connecting… ${look % 7}`, phash: look.toString(16).padStart(16, "0") }) });
  assert.equal((await run(engine, waitStep())).result.outcome, "FAIL_ASSERT");
  assert.ok(seen.asserts >= 3, `judged now and then (${seen.asserts})`);
  assert.ok(seen.asserts <= 3 + Math.ceil(seen.looks / 4), `${seen.asserts} judgements for ${seen.looks} looks`);
});

test("what is waited from is the screen last judged, not one looked at since", async () => {
  // Two taps, a check that says "Connecting…" while the network connects, a
  // look at the tree that catches "Connected", and an agent that says done.
  let acts = 0;
  let connectAt = 0;
  const started = Date.now();
  const { engine, seen } = engineFor({
    assertMs: 100,
    screen: (t) => ({ status: connectAt && t >= connectAt ? "Connected" : "Connecting…", phash: `${acts}`.padStart(16, "0") }),
    plan: (turn) =>
      turn === 1
        ? { actions: [{ name: "tap", describeTarget: "the Lab network" }], done: false, reasoning: "open it" }
        : turn === 2
          ? { actions: [{ name: "tap", describeTarget: "Connect" }], done: false, reasoning: "connect" }
          : { actions: [], done: true, reasoning: "connected" },
  });
  const act = engine.act.bind(engine);
  engine.act = async (req) => {
    acts += 1;
    if (acts === 2) connectAt = Date.now() - started + 50;
    return act(req);
  };
  const { result } = await run(engine, `  - { id: join, do: 'join the network "Lab"', ${CONNECTED}, within: 5s }`);
  assert.equal(result.outcome, "PASS");
  assert.equal(seen.judged.at(-1), "Connected");
});

test("an agent that waits for it is not called a loop, and keeps its turn to act", async () => {
  let tapped = 0;
  const started = Date.now();
  const { engine } = engineFor({
    screen: (t) => ({ status: tapped && t - tapped > 1500 ? "Connected" : tapped ? "Connecting…" : "Saved" }),
    plan: (turn) =>
      turn === 1
        ? { actions: [{ name: "tap", describeTarget: "the Lab network", effect: "it starts connecting" }], done: false, reasoning: "join it" }
        : { actions: [{ name: "wait", params: { ms: 300 }, effect: "it finishes connecting" }], done: false, reasoning: "it is connecting" },
  });
  const act = engine.act.bind(engine);
  engine.act = async (req) => {
    if (req.name === "tap" && !tapped) tapped = Date.now() - started;
    if (req.name === "wait") await sleep(Number(req.params?.ms ?? 0));
    return act(req);
  };
  const { result } = await run(engine, `  - { id: join, do: 'join the network "Lab"', ${CONNECTED}, within: 10s }`);
  assert.equal(result.outcome, "PASS", "waits on a screen that does not change are not a loop here");
});

test("an agent waiting out an ad presses Skip the moment it is offered", async () => {
  let opened = 0;
  let skipped = false;
  const started = Date.now();
  const { engine, seen } = engineFor({
    screen: (t) => ({ status: skipped ? "Connected" : opened && t - opened > 600 ? "Ad, Skip" : opened ? "Ad" : "Results" }),
    plan: (turn, status) =>
      turn === 1
        ? { actions: [{ name: "tap", describeTarget: "the first video", effect: "the video opens" }], done: false, reasoning: "open it" }
        : status === "Ad, Skip"
          ? { actions: [{ name: "tap", describeTarget: "Skip", effect: "the ad ends" }], done: false, reasoning: "skip the ad" }
          : { actions: [{ name: "wait", params: { ms: 200 }, effect: "the ad can be skipped" }], done: false, reasoning: "an ad is playing" },
  });
  const act = engine.act.bind(engine);
  engine.act = async (req) => {
    if (req.name === "tap" && !opened) opened = Date.now() - started;
    else if (req.name === "tap") skipped = true;
    if (req.name === "wait") await sleep(Number(req.params?.ms ?? 0));
    return act(req);
  };
  const { result } = await run(engine, `  - { id: play, do: 'open the first video and skip the ad', ${CONNECTED}, within: 20s }`);
  assert.equal(result.outcome, "PASS", result.detail);
  assert.deepEqual(seen.acts.filter((name) => name === "tap"), ["tap", "tap"], "the video, then Skip");
});

test("a change that came while the last answer was being given is judged before the time is called", async () => {
  // A model that takes a while: the network connects during the last answer before the deadline.
  let firstWaitLook = 0;
  const { engine, seen } = engineFor({
    assertMs: 900,
    screen: (t, look) => {
      if (!firstWaitLook && look > 2) firstWaitLook = t;
      return { status: firstWaitLook && t >= firstWaitLook + 2400 ? "Connected" : "Connecting…", phash: look.toString(16).padStart(16, "0") };
    },
  });
  const { result } = await run(engine, waitStep());
  assert.equal(result.outcome, "PASS", `judged ${JSON.stringify(seen.judged)}`);
});

test("a network that says connected for one look and drops again has not connected", async () => {
  const { engine, seen } = engineFor({ screen: (_t, look) => ({ status: look === 10 ? "Connected" : "Connecting…" }) });
  assert.equal((await run(engine, waitStep())).result.outcome, "FAIL_ASSERT");
  // What held was looked at once more, and the screen it dropped back to is
  // the one a model had already said no to: answered so, without asking again.
  assert.deepEqual(seen.judged, ["Connecting…", "Connected"]);
});

test("the test's own time running out while it waits says nobody could tell", async () => {
  // The first look takes most of the test's time, so its time is up before the wait's.
  const { engine } = engineFor({ screen: () => ({ status: "Connecting…" }), firstLookMs: 1500 });
  const { result, detail } = await run(engine, waitStep("3s"), 4);
  assert.equal(result.outcome, "BUDGET_EXHAUSTED");
  assert.match(detail, /ran out of time, while waiting for "the network "Lab" shows "Connected""/);
});

test("do, then wait: where a moment's grace is over before the network connects, the step's own time is not", async () => {
  const joining = () => {
    let tapped = 0;
    const started = Date.now();
    const made = engineFor({
      screen: (t) => ({ status: tapped && t - tapped > 3500 ? "Connected" : tapped ? "Connecting…" : "Saved" }),
      plan: (turn) =>
        turn === 1
          ? { actions: [{ name: "tap", describeTarget: "the Lab network", effect: "it starts connecting" }], done: false, reasoning: "join it" }
          : { actions: [], done: true, reasoning: "joined; it is connecting" },
    });
    const act = made.engine.act.bind(made.engine);
    made.engine.act = async (req) => {
      if (!tapped) tapped = Date.now() - started;
      return act(req);
    };
    return made;
  };
  const JOIN = `  - { id: join, do: 'join the network "Lab"', ${CONNECTED}`;
  const waited = joining();
  assert.equal((await run(waited.engine, `${JOIN}, within: 10s }`)).result.outcome, "PASS");
  assert.deepEqual(waited.seen.acts, ["tap"], "waiting is not acting: nothing was tapped again while it connected");
  assert.equal((await run(joining().engine, `${JOIN} }`)).result.outcome, "FAIL_ASSERT");
});
