import assert from "node:assert/strict";
import test from "node:test";

import type { RunEvent, TestResult } from "@testsky/executor";
import type { LedgerEntry } from "@testsky/router";

import { buildMidsceneReport, type DumpCall, type DumpTask, inlineScreenshots, locateDump, toMidsceneDump } from "./midscene-dump.ts";

const T0 = 1_700_000_000_000;
const SCREEN = { width: 360, height: 800 };

const RESULT: TestResult = {
  testId: "checkout",
  outcome: "FAIL_ASSERT",
  detail: "no order number",
  startedAt: T0,
  finishedAt: T0 + 30_000,
  usd: 0.01,
  cache: { steps: 2, replayed: 1, heals: 0 },
  popups: 0,
  steps: [
    { stepId: "cart", outcome: "PASS", detail: "the cart lists three items", actions: 1, usd: 0, startedAt: T0 + 1_000, finishedAt: T0 + 6_000, fromCache: true },
    { stepId: "pay", outcome: "FAIL_ASSERT", detail: "no order number", actions: 1, usd: 0.01, startedAt: T0 + 7_000, finishedAt: T0 + 29_000 },
  ],
};

const EVENTS: RunEvent[] = [
  { at: T0 + 1_000, kind: "step_started", stepId: "cart", message: "open the cart" },
  {
    at: T0 + 2_000,
    kind: "action",
    stepId: "cart",
    message: "tap the cart icon",
    shotId: "cart.action-1",
    data: { target: { x: 320, y: 52 }, cached: true, by: "memory", checkedBy: "tree", screen: SCREEN },
  },
  { at: T0 + 5_000, kind: "assertion", stepId: "cart", message: "held, remembered: the cart lists three items", data: { reason: "as before", remembered: true } },
  { at: T0 + 7_000, kind: "step_started", stepId: "pay", message: "pay for the order" },
  {
    at: T0 + 12_000,
    kind: "action",
    stepId: "pay",
    message: "tap the Pay button",
    shotId: "pay.action-1",
    data: {
      target: { x: 180, y: 726 },
      moved: true,
      by: "model",
      seen: "fused",
      confidence: 0.86,
      box: { x: 30, y: 700, width: 300, height: 52 },
      why: "the blue Pay button",
      thought: "the order is ready",
      tree: '[6] Button "Pay"',
      screen: SCREEN,
    },
  },
  { at: T0 + 28_000, kind: "assertion", stepId: "pay", message: "not yet: an order number is visible", data: { reason: "the payment failed" } },
];

const CALLS: LedgerEntry[] = [
  { at: T0 + 9_000, purpose: "plan", stepId: "pay", tier: 1, model: "qwen-vl", usd: 0.002, latencyMs: 1_500, usedTree: true, channel: "fused", tokensIn: 3_900, tokensOut: 40 },
  { at: T0 + 11_000, purpose: "ground", stepId: "pay", tier: 1, model: "qwen-vl", usd: 0.002, latencyMs: 1_200, usedTree: true, channel: "fused", tokensIn: 3_400, tokensOut: 30 },
  { at: T0 + 27_500, purpose: "assert", stepId: "pay", tier: 2, model: "judge", usd: 0.005, latencyMs: 2_000, usedTree: false, channel: "vision", tokensIn: 1_200 },
];

const META = { test: "checkout", title: "Checkout", platform: "android", device: "Pixel 8", engine: "midscene", version: "0.1.0" };
const SHOTS = { "cart.action-1": "AAAA", "pay.action-1": "BBBB", cart: "CCCC", pay: "DDDD" };

const dumpOf = () => toMidsceneDump({ result: RESULT, events: EVENTS, calls: CALLS, meta: META, shots: SHOTS });

/** What testsky says about a task beside its call, and the call. */
const sourceOf = (task: DumpTask | undefined): Record<string, unknown> => {
  const { call: _call, ...rest } = task?.testsky ?? {};
  return rest;
};
const callIn = (task: DumpTask | undefined): DumpCall | undefined => task?.testsky?.call as DumpCall | undefined;

