/**
 * A password typed on an iPhone: the screenshot shows neither the dots nor
 * the keyboard, so the picture does not change, and only the tree says the
 * field is filled. Read as "nothing changed", the agent typed it again until
 * the step stopped on three actions that changed nothing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseTestFile } from "@testsky/artifact";
import type { DeviceHandle, Engine, GroundResult, Observation, PlanRequest, PlanResult, Provenance, TreeNode } from "@testsky/engine-core";
import { CostLedger } from "@testsky/router";

import { runTest, type RunEvent } from "./run.ts";

const DEVICE: DeviceHandle = { id: "00008101-000000000000001E", platform: "ios", osVersion: "27.0", kind: "physical" };
const PROVENANCE: Provenance = { tier: 1, model: "fake", usd: 0.001, latencyMs: 5, usedTree: true, channel: "vision" };

const node = (partial: Partial<TreeNode> & { ref: string; role: string }): TreeNode => ({
  bounds: { x: 0, y: 0, width: 375, height: 812 },
  enabled: true,
  interactive: true,
  children: [],
  ...partial,
});

const FIELD = { x: 109, y: 380, width: 212, height: 22 };
const DONE = { x: 319, y: 70, width: 36, height: 36 };

function sheet(dots: string): TreeNode[] {
  return [
    node({ ref: "done", role: "Button", label: "Bitti", bounds: DONE }),
    node({ ref: "field", role: "SecureTextField", label: "Parola", ...(dots ? { value: dots } : {}), bounds: FIELD }),
  ];
}

function phone() {
  let state: "empty" | "typed" | "joined" = "empty";
  const plans: PlanRequest[] = [];
  const typed: string[] = [];
  const observe = (): Observation => ({
    // The sheet's picture is the same before and after typing.
    frame: { bytes: Buffer.from(state === "joined" ? "list" : "sheet"), capturedAt: Date.now(), size: { width: 375, height: 812 }, pixelRatio: 3 },
    visionBlind: false,
    visionStats: { meanLuma: 40, stdLuma: 30, uniqueColors: 900 },
    signature: { phash: state === "joined" ? "ffffffff00000000" : "0f0f0f0f0f0f0f0f", maskedRegions: [] },
    appContext: {},
    observedAt: Date.now(),
    tree: {
      platform: "ios",
      capturedAt: Date.now(),
      source: "xcuitest",
      truncated: false,
      captureMs: 200,
      root: node({ ref: "app", role: "Application", label: "Ayarlar", interactive: false, children: state === "joined" ? [] : sheet(state === "typed" ? "••••••••" : "") }),
    },
  });
  const engine = {
    name: "fake",
    capabilities: { tree: true, frameStream: false, networkCapture: false, nativePlanning: false, appInstall: false },
    attach: async () => {},
    detach: async () => {},
    observe: async () => observe(),
    openFrameStream: async () => undefined,
    ground: async (req: { description: string }): Promise<GroundResult> => {
      const box = /Bitti/.test(req.description) ? DONE : FIELD;
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      return { point, rect: box, confidence: 0.9, anchor: { tree: { role: /Bitti/.test(req.description) ? "Button" : "SecureTextField", label: /Bitti/.test(req.description) ? "Bitti" : "Parola", bounds: box } }, provenance: PROVENANCE, foundBy: "both" };
    },
    act: async (req: { name: string; params?: Record<string, unknown>; target?: { x: number; y: number } }) => {
      if (req.name === "input") {
        typed.push(String(req.params?.value ?? ""));
        state = "typed";
      }
      if (req.name === "tap" && req.target && req.target.y < 120 && state === "typed") state = "joined";
      return { dispatchedAt: Date.now(), stale: false };
    },
    assert: async () => ({ pass: state === "joined", reason: state === "joined" ? "the sheet closed" : "the password sheet is still up", provenance: PROVENANCE }),
    extract: (async () => ({ data: {}, provenance: PROVENANCE })) as Engine["extract"],
    plan: async (req: PlanRequest): Promise<PlanResult> => {
      plans.push(req);
      const last = req.history[req.history.length - 1];
      // As the planner should: once told the field is filled, it joins.
      if (last?.action === "input" && /as many as were typed/.test(last.outcome)) {
        return { actions: [{ name: "tap", describeTarget: "the Bitti button" }], done: false, provenance: PROVENANCE };
      }
      return { actions: [{ name: "input", describeTarget: "the Parola password field", params: { value: "abcdefgh" } }], done: false, provenance: PROVENANCE };
    },
    popup: async () => ({ found: false, provenance: PROVENANCE }),
    app: { launch: async () => {}, terminate: async () => {}, install: async () => {}, currentBuildId: async () => undefined },
    logs: { open: async () => { throw new Error("no logs"); } },
  } as unknown as Engine;
  return { engine, plans, typed };
}

test("a typed password the picture does not show is a change, and the planner is told the field is filled", async () => {
  const { engine, plans, typed } = phone();
  const events: RunEvent[] = [];
  const result = await runTest({
    engine,
    test: parseTestFile(`
id: join
targets: [{ platform: ios, app: com.apple.Preferences }]
policy: { runs: 1, pass_threshold: 1, budget: { max_steps: 20, max_usd: 1, max_seconds: 60 } }
steps:
  - do: type "abcdefgh" into the password field, then press Bitti
    expect: the password sheet has closed
`),
    device: DEVICE,
    ledger: new CostLedger(),
    settle: false,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.outcome, "PASS", result.detail);
  assert.deepEqual(typed, ["abcdefgh"], "typed once");
  const input = events.find((event) => event.kind === "action" && event.message?.startsWith("input"));
  assert.equal(input?.data?.moved, true, "the field's content changed though no pixel did");
  assert.ok(events.some((event) => event.kind === "note" && /it holds 8 characters, as many as were typed/.test(event.message ?? "")));
  assert.ok(plans.some((req) => req.history.some((entry) => /the password field holds 8 hidden characters, as many as were typed: it is filled/.test(entry.outcome))));
});
