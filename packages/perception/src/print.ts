/**
 * A frame's pixels, decoded: what a print of a picture is taken over.
 *
 * Not the encoded bytes -- two encodings of the same pixels are the same
 * picture, and a model shown either sees the same thing. The size goes in
 * first, so that two screens whose pixels happen to line up are not one.
 *
 * Rows can be left out from the top, where the status bar's clock and battery
 * make every minute a new picture of the same screen; the size line says how
 * many, so that a print taken without them is never one taken with them.
 */

import sharp from "sharp";

/**
 * How far down a status bar's clock and battery reach, as a share of the
 * frame's height. Measured on six phones, an iPhone SE to a Pura 70: the clock
 * ends by 4.1% (an iPhone 12 mini's) and the app's own content starts at 5.4%
 * at the earliest (the SE's navigation bar). A share rather than points: the
 * taller the screen, the taller its status bar.
 */
export const STATUS_BAR_SHARE = 0.05;

export async function framePixels(bytes: Buffer, skipTop = 0): Promise<Buffer | undefined> {
  if (!bytes.length) return undefined;
  try {
    const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const rows = Math.round(info.height * skipTop);
    const size = rows ? `${info.width}x${info.height} from row ${rows}` : `${info.width}x${info.height}`;
    return Buffer.concat([Buffer.from(`${size}\n`), data.subarray(rows * info.width * info.channels)]);
  } catch {
    return undefined;
  }
}
