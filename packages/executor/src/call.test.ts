/**
 * A step that answers an incoming call the moment it rings: the engine's own
 * watch on the tree first, the eyes between its watches, and the step's check
 * after.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseTestFile } from "@testsky/artifact";
import type { AssertRequest, CallAnswer, CallAnswerRequest, DeviceHandle, Engine, GroundResult, Observation, PlanResult, Provenance } from "@testsky/engine-core";
import { CostLedger } from "@testsky/router";

import { runTest, type RunEvent } from "./run.ts";

const DEVICE: DeviceHandle = { id: "00008020-000000000000003A", platform: "ios", osVersion: "18.6", kind: "physical" };
const PROVENANCE: Provenance = { tier: 1, model: "fake", usd: 0.001, latencyMs: 5, usedTree: false, channel: "vision" };

const GUEST = parseTestFile(`
id: guest
targets: [{ platform: ios, app: com.facebook.Messenger }]
policy: { runs: 1, pass_threshold: 1, budget: { max_steps: 20, max_usd: 1, max_seconds: 60 } }
steps:
  - id: ring
    answer: call
    ring: 3s
    expect: the call is connected
    within: 5s
`);

type State = "chats" | "ringing" | "in call";

function phone(options: { watch?: (state: () => State, set: (next: State) => void, calls: number) => CallAnswer; ringsAfterLooks?: number }) {
  let state: State = "chats";
  let looks = 0;
  let watches = 0;
  const asked: string[] = [];
  const observe = (): Observation => {
    looks += 1;
    if (options.ringsAfterLooks !== undefined && looks >= options.ringsAfterLooks && state === "chats") state = "ringing";
    return {
      frame: { bytes: Buffer.from(state), capturedAt: Date.now(), size: { width: 414, height: 896 }, pixelRatio: 2 },
      visionBlind: false,
      visionStats: { meanLuma: 90, stdLuma: 40, uniqueColors: 900 },
      signature: { phash: state === "chats" ? "0000000000000000" : state === "ringing" ? "ffff0000ffff0000" : "ffffffffffffffff", maskedRegions: [] },
      appContext: {},
      observedAt: Date.now(),
    };
  };
  const engine: Engine = {
    name: "fake",
    capabilities: { tree: false, frameStream: false, networkCapture: false, nativePlanning: false, appInstall: false },
    attach: async () => {},
    detach: async () => {},
    observe: async () => observe(),
    openFrameStream: async () => undefined,
    ground: async (): Promise<GroundResult> => ({ point: { x: 300, y: 780 }, confidence: 0.9, anchor: {}, provenance: PROVENANCE }),
    act: async (req) => {
      if (req.name === "tap" && req.target && req.target.y > 700 && state === "ringing") state = "in call";
      return { dispatchedAt: Date.now(), stale: false };
    },
    assert: async (req: AssertRequest) => {
      asked.push(req.assertion);
      const pass = /ringing/.test(req.assertion) ? state === "ringing" : state === "in call";
      return { pass, reason: pass ? "it holds" : `the phone shows ${state}`, provenance: PROVENANCE };
    },
    extract: (async () => ({ data: {}, provenance: PROVENANCE })) as Engine["extract"],
    plan: async (): Promise<PlanResult> => ({ actions: [], done: true, provenance: PROVENANCE }),
    popup: async () => ({ found: false, provenance: PROVENANCE }),
    app: { launch: async () => {}, terminate: async () => {}, install: async () => {}, currentBuildId: async () => undefined },
    logs: { open: async () => { throw new Error("no logs"); } },
  };
  if (options.watch) {
    engine.answerCall = async (_req: CallAnswerRequest) => {
      watches += 1;
      return options.watch!(() => state, (next) => (state = next), watches);
    };
  }
  return { engine, asked, watches: () => watches };
}

async function run(engine: Engine, test = GUEST) {
  const events: RunEvent[] = [];
  const result = await runTest({ engine, test, device: DEVICE, ledger: new CostLedger(), settle: false, onEvent: (event) => events.push(event) });
  return { result, events };
}

test("a call is answered by the engine's own watch, with no model asked where to press, and then checked", async () => {
  const { engine, asked, watches } = phone({
    // The call rings during the second watch, which presses its answer at once.
    watch: (_state, set, calls) => {
      if (calls < 2) return { answered: false, afterMs: 100, looks: 8 };
      set("in call");
      return { answered: true, afterMs: 4200, pressed: "Accept", where: "on the screen", looks: 3 };
    },
  });
  const { result, events } = await run(engine);
  assert.equal(result.outcome, "PASS", result.steps[0]?.detail);
  assert.equal(watches(), 2);
  const answer = events.find((event) => event.kind === "action");
  assert.match(answer?.message ?? "", /answer the call: pressed "Accept" on the screen/);
  assert.equal(answer?.data?.via, "tree");
  assert.ok(asked.some((assertion) => assertion === "the call is connected"), "the step's own check after");
});

test("a ring the tree does not hold is found by looking, and answered where it is seen", async () => {
  const { engine } = phone({ ringsAfterLooks: 2 });
  const { result, events } = await run(engine);
  assert.equal(result.outcome, "PASS", result.steps[0]?.detail);
  const answer = events.find((event) => event.kind === "action");
  assert.equal(answer?.data?.via, "eyes");
});

test("a call that never rings fails the step, and says how long it was waited for", async () => {
  const { engine } = phone({ watch: () => ({ answered: false, afterMs: 3000, looks: 12 }) });
  const { result } = await run(engine);
  assert.equal(result.outcome, "FAIL_ASSERT");
  assert.match(result.steps[0]?.detail ?? "", /no call was answered in 3 s/);
});

test("a call answered is the test acting: a dialog of no known kind over it is left for the check", async () => {
  const ANSWER = parseTestFile(`
id: answer
targets: [{ platform: ios, app: com.facebook.Messenger }]
steps:
  - id: ring
    answer: call
    ring: 3s
    expect: the call is connected
`);
  const { engine } = phone({
    watch: (_state, set) => {
      set("in call");
      return { answered: true, afterMs: 100, pressed: "Accept", where: "on the screen", looks: 1 };
    },
  });
  // Over the call, a dialog nobody wrote a rule for, offered with its OK: for
  // all a rule knows, the app's answer to the call.
  let covered = true;
  const rules: string[] = [];
  const behind = engine.assert;
  engine.assert = async (req) => (covered ? { pass: false, reason: "a dialog covers the call", provenance: PROVENANCE } : behind(req));
  engine.popup = async (req) => {
    rules.push(req.rules.other);
    return covered
      ? { found: true, kind: "other", title: "Poor connection", press: { label: "OK", point: { x: 207, y: 500 } }, provenance: PROVENANCE }
      : { found: false, provenance: PROVENANCE };
  };
  const press = engine.act;
  engine.act = async (req) => {
    if (req.target?.y === 500) covered = false;
    return press(req);
  };
  const { result } = await run(engine, ANSWER);

  assert.equal(result.outcome, "FAIL_ASSERT", "pressing OK would have shown the call connected behind it");
  assert.equal(result.steps[0]?.actions, 1, "answering the call is the step's action");
  assert.ok(rules.length > 0 && rules.every((other) => other === "off"), "no look after the answer may close it");
});
