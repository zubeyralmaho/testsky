import assert from "node:assert/strict";
import test from "node:test";

import { Router } from "@testsky/router";

import { AndroidMidsceneEngine } from "./android.ts";

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test("Android: a screen uiautomator will not dump -- a playing video -- is judged from its frame, and the tree is left alone for a while", async () => {
  const engine = new AndroidMidsceneEngine({ router: new Router({ tiers: { ground: { baseUrl: "http://127.0.0.1:1/v1", model: "none" } } }) });
  let dumps = 0;
  (engine as unknown as { device: unknown }).device = {
    size: async () => ({ width: 360, height: 800 }),
    getUITree: async () => {
      dumps += 1;
      throw new Error("'uiautomator dump --compressed /sdcard/midscene_window_dump.xml' timed out after 5000ms");
    },
  };
  const phone = engine as unknown as Record<string, unknown>;
  phone.deviceState = async () => ({ appId: "com.google.android.youtube", locked: false });
  phone.captureFrame = async () => ({
    bytes: pngHeader(1080, 2400),
    stats: { meanLuma: 90, stdLuma: 40, uniqueColors: 9000 },
    blind: false,
    phash: "0f0f0f0f0f0f0f0f",
    at: Date.now(),
  });

  const first = await engine.observe({ tree: true });
  assert.equal(first.tree, undefined);
  assert.equal(first.appContext.appId, "com.google.android.youtube");
  assert.equal(first.frame.pixelRatio, 3);

  const second = await engine.observe({ tree: true });
  assert.equal(second.tree, undefined);
  assert.equal(dumps, 1, "a tree that just timed out is not asked for again at once");
});

test("Android: after a press, settling waits for the press's answer before taking two still frames for it", async () => {
  const engine = new AndroidMidsceneEngine({ router: new Router({ tiers: { ground: { baseUrl: "http://127.0.0.1:1/v1", model: "none" } } }) });
  (engine as unknown as { device: unknown }).device = { size: async () => ({ width: 360, height: 800 }), getUITree: async () => ({}) };
  const phone = engine as unknown as Record<string, unknown>;
  phone.deviceState = async () => ({ appId: "com.android.settings", locked: false });
  // The app answers on the fourth frame: the three before it are the screen the press was made on.
  let frames = 0;
  phone.captureFrame = async () => {
    frames += 1;
    return { bytes: pngHeader(1080, 2400), stats: { meanLuma: 90, stdLuma: 40, uniqueColors: 9000 }, blind: false, phash: frames < 4 ? "0000000000000000" : "ffffffffffffffff", at: Date.now() };
  };
  const late = await engine.observe({ settle: true, settleMs: 3000, changedFrom: "0000000000000000" });
  assert.equal(late.signature.phash, "ffffffffffffffff", "the answer, not two still frames of the screen before it");

  frames = 0;
  const unchanged = await engine.observe({ settle: true, settleMs: 3000 });
  assert.equal(unchanged.signature.phash, "0000000000000000", "with nothing to wait for, two still frames are still at rest");
});
