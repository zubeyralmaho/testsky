import assert from "node:assert/strict";
import test from "node:test";

import type { TreeNode, TreeSnapshot } from "@testsky/engine-core";
import { calibrateConfidence, ESCALATE_BELOW, labelOverlap } from "./confidence.ts";

function tree(children: Partial<TreeNode>[]): TreeSnapshot {
  return {
    platform: "android",
    capturedAt: 0,
    source: "uiautomator",
    truncated: false,
    captureMs: 10,
    root: {
      ref: "root",
      role: "FrameLayout",
      bounds: { x: 0, y: 0, width: 384, height: 832 },
      enabled: true,
      interactive: false,
      children: children.map((child, i) => ({
        ref: `n${i}`,
        role: "View",
        bounds: { x: 0, y: 0, width: 100, height: 40 },
        enabled: true,
        interactive: false,
        children: [],
        ...child,
      })),
    },
  };
}

test("a point inside the control we asked for is believed", () => {
  const snapshot = tree([
    { ref: "button", role: "Button", label: "Continue", interactive: true, bounds: { x: 60, y: 560, width: 240, height: 72 } },
  ]);
  const score = calibrateConfidence({ point: { x: 180, y: 596 }, description: "the Continue button", tree: snapshot });
  assert.ok(score > ESCALATE_BELOW, `scored ${score}`);
});

test("a point on the background is not, even when the model sounded sure", () => {
  const snapshot = tree([
    { ref: "button", role: "Button", label: "Continue", interactive: true, bounds: { x: 60, y: 560, width: 240, height: 72 } },
  ]);
  const score = calibrateConfidence({ point: { x: 10, y: 20 }, description: "the Continue button", tree: snapshot });
  assert.ok(score < ESCALATE_BELOW, `scored ${score}`);
});

test("a clickable thing with the wrong name scores in between -- worth a second look", () => {
  const snapshot = tree([
    { ref: "other", role: "Button", label: "Cancel", interactive: true, bounds: { x: 0, y: 0, width: 384, height: 100 } },
  ]);
  const score = calibrateConfidence({ point: { x: 100, y: 50 }, description: "the Continue button", tree: snapshot });
  assert.ok(score > 0 && score < ESCALATE_BELOW, `scored ${score}`);
});

test("with no tree, two samples that agree carry the answer", () => {
  const close = calibrateConfidence({
    point: { x: 180, y: 596 },
    agreementPoint: { x: 186, y: 600 },
    description: "the Continue button",
  });
  const apart = calibrateConfidence({
    point: { x: 180, y: 596 },
    agreementPoint: { x: 40, y: 120 },
    description: "the Continue button",
  });
  assert.ok(close > ESCALATE_BELOW, `agreeing samples scored ${close}`);
  assert.equal(apart, 0, "samples that disagree carry nothing");
});

test("with nothing to check against, the answer is exactly as unexamined as it is", () => {
  assert.equal(calibrateConfidence({ point: { x: 1, y: 1 }, description: "anything" }), 0.5);
});

test("label overlap is crude on purpose, and works in Turkish", () => {
  assert.ok(labelOverlap("the Continue button", "Continue") > 0.9);
  assert.ok(labelOverlap("arama alanı", "Arama Alanı") > 0.9);
  assert.equal(labelOverlap("the Continue button", "Cancel"), 0);
  assert.equal(labelOverlap("", "Continue"), 0);
});

test("an anchor has to identify something, or it is not an anchor", async () => {
  // Found by reading a lock file: a tap's stored anchor was the window itself
  // -- role "Other", the whole 440x956 screen -- and a patch hash of all
  // zeros, because the pixels around the point were flat. Both verify on any
  // screen of the same size, which turns the cache from an optimisation into
  // a way of tapping confidently in the wrong place.
  const { Router } = await import("./router.ts");
  const { fixtureScreen } = await import("@testsky/perception");
  const fixture = await fixtureScreen();

  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ found: true, point: [500, 500] }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof globalThis.fetch;

  try {
    const router = new Router({ tiers: { ground: { baseUrl: "http://stub/v1", model: "stub" } } });
    const result = await router.ground({
      observation: {
        frame: { bytes: fixture.png, capturedAt: 0, size: fixture.size, pixelRatio: fixture.pixelRatio },
        visionBlind: false,
        visionStats: { meanLuma: 200, stdLuma: 30, uniqueColors: 90 },
        signature: { phash: "a", maskedRegions: [] },
        appContext: {},
        observedAt: Date.now(),
        tree: {
          platform: "ios",
          capturedAt: 0,
          source: "xcuitest",
          truncated: false,
          captureMs: 1,
          root: {
            ref: "root",
            role: "Other",
            bounds: { x: 0, y: 0, width: fixture.size.width, height: fixture.size.height },
            enabled: true,
            interactive: false,
            children: [],
          },
        },
      },
      description: "the blue Continue button",
      budget: { maxUsd: 1, maxLatencyMs: 5000, maxEscalations: 0 },
    });

    assert.equal(result.anchor.tree, undefined, "the window is not a target");
    // The fixture's centre is plain background, so the patch is flat and is
    // refused rather than stored as an identity.
    assert.equal(result.anchor.patchPhash, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("a pass that argues with itself is re-judged, not accepted", async () => {
  // From a real run: "The screen's title is 'Ayarlar', but the list includes a
  // row labelled 'Genel', matching the expectation." The step passed. The
  // sentence says it should not have.
  const { Router } = await import("./router.ts");
  const { fixtureScreen } = await import("@testsky/perception");
  const fixture = await fixtureScreen();

  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    asked.push(String(body.messages.at(-1).content?.[0]?.text ?? body.messages.at(-1).content).includes("Judge it yourself") ? "strict" : "first");
    const answer =
      asked.length === 1
        ? { pass: true, reason: "The title is 'Ayarlar', but a row labelled 'Genel' is visible, matching." }
        : { pass: false, reason: "The title is 'Ayarlar'; this is the list, not the General screen." };
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;

  try {
    // One model configured, as most installs run: the re-ask still happens.
    const router = new Router({ tiers: { ground: { baseUrl: "http://stub/v1", model: "cheap" } } });
    const result = await router.assert({
      observation: {
        frame: { bytes: fixture.png, capturedAt: 0, size: fixture.size, pixelRatio: fixture.pixelRatio },
        visionBlind: false,
        visionStats: { meanLuma: 200, stdLuma: 30, uniqueColors: 90 },
        signature: { phash: "a", maskedRegions: [] },
        appContext: {},
        observedAt: Date.now(),
      },
      assertion: 'the screen\'s title is "Genel"',
    });

    assert.deepEqual(asked, ["first", "strict"], "the hedge is put back to the judge, strictly");
    assert.equal(result.pass, false);
    assert.match(result.reason, /not the General screen/);
  } finally {
    globalThis.fetch = original;
  }
});
