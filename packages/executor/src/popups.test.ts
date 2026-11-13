import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_POPUP_RULES, emptyLock, parseTestFile, type LockFile, type TestFile } from "@testsky/artifact";
import type {
  AssertResult,
  DeviceHandle,
  Engine,
  GroundResult,
  Observation,
  PlanRequest,
  PlanResult,
  PopupRequest,
  PopupResult,
  Provenance,
  TreeNode,
} from "@testsky/engine-core";
import { CostLedger } from "@testsky/router";

import { findPopup } from "./popups.ts";
import { runTest, type RunEvent } from "./run.ts";

const DEVICE: DeviceHandle = { id: "emulator-5554", platform: "android", osVersion: "15", kind: "emulator" };
const PROVENANCE: Provenance = { tier: 1, model: "fake", usd: 0.001, latencyMs: 5, usedTree: false, channel: "vision" };

const node = (partial: Partial<TreeNode>): TreeNode => ({
  ref: `n-${partial.label ?? partial.identifier ?? "view"}`,
  role: "View",
  bounds: { x: 0, y: 0, width: 360, height: 720 },
  enabled: true,
  interactive: false,
  children: [],
  ...partial,
});

const CONTINUE = node({
  role: "Button",
  label: "Continue",
  identifier: "com.acme:id/next",
  bounds: { x: 60, y: 560, width: 240, height: 72 },
  interactive: true,
});

/** Android's notification prompt, as uiautomator reports it over the app. */
const PROMPT: TreeNode[] = [
  node({ label: "Allow Acme to send you notifications?", identifier: "com.android.permissioncontroller:id/permission_message" }),
  node({ role: "Button", label: "Allow", identifier: "com.android.permissioncontroller:id/permission_allow_button", bounds: { x: 40, y: 600, width: 280, height: 48 }, interactive: true }),
  node({ role: "Button", label: "Don't allow", identifier: "com.android.permissioncontroller:id/permission_deny_button", bounds: { x: 40, y: 660, width: 280, height: 48 }, interactive: true }),
];

interface Screen {
  phash: string;
  tree?: TreeNode[];
}

/**
 * A phone as a little state machine: each screen says what a tap at a given
 * point leads to, and the fake answers observe, act and the model's questions
 * from whichever screen is showing.
 */
function phone(options: {
  screens: Record<string, Screen & { taps?: { at: { x: number; y: number }; to: string }[]; next?: string }>;
  start: string;
  tree?: boolean;
  platform?: "android" | "ios";
  plan?: (state: string, req: PlanRequest) => PlanResult;
  popup?: (state: string, req: PopupRequest) => PopupResult;
  pass?: (state: string) => boolean;
}) {
  let state = options.start;
  const spy = {
    taps: [] as { x: number; y: number }[],
    plans: [] as PlanRequest[],
    popupCalls: 0,
    grounded: 0,
    get state() {
      return state;
    },
  };
  const observe = (tree = false): Observation => {
    const screen = options.screens[state]!;
    return {
      frame: { bytes: Buffer.from(state), capturedAt: Date.now(), size: { width: 360, height: 720 }, pixelRatio: 3 },
      visionBlind: false,
      visionStats: { meanLuma: 100, stdLuma: 30, uniqueColors: 900 },
      signature: { phash: screen.phash, maskedRegions: [] },
      appContext: { appId: "com.acme" },
      observedAt: Date.now(),
      ...(tree && screen.tree
        ? {
            tree: {
              platform: options.platform ?? "android",
              capturedAt: Date.now(),
              source: options.platform === "ios" ? ("xcuitest" as const) : ("uiautomator" as const),
              truncated: false,
              captureMs: 900,
              root: node({ children: screen.tree }),
            },
          }
        : {}),
    };
  };
  const engine: Engine & { stepId?: string } = {
    name: "fake",
    capabilities: { tree: options.tree ?? false, frameStream: false, networkCapture: false, nativePlanning: false, appInstall: false },
    attach: async () => {},
    detach: async () => {},
    observe: async (opts) => observe(opts?.tree === true),
    openFrameStream: async () => undefined,
    ground: async (): Promise<GroundResult> => {
      spy.grounded += 1;
      return {
        point: { x: 180, y: 596 },
        confidence: 0.9,
        anchor: { tree: { role: "Button", label: "Continue", identifier: "com.acme:id/next", bounds: CONTINUE.bounds } },
        provenance: PROVENANCE,
      };
    },
    act: async (req) => {
      if (req.target) spy.taps.push(req.target);
      const screen = options.screens[state]!;
      const hit = req.target && screen.taps?.find((tap) => Math.abs(tap.at.x - req.target!.x) < 30 && Math.abs(tap.at.y - req.target!.y) < 30);
      if (hit) state = hit.to;
      else if (screen.next) state = screen.next;
      return { dispatchedAt: Date.now(), stale: false };
    },
    assert: async (): Promise<AssertResult> => {
      const pass = options.pass ? options.pass(state) : true;
      return { pass, reason: pass ? "it holds" : `not on ${state}`, provenance: PROVENANCE };
    },
    extract: (async () => ({ data: {}, provenance: PROVENANCE })) as Engine["extract"],
    plan: async (req): Promise<PlanResult> => {
      spy.plans.push(req);
      return options.plan ? options.plan(state, req) : { actions: [], done: true, provenance: PROVENANCE };
    },
    popup: async (req): Promise<PopupResult> => {
      spy.popupCalls += 1;
      return options.popup ? options.popup(state, req) : { found: false, provenance: PROVENANCE };
    },
    app: { launch: async () => {}, terminate: async () => {}, install: async () => {}, currentBuildId: async () => "com.acme@1.0+1" },
    logs: { open: async () => { throw new Error("no logs"); } },
  };
  return { engine, spy };
}

