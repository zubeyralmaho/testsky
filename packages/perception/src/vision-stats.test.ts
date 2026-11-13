import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import { isVisionBlind, visionStats } from "./vision-stats.ts";

const png = (r: number, g: number, b: number) =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g, b } } }).png().toBuffer();

test("a black capture reads as blind -- a secure screen, or a frame caught mid-render", async () => {
  const stats = await visionStats(await png(0, 0, 0));
  assert.equal(isVisionBlind(stats), true);
  assert.ok(stats.meanLuma < 1);
});

test("a flat white splash also reads as blind: uniform is unreadable whatever its colour", async () => {
  assert.equal(isVisionBlind(await visionStats(await png(255, 255, 255))), true);
});

test("a real screen full of detail does not", async () => {
  // Noise stands in for a screen: many colours, high variance.
  const width = 64;
  const raw = Buffer.alloc(width * width * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 37) % 251;
  const image = await sharp(raw, { raw: { width, height: width, channels: 3 } }).png().toBuffer();
  const stats = await visionStats(image);
  assert.equal(isVisionBlind(stats), false);
  assert.ok(stats.uniqueColors > 8, `only ${stats.uniqueColors} shades`);
});
