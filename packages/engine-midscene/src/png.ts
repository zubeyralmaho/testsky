/**
 * The pixel size of a PNG, read from its header.
 *
 * We need it to convert a model's pixel answer back into device points, and a
 * full image decoder is a heavy dependency to carry for eight bytes. The IHDR
 * chunk is always first and always at the same offset.
 */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  const signature = bytes.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") {
    throw new Error("expected a PNG screenshot from the device");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * The pixel size of a PNG or a JPEG: a JPEG says it in its frame header, the
 * first SOF marker, after whatever segments come before it. testsky's own
 * Android agent sends JPEGs; Midscene's screenshots are PNGs.
 */
export function imageSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.length >= 24 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return pngSize(bytes);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("expected a PNG or JPEG screenshot from the device");
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) break;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // SOF0-SOF15 carry the size; C4, C8 and CC are other tables that share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  throw new Error("a JPEG screenshot with no frame header");
}
