import assert from "node:assert/strict";
import test from "node:test";

import type { RunEvent, TestResult } from "@testsky/executor";
import type { LedgerEntry } from "@testsky/router";

import { buildReport } from "./report.ts";

const T0 = 1_700_000_000_000;

const RESULT: TestResult = {
  testId: "checkout",
  outcome: "FAIL_ASSERT",
  detail: "the cart is empty",
  startedAt: T0,
  finishedAt: T0 + 30_000,
  usd: 0.01,
  cache: { steps: 2, replayed: 1, heals: 0 },
  popups: 0,
  steps: [
    { stepId: "cart", outcome: "PASS", detail: "one item", actions: 1, usd: 0, startedAt: T0 + 2_000, finishedAt: T0 + 8_000, fromCache: true },
    { stepId: "pay", outcome: "FAIL_ASSERT", detail: "<the cart> is empty", actions: 2, usd: 0.01, startedAt: T0 + 9_000, finishedAt: T0 + 29_000 },
  ],
};

const EVENTS: RunEvent[] = [
  { at: T0 + 2_100, kind: "step_started", stepId: "cart", message: "tap the cart" },
  { at: T0 + 12_500, kind: "assertion", stepId: "pay", message: 'not yet: an order number is visible' },
];

const CALLS: LedgerEntry[] = [
  { at: T0 + 3_000, purpose: "ground", stepId: "cart", tier: 1, model: "grounder", usd: 0, latencyMs: 400, usedTree: false, channel: "vision" },
  { at: T0 + 13_000, purpose: "assert", stepId: "pay", tier: 2, model: "judge", usd: 0.01, latencyMs: 900, usedTree: true, channel: "fused", tokensIn: 2000 },
];

const META = { test: "checkout", title: "Checkout", platform: "android", device: "R6", engine: "midscene" };

test("every step knows where it is in the video, measured from frame zero", () => {
  // Frame zero is the recording's first frame, not the run's start: seeking to
  // a step is the entire point of the file.
  const html = buildReport({ result: RESULT, events: EVENTS, calls: CALLS, meta: META, videoStartedAt: T0 + 1_000 });
  assert.match(html, /data-seek="1\.00"/, "the first step began a second after frame zero");
  assert.match(html, /data-seek="8\.00"/, "and the second one eight seconds in");
  // Events carry their own offsets, so the panel can follow the playhead.
  assert.match(html, /data-at="11\.50"/);
});

test("without a recording it still reads, timed from the run's own start", () => {
  const html = buildReport({ result: RESULT, events: EVENTS, calls: CALLS, meta: META });
  assert.match(html, /No recording for this run/);
  assert.match(html, /data-seek="2\.00"/);
});

test("the verdict is in words, and only one outcome accuses the app", () => {
  const html = buildReport({ result: RESULT, events: EVENTS, calls: CALLS, meta: META });
  assert.match(html, /your app may be broken/);
  assert.match(html, /class="rail-step bad"/);
  assert.match(html, /class="rail-step ok"/);
  // What the memory saved, where a reader will look for it.
  assert.match(html, /1\/2 steps remembered/);
});

test("what a model was asked, what it cost, and how long it took", () => {
  const html = buildReport({ result: RESULT, events: EVENTS, calls: CALLS, meta: META });
  assert.match(html, /<td>ground<\/td>/);
  assert.match(html, /tier 2/);
  assert.match(html, /\$0\.0100/);
  assert.match(html, /900ms/);
});

test("text from the app is escaped, because a test's own words end up in here", () => {
  const html = buildReport({ result: RESULT, events: EVENTS, calls: CALLS, meta: META });
  assert.match(html, /&lt;the cart&gt; is empty/);
  assert.ok(!html.includes("<the cart>"));
});