async function run(engine: Engine & { stepId?: string }, test: TestFile, lock?: LockFile) {
  const events: RunEvent[] = [];
  const result = await runTest({
    engine,
    test,
    device: DEVICE,
    ledger: new CostLedger(),
    settle: false,
    onEvent: (event) => events.push(event),
    ...(lock ? { lock, appBuild: "com.acme@1.0+1" } : {}),
  });
  return { result, events, popups: events.filter((event) => event.kind === "popup") };
}

const PRESS = parseTestFile(`
id: press
targets: [{ platform: android, app: com.acme }]
steps:
  - id: press
    do: press continue
    expect: the next screen is showing
`);

const HOME = "0000000000000000";
const NEXT = "00000000ffffffff";

test("a system prompt over a remembered screen is answered from the tree, and the memory still replays", async () => {
  const learn = phone({
    tree: true,
    start: "home",
    screens: { home: { phash: HOME, tree: [CONTINUE], taps: [{ at: { x: 180, y: 596 }, to: "next" }] }, next: { phash: NEXT } },
    plan: (state) =>
      state === "home"
        ? { actions: [{ name: "tap", describeTarget: "the Continue button" }], done: false, provenance: PROVENANCE }
        : { actions: [], done: true, provenance: PROVENANCE },
    pass: (state) => state === "next",
  });
  const lock = emptyLock("press", "android", "com.acme@1.0+1");
  assert.equal((await run(learn.engine, PRESS, lock)).result.outcome, "PASS");

  // Fresh install, second run: the notification prompt is up over the home screen.
  const { engine, spy } = phone({
    tree: true,
    start: "prompt",
    screens: {
      prompt: { phash: "ffffffffffffffff", tree: [CONTINUE, ...PROMPT], taps: [{ at: { x: 180, y: 684 }, to: "home" }] },
      home: { phash: HOME, tree: [CONTINUE], taps: [{ at: { x: 180, y: 596 }, to: "next" }] },
      next: { phash: NEXT },
    },
    pass: (state) => state === "next",
  });
  const { result, popups } = await run(engine, PRESS, lock);

  assert.equal(result.outcome, "PASS", "not a heal, not a failure");
  assert.equal(result.steps[0]!.fromCache, true, "the memory replayed once the prompt was out of the way");
  assert.equal(result.steps[0]!.popups, 1);
  assert.equal(result.popups, 1);
  assert.equal(lock.heals.length, 0, "nothing about the app changed, so nothing is proposed");
  assert.deepEqual(spy.taps, [{ x: 180, y: 684 }, { x: 180, y: 596 }], "Don't allow, by the default rule, then the remembered tap");
  assert.equal(spy.plans.length + spy.grounded + spy.popupCalls, 0, "the tree named it: no model was asked anything");
  assert.equal(popups[0]!.data?.by, "tree");
  assert.equal(popups[0]!.shotId, "press.popup-1", "the prompt keeps its own screenshot beside the step's");
  assert.ok(popups[0]!.screenshot?.length);
});

