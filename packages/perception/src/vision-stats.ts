/**
 * Whether there is anything in this frame worth showing a model.
 *
 * A vision-language model asked about a black rectangle does not answer "I
 * cannot see"; it describes a plausible screen. So a blank capture is not a
 * missing image, it is a confident wrong answer -- and on a phone blank
 * captures are routine: FLAG_SECURE screens (payment PINs, DRM video, some
 * login screens) come back black by design, and any frame caught mid-animation
 * can come back black by accident.
 *
 * The two are told apart by trying again: a transient black frame resolves in
 * a few hundred milliseconds, a secure screen never does.
 */

import sharp from "sharp";
import type { VisionStats } from "@testsky/engine-core";

/** Thresholds over a 32x32 greyscale downsample. Generous on purpose: a false
 *  "blind" costs one extra capture, a false "readable" costs a wrong answer. */
const DARK_MEAN = 12;
const FLAT_STD = 6;
const FEW_COLOURS = 8;

export async function visionStats(png: Buffer): Promise<VisionStats> {
  const { data } = await sharp(png).greyscale().resize(32, 32, { fit: "fill" }).raw().toBuffer({
    resolveWithObject: true,
  });

  let sum = 0;
  const histogram = new Uint16Array(256);
  for (const value of data) {
    sum += value;
    histogram[value] = (histogram[value] ?? 0) + 1;
  }
  const mean = sum / data.length;

  let variance = 0;
  for (const value of data) variance += (value - mean) ** 2;

  let uniqueColors = 0;
  for (const count of histogram) if (count > 0) uniqueColors += 1;

  return {
    meanLuma: Number(mean.toFixed(2)),
    stdLuma: Number(Math.sqrt(variance / data.length).toFixed(2)),
    uniqueColors,
  };
}

export function isVisionBlind(stats: VisionStats): boolean {
  return (stats.meanLuma < DARK_MEAN && stats.stdLuma < FLAT_STD) || stats.uniqueColors < FEW_COLOURS;
}

/**
 * A screenshot small enough to inline in a report.
 *
 * A phone screenshot is a 400 KB PNG, and a report carries one per step. WebP
 * at 1000px wide keeps every word on the screen legible at a tenth of the
 * size, which is the difference between a report somebody opens and one they
 * wait for.
 */
/**
 * A frame as JPEG, for viewers that take nothing else: Midscene's report reads
 * screenshots as PNG or JPEG only.
 */
export async function toJpeg(png: Buffer, maxWidth = 1000): Promise<Buffer> {
  try {
    return await sharp(png).resize({ width: maxWidth, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
  } catch {
    return png;
  }
}

/** A frame as PNG, whatever it came as: the record keeps every frame as one. Bytes that are not a picture stay as they are. */
export async function toPng(image: Buffer): Promise<Buffer> {
  if (image.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return image;
  try {
    return await sharp(image).png({ compressionLevel: 3 }).toBuffer();
  } catch {
    return image;
  }
}

export async function toWebp(png: Buffer, maxWidth = 1000): Promise<Buffer> {
  try {
    return await sharp(png).resize({ width: maxWidth, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
  } catch {
    return png;
  }
}
