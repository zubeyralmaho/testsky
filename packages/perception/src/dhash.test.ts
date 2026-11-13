import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import { dhash, hamming, patchHash, spotMoved } from "./dhash.ts";
import { fixtureScreen } from "./fixture.ts";

const solid = (r: number, g: number, b: number) =>
  sharp({ create: { width: 128, height: 256, channels: 3, background: { r, g, b } } }).png().toBuffer();

test("the same screen hashes the same, twice", async () => {
  const { png } = await fixtureScreen();
  assert.equal(await dhash(png), await dhash(png));
  assert.equal((await dhash(png)).length, 16); // 64 bits, hex
});

test("re-encoding and a small repaint do not move it much", async () => {
  const { png } = await fixtureScreen();
  // A JPEG round trip stands in for the noise a device screenshot carries.
  const noisy = await sharp(png).jpeg({ quality: 70 }).toBuffer().then((b) => sharp(b).png().toBuffer());
  assert.ok(hamming(await dhash(png), await dhash(noisy)) <= 4, "a repaint should not read as a new screen");
});

test("a different screen is a different hash", async () => {
  const { png } = await fixtureScreen();
  const blank = await solid(240, 240, 240);
  assert.ok(hamming(await dhash(png), await dhash(blank)) > 10);
});

test("hamming counts differing bits, and refuses to compare unlike hashes", () => {
  assert.equal(hamming("ffff", "ffff"), 0);
  assert.equal(hamming("0000", "000f"), 4);
  assert.equal(hamming("ffff", "fff"), 64);
});

test("the status bar is ignored, so a ticking clock is not a new screen", async () => {
  const { png } = await fixtureScreen();
  const meta = await sharp(png).metadata();
  // Paint something different across the top strip: a clock going from 9:41 to
  // 9:42 is a smaller change than this, and even this must not register.
  const withBadge = await sharp(png)
    .composite([
      {
        input: {
          create: { width: meta.width!, height: Math.round(meta.height! * 0.03), channels: 3, background: { r: 255, g: 0, b: 0 } },
        },
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();

  assert.equal(await dhash(png), await dhash(withBadge), "masked away");
  // And the mask is really applied, rather than the change being too small to
  // register either way: hashing the whole image gives a different answer.
  assert.notEqual(await dhash(png), await dhash(png, { maskTopFraction: 0 }));
});

test("a patch hash follows the pixels around a point, and clamps at the edges", async () => {
  const { png, size, pixelRatio, target } = await fixtureScreen();
  const frame = { size, pixelRatio };
  const centre = { x: target.x + target.width / 2, y: target.y + target.height / 2 };

  const onButton = await patchHash(png, centre, frame);
  const again = await patchHash(png, centre, frame);
  assert.equal(onButton, again, "the same pixels hash the same");

  // Somewhere empty looks nothing like the button.
  const onBackground = await patchHash(png, { x: 180, y: 300 }, frame);
  assert.ok(hamming(onButton!, onBackground!) > 8, "a different neighbourhood is a different hash");

  // A point in the corner still answers rather than failing.
  assert.ok(await patchHash(png, { x: 0, y: 0 }, frame));
  assert.ok(await patchHash(png, { x: size.width, y: size.height }, frame));
});

test("an aimed action's spot moves only when what is under it does", async () => {
  const screen = async (blocks: { left: number; top: number; side: number; shade: number }[]) =>
    sharp({ create: { width: 360, height: 720, channels: 3, background: { r: 240, g: 240, b: 240 } } })
      .composite(
        blocks.map((block) => ({
          input: { create: { width: block.side, height: block.side, channels: 3, background: { r: block.shade, g: block.shade, b: block.shade } } },
          left: block.left,
          top: block.top,
        })),
      )
      .png()
      .toBuffer();
  const frame = { size: { width: 360, height: 720 }, pixelRatio: 1 };
  // A search icon at the top right, smaller than the spot around it.
  const icon = { left: 324, top: 64, side: 32, shade: 30 };
  const before = await screen([icon, { left: 40, top: 400, side: 120, shade: 20 }]);
  // A video below plays on: its frame is another picture, the icon is where it was.
  const playing = await screen([icon, { left: 40, top: 400, side: 120, shade: 200 }, { left: 160, top: 520, side: 120, shade: 90 }]);
  assert.equal(await spotMoved(before, playing, { x: 340, y: 80 }, frame), false);
  // The page scrolled: the icon is not under the spot any more.
  const scrolled = await screen([{ ...icon, top: 184 }, { left: 40, top: 400, side: 120, shade: 20 }]);
  assert.equal(await spotMoved(before, scrolled, { x: 340, y: 80 }, frame), true);
  assert.equal(await spotMoved(Buffer.alloc(0), playing, { x: 340, y: 80 }, frame), true, "a spot that cannot be read has moved");
});