const SEND = parseTestFile(`
id: send
targets: [{ platform: android, app: com.acme }]
steps:
  - id: send
    do: tap Send
    expect: the message is marked as sent
`);

test("a rating sheet over the expectation is answered before the app is blamed", async () => {
  const { engine, spy } = phone({
    start: "compose",
    screens: {
      compose: { phash: HOME, next: "rating" },
      rating: { phash: "ffffffffffffffff", taps: [{ at: { x: 180, y: 600 }, to: "sent" }] },
      sent: { phash: NEXT },
    },
    plan: (_state, req) =>
      req.history.length === 0
        ? { actions: [{ name: "tap", describeTarget: "the Send button" }], done: false, provenance: PROVENANCE }
        : { actions: [], done: true, provenance: PROVENANCE },
    popup: (state) =>
      state === "rating"
        ? { found: true, kind: "rating", title: "Enjoying Acme?", press: { label: "Not now", point: { x: 180, y: 600 } }, provenance: PROVENANCE }
        : { found: false, provenance: PROVENANCE },
    pass: (state) => state === "sent",
  });
  const lock = emptyLock("send", "android", "com.acme@1.0+1");
  const { result, popups } = await run(engine, SEND, lock);

  assert.equal(result.outcome, "PASS", "the sheet hid the mark; it did not make the app wrong");
  assert.equal(result.steps[0]!.healed, undefined);
  assert.equal(popups.length, 1);
  assert.match(popups[0]!.message, /rating request \("Enjoying Acme\?"\) -- pressed "Not now"/);
  assert.equal(spy.state, "sent");
  assert.deepEqual(
    lock.steps.send!.actions.map((action) => action.describeTarget),
    ["the Send button"],
    "the step remembers its own tap, never the pop-up's",
  );
});

const OPEN = parseTestFile(`
id: open
targets: [{ platform: android, app: com.acme }]
steps:
  - id: open
    do: open the chat with Ada
    expect: the chat with Ada is open
`);

test("a sheet the planner names is answered by the rule, and the step is learned on the screen under it", async () => {
  const { engine, spy } = phone({
    start: "promo",
    screens: {
      promo: { phash: "ffffffffffffffff", taps: [{ at: { x: 330, y: 120 }, to: "home" }] },
      home: { phash: HOME, next: "chat" },
      chat: { phash: NEXT },
    },
    plan: (state, req) =>
      state === "promo" && req.popups
        ? { actions: [], done: false, popup: { kind: "promo", title: "What's new in 4.12" }, provenance: PROVENANCE }
        : state === "home"
          ? { actions: [{ name: "tap", describeTarget: "Ada in the chat list" }], done: false, provenance: PROVENANCE }
          : { actions: [], done: true, provenance: PROVENANCE },
    popup: (state, req) =>
      state === "promo"
        ? { found: true, kind: req.hint?.kind ?? "promo", press: { label: "Close", point: { x: 330, y: 120 } }, provenance: PROVENANCE }
        : { found: false, provenance: PROVENANCE },
    pass: (state) => state === "chat",
  });
  const lock = emptyLock("open", "android", "com.acme@1.0+1");
  const { result } = await run(engine, OPEN, lock);

  assert.equal(result.outcome, "PASS");
  assert.equal(result.popups, 1);
  assert.equal(spy.plans[0]!.popups, true, "the planner was asked to name pop-ups rather than answer them");
  const learned = lock.steps.open!;
  assert.deepEqual(learned.actions.map((action) => action.describeTarget), ["Ada in the chat list"]);
  assert.equal(learned.screen.phash, HOME, "keyed on the chat list, not on a sheet that may never show again");
});

test("a kind the rules leave to the test is not pressed, and the step is told to deal with it", async () => {
  const NOTIFY = parseTestFile(`
id: notify
targets: [{ platform: android, app: com.acme }]
policy:
  popups:
    notifications: off
steps:
  - id: turn-on
    do: allow notifications when asked
    expect: notifications are on
`);
  const { engine, spy } = phone({
    start: "prompt",
    screens: { prompt: { phash: "ffffffffffffffff", next: "allowed" }, allowed: { phash: NEXT } },
    plan: (state, req) =>
      state === "prompt"
        ? req.popups
          ? { actions: [], done: false, popup: { kind: "notifications" }, provenance: PROVENANCE }
          : { actions: [{ name: "tap", describeTarget: "Allow" }], done: false, provenance: PROVENANCE }
        : { actions: [], done: true, provenance: PROVENANCE },
    // What the router returns for a kind marked off: named, never pressed.
    popup: (state) => (state === "prompt" ? { found: true, kind: "notifications", provenance: PROVENANCE } : { found: false, provenance: PROVENANCE }),
    pass: (state) => state === "allowed",
  });
  const { result, events, popups } = await run(engine, NOTIFY);

  assert.equal(result.outcome, "PASS");
  assert.equal(popups.length, 0);
  assert.ok(events.some((event) => /your rules leave it to the test/.test(event.message)));
  assert.equal(spy.plans[1]!.popups, undefined, "once left to the test, the planner answers it like any screen");
});

