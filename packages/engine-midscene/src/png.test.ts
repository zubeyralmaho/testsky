import assert from "node:assert/strict";
import test from "node:test";

import { pngSize } from "./png.ts";

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test("reads the pixel size a device screenshot reports", () => {
  assert.deepEqual(pngSize(pngHeader(1080, 2400)), { width: 1080, height: 2400 });
});

test("anything that is not a PNG says so, instead of returning nonsense", () => {
  // Silently returning zeros here would put every later tap at the top-left
  // corner, which is a far worse day than a clear error.
  assert.throws(() => pngSize(Buffer.from("not a png at all, really")), /expected a PNG screenshot/);
});
