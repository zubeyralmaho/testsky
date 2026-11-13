/**
 * A 64-bit fingerprint of what a screen looks like.
 *
 * Two jobs, both load-bearing:
 *
 *  - **Settling.** An action's effect is not on screen when the action
 *    returns. Comparing consecutive frames is how we know the screen stopped
 *    moving, and comparing them by hash rather than by bytes survives the
 *    blinking cursor and the changing clock that make byte equality useless.
 *  - **Screen identity.** The action cache keys on "is this the same screen we
 *    learned on", and a difference hash is stable under a repaint or a
 *    one-pixel shift while still noticing a different screen.
 *
 * Difference hash: downscale to 9x8 greyscale, then one bit per adjacent pair,
 * left brighter than right. Cheap, and it ignores overall brightness -- which
 * matters on a phone whose auto-brightness moves while a test runs.
 */

import sharp from "sharp";

const WIDTH = 9;
const HEIGHT = 8;

/**
 * The strip at the top of a phone screen that changes on its own.
 *
 * The clock ticks, the battery drops, a notification icon appears. Hashing it
 * means two captures of a motionless screen disagree, so nothing ever settles
 * and the action cache never hits. Four percent covers a status bar on every
 * phone we have measured, and losing it costs nothing: no test asserts on the
 * clock.
 */
const DEFAULT_MASK_TOP = 0.04;

export interface DhashOptions {
  /** Fraction of the image height to ignore at the top. */
  maskTopFraction?: number;
}

export async function dhash(png: Buffer, options: DhashOptions = {}): Promise<string> {
  const maskTop = options.maskTopFraction ?? DEFAULT_MASK_TOP;
  let image = sharp(png);
  if (maskTop > 0) {
    const meta = await image.metadata();
    const height = meta.height ?? 0;
    const width = meta.width ?? 0;
    const top = Math.round(height * maskTop);
    if (height > top + HEIGHT && width > WIDTH) {
      image = sharp(png).extract({ left: 0, top, width, height: height - top });
    }
  }

  const { data } = await image
    .greyscale()
    .resize(WIDTH, HEIGHT, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = "";
  for (let row = 0; row < HEIGHT; row += 1) {
    for (let col = 0; col < WIDTH - 1; col += 1) {
      const left = data[row * WIDTH + col] ?? 0;
      const right = data[row * WIDTH + col + 1] ?? 0;
      bits += left > right ? "1" : "0";
    }
  }

  let hex = "";
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** How many of the 64 bits differ. 0 is identical; over ~10 is another screen. */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    let diff = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (diff) {
      distance += diff & 1;
      diff >>= 1;
    }
  }
  return distance;
}

/**
 * Whether the spot an action was aimed at looks different now. A decision
 * goes stale when what is under it moved -- not when a video plays elsewhere
 * on the page: a whole-screen comparison on a feed that never stops moving
 * dropped every tap as stale. A spot that cannot be read has moved.
 */
export async function spotMoved(
  before: Buffer,
  after: Buffer,
  point: { x: number; y: number },
  frame: { size: { width: number; height: number }; pixelRatio: number },
): Promise<boolean> {
  const [was, now] = await Promise.all([patchHash(before, point, frame, SPOT_POINTS), patchHash(after, point, frame, SPOT_POINTS)]);
  return !was || !now || hamming(was, now) > SPOT_DISTANCE;
}

/** The square around an action's spot, in points: the control and a margin, not its neighbours. */
const SPOT_POINTS = 64;
/** As far as a remembered control's own patch may drift and still be the same control. */
const SPOT_DISTANCE = 8;

/**
 * A fingerprint of the pixels immediately around a point.
 *
 * This is what makes a remembered tap checkable for free. The screen hash says
 * "the same screen"; it cannot say "the button is still there". A patch hash
 * can: crop the square the tap was aimed at, hash it, and compare. A button
 * that moved, changed colour or disappeared fails the comparison, and the step
 * re-resolves instead of tapping whatever took its place.
 *
 * Deliberately not the whole element: we do not know its bounds without a
 * tree, and a fixed square around the point is both cheap and sufficient --
 * a label change inside a button moves these pixels, which is exactly when we
 * want to look again.
 */
export async function patchHash(
  png: Buffer,
  point: { x: number; y: number },
  frame: { size: { width: number; height: number }; pixelRatio: number },
  patchPoints = 96,
): Promise<string | undefined> {
  const ratio = frame.pixelRatio || 1;
  // An anchor is an optimisation, never a requirement: a frame we cannot
  // decode costs us a cheap check, not a run.
  let meta;
  try {
    meta = await sharp(png).metadata();
  } catch {
    return undefined;
  }
  const imageWidth = meta.width ?? Math.round(frame.size.width * ratio);
  const imageHeight = meta.height ?? Math.round(frame.size.height * ratio);
  const side = Math.round(patchPoints * ratio);

  // Clamped rather than refused: a target near an edge is still a target, and
  // a patch that slides inward is still the same neighbourhood.
  const left = Math.max(0, Math.min(imageWidth - side, Math.round(point.x * ratio - side / 2)));
  const top = Math.max(0, Math.min(imageHeight - side, Math.round(point.y * ratio - side / 2)));
  if (side <= 0 || imageWidth < side || imageHeight < side) return undefined;

  const patch = await sharp(png).extract({ left, top, width: side, height: side }).png().toBuffer();
  return dhash(patch, { maskTopFraction: 0 });
}