test("a dialog that reopens forever is answered twelve times, then the step carries on as it would have", async () => {
  let shown = 0;
  const { engine, spy } = phone({
    start: "sheet-0",
    screens: Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`sheet-${i}`, { phash: (i * 7 + 1).toString(16).padStart(16, "0"), next: `sheet-${i + 1}` }]),
    ),
    plan: (_state, req) =>
      req.popups
        ? { actions: [], done: false, popup: { kind: "promo" }, provenance: PROVENANCE }
        : { actions: [], done: true, provenance: PROVENANCE },
    popup: () => {
      shown += 1;
      return { found: true, kind: "promo", press: { label: "Close", point: { x: 330, y: 120 } }, provenance: PROVENANCE };
    },
  });
  const { result } = await run(engine, OPEN);

  assert.equal(result.popups, 12);
  assert.equal(shown, 12, "no look past the limit");
  assert.equal(spy.plans.filter((req) => req.popups).length, 12, "each one named by the planner, one at a time -- no second look by the model");
  assert.equal(spy.plans.at(-1)!.popups, undefined, "after the limit, the planner stops being asked about them");
});

test("the app's own error is never closed before the verdict: a failure stays a failure", async () => {
  const PAY = parseTestFile(`
id: pay
targets: [{ platform: android, app: com.acme }]
steps:
  - id: pay
    do: tap Pay
    expect: no error message is shown
`);
  const asked: PopupRequest[] = [];
  const { engine } = phone({
    start: "checkout",
    screens: {
      checkout: { phash: HOME, next: "failed" },
      failed: { phash: "ffffffffffffffff", taps: [{ at: { x: 180, y: 500 }, to: "checkout" }] },
    },
    plan: (state) =>
      state === "checkout"
        ? { actions: [{ name: "tap", describeTarget: "the Pay button" }], done: false, provenance: PROVENANCE }
        : { actions: [], done: true, provenance: PROVENANCE },
    // As the router answers: the kind is named, and pressed only if the rules allow it.
    popup: (state, req) => {
      asked.push(req);
      return state === "failed"
        ? {
            found: true,
            kind: "other",
            title: "Payment failed",
            ...(req.rules.other !== "off" ? { press: { label: "OK", point: { x: 180, y: 500 } } } : {}),
            provenance: PROVENANCE,
          }
        : { found: false, provenance: PROVENANCE };
    },
    pass: (state) => state !== "failed",
  });
  const { result, events } = await run(engine, PAY);

  assert.equal(result.outcome, "FAIL_ASSERT", "pressing OK would have made \"no error message is shown\" true");
  assert.equal(result.popups, 0);
  assert.equal(asked[0]?.rules.other, "off", "after acting, a dialog of no known kind is not closed");
  assert.match(asked[0]?.goal ?? "", /tap Pay, then check that no error message is shown/);
  assert.ok(!events.some((event) => event.kind === "popup"), "nothing was pressed on it");
});