test("a call with no event of its own shows what the model answered, and a judge that said no is not ticked", () => {
  const call = (purpose: LedgerEntry["purpose"], answer: string | undefined, at: number): LedgerEntry => ({
    at: T0 + at,
    purpose,
    stepId: "pay",
    tier: 1,
    model: "haiku",
    usd: 0,
    latencyMs: 100,
    usedTree: false,
    channel: "vision",
    ...(answer === undefined ? {} : { answer }),
  });
  const extra = [
    call("assert", '{"pass": false, "reason": "only a progress line shows"}', 100),
    call("assert", '{"onTarget": true, "reason": "it went to the button"}', 200),
    call("plan", 'Here it is: {"actions": [], "done": true, "reasoning": "already there"}', 300),
    call("popup", "not json at all", 400),
    call("assert", undefined, 500),
  ];
  const tasks = toMidsceneDump({ result: RESULT, events: [], calls: extra, meta: META, shots: {} }).dump.executions[1]!.tasks;
  const [no, aimed, planned, garbled, unsaid] = tasks;
  assert.equal(no!.output, false);
  assert.equal(no!.thought, "only a progress line shows");
  assert.deepEqual(no!.testsky, {
    shown: "vision",
    call: { purpose: "assert", model: "haiku", tier: 1, shown: "vision", latencyMs: 100, usd: 0, answer: '{"pass": false, "reason": "only a progress line shows"}' },
  });
  assert.equal(aimed!.output, true);
  assert.equal(planned!.thought, "already there", "read through the words around the JSON");
  assert.equal(garbled!.output, undefined);
  assert.equal(callIn(garbled)?.answer, "not json at all", "an answer that cannot be read is still there to read");
  assert.equal(unsaid!.output, undefined);
  assert.deepEqual(
    unsaid!.testsky,
    { shown: "vision", call: { purpose: "assert", model: "haiku", tier: 1, shown: "vision", latencyMs: 100, usd: 0 } },
    "a report of a run from before answers were kept",
  );
});

test("each step is an execution, named for what it was asked to do", () => {
  const { dump } = dumpOf();
  assert.deepEqual(
    dump.executions.map((execution) => execution.name),
    ["cart - open the cart", "pay - pay for the order"],
  );
  assert.equal(dump.platform, "Android");
  assert.equal(dump.sdkVersion, "0.1.0");
  assert.equal(dump.groupName, "Checkout");
});

test("a model's action is the plan, the locate and the action Midscene would have recorded", () => {
  const pay = dumpOf().dump.executions[1]!;
  assert.deepEqual(
    pay.tasks.map((task) => `${task.type}/${task.subType}`),
    ["Planning/Plan", "Planning/Locate", "Action Space/Tap", "Insight/Assert"],
  );
  const [plan, locate, tap] = pay.tasks;
  assert.equal(plan!.usage?.prompt_tokens, 3_900);
  assert.equal(plan!.usage?.intent, "planning");
  assert.equal(plan!.thought, "the order is ready");
  assert.deepEqual(locate!.output, {
    element: { center: [180, 726], rect: { left: 30, top: 700, width: 300, height: 52 }, description: "the Pay button" },
  });
  assert.equal(locate!.thought, "the blue Pay button");
  assert.deepEqual(sourceOf(locate), { shown: "fused", seen: "fused", confidence: 0.86, tree: '[6] Button "Pay"' });
  assert.equal(callIn(locate)?.purpose, "ground", "the call that answered rides on the locate");
  assert.deepEqual((tap!.param as { locate: { center: number[] } }).locate.center, [180, 726]);
  assert.equal(tap!.hitBy, undefined, "a model found this one");
});

test("an action replayed from memory is a cache hit, and says what checked it", () => {
  const cart = dumpOf().dump.executions[0]!;
  const tap = cart.tasks.find((task) => task.subType === "Tap")!;
  assert.deepEqual(tap.hitBy, { from: "Cache", context: { checkedBy: "tree" } });
  assert.equal(cart.tasks.filter((task) => task.type === "Planning").length, 0, "and no model was asked");
});

test("frames travel as images by id; an action shows the screen it left behind", () => {
  const { dump, images } = dumpOf();
  assert.equal(images["pay_action-1"], "data:image/jpeg;base64,BBBB", "ids keep to the characters the viewer accepts");
  const tap = dump.executions[1]!.tasks.find((task) => task.subType === "Tap")!;
  assert.equal(tap.uiContext?.screenshot.id, "pay_action-1");
  assert.equal(tap.uiContext?.screenshot.mimeType, "image/jpeg", "and the types: a webp screenshot is refused");
  assert.deepEqual(tap.uiContext?.size, { width: 360, height: 800, dpr: 1 });
  assert.equal(tap.recorder?.[0]?.screenshot.id, "pay", "the step's own frame, the last one it saw");
});

