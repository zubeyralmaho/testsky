/**
 * A frame with a ring drawn where an action went.
 *
 * A model asked "is this what the step names?" about a point given only as
 * numbers reads the numbers against its own idea of the screen; a ring on the
 * picture is the point itself. Drawn in the image's own pixels, from a point
 * in device points.
 */

import sharp from "sharp";

import type { Point, Size } from "@testsky/engine-core";

export async function markPoint(bytes: Buffer, point: Point, size: Size): Promise<Buffer> {
  const image = sharp(bytes);
  const { width = 0, height = 0 } = await image.metadata();
  if (!width || !height || !size.width || !size.height) return bytes;
  const x = Math.round((point.x * width) / size.width);
  const y = Math.round((point.y * height) / size.height);
  // A fingertip on the screen: about a twentieth of its narrow side across.
  const radius = Math.max(12, Math.round(Math.min(width, height) * 0.035));
  const stroke = Math.max(3, Math.round(radius / 4));
  const ring =
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
    `<circle cx="${x}" cy="${y}" r="${radius}" fill="none" stroke="#ff0033" stroke-width="${stroke}"/>` +
    `<circle cx="${x}" cy="${y}" r="${Math.max(2, Math.round(stroke / 2))}" fill="#ff0033"/>` +
    `</svg>`;
  return image.composite([{ input: Buffer.from(ring), top: 0, left: 0 }]).png().toBuffer();
}