test("a pop-up left to the step holds only for its own screen", async () => {
  const NOTIFY = parseTestFile(`
id: notify
targets: [{ platform: android, app: com.acme }]
policy:
  popups: { notifications: off }
steps:
  - id: open
    do: allow notifications, then open the chat with Ada
    expect: the chat with Ada is open
`);
  const { engine, spy } = phone({
    start: "prompt",
    screens: {
      prompt: { phash: "ffffffffffffffff", taps: [{ at: { x: 180, y: 596 }, to: "promo" }] },
      promo: { phash: "0f0f0f0f0f0f0f0f", taps: [{ at: { x: 330, y: 120 }, to: "home" }] },
      home: { phash: HOME, next: "chat" },
      chat: { phash: NEXT },
    },
    plan: (state, req) => {
      if (state === "prompt") {
        return req.popups
          ? { actions: [], done: false, popup: { kind: "notifications" }, provenance: PROVENANCE }
          : { actions: [{ name: "tap", describeTarget: "Allow" }], done: false, provenance: PROVENANCE };
      }
      if (state === "promo") {
        return req.popups
          ? { actions: [], done: false, popup: { kind: "promo", title: "What's new" }, provenance: PROVENANCE }
          : { actions: [{ name: "tap", describeTarget: "Close" }], done: false, provenance: PROVENANCE };
      }
      return state === "home"
        ? { actions: [{ name: "tap", describeTarget: "Ada" }], done: false, provenance: PROVENANCE }
        : { actions: [], done: true, provenance: PROVENANCE };
    },
    popup: (state, req) =>
      state === "prompt"
        ? { found: true, kind: "notifications", provenance: PROVENANCE }
        : state === "promo" && req.rules.promo !== "off"
          ? { found: true, kind: "promo", press: { label: "Close", point: { x: 330, y: 120 } }, provenance: PROVENANCE }
          : { found: false, provenance: PROVENANCE },
    pass: (state) => state === "chat",
  });
  const lock = emptyLock("notify", "android", "com.acme@1.0+1");
  const { result } = await run(engine, NOTIFY, lock);

  assert.equal(result.outcome, "PASS");
  assert.equal(result.popups, 1, "the promo sheet after the prompt was answered by its rule");
  assert.deepEqual(
    lock.steps.open!.actions.map((action) => action.describeTarget),
    ["Allow", "Ada"],
    "the step's own taps, and not the sheet's Close -- which the planner would have filed had it not been asked",
  );
});

test("a system prompt whose button the tree does not know goes to the eyes, not to the step", async () => {
  const photos = [
    node({
      role: "Alert",
      label: "“Acme” Would Like to Access Your Photos",
      children: [node({ role: "Button", label: "Don’t Allow" }), node({ role: "Button", label: "Allow Limited Access" })],
    }),
  ];
  const { engine, spy } = phone({
    tree: true,
    platform: "ios",
    start: "photos",
    screens: { photos: { phash: HOME, tree: photos } },
    popup: (_state, req) => ({
      found: true,
      kind: req.hint?.kind ?? "other",
      press: { label: "Allow Full Access", point: { x: 180, y: 520 } },
      provenance: PROVENANCE,
    }),
  });
  const rules = DEFAULT_POPUP_RULES;
  const observation = await engine.observe();

  const free = await findPopup({ engine, observation, rules, look: false });
  assert.equal(free.found, undefined, "without a model call, a prompt it cannot answer is not claimed");

  const looked = await findPopup({ engine, observation, rules, look: true });
  assert.equal(spy.popupCalls, 1);
  assert.equal(looked.found?.kind, "camera", "the tree's reading of the kind goes along as the lead");
  assert.equal(looked.found?.by, "vision");
});

// The last in words that say nothing of a failure: only the rule about acting keeps it up.
for (const [kind, title] of [["promo", "Payment failed"], ["other", "Ödeme başarısız"], ["other", "Insufficient funds"]] as const) {
test(`a dialog left over from the step before is not closed at the next step's start (${kind}, "${title}")`, async () => {
  const PAY_THEN_HOME = parseTestFile(`
id: pay-then-home
targets: [{ platform: android, app: com.acme }]
steps:
  - id: pay
    do: tap Pay
  - id: home
    do: go to the home screen
    expect: no error message is shown
`);
  const { engine, spy } = phone({
    start: "checkout",
    screens: {
      checkout: { phash: HOME, next: "failed" },
      failed: { phash: "ffffffffffffffff", taps: [{ at: { x: 180, y: 500 }, to: "home" }], next: "failed" },
      home: { phash: NEXT },
    },
    plan: (state, req) =>
      state === "checkout"
        ? { actions: [{ name: "tap", describeTarget: "the Pay button" }], done: false, provenance: PROVENANCE }
        : state === "failed" && req.popups
          ? { actions: [], done: false, popup: { kind: "other", title: "Payment failed" }, provenance: PROVENANCE }
          : { actions: [], done: true, provenance: PROVENANCE },
    // An engine that ignores the rules and calls the dialog a promo: the
    // executor's own checks are all that stand between it and a green run.
    popup: (state) =>
      state === "failed"
        ? { found: true, kind, title, press: { label: "OK", point: { x: 180, y: 500 } }, provenance: PROVENANCE }
        : { found: false, provenance: PROVENANCE },
    pass: (state) => state !== "failed",
  });
  const { result } = await run(engine, PAY_THEN_HOME);

  assert.equal(result.outcome, "FAIL_ASSERT");
  assert.equal(result.popups, 0);
  assert.equal(spy.state, "failed", "the dialog is still on screen for the verdict to see");
});
}

