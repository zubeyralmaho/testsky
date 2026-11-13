/**
 * How much to believe a grounder.
 *
 * No grounding model reports a usable confidence: ask one and it says 0.95
 * about a point it invented. So the number is computed here, from evidence the
 * model did not produce, and it decides one thing -- whether to spend a second,
 * more expensive call before tapping.
 *
 * The evidence, cheapest first:
 *
 *  - **Tree corroboration.** Is there a node under that point, and does its
 *    label resemble what we asked for? This is free once the tree is captured
 *    and it is the strongest signal available: a point inside the node called
 *    "Continue" when the step said "the Continue button" is not a guess.
 *  - **Interactivity.** A point inside something clickable beats a point on a
 *    background, even when no label matches.
 *  - **Agreement.** Two samples of the same question landing within a finger's
 *    width of each other. Costs a second call, so it is only asked for when
 *    the tree cannot answer.
 */

import type { Point, TreeSnapshot } from "@testsky/engine-core";
import { nodeAt } from "@testsky/perception";

/** Two points this close are the same target: a fingertip is about 9mm. */
const AGREEMENT_RADIUS = 24;

const WEIGHT = { agreement: 0.5, tree: 0.3, interactive: 0.2 };

/** Words in common, as a fraction of the shorter side. Deliberately crude:
 *  it is a corroboration, not a matcher. */
export function labelOverlap(description: string, label: string): number {
  const words = (text: string) =>
    new Set(
      text
        .toLocaleLowerCase("tr")
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length > 2),
    );
  const wanted = words(description);
  const got = words(label);
  if (!wanted.size || !got.size) return 0;
  let shared = 0;
  for (const word of wanted) if (got.has(word)) shared += 1;
  return shared / Math.min(wanted.size, got.size);
}

export interface ConfidenceEvidence {
  point: Point;
  description: string;
  tree?: TreeSnapshot;
  /** A second sample of the same question, when one was taken. */
  agreementPoint?: Point;
}

export function calibrateConfidence(evidence: ConfidenceEvidence): number {
  const parts: { weight: number; score: number }[] = [];

  if (evidence.agreementPoint) {
    const dx = evidence.point.x - evidence.agreementPoint.x;
    const dy = evidence.point.y - evidence.agreementPoint.y;
    const distance = Math.hypot(dx, dy);
    parts.push({ weight: WEIGHT.agreement, score: Math.max(0, 1 - distance / (AGREEMENT_RADIUS * 2)) });
  }

  if (evidence.tree) {
    const node = nodeAt(evidence.tree.root, evidence.point.x, evidence.point.y);
    const overlap = node?.label ? labelOverlap(evidence.description, node.label) : 0;
    parts.push({ weight: WEIGHT.tree, score: overlap });
    parts.push({ weight: WEIGHT.interactive, score: node?.interactive ? 1 : 0 });
  }

  // Nothing to go on: neither a tree nor a second opinion. Half, which is
  // below every threshold -- an unexamined answer is not a confident one.
  if (!parts.length) return 0.5;

  const total = parts.reduce((sum, part) => sum + part.weight, 0);
  const score = parts.reduce((sum, part) => sum + part.weight * part.score, 0) / total;
  return Number(score.toFixed(3));
}

/** Below this, ask again -- with the tree, and with a better model when there
 *  is one. Above it, act. */
export const ESCALATE_BELOW = 0.65;
