/**
 * A screen that never stops moving -- a preview playing on a feed: every plan
 * and every look are on a slightly different picture. The plan is made again
 * once on the picture its target is looked for in, and then carried out --
 * never put off for good. (The engines judge a tap's staleness by its own
 * spot: perception's spotMoved.)
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseTestFile } from "@testsky/artifact";
import type { DeviceHandle, Engine, GroundResult, Observation, PlanResult, Provenance } from "@testsky/engine-core";
import { CostLedger } from "@testsky/router";

import { runTest } from "./run.ts";

const DEVICE: DeviceHandle = { id: "NOTHING00000001", platform: "android", osVersion: "", kind: "physical" };
const PROVENANCE: Provenance = { tier: 1, model: "fake", usd: 0.002, latencyMs: 5, usedTree: false, channel: "vision" };
const SEARCH = { x: 300, y: 10, width: 48, height: 48 };

function feed(look: number, tree: boolean): Observation {
  return {
    frame: { bytes: Buffer.alloc(0), capturedAt: 0, size: { width: 360, height: 720 }, pixelRatio: 3 },
    visionBlind: false,
    visionStats: { meanLuma: 100, stdLuma: 30, uniqueColors: 90 },
    // Every look a new frame of the preview: far apart as pictures go.
    signature: { phash: (look % 2 ? "f0f0f0f0f0f0f0f0" : "0f0f0f0f0f0f0f0f"), maskedRegions: [] },
    appContext: {},
    observedAt: Date.now(),
    ...(tree
      ? {
          tree: {
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
              children: [{ ref: "s", role: "Button", label: "Search", bounds: SEARCH, enabled: true, interactive: true, children: [] }],
            },
          },
        }
      : {}),
  } as Observation;
}

test("on a screen that never stops moving, the step still acts", async () => {
  let looks = 0;
  const acts: string[] = [];
  const engine: Engine & { stepId?: string } = {
    name: "fake",
    capabilities: { tree: true, frameStream: false, networkCapture: false, nativePlanning: false, appInstall: false },
    attach: async () => {},
    detach: async () => {},
    observe: async (options) => feed((looks += 1), options?.tree === true),
    openFrameStream: async () => undefined,
    ground: async (): Promise<GroundResult> => ({
      point: { x: 324, y: 34 },
      confidence: 0.9,
      anchor: { tree: { role: "Button", label: "Search", bounds: SEARCH } },
      provenance: PROVENANCE,
    }),
    act: async (req) => {
      acts.push(req.name);
      return { dispatchedAt: Date.now(), stale: false };
    },
    assert: async () => ({ pass: true, reason: "it holds", provenance: PROVENANCE }),
    extract: (async () => ({ data: {}, provenance: PROVENANCE })) as Engine["extract"],
    plan: async (): Promise<PlanResult> =>
      acts.length
        ? { actions: [], done: true, reasoning: "the search is open", provenance: PROVENANCE }
        : { actions: [{ name: "tap", describeTarget: "the search icon at the top right" }], done: false, reasoning: "open search", provenance: PROVENANCE },
    popup: async () => ({ found: false, provenance: PROVENANCE }),
    app: { launch: async () => {}, terminate: async () => {}, install: async () => {}, currentBuildId: async () => undefined },
    logs: {
      open: async () => {
        throw new Error("no logs");
      },
    },
  };
  const result = await runTest({
    engine,
    test: parseTestFile(`
id: youtube
targets: [{ platform: android, app: com.google.android.youtube }]
policy: { runs: 1, pass_threshold: 1, budget: { max_steps: 20, max_usd: 1, max_seconds: 60 } }
steps:
  - do: open the search
`),
    device: DEVICE,
    ledger: new CostLedger(),
    settle: false,
  });
  assert.equal(result.outcome, "PASS", result.detail);
  assert.deepEqual(acts, ["tap"]);
});

test("a plan made from a tree is checked by the picture alone, and read again only when the screen moved", async () => {
  const trees: boolean[] = [];
  let planned = 0;
  let same = true;
  const grounded: boolean[] = [];
  const engine = {
    name: "fake",
    capabilities: { tree: true, frameStream: false, networkCapture: false, nativePlanning: false, appInstall: false },
    attach: async () => {},
    detach: async () => {},
    observe: async (options?: { tree?: boolean }) => {
      trees.push(options?.tree === true);
      return feed(same ? 1 : 2, options?.tree === true);
    },
    openFrameStream: async () => undefined,
    ground: async (req: { observation: Observation }): Promise<GroundResult> => {
      grounded.push(Boolean(req.observation.tree));
      return { point: { x: 324, y: 34 }, confidence: 0.9, anchor: { tree: { role: "Button", label: "Search", bounds: SEARCH } }, provenance: PROVENANCE };
    },
    act: async () => ({ dispatchedAt: Date.now(), stale: false }),
    assert: async () => ({ pass: true, reason: "it holds", provenance: PROVENANCE }),
    extract: (async () => ({ data: {}, provenance: PROVENANCE })) as Engine["extract"],
    plan: async (): Promise<PlanResult> => {
      planned += 1;
      return planned === 1
        ? { actions: [{ name: "tap", describeTarget: "the search icon" }], done: false, reasoning: "open search", provenance: PROVENANCE }
        : { actions: [], done: true, reasoning: "done", provenance: PROVENANCE };
    },
    popup: async () => ({ found: false, provenance: PROVENANCE }),
    app: { launch: async () => {}, terminate: async () => {}, install: async () => {}, currentBuildId: async () => undefined },
    logs: { open: async () => { throw new Error("no logs"); } },
  } as unknown as Engine;
  const run = () =>
    runTest({
      engine,
      test: parseTestFile(`
id: youtube
targets: [{ platform: android, app: com.google.android.youtube }]
policy: { runs: 1, pass_threshold: 1, budget: { max_steps: 20, max_usd: 1, max_seconds: 60 } }
steps:
  - do: open the search
`),
      device: DEVICE,
      ledger: new CostLedger(),
      settle: false,
    });
  const result = await run();
  assert.equal(result.outcome, "PASS", result.detail);
  assert.deepEqual(grounded, [true], "the target is still looked for with the plan's tree");
  // The step's own look, with its tree, and then the picture alone before the press.
  assert.deepEqual(trees.slice(0, 2), [true, false]);
});

for (const [what, controls, plans, note] of [
  ["a picture that moved over the same controls keeps its plan", ["a", "a", "a", "a"], 1, false],
  ["a picture that moved over other controls is planned again", ["a", "b", "b", "b"], 2, true],
] as const) {
  test(what, async () => {
    let looks = 0;
    let planned = 0;
    const said: string[] = [];
    const engine = {
      name: "fake",
      capabilities: { tree: true, frameStream: false, networkCapture: false, nativePlanning: false, appInstall: false },
      attach: async () => {},
      detach: async () => {},
      observe: async (options?: { tree?: boolean }) => {
        looks += 1;
        const seen = feed(looks, options?.tree === true);
        return options?.tree ? { ...seen, signature: { ...seen.signature, treeHash: controls[Math.min(looks - 1, controls.length - 1)] } } : seen;
      },
      openFrameStream: async () => undefined,
      ground: async (): Promise<GroundResult> => ({ point: { x: 324, y: 34 }, confidence: 0.9, anchor: { tree: { role: "Button", label: "Search", bounds: SEARCH } }, provenance: PROVENANCE }),
      act: async () => ({ dispatchedAt: Date.now(), stale: false }),
      assert: async () => ({ pass: true, reason: "it holds", provenance: PROVENANCE }),
      extract: (async () => ({ data: {}, provenance: PROVENANCE })) as Engine["extract"],
      plan: async (): Promise<PlanResult> => {
        planned += 1;
        return { actions: [{ name: "tap", describeTarget: "the search icon" }], done: false, reasoning: "open search", provenance: PROVENANCE };
      },
      popup: async () => ({ found: false, provenance: PROVENANCE }),
      app: { launch: async () => {}, terminate: async () => {}, install: async () => {}, currentBuildId: async () => undefined },
      logs: { open: async () => { throw new Error("no logs"); } },
    } as unknown as Engine;
    const result = await runTest({
      engine,
      test: parseTestFile(`
id: youtube
targets: [{ platform: android, app: com.google.android.youtube }]
policy: { runs: 1, pass_threshold: 1, budget: { max_steps: 20, max_usd: 1, max_seconds: 60 } }
steps:
  - do: open the search
    expect: the search is open
`),
      device: DEVICE,
      ledger: new CostLedger(),
      settle: false,
      onEvent: (event) => said.push(event.message ?? ""),
    });
    assert.equal(result.outcome, "PASS", result.detail);
    assert.equal(planned, plans);
    assert.equal(said.some((message) => message.includes("the screen changed while deciding")), note);
  });
}