test("a kind the rules leave off is not pressed even when the engine points at a button", async () => {
  const { engine } = phone({
    start: "sheet",
    screens: { sheet: { phash: HOME } },
    popup: () => ({ found: true, kind: "rating", press: { label: "Rate now", point: { x: 180, y: 500 } }, provenance: PROVENANCE }),
  });
  const found = await findPopup({ engine, observation: await engine.observe(), rules: { ...DEFAULT_POPUP_RULES, rating: "off" }, look: true });
  assert.equal(found.found?.kind, "rating");
  assert.equal(found.found?.press, undefined);
});

test("a tip closed by a tap beside it is tapped there -- unless the tree says the spot is a control", async () => {
  const tip = (point: { x: number; y: number }) =>
    phone({
      start: "tip",
      tree: true,
      screens: { tip: { phash: HOME, tree: [CONTINUE] } },
      popup: () => ({ found: true, kind: "promo", title: "Now you can swipe to dismiss", press: { label: "outside the tip", point, outside: true }, provenance: PROVENANCE }),
    }).engine;
  const empty = tip({ x: 180, y: 300 });
  const beside = await findPopup({ engine: empty, observation: await empty.observe(), rules: DEFAULT_POPUP_RULES, look: true });
  assert.deepEqual(beside.found?.press, { label: "outside the tip", point: { x: 180, y: 300 }, outside: true });

  const onButton = tip({ x: 180, y: 596 });
  const refused = await findPopup({ engine: onButton, observation: await onButton.observe(), rules: DEFAULT_POPUP_RULES, look: true });
  assert.equal(refused.found?.kind, "promo");
  assert.equal(refused.found?.press, undefined, "Continue is under that spot: a tap meant to close a tip does not press it");
});

test("the phone's own account asking for its password mid-step is put off, though the step has acted", async () => {
  // Raised by Settings, not by the app in front: unlike a dialog of no known
  // kind after the step acted, it is never the app's answer.
  const VERIFY: TreeNode[] = [
    node({
      role: "Alert",
      label: "Apple Account Verification",
      children: [
        node({ role: "Button", label: "Not Now", bounds: { x: 30, y: 440, width: 150, height: 50 }, interactive: true }),
        node({ role: "Button", label: "Settings", bounds: { x: 190, y: 440, width: 150, height: 50 }, interactive: true }),
      ],
    }),
  ];
  const { engine, spy } = phone({
    start: "verify",
    tree: true,
    platform: "ios",
    screens: { verify: { phash: HOME, tree: VERIFY, taps: [{ at: { x: 105, y: 465 }, to: "calculator" }] }, calculator: { phash: NEXT } },
  });
  const found = await findPopup({ engine, observation: await engine.observe(), rules: { ...DEFAULT_POPUP_RULES, other: "off" }, look: false });
  assert.equal(found.found?.kind, "account");
  assert.deepEqual(found.found?.press, { label: "Not Now", point: { x: 105, y: 465 } });
  assert.equal(found.found?.by, "tree", "for free: the tree names it");
  assert.equal(spy.popupCalls, 0);
});

test("at the verdict, sheets stacked on top of each other are all answered, since no planner comes after", async () => {
  const { engine } = phone({
    start: "compose",
    screens: {
      compose: { phash: HOME, next: "promo" },
      promo: { phash: "ffffffffffffffff", taps: [{ at: { x: 330, y: 120 }, to: "rating" }] },
      rating: { phash: "0f0f0f0f0f0f0f0f", taps: [{ at: { x: 180, y: 600 }, to: "sent" }] },
      sent: { phash: NEXT },
    },
    plan: (_state, req) =>
      req.history.length === 0
        ? { actions: [{ name: "tap", describeTarget: "the Send button" }], done: false, provenance: PROVENANCE }
        : { actions: [], done: true, provenance: PROVENANCE },
    popup: (state) =>
      state === "promo"
        ? { found: true, kind: "promo", press: { label: "Close", point: { x: 330, y: 120 } }, provenance: PROVENANCE }
        : state === "rating"
          ? { found: true, kind: "rating", press: { label: "Not now", point: { x: 180, y: 600 } }, provenance: PROVENANCE }
          : { found: false, provenance: PROVENANCE },
    pass: (state) => state === "sent",
  });
  const { result } = await run(engine, SEND);

  assert.equal(result.outcome, "PASS", "the second sheet hid the mark as much as the first");
  assert.equal(result.popups, 2);
});

