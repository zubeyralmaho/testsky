import assert from "node:assert/strict";
import test from "node:test";

import { AndroidDevice } from "@midscene/android";
import type { Size } from "@testsky/engine-core";
import { Router } from "@testsky/router";

import { AndroidMidsceneEngine, forgetScreenInfo, turned } from "./android.ts";

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test("a frame the other way round from the kept size is a turn, and a square one says nothing", () => {
  assert.equal(turned({ width: 1080, height: 2400 }, { width: 412, height: 915 }), false);
  assert.equal(turned({ width: 2400, height: 1080 }, { width: 412, height: 915 }), true);
  assert.equal(turned({ width: 1080, height: 2400 }, { width: 915, height: 412 }), true);
  assert.equal(turned({ width: 1600, height: 1600 }, { width: 412, height: 915 }), false);
});

test("Android: the screen's size is read once and kept, and read again only once the phone has turned", async () => {
  const engine = new AndroidMidsceneEngine({ router: new Router({ tiers: { ground: { baseUrl: "http://127.0.0.1:1/v1", model: "none" } } }) });
  let reads = 0;
  let landscape = false;
  // Kept the way Midscene keeps it: read on the first call, then until forgotten.
  const device = {
    cachedScreenSize: null as Size | null,
    async size(): Promise<Size> {
      if (!this.cachedScreenSize) {
        reads += 1;
        this.cachedScreenSize = landscape ? { width: 915, height: 412 } : { width: 412, height: 915 };
      }
      return this.cachedScreenSize;
    },
  };
  (engine as unknown as { device: unknown }).device = device;
  const phone = engine as unknown as Record<string, unknown>;
  phone.deviceState = async () => ({ appId: "com.android.settings", locked: false });
  let frame = pngHeader(1080, 2400);
  phone.captureFrame = async () => ({
    bytes: frame,
    stats: { meanLuma: 90, stdLuma: 40, uniqueColors: 9000 },
    blind: false,
    phash: "0f0f0f0f0f0f0f0f",
    at: Date.now(),
  });

  await engine.observe({ tree: false });
  const again = await engine.observe({ tree: false });
  assert.equal(reads, 1);
  assert.deepEqual(again.frame.size, { width: 412, height: 915 });

  landscape = true;
  frame = pngHeader(2400, 1080);
  const sideways = await engine.observe({ tree: false });
  assert.equal(reads, 2);
  assert.deepEqual(sideways.frame.size, { width: 915, height: 412 });
  assert.equal(sideways.frame.pixelRatio, 2400 / 915);

  await engine.observe({ tree: false });
  assert.equal(reads, 2);
});

test("the pinned Midscene keeps the screen's size, rotation and tap scale in the fields a turn forgets", () => {
  const device = new AndroidDevice("not-a-phone", { autoDismissKeyboard: true });
  const kept = device as unknown as Record<string, unknown>;
  for (const field of ["cachedScreenSize", "cachedOrientation", "cachedAdjustScale"]) assert.ok(field in kept, `${field} is not on Midscene's AndroidDevice`);
  kept.cachedScreenSize = { physical: "1080x2400", override: "", orientation: 0, isCurrentOrientation: false };
  kept.cachedOrientation = 0;
  kept.cachedAdjustScale = { x: 0.38, y: 0.38 };
  forgetScreenInfo(device);
  assert.deepEqual([kept.cachedScreenSize, kept.cachedOrientation, kept.cachedAdjustScale], [null, null, null]);
});