test("an assertion is Midscene's assert, judged on the step's frame", () => {
  const pay = dumpOf().dump.executions[1]!;
  const verdict = pay.tasks.at(-1)!;
  assert.equal(verdict.subType, "Assert");
  assert.equal(verdict.output, false);
  assert.equal(verdict.thought, "the payment failed");
  assert.equal(verdict.usage?.model_name, "judge");
  assert.equal(verdict.uiContext?.screenshot.id, "pay");
});

test("a failed step says so on its last task, in its own words", () => {
  const pay = dumpOf().dump.executions[1]!;
  assert.equal(pay.tasks.at(-1)!.status, "failed");
  assert.equal(pay.tasks.at(-1)!.errorMessage, "FAIL_ASSERT: no order number");
  assert.ok(dumpOf().dump.executions[0]!.tasks.every((task) => task.status === "finished"));
});

test("a frame a step kept to itself is not in the report at all", () => {
  const { images, dump } = toMidsceneDump({ result: RESULT, events: EVENTS, calls: CALLS, meta: META, shots: {} });
  assert.deepEqual(images, {});
  assert.equal(dump.executions[1]!.tasks.find((task) => task.subType === "Tap")!.uiContext, undefined);
});

test("the dump goes before </html> and cannot close its own script tag", () => {
  const sneaky = { ...META, title: 'Pay </script><script>alert("x")</script> now' };
  const html = buildMidsceneReport({ result: RESULT, events: EVENTS, calls: CALLS, meta: sneaky, shots: SHOTS }, "<html><body></body></html>");
  assert.ok(html.endsWith("</html>"));
  assert.ok(!html.includes('<script>alert("x")'), "the title's markup never reaches the page as markup");
  const json = html.match(/<script type="midscene_web_dump" type="application\/json">([\s\S]*?)<\/script>/)![1]!;
  assert.equal(JSON.parse(json).groupName, sneaky.title, "and it reads back exactly");
  assert.match(html, /<script type="midscene-image" data-id="pay_action-1">data:image\/jpeg;base64,BBBB<\/script>/);
});

test("for the playground, frames can sit in the dump itself", () => {
  const { dump, images } = dumpOf();
  const inline = inlineScreenshots(dump, images);
  const tap = inline.executions[1]!.tasks.find((task) => task.subType === "Tap")!;
  assert.deepEqual(tap.uiContext?.screenshot, { base64: "data:image/jpeg;base64,BBBB", capturedAt: T0 + 12_000 });
  assert.equal(dump.executions[1]!.tasks.find((task) => task.subType === "Tap")!.uiContext?.screenshot.type, "midscene_screenshot_ref", "the original is untouched");
});

test("the frame gets the run's verdict, where it ran and what it cost", () => {
  const html = buildMidsceneReport({ result: RESULT, events: EVENTS, calls: CALLS, meta: META, shots: SHOTS }, "<html></html>");
  const json = html.match(/<script type="testsky_run" type="application\/json">([\s\S]*?)<\/script>/)![1]!;
  const run = JSON.parse(json) as Record<string, unknown>;
  assert.equal(run.outcome, "FAIL_ASSERT");
  assert.equal(run.tone, "amber");
  assert.match(String(run.verdict), /your app may be broken/);
  assert.deepEqual([run.steps, run.passed, run.remembered, run.calls], [2, 1, 1, 3]);
  assert.equal(run.platform, "android");
});

