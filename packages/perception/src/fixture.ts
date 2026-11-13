/**
 * A screen we already know the answer to.
 *
 * `testsky doctor` needs to prove more than "the endpoint replied": a model can
 * answer a text question perfectly and still be unable to see an image, and a
 * grounder can return coordinates in the wrong space and be wrong by a factor
 * of three. So doctor asks for a target whose position we know exactly, and
 * checks the answer landed inside it. That single check covers vision support,
 * the JSON contract, and the pixel-to-point conversion at once.
 */

import sharp from "sharp";

import type { Rect } from "@testsky/engine-core";

export interface FixtureScreen {
  png: Buffer;
  /** Logical size, in points, as a device would report it. */
  size: { width: number; height: number };
  pixelRatio: number;
  /** Where the blue button is, in points. */
  target: Rect;
  targetDescription: string;
}

/**
 * A phone-shaped screen: pale background, a dark header, and one blue button
 * low on the page. Deliberately unlike any real app, so a model cannot answer
 * from memory of a screen it has seen before.
 */
export async function fixtureScreen(): Promise<FixtureScreen> {
  const ratio = 3;
  const size = { width: 360, height: 720 };
  const width = size.width * ratio;
  const height = size.height * ratio;
  const target: Rect = { x: 60, y: 560, width: 240, height: 72 };

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#f2f4f7"/>
  <rect width="100%" height="${72 * ratio}" fill="#1f2937"/>
  <text x="${24 * ratio}" y="${46 * ratio}" font-family="Helvetica" font-size="${20 * ratio}" fill="#f9fafb">Doctor check</text>
  <rect x="${24 * ratio}" y="${120 * ratio}" width="${312 * ratio}" height="${180 * ratio}" rx="${12 * ratio}" fill="#ffffff" stroke="#d1d5db" stroke-width="${2 * ratio}"/>
  <text x="${48 * ratio}" y="${180 * ratio}" font-family="Helvetica" font-size="${18 * ratio}" fill="#374151">Nothing here to tap</text>
  <rect x="${target.x * ratio}" y="${target.y * ratio}" width="${target.width * ratio}" height="${target.height * ratio}" rx="${10 * ratio}" fill="#2563eb"/>
  <text x="${(target.x + target.width / 2) * ratio}" y="${(target.y + 46) * ratio}" font-family="Helvetica" font-size="${22 * ratio}" fill="#ffffff" text-anchor="middle">Continue</text>
</svg>`;

  return {
    png: await sharp(Buffer.from(svg)).png().toBuffer(),
    size,
    pixelRatio: ratio,
    target,
    targetDescription: "the blue Continue button",
  };
}

/** Is this point inside the rect, allowing a little slack at the edges? */
export function pointInside(point: { x: number; y: number }, rect: Rect, slack = 8): boolean {
  return (
    point.x >= rect.x - slack &&
    point.x <= rect.x + rect.width + slack &&
    point.y >= rect.y - slack &&
    point.y <= rect.y + rect.height + slack
  );
}
