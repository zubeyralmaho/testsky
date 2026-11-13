import assert from "node:assert/strict";
import test from "node:test";

import type { Observation } from "@testsky/engine-core";
import { Router } from "@testsky/router";

import { AndroidMidsceneEngine } from "./android.ts";
import { IosMidsceneEngine } from "./ios.ts";

const SEEN: Observation = {
  frame: { bytes: Buffer.alloc(0), capturedAt: 0, size: { width: 360, height: 800 }, pixelRatio: 3 },
  visionBlind: false,
  visionStats: { meanLuma: 120, stdLuma: 40, uniqueColors: 9000 },
  signature: { phash: "aaaaaaaaaaaaaaaa", maskedRegions: [] },
  appContext: {},
  observedAt: Date.now(),
};

/** A device that writes down what it was asked to do, in order. */
function recordingDevice() {
  const calls: string[] = [];
  return {
    calls,
    device: {
      size: async () => ({ width: 360, height: 800 }),
      inputPrimitives: {
        pointer: { tap: async (at: { x: number; y: number }) => void calls.push(`tap ${at.x},${at.y}`) },
        keyboard: {
          clearInput: async () => void calls.push("clear"),
          typeText: async (text: string) => void calls.push(`type ${text}`),
          keyboardPress: async (key: string) => void calls.push(`key ${key}`),
        },
      },
    },
  };
}

for (const [platform, Engine] of [
  ["Android", AndroidMidsceneEngine],
  ["iOS", IosMidsceneEngine],
] as const) {
  test(`${platform}: a field holds exactly what is typed -- what was in it goes first, unless the step adds to it`, async () => {
    const engine = new Engine({ router: new Router({ tiers: { ground: { baseUrl: "http://127.0.0.1:1/v1", model: "none" } } }) });
    const { device, calls } = recordingDevice();
    (engine as unknown as { device: unknown }).device = device;

    await engine.act({ name: "input", target: { x: 100, y: 200 }, params: { value: "hello" }, decidedFrom: SEEN });
    assert.deepEqual(calls, ["tap 100,200", "clear", "type hello"]);

    calls.length = 0;
    await engine.act({ name: "input", target: { x: 100, y: 200 }, params: { value: " world", append: true }, decidedFrom: SEEN });
    // Android puts the caret where the tap landed; the text goes at the end.
    assert.deepEqual(calls, platform === "Android" ? ["tap 100,200", "key End", "type  world"] : ["tap 100,200", "type  world"]);
  });
}

for (const [platform, Engine] of [
  ["Android", AndroidMidsceneEngine],
  ["iOS", IosMidsceneEngine],
] as const) {
  test(`${platform}: a swipe goes through on a screen a video keeps moving, and a back press decided on another frame does not`, async () => {
    const engine = new Engine({ router: new Router({ tiers: { ground: { baseUrl: "http://127.0.0.1:1/v1", model: "none" } } }) });
    const swipes: string[] = [];
    (engine as unknown as { device: unknown }).device = {
      size: async () => ({ width: 360, height: 800 }),
      inputPrimitives: {
        touch: {
          swipe: async (from: { y: number }, to: { y: number }, opts: { duration: number }) => void swipes.push(`${from.y} -> ${to.y} in ${opts.duration} ms`),
        },
      },
    };
    // Every frame now is far from the one decided on, as on a playing video.
    (engine as unknown as Record<string, unknown>).captureFrame = async () => ({
      bytes: Buffer.alloc(0),
      stats: SEEN.visionStats,
      blind: false,
      phash: "5555555555555555",
      at: Date.now(),
    });
    const decidedFrom: Observation = { ...SEEN, observedAt: Date.now() - 10_000 };
    const staleGuard = { maxAgeMs: 2500, maxPhashDistance: 6 };

    const swipe = await engine.act({ name: "swipe", params: { direction: "down" }, decidedFrom, staleGuard });
    assert.equal(swipe.stale, false);
    // A flick for a page to turn on, and a drag that stops for a list to be read.
    const scroll = await engine.act({ name: "scroll", params: { direction: "down" }, decidedFrom, staleGuard });
    assert.equal(scroll.stale, false);
    assert.deepEqual(swipes, ["400 -> 80 in 300 ms", "400 -> 80 in 1000 ms"]);

    const back = await engine.act({ name: "back", decidedFrom, staleGuard });
    assert.equal(back.stale, true);
  });
}
