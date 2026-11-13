import assert from "node:assert/strict";
import test from "node:test";

import type { Observation, PlanRequest, PlanResult } from "@testsky/engine-core";
import { fixtureScreen } from "@testsky/perception";

import { CostLedger } from "./ledger.ts";
import { Router } from "./router.ts";

const FRAME = (await fixtureScreen()).png;

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

/** Asks the planner once, answering as `answer`; returns the prompt's words and what was made of the answer. */
async function plan(extra: Partial<PlanRequest>, answer: unknown): Promise<{ prompt: string; result: PlanResult }> {
  let sent = "";
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent = init.body;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  try {
    const router = new Router({ tiers: { ground: { baseUrl: "http://127.0.0.1:1/v1", model: "planner" } } }, new CostLedger());
    const result = await router.plan({
      observation: observation(),
      goal: "forget every saved Wi-Fi network",
      history: [],
      actionSpace: ["tap", "swipe"],
      budget: { maxUsd: 1, maxLatencyMs: 30_000, maxEscalations: 1 },
      ...extra,
    });
    const body = JSON.parse(sent) as { messages: { role: string; content: unknown }[] };
    const user = body.messages.find((message) => message.role === "user")!;
    const prompt = typeof user.content === "string" ? user.content : (user.content as { text?: string }[]).map((part) => part.text ?? "").join("\n");
    return { prompt, result };
  } finally {
    globalThis.fetch = original;
  }
}

const SWIPE = { actions: [{ name: "swipe", params: { direction: "down" } }], done: false };

test("on its first turns the planner is asked what done means, as a state it can see", async () => {
  const { prompt } = await plan({ understand: true }, SWIPE);
  assert.match(prompt, /"doneWhen": "at most 15 words, or null"/);
  assert.match(prompt, /what the screen will show once the goal is done -- a lasting state you can see, not an\n  action/);
  assert.match(prompt, /Say what is there rather than what is not, in the screen's own language/);
  assert.match(prompt, /Quote only words you can see on this screen or that the goal itself quotes/, "never a title it has not seen yet");
  assert.match(prompt, /"last": "as expected\|something else\|nothing"/, "a template that does not put words in its mouth");
  assert.doesNotMatch((await plan({}, SWIPE)).prompt, /doneWhen/, "and not once it has said");
});

test("every turn after, it is handed back what done means and how far it has got", async () => {
  const { prompt } = await plan({ ledger: { doneWhen: "no saved networks are listed", progress: "2 of 5 forgotten" } }, SWIPE);
  assert.match(prompt, /The goal is done when: no saved networks are listed\nProgress so far: 2 of 5 forgotten/);
  assert.match(prompt, /A goal about each or all of\n  several things is done only when none of them is left/);
});

test("the history says what each action was expected to do, beside what it did", async () => {
  const { prompt } = await plan(
    { history: [{ action: "tap", description: '"Forget"', outcome: "the screen changed", expected: "the network leaves the list" }] },
    SWIPE,
  );
  assert.match(prompt, /1\. tap "Forget", expecting: the network leaves the list -> the screen changed/);
});

test("an answer keeps each action's effect, its count and its verdict on the last action", async () => {
  const { result } = await plan(
    { understand: true },
    {
      doneWhen: "  no saved networks\n are listed ",
      last: "as expected",
      actions: [{ name: "tap", describeTarget: "the first saved network", effect: "its page opens" }],
      done: false,
      progress: "1 of 5 forgotten",
    },
  );
  assert.equal(result.doneWhen, "no saved networks are listed");
  assert.equal(result.last, "as expected");
  assert.equal(result.progress, "1 of 5 forgotten");
  assert.deepEqual(result.actions, [{ name: "tap", describeTarget: "the first saved network", effect: "its page opens" }]);
});

test("what an answer says outside what was asked, or not as words, is not kept", async () => {
  const { result } = await plan(
    {},
    { doneWhen: "the list is empty", last: "probably fine", actions: [{ name: "tap", describeTarget: "x", effect: { nested: true } }], done: false, progress: "null" },
  );
  assert.equal(result.doneWhen, undefined, "done-when only when it was asked for");
  assert.equal(result.last, undefined, "a verdict is one of the three, or none");
  assert.equal(result.progress, undefined, "a template's null is no progress");
  assert.deepEqual(result.actions, [{ name: "tap", describeTarget: "x" }], "an effect is words, or nothing");
  const told = await plan({ understand: true }, { doneWhen: "null", actions: [], done: true });
  assert.equal(told.result.doneWhen, undefined, "an agent that says no screen would show it has said nothing to check");
});