test("before the test acts, a wait is not failed by a pop-up: whatever comes up while it waits is put out of the way", async () => {
  const WAIT = parseTestFile(`
id: wait
targets: [{ platform: android, app: com.acme }]
steps:
  - id: wait
    do: open the video
    expect: the video is playing
    within: 5s
`);
  const { engine } = phone({
    start: "nag",
    screens: {
      nag: { phash: HOME, taps: [{ at: { x: 180, y: 500 }, to: "video" }] },
      video: { phash: NEXT },
    },
    plan: () => ({ actions: [], done: true, provenance: PROVENANCE }),
    popup: (state) =>
      state === "nag"
        ? { found: true, kind: "other", title: "Software update", press: { label: "Later", point: { x: 180, y: 500 } }, provenance: PROVENANCE }
        : { found: false, provenance: PROVENANCE },
    pass: (state) => state === "video",
  });
  const { result } = await run(engine, WAIT);
  assert.equal(result.outcome, "PASS");
  assert.equal(result.popups, 1);
});

/**
 * A dialog nobody wrote a rule for, in words that say nothing of a failure,
 * from an engine that offers to press it whatever the rules say: whether the
 * test has acted is all that decides.
 */
const unknown = (title: string, label = "OK"): PopupResult => ({
  found: true,
  kind: "other",
  title,
  press: { label, point: { x: 180, y: 500 } },
  provenance: PROVENANCE,
});
const NONE: PopupResult = { found: false, provenance: PROVENANCE };

test("before the test acts, a dialog of no known kind the planner names is closed", async () => {
  const asked: PopupRequest[] = [];
  const { engine } = phone({
    start: "update",
    screens: {
      update: { phash: "ffffffffffffffff", taps: [{ at: { x: 180, y: 500 }, to: "home" }] },
      home: { phash: HOME, next: "chat" },
      chat: { phash: NEXT },
    },
    plan: (state, req) =>
      state === "update" && req.popups
        ? { actions: [], done: false, popup: { kind: "other", title: "Software update" }, provenance: PROVENANCE }
        : state === "home"
          ? { actions: [{ name: "tap", describeTarget: "Ada in the chat list" }], done: false, provenance: PROVENANCE }
          : { actions: [], done: true, provenance: PROVENANCE },
    popup: (state, req) => {
      asked.push(req);
      return state === "update" ? unknown("Software update", "Later") : NONE;
    },
    pass: (state) => state === "chat",
  });
  const { result, popups } = await run(engine, OPEN);

  assert.equal(result.outcome, "PASS", result.detail);
  assert.equal(popups.length, 1);
  assert.match(popups[0]!.message, /a pop-up \("Software update"\) -- pressed "Later"/);
  assert.equal(asked[0]?.rules.other, "dismiss", "nothing has been done yet: it cannot be the app's answer to anything");
});

test("before the test acts, a dialog of no known kind over the expectation is closed at the verdict", async () => {
  const HOME_SHOWS = parseTestFile(`
id: home-shows
targets: [{ platform: android, app: com.acme }]
steps:
  - id: home
    expect: the home screen is showing
`);
  const asked: PopupRequest[] = [];
  const { engine } = phone({
    start: "update",
    screens: {
      update: { phash: "ffffffffffffffff", taps: [{ at: { x: 180, y: 500 }, to: "home" }] },
      home: { phash: HOME },
    },
    popup: (state, req) => {
      asked.push(req);
      return state === "update" ? unknown("Software update", "Later") : NONE;
    },
    pass: (state) => state === "home",
  });
  const { result } = await run(engine, HOME_SHOWS);

  assert.equal(result.outcome, "PASS", result.detail);
  assert.equal(result.popups, 1);
  assert.equal(asked[0]?.rules.other, "dismiss");
});

/**
 * Pay is tapped, and the app answers with a dialog whose OK leaves a checkout
 * with no error on it. `named`: whether the planner names the dialog.
 */
