/**
 * A list that moves between the decision and the press: a Wi-Fi list
 * re-sorting as it scans, Settings on an iPhone pushed down by a banner that
 * loads late. The press goes to the control the target was found as, where it
 * is now, and a control that has gone is planned for again.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseTestFile } from "@testsky/artifact";
import type { DeviceHandle, Engine, GroundResult, Observation, PlanResult, Provenance, TreeNode } from "@testsky/engine-core";
import { CostLedger } from "@testsky/router";

import { runTest } from "./run.ts";

const DEVICE: DeviceHandle = { id: "NOTHING00000001", platform: "android", osVersion: "15", kind: "physical" };
const PROVENANCE: Provenance = { tier: 1, model: "fake", usd: 0.002, latencyMs: 5, usedTree: true, channel: "vision" };

const row = (label: string, y: number): TreeNode => ({ ref: label, role: "Button", label, bounds: { x: 0, y, width: 360, height: 60 }, enabled: true, interactive: true, children: [] });

function screen(rows: TreeNode[], look: number): Observation {
  return {
    frame: { bytes: Buffer.alloc(0), capturedAt: 0, size: { width: 360, height: 720 }, pixelRatio: 3 },
    visionBlind: false,
    visionStats: { meanLuma: 100, stdLuma: 30, uniqueColors: 90 },
    signature: { phash: "f0f0f0f0f0f0f0f0", treeHash: rows.map((each) => each.label).join(","), maskedRegions: [] },
    appContext: {},
    observedAt: Date.now() + look,
    tree: {
      platform: "android",
      capturedAt: 0,
      source: "uiautomator",
      truncated: false,
      captureMs: 10,
      root: { ref: "root", role: "FrameLayout", bounds: { x: 0, y: 0, width: 360, height: 720 }, enabled: true, interactive: false, children: rows },
    },
  };
}

function phone(lists: TreeNode[][], options: { pressesControls?: boolean } = {}) {
  let looks = 0;
  let planned = 0;
  const pressed: { x: number; y: number }[] = [];
  const said: string[] = [];
  const data: Record<string, unknown>[] = [];
  const engine = {
    name: "fake",
    capabilities: { tree: true, frameStream: false, networkCapture: false, nativePlanning: false, appInstall: false, ...(options.pressesControls ? { pressesControls: true } : {}) },
    attach: async () => {},
    detach: async () => {},
    observe: async () => {
      looks += 1;
      return screen(lists[Math.min(looks - 1, lists.length - 1)]!, looks);
    },
    openFrameStream: async () => undefined,
    // Found where it was when the plan was made: the first row.
    ground: async (): Promise<GroundResult> => ({ point: { x: 180, y: 130 }, confidence: 0.9, anchor: { tree: { role: "Button", label: "Lab", bounds: { x: 0, y: 100, width: 360, height: 60 } } }, provenance: PROVENANCE }),
    act: async (req: { target?: { x: number; y: number } }) => {
      if (req.target) pressed.push(req.target);
      return { dispatchedAt: Date.now(), stale: false, ...(options.pressesControls ? { via: "control" } : {}) };
    },
    assert: async () => ({ pass: true, reason: "it holds", provenance: PROVENANCE }),
    extract: (async () => ({ data: {}, provenance: PROVENANCE })) as Engine["extract"],
    plan: async (): Promise<PlanResult> => {
      planned += 1;
      return { actions: [{ name: "tap", describeTarget: "the row named Lab" }], done: false, reasoning: "open Lab", provenance: PROVENANCE };
    },
    popup: async () => ({ found: false, provenance: PROVENANCE }),
    app: { launch: async () => {}, terminate: async () => {}, install: async () => {}, currentBuildId: async () => undefined },
    logs: { open: async () => { throw new Error("no logs"); } },
  } as unknown as Engine;
  const run = () =>
    runTest({
      engine,
      test: parseTestFile(`
id: wifi
targets: [{ platform: android, app: com.android.settings }]
policy: { runs: 1, pass_threshold: 1, budget: { max_steps: 20, max_usd: 1, max_seconds: 60 } }
steps:
  - do: open the row named Lab
    expect: Lab is open
`),
      device: DEVICE,
      ledger: new CostLedger(),
      settle: false,
      onEvent: (event) => {
        said.push(event.message ?? "");
        if (event.kind === "action" && event.data) data.push(event.data);
      },
    });
  return { run, pressed, said, data, planned: () => planned, looks: () => looks };
}

const BEFORE = [row("Lab", 100), row("Guest", 160), row("Office", 220)];
// Re-sorted as it scanned: the row decided on is two rows down now.
const AFTER = [row("Guest", 100), row("Office", 160), row("Lab", 220)];

test("a press follows its control to where the list moved it", async () => {
  const { run, pressed, said, planned } = phone([BEFORE, BEFORE, AFTER]);
  const result = await run();
  assert.equal(result.outcome, "PASS", result.detail);
  assert.deepEqual(pressed, [{ x: 180, y: 250 }], "the same place within the row, where the row is now");
  assert.equal(planned(), 1, "no plan made again for a row that only moved");
  assert.ok(said.some((message) => message.includes("moved before the press")));
});

test("a control gone from the screen is planned for again, not pressed where it was", async () => {
  const gone = [row("Guest", 100), row("Office", 160)];
  const { run, pressed, planned } = phone([BEFORE, BEFORE, gone, BEFORE, BEFORE, BEFORE]);
  const result = await run();
  assert.equal(result.outcome, "PASS", result.detail);
  assert.equal(planned(), 2);
  assert.deepEqual(pressed, [{ x: 180, y: 130 }], "pressed once, after the plan was made again on a screen that had it");
});

test("a control still where it was is pressed there, with no second look at the tree spent on moving it", async () => {
  const { run, pressed, said } = phone([BEFORE]);
  const result = await run();
  assert.equal(result.outcome, "PASS", result.detail);
  assert.deepEqual(pressed, [{ x: 180, y: 130 }]);
  assert.ok(!said.some((message) => message.includes("moved before the press")));
});

test("an engine that presses the control itself is handed the decision, with no look at the tree before the press", async () => {
  const { run, pressed, said, data, looks } = phone([BEFORE, BEFORE, AFTER], { pressesControls: true });
  const result = await run();
  assert.equal(result.outcome, "PASS", result.detail);
  assert.deepEqual(pressed, [{ x: 180, y: 130 }], "the point decided on goes with the tree it was decided on; the engine finds the row");
  assert.ok(!said.some((message) => message.includes("moved before the press")));
  assert.equal(data[0]?.via, "control", "the report says how it was pressed");
  const following = phone([BEFORE, BEFORE, AFTER]);
  await following.run();
  assert.equal(looks(), following.looks() - 1, "one look fewer: the read before the press");
});
