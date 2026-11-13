import assert from "node:assert/strict";
import test from "node:test";

import type { Observation, TreeNode } from "@testsky/engine-core";
import { fixtureScreen } from "@testsky/perception";

import { BlindScreenError, Router } from "./router.ts";

const FRAME = (await fixtureScreen()).png;

/** Safari on a Google results page: its own address bar at the bottom, the page's search box at the top. */
function results(tree = true): Observation {
  const node = (partial: Partial<TreeNode> & { ref: string }): TreeNode => ({ role: "Other", bounds: { x: 0, y: 0, width: 390, height: 844 }, enabled: true, interactive: false, children: [], ...partial });
  const root = node({
    ref: "root",
    role: "Application",
    label: "Safari",
    children: [
      node({
        ref: "web",
        role: "WebView",
        label: "weather - Google Search",
        bounds: { x: 0, y: 50, width: 390, height: 700 },
        children: [node({ ref: "q", role: "TextField", label: "Search", identifier: "q", interactive: true, bounds: { x: 20, y: 115, width: 300, height: 34 } })],
      }),
      node({ ref: "bar", role: "TextField", label: "Address", identifier: "TabBarItemTitle", interactive: true, bounds: { x: 40, y: 780, width: 310, height: 40 } }),
    ],
  });
  return {
    frame: { bytes: FRAME, capturedAt: 0, size: { width: 390, height: 844 }, pixelRatio: 3 },
    visionBlind: false,
    visionStats: { meanLuma: 100, stdLuma: 30, uniqueColors: 90 },
    signature: { phash: "abc", maskedRegions: [] },
    appContext: {},
    observedAt: Date.now(),
    ...(tree ? { tree: { platform: "ios" as const, capturedAt: 0, source: "xcuitest" as const, truncated: false, captureMs: 1, root } } : {}),
  };
}

/** Answers each call with the next of `answers`, and keeps what was asked, and of which model. */
function stubModel(...answers: unknown[]): { asked: { model: string; text: string; image: boolean }[]; restore: () => void } {
  const asked: { model: string; text: string; image: boolean }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { model: string; messages: { role: string; content: string | { type: string; text?: string }[] }[] };
    const user = body.messages.find((message) => message.role === "user")!.content;
    const parts = typeof user === "string" ? [{ type: "text", text: user }] : user;
    asked.push({ model: body.model, text: parts.map((part) => part.text ?? "").join("\n"), image: parts.some((part) => part.type === "image_url") });
    const answer = answers[Math.min(asked.length - 1, answers.length - 1)];
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return { asked, restore: () => { globalThis.fetch = original; } };
}

const TWO = { tiers: { ground: { baseUrl: "http://stub/v1", model: "cheap" }, reason: { baseUrl: "http://stub/v1", model: "judge" } } };
const THREE = { tiers: { ...TWO.tiers, escalation: { baseUrl: "http://stub/v1", model: "second" } } };
const TYPED = {
  instruction: 'go to the address "https://www.google.com" in the address bar',
  action: "input" as const,
  point: { x: 171, y: 132 },
  meant: "the search box at the top showing 'weather'",
  text: "https://www.google.com",
};

