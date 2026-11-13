import assert from "node:assert/strict";
import test from "node:test";

import { modelPointToDevice } from "./router.ts";

const PHONE = { width: 384, height: 832 };

test("a normalised answer becomes device points, whatever the phone's density", () => {
  // The centre of the screen is the centre of the screen on a 2x and a 3x.
  assert.deepEqual(modelPointToDevice({ x: 500, y: 500 }, PHONE, 3), { x: 192, y: 416 });
  assert.deepEqual(modelPointToDevice({ x: 500, y: 500 }, PHONE, 2), { x: 192, y: 416 });
  assert.deepEqual(modelPointToDevice({ x: 0, y: 0 }, PHONE, 3), { x: 0, y: 0 });
  assert.deepEqual(modelPointToDevice({ x: 1000, y: 1000 }, PHONE, 3), { x: PHONE.width, y: PHONE.height });
});

test("a model that answered in image pixels anyway still lands", () => {
  // 1080x2400 pixels at 3x is 360x800 points; a pixel answer exceeds 1000 and
  // is divided down instead of being read as a fraction of the screen.
  assert.deepEqual(modelPointToDevice({ x: 1080, y: 2400 }, { width: 360, height: 800 }, 3), { x: 360, y: 800 });
});

test("the bug this exists to prevent: a normalised answer read as pixels", () => {
  // qwen3-vl-plus answers 0-1000. Read as pixels on a 3x phone it lands in the
  // top-left quadrant -- the tap misses, the screen does not change, and the
  // agent concludes the button does not work.
  const asPixels = { x: Math.round(498 / 3), y: Math.round(828 / 3) };
  const correct = modelPointToDevice({ x: 498, y: 828 }, { width: 360, height: 720 }, 3);
  assert.deepEqual(correct, { x: 179, y: 596 });
  assert.notDeepEqual(correct, asPixels);
});