test("a target the tree held when the model found nothing is a locate with no usage, after the model's", () => {
  const held: RunEvent = {
    at: T0 + 12_000,
    kind: "action",
    stepId: "pay",
    message: "tap the Pay button",
    shotId: "pay.action-1",
    data: {
      target: { x: 180, y: 726 },
      moved: true,
      by: "tree",
      seen: "tree",
      confidence: 0.95,
      box: { x: 30, y: 700, width: 300, height: 52 },
      why: 'the tree has one Button called "Pay"; the model found nothing',
      tree: '[6] Button "Pay"',
      screen: SCREEN,
    },
  };
  const events = EVENTS.map((event) => (event.kind === "action" && event.stepId === "pay" ? held : event));
  const input = { result: RESULT, events, calls: CALLS, meta: META, shots: SHOTS };
  const pay = toMidsceneDump(input).dump.executions[1]!;
  assert.deepEqual(
    pay.tasks.map((task) => `${task.type}/${task.subType}`),
    ["Planning/Plan", "Planning/Locate", "Planning/Locate", "Action Space/Tap", "Insight/Assert"],
  );
  const [, asked, tree, tap] = pay.tasks;
  assert.equal(asked!.usage?.prompt_tokens, 3_400, "the model's look, paid for");
  assert.equal(asked!.output, undefined, "and finding nothing");
  assert.deepEqual(sourceOf(asked), { shown: "fused", answered: false });
  assert.equal(tree!.usage, undefined, "the tree spent nothing");
  assert.equal(tree!.thought, 'the tree has one Button called "Pay"; the model found nothing');
  assert.deepEqual((tree!.output as { element: { rect: unknown } }).element.rect, { left: 30, top: 700, width: 300, height: 52 });
  assert.deepEqual(tree!.testsky, { by: "tree", seen: "tree", confidence: 0.95, tree: '[6] Button "Pay"' });
  assert.equal(tap!.testsky?.by, "tree");
  assert.equal(tap!.hitBy, undefined, "it is not a memory");

  const html = buildMidsceneReport(input, "<html></html>");
  const run = JSON.parse(html.match(/<script type="testsky_run" type="application\/json">([\s\S]*?)<\/script>/)![1]!) as Record<string, unknown>;
  assert.deepEqual([run.agreed, run.treeAlone], [0, 1]);
});

test("a target the model and the tree agreed on says so on the locate that answered", () => {
  const events = EVENTS.map((event) =>
    event.kind === "action" && event.stepId === "pay" ? { ...event, data: { ...event.data, by: "both" } } : event,
  );
  const second: LedgerEntry = { ...CALLS[1]!, at: T0 + 11_500, tier: 2, model: "escalation" };
  const input = { result: RESULT, events, calls: [...CALLS.slice(0, 2), second, CALLS[2]!], meta: META, shots: SHOTS };
  const pay = toMidsceneDump(input).dump.executions[1]!;
  const locates = pay.tasks.filter((task) => task.subType === "Locate");
  assert.equal(locates.length, 2);
  assert.deepEqual(sourceOf(locates[0]), { shown: "fused", answered: false }, "the first look was corrected");
  assert.equal(locates[1]!.testsky?.by, "both");
  assert.equal(locates[1]!.usage?.model_name, "escalation");
  assert.equal(pay.tasks.find((task) => task.subType === "Tap")!.testsky?.by, "both");
  const html = buildMidsceneReport(input, "<html></html>");
  const run = JSON.parse(html.match(/<script type="testsky_run" type="application\/json">([\s\S]*?)<\/script>/)![1]!) as Record<string, unknown>;
  assert.deepEqual([run.agreed, run.treeAlone], [1, 0]);
});

test("an iOS back is a back, not Android's button, and an action with no target was found by nobody", () => {
  const back: RunEvent = { at: T0 + 12_000, kind: "action", stepId: "pay", message: "back", shotId: "pay.action-1", data: { moved: true, screen: SCREEN } };
  const events = EVENTS.map((event) => (event.kind === "action" && event.stepId === "pay" ? back : event));
  const ios = toMidsceneDump({ result: RESULT, events, calls: [], meta: { ...META, platform: "ios" }, shots: SHOTS }).dump;
  const task = ios.executions[1]!.tasks.find((each) => each.type === "Action Space")!;
  assert.equal(task.subType, "Back");
  assert.equal(task.testsky?.by, undefined);
  const android = toMidsceneDump({ result: RESULT, events, calls: [], meta: META, shots: SHOTS }).dump;
  assert.equal(android.executions[1]!.tasks.find((each) => each.type === "Action Space")!.subType, "AndroidBackButton");
});

// ── A playground Locate ─────────────────────────────────────────────────────

const LOCATE = {
  description: "Wi-Fi",
  meta: { platform: "android", device: "emulator-5554" },
  shot: "AAAA",
  size: SCREEN,
  at: T0,
} as const;
const GROUND = (at: number, model: string): LedgerEntry => ({
  at,
  purpose: "ground",
  tier: 1,
  model,
  usd: 0.001,
  latencyMs: 900,
  usedTree: true,
  channel: "fused",
  tokensIn: 3_000,
  tokensOut: 20,
});