function payAndAnswer(named: boolean) {
  const asked: PopupRequest[] = [];
  const { engine, spy } = phone({
    start: "checkout",
    screens: {
      checkout: { phash: HOME, next: "funds" },
      funds: { phash: "ffffffffffffffff", taps: [{ at: { x: 180, y: 500 }, to: "checkout" }] },
    },
    plan: (state, req) =>
      state === "checkout"
        ? { actions: [{ name: "tap", describeTarget: "the Pay button" }], done: false, provenance: PROVENANCE }
        : named && req.popups
          ? { actions: [], done: false, popup: { kind: "other", title: "Insufficient funds" }, provenance: PROVENANCE }
          : { actions: [], done: true, provenance: PROVENANCE },
    popup: (state, req) => {
      asked.push(req);
      return state === "funds" ? unknown("Insufficient funds") : NONE;
    },
    pass: (state) => state !== "funds",
  });
  return { engine, spy, asked };
}

test("once the test has acted, a dialog of no known kind the planner names is left alone, and left for the verdict", async () => {
  const TAP_PAY = parseTestFile(`
id: tap-pay
targets: [{ platform: android, app: com.acme }]
steps:
  - id: pay
    do: tap Pay
    expect: no error message is shown
`);
  const { engine, spy, asked } = payAndAnswer(true);
  const { result, events } = await run(engine, TAP_PAY);

  assert.equal(result.outcome, "FAIL_ASSERT", "pressing OK would have made \"no error message is shown\" true");
  assert.equal(result.popups, 0);
  assert.equal(spy.state, "funds", "the dialog is still on screen for the verdict to see");
  assert.equal(asked[0]?.hint?.kind, "other", "the first look was at the planner's report");
  assert.ok(asked.length >= 2, "and the look before the verdict came after it");
  assert.ok(asked.every((req) => req.rules.other === "off"), "no look after acting may close it");
  assert.ok(events.some((event) => event.message === "a pop-up is up after the test acted; with no rule for it, it may be the app's answer, so it is left alone"));
});

test("once the test has acted, a wait leaves a dialog of no known kind alone", async () => {
  const WAIT_PAY = parseTestFile(`
id: wait-pay
targets: [{ platform: android, app: com.acme }]
steps:
  - id: pay
    do: tap Pay
    expect: no error message is shown
    within: 3s
`);
  const { engine, spy, asked } = payAndAnswer(false);
  const { result } = await run(engine, WAIT_PAY);

  assert.equal(result.outcome, "FAIL_ASSERT");
  assert.match(result.detail, /did not hold within 3 s/);
  assert.equal(result.popups, 0);
  assert.equal(spy.state, "funds");
  assert.equal(asked[0]?.hint, undefined, "the planner never named it: the wait's own look found it");
  assert.ok(asked.every((req) => req.rules.other === "off"));
});

test("the phone's own account raised after a press is answered from the tree before the agent plans again", async () => {
  // An iPhone SE mid-test: the agent pressed Not Now itself, as a plan,
  // a grounding and a check -- 42 s -- and the press went into the memory.
  const VERIFY: TreeNode[] = [
    node({
      role: "Alert",
      label: "Apple Account Verification",
      children: [
        node({ role: "Button", label: "Not Now", bounds: { x: 30, y: 440, width: 150, height: 50 }, interactive: true }),
        node({ role: "Button", label: "Settings", bounds: { x: 190, y: 440, width: 150, height: 50 }, interactive: true }),
      ],
    }),
  ];
  const { engine, spy } = phone({
    start: "home",
    tree: true,
    platform: "ios",
    screens: {
      home: { phash: HOME, tree: [CONTINUE], taps: [{ at: { x: 180, y: 596 }, to: "verify" }] },
      verify: { phash: "ffffffffffffffff", tree: VERIFY, taps: [{ at: { x: 105, y: 465 }, to: "next" }] },
      next: { phash: NEXT, tree: [] },
    },
    plan: (state, req) =>
      state === "home" && req.history.length === 0
        ? { actions: [{ name: "tap", describeTarget: "the Continue button" }], done: false, provenance: PROVENANCE }
        : { actions: [], done: true, provenance: PROVENANCE },
    pass: (state) => state === "next",
  });
  const { result, popups } = await run(engine, PRESS);
  assert.equal(result.outcome, "PASS", result.detail);
  assert.equal(popups.length, 1);
  assert.equal(popups[0]?.data?.by, "tree");
  assert.ok(!spy.plans.some((req) => req.observation.frame.bytes.toString() === "verify"), "the planner never saw the prompt");
  assert.equal(spy.popupCalls, 0, "no model asked about it");
});
