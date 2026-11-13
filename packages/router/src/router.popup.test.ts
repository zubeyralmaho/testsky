import assert from "node:assert/strict";
import test from "node:test";

import type { Observation, PopupRules } from "@testsky/engine-core";
import { fixtureScreen } from "@testsky/perception";

import { Router } from "./router.ts";

const FRAME = (await fixtureScreen()).png;

/** The shared defaults, spelled out: the router takes rules, it does not own them. */
const DEFAULT_POPUP_RULES: PopupRules = {
  notifications: "deny",
  location: "allow",
  camera: "allow",
  tracking: "deny",
  rating: "dismiss",
  promo: "dismiss",
  account: "dismiss",
  cookies: "deny",
  other: "dismiss",
};

function observation(): Observation {
  return {
    frame: { bytes: FRAME, capturedAt: 0, size: { width: 360, height: 720 }, pixelRatio: 3 },
    visionBlind: false,
    visionStats: { meanLuma: 100, stdLuma: 30, uniqueColors: 90 },
    signature: { phash: "abc", maskedRegions: [] },
    appContext: {},
    observedAt: Date.now(),
  };
}

/** Answers every call with `answer`, and keeps what was asked. */
function stubModel(answer: unknown): { asked: string[]; restore: () => void } {
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: { role: string; content: string | { type: string; text?: string }[] }[] };
    const user = body.messages.find((message) => message.role === "user")!.content;
    asked.push(typeof user === "string" ? user : user.map((part) => part.text ?? "").join("\n"));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return { asked, restore: () => { globalThis.fetch = original; } };
}

const CONFIG = { tiers: { ground: { baseUrl: "http://stub/v1", model: "cheap" }, reason: { baseUrl: "http://stub/v1", model: "better" } } };

test("a pop-up is found, named, and pressed where the rule says, in device points", async () => {
  const stub = stubModel({ popup: true, kind: "rating", title: "Enjoying Chats?", button: "Not now", point: [500, 750] });
  try {
    const router = new Router(CONFIG);
    const found = await router.popup({ observation: observation(), goal: "send a message to Ada", rules: DEFAULT_POPUP_RULES });
    assert.equal(found.found, true);
    assert.equal(found.kind, "rating");
    assert.equal(found.title, "Enjoying Chats?");
    assert.deepEqual(found.press, { label: "Not now", point: { x: 180, y: 540 } });

    const asked = stub.asked[0]!;
    assert.match(asked, /send a message to Ada/, "the goal is there, so a sheet the step opened is not taken for one in its way");
    assert.match(asked, /rating -- a request to rate or review the app: press the control that closes it/);
    assert.match(asked, /notifications -- .*: press the control that declines/);
    assert.equal(router.ledger.all()[0]?.purpose, "popup");
    assert.equal(router.ledger.all()[0]?.model, "better", "telling what is in the way is judgement, not grounding");
  } finally {
    stub.restore();
  }
});

test("a tip with nothing on it to close it is closed by a tap on empty background, and the answer says so", async () => {
  const stub = stubModel({ popup: true, kind: "promo", title: "Now you can swipe or tap to dismiss your alarm", button: "outside the tip", point: [500, 600], outside: true });
  try {
    const found = await new Router(CONFIG).popup({ observation: observation(), rules: DEFAULT_POPUP_RULES });
    assert.deepEqual(found.press, { label: "outside the tip", point: { x: 180, y: 432 }, outside: true });
    assert.match(stub.asked[0]!, /promo -- .*: press the control that closes it .* or, for a tip or callout .* tap empty background outside it, away from every control/);
  } finally {
    stub.restore();
  }
});

test("a kind the rules leave to the test is named but never pressed, whatever the model points at", async () => {
  const stub = stubModel({ popup: true, kind: "notifications", button: "Allow", point: [700, 600] });
  try {
    const router = new Router(CONFIG);
    const found = await router.popup({
      observation: observation(),
      rules: { ...DEFAULT_POPUP_RULES, notifications: "off" },
    });
    assert.equal(found.kind, "notifications");
    assert.equal(found.press, undefined);
    assert.match(stub.asked[0]!, /notifications -- .*: leave it/);
  } finally {
    stub.restore();
  }
});

test("nothing in the way is nothing, and a kind the model made up is read as anything else", async () => {
  let stub = stubModel({ popup: false });
  try {
    assert.equal((await new Router(CONFIG).popup({ observation: observation(), rules: DEFAULT_POPUP_RULES })).found, false);
  } finally {
    stub.restore();
  }
  stub = stubModel({ popup: true, kind: "newsletter", button: "No thanks", point: [500, 500] });
  try {
    const found = await new Router(CONFIG).popup({ observation: observation(), rules: DEFAULT_POPUP_RULES });
    assert.equal(found.kind, "other");
    assert.equal(found.press?.label, "No thanks");
  } finally {
    stub.restore();
  }
});

test("the planner is asked to name a pop-up only when the executor will answer it", async () => {
  const stub = stubModel({ actions: [], done: false, popup: { kind: "promo", title: "What's new in 4.12" } });
  try {
    const router = new Router(CONFIG);
    const request = {
      observation: observation(),
      goal: "open the chat with Ada",
      history: [],
      actionSpace: ["tap" as const],
      budget: { maxUsd: 1, maxLatencyMs: 10_000, maxEscalations: 0 },
    };
    const flagged = await router.plan({ ...request, popups: true });
    assert.deepEqual(flagged.popup, { kind: "promo", title: "What's new in 4.12" });
    assert.match(stub.asked[0]!, /do not act on it/);

    const unflagged = await router.plan(request);
    assert.equal(unflagged.popup, undefined, "a planner not asked about pop-ups has not named one");
    assert.doesNotMatch(stub.asked[1]!, /do not act on it/);
  } finally {
    stub.restore();
  }
});

test("an echo of the answer template names no pop-up", async () => {
  const request = {
    observation: observation(),
    goal: "open the chat with Ada",
    history: [],
    actionSpace: ["tap" as const],
    budget: { maxUsd: 1, maxLatencyMs: 10_000, maxEscalations: 0 },
    popups: true,
  };
  for (const echoed of [{}, { kind: "notifications|location|camera|tracking|rating|promo|cookies|other" }, { kind: null }]) {
    const stub = stubModel({ actions: [{ name: "tap", describeTarget: "Ada" }], done: false, popup: echoed });
    try {
      const plan = await new Router(CONFIG).plan(request);
      assert.equal(plan.popup, undefined, `${JSON.stringify(echoed)} is not a pop-up`);
      assert.equal(plan.actions[0]?.describeTarget, "Ada", "and the step's own action stands");
    } finally {
      stub.restore();
    }
  }
});

test("the app's own answer -- an error, a warning, not responding -- is never offered up as a pop-up", async () => {
  const stub = stubModel({ popup: false });
  try {
    await new Router(CONFIG).popup({ observation: observation(), goal: "tap Pay, then check that no error message is shown", rules: DEFAULT_POPUP_RULES });
    assert.match(stub.asked[0]!, /Nor is an error, a warning, a confirmation of what the test just did, or the system saying the app stopped or is not responding/);
    assert.match(stub.asked[0]!, /no error message is shown/, "the expectation travels with the question");
  } finally {
    stub.restore();
  }
});
