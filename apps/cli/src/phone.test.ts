import assert from "node:assert/strict";
import test from "node:test";

import type { TreeNode, TreeSnapshot } from "@testsky/engine-core";
import type { TriedStep } from "@testsky/harness";

import { extensionOf, outlineTree, stepAnswer, stepFromFlags } from "./phone.ts";

const flag = (argv: string[], name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

test("a step is made of --do, --expect and --read, any of them", () => {
  assert.deepEqual(stepFromFlags(["--do", "tap the Pay button", "--expect", "the order is paid"], flag), { do: "tap the Pay button", expect: "the order is paid" });
  assert.deepEqual(stepFromFlags(["--read", "the total"], flag), { extract: { answer: "the total" } });
  assert.equal(stepFromFlags(["--device", "R58M"], flag), undefined);
});

const node = (role: string, over: Partial<TreeNode> = {}, children: TreeNode[] = []): TreeNode => ({
  ref: role,
  role,
  bounds: { x: 0, y: 0, width: 360, height: 40 },
  enabled: true,
  interactive: false,
  children,
  ...over,
});

test("the tree is outlined by what says something or can be used; silent containers and what is not drawn are left out", () => {
  const tree: TreeSnapshot = {
    platform: "android",
    capturedAt: 0,
    source: "uiautomator",
    truncated: false,
    captureMs: 10,
    root: node("FrameLayout", {}, [
      node("LinearLayout", {}, [
        node("TextView", { label: "Settings", bounds: { x: 16, y: 40, width: 200, height: 32 } }),
        node("Button", { label: "General", identifier: "com.android.settings:id/title", interactive: true, bounds: { x: 20, y: 580, width: 320, height: 40 } }, [
          node("TextView", { label: "General" }),
        ]),
        node("Switch", { label: "Wi-Fi", value: "on", interactive: true, enabled: false }),
        node("Button", { label: "Hidden", interactive: true, visible: false }),
      ]),
    ]),
  };
  assert.deepEqual(outlineTree(tree), [
    'TextView "Settings" (16,40 200x32)',
    'Button "General" #com.android.settings:id/title (20,580 320x40)',
    '  TextView "General" (0,0 360x40)',
    'Switch "Wi-Fi" = "on" (0,0 360x40) [disabled]',
  ]);
  assert.deepEqual(outlineTree(tree, 2).at(-1), "... more than 2 nodes");
});

test("a tried step answers with its outcome in words, what it read and what it cost", () => {
  const tried = {
    id: "instruction-1",
    step: { extract: { answer: "the total" } },
    result: {
      testId: "playground",
      outcome: "PASS",
      detail: "all steps passed",
      steps: [{ stepId: "instruction-1", outcome: "PASS", detail: "read the total", actions: 0, usd: 0.001, startedAt: 1000, finishedAt: 2500 }],
      startedAt: 1000,
      finishedAt: 2500,
      usd: 0.001,
      cache: { steps: 1, replayed: 0, heals: 0 },
      popups: 0,
    },
    events: [],
    shots: new Map(),
    calls: [{ usd: 0.001 }, { usd: 0.0005 }],
    passed: true,
    answer: "$146.00",
    failure: null,
  } as unknown as TriedStep;
  const answer = stepAnswer(tried, { id: "R58M", platform: "android", osVersion: "14", kind: "physical" }, { shot: "/tmp/x.png" });
  assert.deepEqual(
    [answer.outcome, answer.passed, answer.exitCode, answer.answer, answer.ms, answer.usd, answer.modelCalls, answer.shot],
    ["PASS", true, 0, "$146.00", 1500, 0.0015, 2, "/tmp/x.png"],
  );
});

test("a frame's file is named by its own bytes", () => {
  assert.equal(extensionOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), "png");
  assert.equal(extensionOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpg");
});