test("the aim is asked of the screen before the action, with the ring and what the tree says is under it", async () => {
  const stub = stubModel({ onTarget: true, reason: "the ring is on the address bar" });
  try {
    const answer = await new Router(TWO).aim({ ...TYPED, observation: results() });
    assert.equal(answer.onTarget, true);
    assert.equal(stub.asked.length, 1);
    const [asked] = stub.asked;
    assert.equal(asked!.model, "judge", "the model that judges");
    assert.ok(asked!.image, "with the marked picture");
    assert.match(asked!.text, /told: "go to the address "https:\/\/www.google.com" in the address bar"/);
    assert.match(asked!.text, /typed "https:\/\/www.google.com" into what it called "the search box at the top showing 'weather'"/);
    assert.match(asked!.text, /the ring is on: TextField "Search" #q, in WebView "weather - Google Search"/);
    assert.doesNotMatch(asked!.text, /Google home page/, "and never the expectation, nor where it led");
    assert.match(asked!.text, /a dialog, alert or tip in the way that has to be closed/, "closing what covers the screen is on the way");
  } finally {
    stub.restore();
  }
});

/** Where Safari's own address bar is, on the 0-1000 scale: the pill at the bottom. */
const BAR: [number, number] = [500, 945];

test("a judge that could not be read leaves the second-look model's off target unconfirmed, not confirmed by itself", async () => {
  // The judge's JSON broke on both asks, so the model kept for second looks
  // gave the first answer: asking it again would be it agreeing with itself.
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const { model } = JSON.parse(init.body) as { model: string };
    asked.push(model);
    const content = model === "judge" ? '{"onTarget": false, "reason": "a search box in the page}' : JSON.stringify({ onTarget: false, named: BAR, reason: "the page's own search field" });
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  try {
    const answer = await new Router(THREE).aim({ ...TYPED, observation: results() });
    assert.equal(answer.onTarget, false);
    assert.equal(answer.confirmed, undefined);
    assert.deepEqual(asked, ["judge", "judge", "second"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("off target takes the named thing seen elsewhere, and two models saying so to be confirmed", async () => {
  const both = stubModel({ onTarget: false, named: BAR, reason: "a search box in the page" }, { onTarget: false, named: BAR, reason: "the page's own search field" });
  try {
    const answer = await new Router(THREE).aim({ ...TYPED, observation: results() });
    assert.equal(answer.onTarget, false);
    assert.equal(answer.confirmed, true);
    assert.equal(answer.reason, "the page's own search field");
    assert.deepEqual(both.asked.map((ask) => ask.model), ["judge", "second"]);
  } finally {
    both.restore();
  }

  const split = stubModel({ onTarget: false, named: BAR, reason: "a search box in the page" }, { onTarget: true, named: BAR, reason: "the address bar" });
  try {
    const answer = await new Router(THREE).aim({ ...TYPED, observation: results() });
    assert.equal(answer.onTarget, true, "one model's word does not take the blame off the app");
    assert.match(answer.reason, /the address bar \(a first look said: a search box in the page\)/);
  } finally {
    split.restore();
  }

  const one = stubModel({ onTarget: false, named: BAR, reason: "a search box in the page" });
  try {
    const answer = await new Router(TWO).aim({ ...TYPED, observation: results(false) });
    assert.equal(answer.onTarget, false, "with one judge there is no second to ask");
    assert.equal(answer.confirmed, undefined, "and nothing to confirm it");
    assert.equal(one.asked.length, 1);
    assert.doesNotMatch(one.asked[0]!.text, /accessibility tree says/, "no tree, nothing said of it");
  } finally {
    one.restore();
  }
});

test("off target is not counted when the named thing is not shown, or is the control under the ring", async () => {
  for (const named of [null, undefined, [440, 156] as [number, number]]) {
    // [440, 156] is the page's search box itself: the ring is on it.
    const stub = stubModel({ onTarget: false, ...(named === undefined ? {} : { named }), reason: "not the address bar" });
    try {
      const answer = await new Router(TWO).aim({ ...TYPED, observation: results() });
      assert.equal(answer.onTarget, true, JSON.stringify(named));
      assert.match(answer.reason, /not counted: the thing the step names was not shown elsewhere/);
    } finally {
      stub.restore();
    }
  }
  // With a tree, the named thing has to be a control: an empty patch of page is not "the address bar elsewhere".
  const blank = stubModel({ onTarget: false, named: [500, 500], reason: "not the address bar" });
  try {
    assert.equal((await new Router(TWO).aim({ ...TYPED, observation: results() })).onTarget, true);
  } finally {
    blank.restore();
  }
  // With no tree to tell controls apart, a place a fingertip away is the same place.
  const near = stubModel({ onTarget: false, named: [460, 165], reason: "beside it" });
  try {
    assert.equal((await new Router(TWO).aim({ ...TYPED, observation: results(false) })).onTarget, true);
  } finally {
    near.restore();
  }
});

test("what the tree says is under the ring is only what is drawn", async () => {
  const sheet = results();
  // A link behind a sheet, at the very point of the ring, that XCUITest still lists.
  sheet.tree!.root.children.unshift({
    ref: "hidden",
    role: "Link",
    label: "Cancel order",
    bounds: { x: 150, y: 120, width: 60, height: 30 },
    enabled: true,
    interactive: true,
    visible: false,
    children: [],
  });
  const stub = stubModel({ onTarget: true, reason: "on the search box" });
  try {
    await new Router(TWO).aim({ ...TYPED, observation: sheet });
    assert.doesNotMatch(stub.asked[0]!.text, /Cancel order/);
    assert.match(stub.asked[0]!.text, /the ring is on: TextField "Search" #q/);
  } finally {
    stub.restore();
  }
});

test("a black frame is not judged", async () => {
  const blind = { ...results(), visionBlind: true };
  await assert.rejects(new Router(TWO).aim({ ...TYPED, observation: blind }), BlindScreenError);
});
