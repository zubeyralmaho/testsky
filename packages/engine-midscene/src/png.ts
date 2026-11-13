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