test("a Locate the model and the tree agree on boxes the element on the answering call, and presses nothing", () => {
  const { dump, images } = locateDump({
    ...LOCATE,
    calls: [GROUND(T0 + 1_000, "first"), GROUND(T0 + 2_000, "second")],
    found: { point: { x: 180, y: 300 }, rect: { x: 0, y: 270, width: 360, height: 60 }, foundBy: "both", why: "the Wi-Fi row", confidence: 0.9 },
    tree: 'Row "Wi-Fi" at (0,270 360x60) -- the tree has one Row called "Wi-Fi"',
  });
  const tasks = dump.executions[0]!.tasks;
  assert.deepEqual(tasks.map((task) => [task.type, task.subType, task.status]), [
    ["Planning", "Locate", "finished"],
    ["Planning", "Locate", "finished"],
    ["Log", "Note", "finished"],
  ]);
  assert.equal(tasks.some((task) => task.type === "Action Space"), false, "nothing was pressed");
  assert.equal(tasks[0]!.output, undefined, "the call a second look corrected answers nothing");
  assert.deepEqual(sourceOf(tasks[0]), { shown: "fused", answered: false });
  assert.deepEqual(tasks[1]!.output, { element: { center: [180, 300], rect: { left: 0, top: 270, width: 360, height: 60 }, description: "Wi-Fi" } });
  assert.deepEqual(sourceOf(tasks[1]), { shown: "fused", by: "both", confidence: 0.9 });
  assert.equal(callIn(tasks[1])?.model, "second");
  assert.equal(tasks[1]!.thought, "the Wi-Fi row");
  assert.deepEqual(tasks[2]!.param, { content: 'The tree alone: Row "Wi-Fi" at (0,270 360x60) -- the tree has one Row called "Wi-Fi"' });
  assert.equal(tasks[2]!.recorder?.[0]?.screenshot.id, tasks[1]!.uiContext?.screenshot.id, "a note is replayed on the frame");
  assert.equal(Object.values(images)[0], "data:image/jpeg;base64,AAAA");
});

test("a Locate the tree held alone is a locate that cost nothing", () => {
  const { dump } = locateDump({ ...LOCATE, calls: [], found: { point: { x: 10, y: 10 }, foundBy: "tree", why: "no picture" } });
  const [held] = dump.executions[0]!.tasks;
  assert.equal(held!.usage, undefined);
  assert.deepEqual(held!.testsky, { seen: "tree", by: "tree" });
  assert.deepEqual((held!.output as { element: { rect: unknown } }).element.rect, { left: 6, top: 6, width: 8, height: 8 });
});

test("a Locate that would press nothing fails on the frame, with why", () => {
  const { dump } = locateDump({ ...LOCATE, calls: [GROUND(T0 + 1_000, "first")], refused: "the model and the tree disagree" });
  const tasks = dump.executions[0]!.tasks;
  assert.deepEqual(tasks.map((task) => [task.subType, task.status]), [["Locate", "finished"], ["Note", "failed"]]);
  assert.equal(tasks[1]!.errorMessage, "the model and the tree disagree");
  assert.ok(tasks[1]!.recorder?.[0]?.screenshot, "the failure is shown on the frame, not on black");
  assert.equal(dump.platform, "Android");
});

// ── The conversation itself ─────────────────────────────────────────────────

const TREE_LINES = '[1] Window\n  [6] Button "Pay" (30,700 300x52)';
const PROMPT = `Find this element in the screenshot: "the Pay button".\n\nThe screen's accessibility tree:\n${TREE_LINES}\n\nAnswer exactly: {...}`;
const ASKED_GROUND: LedgerEntry = {
  ...CALLS[1]!,
  answer: '{"found": true, "point": [500, 908], "why": "the blue Pay button"}',
  reasoning: "The tree names one Pay button at the bottom; the picture shows it there too.",
  asked: {
    system: "You locate elements on a phone screen.",
    user: PROMPT,
    treeSpan: [PROMPT.indexOf(TREE_LINES), PROMPT.indexOf(TREE_LINES) + TREE_LINES.length],
    image: "picture-pay",
  },
};

