/**
 * Is what we learned last time still true?
 *
 * This is the whole economics of the product. A test that asks a model where
 * every button is, every run, costs what it costs and takes as long as it
 * takes. A test that remembers -- and can check its memory for free, in
 * milliseconds, without a model -- costs almost nothing on the runs where
 * nothing changed, which is nearly all of them.
 *
 * "For free" is the hard part, and it is why there are two checks rather than
 * a stored screenshot comparison:
 *
 *  - **The tree anchor**, when a tree is at hand: the node that was under the
 *    point, by role and name. A button that moved is still that button; a
 *    button that became something else is not.
 *  - **The patch hash** otherwise: the pixels around the point. It needs no
 *    tree and no model, and it notices the thing that actually matters --
 *    that what sits under the finger is no longer what we aimed at.
 *
 * Every rejection is a reason, because a rejection becomes a heal record, and
 * a heal record nobody can read is the failure this design exists to avoid.
 */

import type { Anchor, Observation, Point, TreeNode } from "@testsky/engine-core";
import { coversMostOf, hamming, isFlatHash, nodeAt, patchHash, sameLabel } from "./deps.ts";

/** A remembered point may drift this far and still be the same target. */
export const ANCHOR_DRIFT = 32;
/** Pixels around the point may differ by this many bits before we look again. */
const PATCH_DISTANCE = 8;
/** Two screens this close are the same screen. */
const SCREEN_DISTANCE = 6;

export interface Verdict {
  ok: boolean;
  reason: string;
  /** How it was decided, so the report can say why it was cheap. */
  by: "tree" | "pixels" | "none";
}

export function screenMatches(
  learned: { phash: string; treeHash?: string },
  observation: Observation,
): boolean {
  // A tree hash, when both sides have one, is the stronger claim: it follows
  // the controls rather than the paint.
  if (learned.treeHash && observation.signature.treeHash) {
    return learned.treeHash === observation.signature.treeHash;
  }
  if (!learned.phash || !observation.signature.phash) return false;
  return hamming(learned.phash, observation.signature.phash) <= SCREEN_DISTANCE;
}

export async function verifyAnchor(
  anchor: Anchor | undefined,
  point: { x: number; y: number } | undefined,
  observation: Observation,
): Promise<Verdict> {
  if (!anchor || !point) return { ok: false, reason: "nothing was remembered about this target", by: "none" };

  // An anchor that cannot fail is not a check. Older lock files hold both
  // kinds -- a window-sized container, a hash of flat pixels -- and trusting
  // them replays a remembered tap on a screen that no longer deserves it.
  const treeAnchor =
    anchor.tree && !coversMostOf(anchor.tree.bounds, observation.frame.size) ? anchor.tree : undefined;
  const patchAnchor = isFlatHash(anchor.patchPhash) ? undefined : anchor.patchPhash;
  if (!treeAnchor && !patchAnchor) {
    // Two different situations, and a reviewer should be able to tell them
    // apart: nothing was kept at all, or what was kept could never fail.
    const kept = Boolean(anchor.tree || anchor.patchPhash);
    return {
      ok: false,
      reason: kept ? "what was remembered about this target identifies any screen" : "nothing was remembered about this target",
      by: "none",
    };
  }

  if (treeAnchor && observation.tree) {
    const node = nodeAt(observation.tree.root, point.x, point.y);
    if (!node) return { ok: false, reason: "nothing is at that point any more", by: "tree" };
    if (node.role !== treeAnchor.role) {
      return { ok: false, reason: `a ${node.role} is there now, not a ${treeAnchor.role}`, by: "tree" };
    }
    if (treeAnchor.identifier && node.identifier && node.identifier !== treeAnchor.identifier) {
      return { ok: false, reason: `a different control is there (${node.identifier})`, by: "tree" };
    }
    const drift = Math.hypot(node.bounds.x - treeAnchor.bounds.x, node.bounds.y - treeAnchor.bounds.y);
    if (drift > ANCHOR_DRIFT) {
      return { ok: false, reason: `it moved ${Math.round(drift)} points`, by: "tree" };
    }
    if (treeAnchor.label && node.label && !sameLabel(treeAnchor.label, node.label)) {
      return { ok: false, reason: `it is called "${node.label}" now, not "${treeAnchor.label}"`, by: "tree" };
    }
    return { ok: true, reason: "the same control is still there", by: "tree" };
  }

  if (patchAnchor && !observation.visionBlind) {
    const now = await patchHash(observation.frame.bytes, point, {
      size: observation.frame.size,
      pixelRatio: observation.frame.pixelRatio,
    });
    // Not evidence that anything changed: nothing could be checked at all.
    if (!now) return { ok: false, reason: "the screen could not be sampled at that point", by: "none" };
    const distance = hamming(patchAnchor, now);
    if (distance > PATCH_DISTANCE) {
      return { ok: false, reason: `what is under that point changed (${distance} bits)`, by: "pixels" };
    }
    return { ok: true, reason: "the pixels around the point are unchanged", by: "pixels" };
  }

  return { ok: false, reason: "no way to check the remembered target on this screen", by: "none" };
}

const plain = (text: string) => text.trim().replace(/\s+/g, " ").toLocaleLowerCase("tr");

/**
 * Where a remembered control went, when it is no longer under its point: the
 * one control on this screen with its role, its identifier and its very
 * words, in view. A list moved by a replayed swipe never stops where it
 * stopped the time before -- measured on an Android emulator, the same
 * Settings row sat 440 points apart on two runs -- and the row it was is
 * still the row it is. Not a heal, because nothing about the app changed.
 *
 * Only one, and only the same words: two rows called "Delete" are no answer,
 * and "Display" is not "Display & touch" -- a renamed control is for a person
 * to see. The point keeps its place within the control.
 */
export function relocateAnchor(anchor: Anchor | undefined, point: Point, observation: Observation): Point | undefined {
  const remembered = anchor?.tree;
  const tree = observation.tree;
  if (!remembered?.label || !tree || coversMostOf(remembered.bounds, observation.frame.size)) return undefined;
  const words = plain(remembered.label);
  const found: TreeNode[] = [];
  const visit = (node: TreeNode): void => {
    const same =
      node.role === remembered.role &&
      node.label !== undefined &&
      plain(node.label) === words &&
      (!remembered.identifier || !node.identifier || node.identifier === remembered.identifier);
    if (same) found.push(node);
    for (const child of node.children) visit(child);
  };
  visit(tree.root);
  if (found.length !== 1 || coversMostOf(found[0]!.bounds, observation.frame.size)) return undefined;
  const { bounds } = found[0]!;
  const moved = { x: bounds.x + (point.x - remembered.bounds.x), y: bounds.y + (point.y - remembered.bounds.y) };
  const { width, height } = observation.frame.size;
  return moved.x >= 0 && moved.x <= width && moved.y >= 0 && moved.y <= height ? moved : undefined;
}