test("a pop-up is shown beside the screen it was answered on, and counted where a reader looks", () => {
  const result: TestResult = {
    ...RESULT,
    popups: 1,
    steps: [{ ...RESULT.steps[0]!, popups: 1 }, RESULT.steps[1]!],
  };
  const events: RunEvent[] = [
    ...EVENTS,
    {
      at: T0 + 2_400,
      kind: "popup",
      stepId: "cart",
      message: 'a notification prompt -- pressed "Don\'t allow", as your rules say',
      data: { kind: "notifications", answer: "deny", pressed: "Don't allow", by: "tree" },
      shotId: "cart.popup-1",
    },
  ];
  const html = buildReport({ result, events, calls: CALLS, meta: META, shots: { "cart.popup-1": "UklGRg==" } });
  assert.match(html, /1 pop-up answered by your rules/);
  assert.match(html, /1 action\(s\) · remembered · 1 pop-up answered/);
  assert.match(html, /<ul class="popups"><li><img[^>]+src="data:image\/webp;base64,UklGRg=="/);
  assert.match(html, /pressed &quot;Don't allow&quot;, as your rules say/, "escaped like every other word from the screen");
  assert.match(html, /read from the screen's tree/);
});

test("a pull request's heal does not send anybody to review it", () => {
  const healed: TestResult = { ...RESULT, outcome: "HEALED_PASS" };
  const onBranch = buildReport({ result: healed, events: EVENTS, calls: CALLS, meta: { ...META, pullRequest: true } });
  assert.match(onBranch, /on a pull request, so the memory is unchanged/);
  assert.match(onBranch, /midscene · pull request<\/span>/);
  assert.doesNotMatch(onBranch, /review the heal/);
  assert.match(buildReport({ result: healed, events: EVENTS, calls: CALLS, meta: META }), /review the heal/);
});

test("the app's log sits under the step it was written in, on the video's clock", () => {
  const deviceLog = {
    lines: [
      { at: T0 + 1_500, text: "launching" },
      { at: T0 + 3_000, text: "cart opened" },
      { at: T0 + 12_000, text: "error: [com.acme.shop] <payment> declined" },
    ],
    dropped: 7,
  };
  const html = buildReport({ result: RESULT, events: EVENTS, calls: CALLS, meta: META, videoStartedAt: T0 + 1_000, deviceLog });
  // Before the cart step started, while the app was opening.
  assert.match(html, /<strong>Before the first step<\/strong><p class="muted">7 earlier lines of the app's log did not fit/);
  assert.match(html, /<li data-at="0\.50"><span class="t">0\.5s<\/span> launching<\/li>/);
  assert.match(html, /id="step-0"[\s\S]*1 line from the app's log<\/summary><ol class="log"><li data-at="2\.00"><span class="t">2\.0s<\/span> cart opened/);
  // During the pay step, marked, and escaped like everything else the app says.
  assert.match(html, /id="step-1"[\s\S]*<li data-at="11\.00" class="serious"><span class="t">11\.0s<\/span> error: \[com\.acme\.shop\] &lt;payment&gt; declined/);
  // Without a log, no section says there was none.
  assert.doesNotMatch(buildReport({ result: RESULT, events: EVENTS, calls: CALLS, meta: META }), /from the app's log|Before the first step/);
});

test("what a step and the whole run cost is shown in dollars, not as a bare number", () => {
  const html = buildReport({ result: RESULT, events: EVENTS, calls: CALLS, meta: META });
  assert.match(html, /2 action\(s\) · \$0\.0100<\/span>/);
  assert.match(html, /model calls \(tier 1: 1, tier 2: 1\) · \$0\.0100 ·/);
});

const ACTED: RunEvent[] = [
  {
    at: T0 + 3_500,
    kind: "action",
    stepId: "cart",
    message: "tap the cart icon",
    shotId: "cart.action-1",
    data: { target: { x: 100, y: 200 }, cached: true, by: "memory", checkedBy: "tree", screen: { width: 360, height: 800 } },
  },
  {
    at: T0 + 10_000,
    kind: "action",
    stepId: "pay",
    message: "tap the Pay button",
    shotId: "pay.action-1",
    data: {
      target: { x: 180, y: 700 },
      moved: false,
      by: "model",
      seen: "fused",
      confidence: 0.42,
      box: { x: 90, y: 680, width: 180, height: 40 },
      why: "the <Pay> button at the bottom",
      thought: "pay for the order",
      screen: { width: 360, height: 800 },
    },
  },
];

const ACTION_SHOTS = { "cart.action-1": "AAAA", "pay.action-1": "BBBB" };

test("each action is shown on the screen it was decided on, marked where it pressed", () => {
  const html = buildReport({
    result: RESULT,
    events: [...EVENTS, ...ACTED],
    calls: CALLS,
    meta: META,
    shots: ACTION_SHOTS,
    videoStartedAt: T0 + 1_000,
  });
  assert.match(html, /<span class="mark" style="left:27\.78%;top:25\.00%"><\/span>/, "(100, 200) on a 360x800 screen");
  assert.match(html, /<span class="box" style="left:25\.00%;top:85\.00%;width:50\.00%;height:5\.00%"><\/span>/);
  assert.match(html, /src="data:image\/webp;base64,BBBB"/);
  assert.match(html, /data-at="9\.00"/, "and it knows its moment in the video");
});

test("who found each target is said: memory, or a model and what it was shown", () => {
  const html = buildReport({ result: RESULT, events: [...EVENTS, ...ACTED], calls: CALLS, meta: META, shots: ACTION_SHOTS });
  assert.match(html, /from memory, checked against the tree/);
  assert.match(html, /model · screenshot \+ tree/);
  assert.match(html, /confidence 0\.42 · the screen did not change/);
  assert.match(html, /the &lt;Pay&gt; button at the bottom/);
  assert.match(html, /pay for the order/);
  assert.match(html, /2 actions: 1 from memory, 1 by a model \(1 with the tree\)/);
});

test("an action with no frame is listed without a picture to mark", () => {
  const unframed: RunEvent = {
    at: T0 + 10_000,
    kind: "action",
    stepId: "pay",
    message: "tap the PIN field",
    data: { target: { x: 1, y: 2 }, by: "model", seen: "vision", screen: { width: 360, height: 800 } },
  };
  const html = buildReport({ result: RESULT, events: [unframed], calls: CALLS, meta: META, shots: ACTION_SHOTS });
  assert.match(html, /tap the PIN field/);
  assert.match(html, /model · screenshot</);
  assert.ok(!html.includes('<span class="mark"'), "no frame, so nothing is marked");
});

test("the call table says what each call was shown", () => {
  const html = buildReport({ result: RESULT, events: EVENTS, calls: CALLS, meta: META });
  assert.match(html, /<td>screenshot<\/td>/);
  assert.match(html, /<td>screenshot \+ tree<\/td>/);
});

test("the tree a model was shown sits under its action, folded away and escaped", () => {
  const action: RunEvent = {
    at: T0 + 10_000,
    kind: "action",
    stepId: "pay",
    message: "tap the Pay button",
    data: { target: { x: 1, y: 2 }, by: "model", seen: "fused", tree: '[3] Button "Pay <now>" (90,680 180x40)', screen: { width: 360, height: 800 } },
  };
  const html = buildReport({ result: RESULT, events: [action], calls: CALLS, meta: META });
  assert.match(html, /<details class="tree"><summary>the tree it was shown<\/summary><pre>\[3\] Button &quot;Pay &lt;now&gt;&quot;/);
});

test("who found a target says when the model and the tree agreed, and when the tree held alone", () => {
  const acted = (by: string, at: number): RunEvent => ({
    at,
    kind: "action",
    stepId: "pay",
    message: "tap the Pay button",
    data: { target: { x: 180, y: 726 }, moved: true, by, seen: by === "tree" ? "tree" : "fused", confidence: 0.95, screen: { width: 360, height: 800 } },
  });
  const html = buildReport({ result: RESULT, events: [...EVENTS, ...ACTED, acted("both", T0 + 10_500), acted("tree", T0 + 11_000)], calls: CALLS, meta: META, shots: ACTION_SHOTS });
  assert.match(html, /model and tree agreeing/);
  assert.match(html, /tree alone, the model found nothing/);
  assert.match(html, /4 actions: 1 from memory, 1 model and tree agreeing, 1 by a model \(1 with the tree\), 1 by the tree alone/);
});