test("a call carries what it was asked, what it thought and what it said, on the picture it was shown", () => {
  const ringed: LedgerEntry = {
    at: T0 + 11_800,
    purpose: "assert",
    stepId: "pay",
    tier: 1,
    model: "haiku",
    usd: 0.001,
    latencyMs: 300,
    usedTree: false,
    channel: "vision",
    answer: '{"onTarget": true, "reason": "the ring is on Pay"}',
    asked: { system: "You check where an agent pressed.", user: "Is the ring on the thing the instruction names?", image: "picture-ring" },
  };
  const events = EVENTS.map((event) =>
    event.kind === "action" && event.stepId === "pay" ? { ...event, data: { ...event.data, treeAnswer: 'the tree has one Button called "Pay"' } } : event,
  );
  // The ground call was shown the frame the action was decided on: one picture, carried once.
  const input = {
    result: RESULT,
    events,
    calls: [CALLS[0]!, ASKED_GROUND, ringed, CALLS[2]!],
    meta: META,
    shots: { ...SHOTS, "picture-pay": SHOTS["pay.action-1"], "picture-ring": "RRRR" },
  };
  const { dump, images } = toMidsceneDump(input);
  const pay = dump.executions[1]!;
  const locate = pay.tasks.find((task) => task.subType === "Locate")!;
  const call = callIn(locate)!;
  assert.equal(call.system, "You locate elements on a phone screen.");
  assert.equal(call.prompt, PROMPT);
  assert.equal(call.prompt!.slice(...call.treeSpan!), TREE_LINES, "the tree's lines, found in the question as it was sent");
  assert.equal(call.thinking, "The tree names one Pay button at the bottom; the picture shows it there too.");
  assert.equal(call.answer, '{"found": true, "point": [500, 908], "why": "the blue Pay button"}');
  assert.equal(call.picture?.id, locate.uiContext?.screenshot.id, "the picture it was shown is the frame the action was decided on");
  assert.equal(Object.values(images).filter((uri) => uri.endsWith(SHOTS["pay.action-1"])).length, 1, "and is carried once");
  assert.equal(sourceOf(locate).treeAnswer, 'the tree has one Button called "Pay"', "the tree's own answer, beside the model's");

  // The aim check was shown the frame with the ring on it, and is shown on it.
  const aim = pay.tasks.find((task) => callIn(task)?.answer?.includes("onTarget"))!;
  assert.equal(images[aim.uiContext!.screenshot.id], "data:image/jpeg;base64,RRRR");
  assert.equal(callIn(aim)?.picture?.id, aim.uiContext?.screenshot.id);

  // In the viewer, where every reference becomes its picture.
  const inlined = inlineScreenshots(dump, images);
  const shown = inlined.executions[1]!.tasks.find((task) => task.subType === "Locate")!.testsky!.call as { picture: { base64: string } };
  assert.equal(shown.picture.base64, `data:image/jpeg;base64,${SHOTS["pay.action-1"]}`);
});

test("every look a check took is shown, not only the one its verdict came from", () => {
  const first: LedgerEntry = { ...CALLS[2]!, at: T0 + 26_000, model: "haiku", answer: '{"pass": true, "reason": "a number shows"}' };
  const strict: LedgerEntry = { ...CALLS[2]!, answer: '{"pass": false, "reason": "the number is the cart total, not an order number"}' };
  const pay = toMidsceneDump({ result: RESULT, events: EVENTS, calls: [...CALLS.slice(0, 2), first, strict], meta: META, shots: SHOTS }).dump.executions[1]!;
  const asserts = pay.tasks.filter((task) => task.subType === "Assert");
  assert.equal(asserts.length, 2);
  assert.equal(asserts[0]!.subTask, true, "the first look, overruled");
  assert.equal(callIn(asserts[0])?.model, "haiku");
  assert.equal(callIn(asserts[1])?.model, "judge", "the verdict's own look");
  assert.equal(asserts[1]!.output, false);
});

test("a playground Locate shows each call's picture, the frame itself carried once", () => {
  const { dump, images } = locateDump({
    ...LOCATE,
    calls: [{ ...GROUND(T0 + 1_000, "first"), asked: { system: "s", user: "u", image: "picture-frame" } }],
    pictures: { "picture-frame": LOCATE.shot },
    found: { point: { x: 180, y: 300 }, foundBy: "model" },
  });
  const [task] = dump.executions[0]!.tasks;
  assert.equal(callIn(task)?.picture?.id, task!.uiContext?.screenshot.id);
  assert.equal(Object.keys(images).length, 1);
});
