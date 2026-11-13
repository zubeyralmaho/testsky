/**
 * What can serve as an anchor, and what only looks like one.
 *
 * An anchor exists to answer one question for free: is the thing we aimed at
 * last time still under this point? Two kinds of stored value cannot answer
 * it, and both of them answer "yes" to everything instead:
 *
 *  - a hash of flat pixels, which every other flat patch on every other
 *    screen also hashes to;
 *  - a container the size of the display, which is under every point there is.
 *
 * Stored, they turn the cache from an optimisation into a way of tapping
 * confidently in the wrong place. Refused, the step costs one model call and
 * lands where it meant to.
 */

import type { Anchor, Point, Rect, TreeSnapshot } from "@testsky/engine-core";

import { nodeAt } from "./tree.ts";

/** A patch of one colour: the hash is all zeros or all ones and means nothing. */
export function isFlatHash(hash: string | undefined): boolean {
  return !hash || /^0+$|^f+$/i.test(hash);
}

/** A box this large is the window, the scroll view or the background. */
export const ANCHOR_MAX_AREA_SHARE = 0.6;

export function coversMostOf(bounds: Rect, screen: { width: number; height: number }): boolean {
  const area = screen.width * screen.height;
  if (area <= 0) return false;
  return (Math.max(0, bounds.width) * Math.max(0, bounds.height)) / area > ANCHOR_MAX_AREA_SHARE;
}

/**
 * The control worth remembering at a point, as an anchor, or none.
 *
 * `nodeAt` answers what a tap would hit, which on a screen full of plain
 * containers can be the window itself: role "Other", bounds the whole
 * display. An anchor has to identify something, so a container covering most
 * of the screen is not one, and neither is a node with no name, no identifier
 * and nothing to press.
 *
 * One definition, because two callers need it: the router, when a tree came
 * with the frame it grounded on, and the executor, which reads the tree
 * afterwards when the pixels around the point were too flat to remember.
 */
export function anchorAt(tree: TreeSnapshot, point: Point): NonNullable<Anchor["tree"]> | undefined {
  const node = nodeAt(tree.root, point.x, point.y);
  if (!node) return undefined;
  const identifies = Boolean(node.label?.trim() || node.identifier?.trim() || node.interactive);
  if (!identifies || coversMostOf(node.bounds, tree.root.bounds)) return undefined;
  return {
    role: node.role,
    bounds: node.bounds,
    ...(node.label ? { label: node.label } : {}),
    ...(node.identifier ? { identifier: node.identifier } : {}),
  };
}

/**
 * The control a tap at this point presses: the smallest box around it that
 * can be pressed, short of the screen-sized containers every app is wrapped
 * in. A row's label and its middle press the same row, where the smallest
 * node under each -- a line of text, the blank beside it -- does not say so.
 */
export function pressableAt(tree: TreeSnapshot, point: Point): Rect | undefined {
  let best: Rect | undefined;
  const visit = (node: TreeSnapshot["root"]): void => {
    const { bounds } = node;
    const inside = point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
    const smaller = !best || bounds.width * bounds.height < best.width * best.height;
    if (inside && node.interactive && smaller && !coversMostOf(bounds, tree.root.bounds)) best = bounds;
    for (const child of node.children) visit(child);
  };
  visit(tree.root);
  return best;
}
