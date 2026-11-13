import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import { markPoint } from "./mark.ts";

test("the ring goes where the point is, in the image's own pixels", async () => {
  // A 3x phone: 390x844 points, 1170x2532 pixels, all white.
  const frame = await sharp({ create: { width: 1170, height: 2532, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  const marked = await markPoint(frame, { x: 171, y: 132 }, { width: 390, height: 844 });
  const { data, info } = await sharp(marked).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1170, "same size as the frame");
  const at = (x: number, y: number) => {
    const i = (y * info.width + x) * 3;
    return [data[i], data[i + 1], data[i + 2]];
  };
  assert.deepEqual(at(513, 396), [255, 0, 51], "the dot at 171,132 points is at 513,396 pixels");
  assert.deepEqual(at(100, 2000), [255, 255, 255], "and the rest of the screen is left as it was");
});

test("a frame that cannot be measured is passed on as it was", async () => {
  const frame = Buffer.from("not an image");
  await assert.rejects(markPoint(frame, { x: 1, y: 1 }, { width: 10, height: 10 }));
  const blank = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
  assert.equal(await markPoint(blank, { x: 1, y: 1 }, { width: 0, height: 0 }), blank);
});
