import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import { STATUS_BAR_SHARE, framePixels } from "./print.ts";

async function picture(text: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="720">
    <rect width="100%" height="100%" fill="#f2f4f7"/>
    <text x="20" y="220" font-family="Helvetica" font-size="18" fill="#111827">${text}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

test("the same pixels are the same picture, however they were encoded", async () => {
  const png = await picture("3 items in your cart");
  const webp = await sharp(png).webp({ lossless: true }).toBuffer();
  assert.notDeepEqual(png, webp);
  assert.deepEqual(await framePixels(webp), await framePixels(png));
});

test("one digit is another picture", async () => {
  assert.notDeepEqual(await framePixels(await picture("2 items in your cart")), await framePixels(await picture("3 items in your cart")));
});

test("without the status bar, the clock moving on is the same picture -- and the screen changing is not", async () => {
  const at = (clock: string, text = "3 items in your cart") =>
    sharp(
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="720">
        <rect width="100%" height="100%" fill="#f2f4f7"/>
        <text x="20" y="22" font-family="Helvetica" font-size="16" fill="#111827">${clock}</text>
        <text x="20" y="220" font-family="Helvetica" font-size="18" fill="#111827">${text}</text>
      </svg>`),
    )
      .png()
      .toBuffer();
  assert.notDeepEqual(await framePixels(await at("9:41")), await framePixels(await at("9:42")));
  assert.deepEqual(await framePixels(await at("9:41"), STATUS_BAR_SHARE), await framePixels(await at("9:42"), STATUS_BAR_SHARE));
  assert.notDeepEqual(await framePixels(await at("9:41", "2 items in your cart"), STATUS_BAR_SHARE), await framePixels(await at("9:41"), STATUS_BAR_SHARE));
});

test("bytes that are not a picture have no pixels", async () => {
  assert.equal(await framePixels(Buffer.alloc(0)), undefined);
  assert.equal(await framePixels(Buffer.from("not an image")), undefined);
});
