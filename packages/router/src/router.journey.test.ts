import assert from "node:assert/strict";
import test from "node:test";

import type { Observation } from "@testsky/engine-core";
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

/** What the planner is sent, captured, and answered with a swipe. */
async function planned(journey?: { test: string; done: string[] }): Promise<string> {
  let sent = "";
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent = init.body;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ actions: [{ name: "swipe" }], done: false }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  try {
    const router = new Router({ tiers: { ground: { baseUrl: "http://127.0.0.1:1/v1", model: "planner" } } }, new CostLedger());
    await router.plan({
      observation: observation(),
      goal: 'open the general settings section, the row labelled "Genel"',
      history: [{ action: "tap", description: "the row labelled Genel", outcome: "not found on this screen -- the list starts with Arama" }],
      ...(journey ? { journey } : {}),
      actionSpace: ["tap", "swipe"],
      budget: { maxUsd: 1, maxLatencyMs: 30_000, maxEscalations: 1 },
    });
  } finally {
    globalThis.fetch = original;
  }
  return sent;
}

test("the planner is told the steps before its own, and what this step already tried", async () => {
  const sent = await planned({
    test: "Move around the Settings app",
    done: ["check: a Settings screen is visible", "scroll further down the settings list (then: setting categories are visible)"],
  });
  assert.match(sent, /This goal is one step of a test, \\"Move around the Settings app\\"/);
  assert.match(sent, /2\. scroll further down the settings list/);
  assert.doesNotMatch(sent, /still to come|after this one/, "never the steps after it: a planner shown the next step starts on it");
  assert.match(sent, /not found on this screen -- the list starts with Arama/, "and what this step already tried");
});

test("without a test around it, the prompt is as it was", async () => {
  assert.doesNotMatch(await planned(), /one step of a test/);
});

test("the planner is told to do what the goal says to the letter: its names, its text, nothing more", async () => {
  const sent = JSON.parse(await planned()) as { messages: { role: string; content: unknown }[] };
  const user = sent.messages.find((message) => message.role === "user")!;
  const text = typeof user.content === "string" ? user.content : (user.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("\n");
  assert.match(text, /Do what the goal says, to the letter, and nothing it does not ask for/);
  assert.match(text, /A sign-in page is not yours to get past unless the goal says to sign in/, "an agent used a saved password to sign a phone into a test account");
  assert.match(text, /A name the goal puts in quotes is the element's name:\n  copy it exactly, quotes and all/);
  assert.match(text, /Type exactly the text the goal gives, character for character/);
  assert.match(text, /A password field's value in the tree, dots such as "••••••••", is what was typed into it/, "an iPhone's picture hides a typed password");
});
