/**
 * What a person said about the memory, applied to it.
 *
 * A heal is written into the lock the moment it happens -- the run has to
 * finish on something -- so by the time anybody reviews it, the substitute is
 * already what the next run will replay. Accepting that changes nothing.
 * Rejecting it has to undo it: the memory goes back to what it was, the next
 * run checks the old target again, and if the same substitute turns up, that
 * is the failure the reviewer said it was rather than another quiet heal.
 *
 * The decision is written into the lock as well as acted on. A runner that
 * cannot reach the control plane next time -- or a `testsky run` on the same
 * checkout, which never talks to one -- still knows what was rejected.
 *
 * Without a control plane, a review is that writing done by hand: a heal's
 * `status` set to `accepted` or `rejected`. The status alone cannot also be
 * the record that the word was acted on, or an edit would read as a decision
 * applied long ago. So a heal keeps a second word, `applied`: the one the
 * memory was last made to follow. A status that says something else is a word
 * no run has acted on yet, and the next run acts on it -- once, the same way
 * as a control plane's.
 *
 * A status set back to `pending_review` takes the word back, and nothing
 * more: the memory is left as the word left it. A rejection taken back keeps
 * the old target, and a run that still finds the change heals it again --
 * HEALED_PASS, up for review -- rather than replaying a substitute nobody
 * accepted and calling it a PASS.
 */

import type { HealDecision, HealRecord, LockFile, ResolvedAction } from "@testsky/artifact";
import type { ActionName, Anchor, Point } from "@testsky/engine-core";

import { labelOverlap } from "./label.ts";
import { ANCHOR_DRIFT } from "./verify.ts";

/** Either side of a heal, or a remembered action: each names something to do. */
export interface Target {
  action?: ActionName;
  describeTarget?: string;
  point?: Point;
  anchor?: Anchor;
}

const normalise = (text: string | undefined) => (text ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("tr");

/** Actions that are nothing without a place on the screen. */
const PLACED: ReadonlySet<ActionName> = new Set(["tap", "doubleTap", "longPress", "input"]);

/**
 * The before side of a detour: a target the agent asked for and never found,
 * so it has no place -- only the agent's words for it.
 */
const unplaced = (side: Target) => Boolean(side.action && PLACED.has(side.action) && !side.point && !side.anchor);

/**
 * Do two records name the same thing to do?
 *
 * Not equality. A target grounded twice lands a few points apart, and a match
 * against "the heal a person rejected" that jitter can defeat would quietly
 * turn a rejection back into a green run. So a control is compared as a
 * control -- role, identifier, words, roughly where -- and a bare point as a
 * point, within the drift the anchor check already tolerates.
 */
export function sameTarget(a: Target, b: Target): boolean {
  if (a.action !== b.action) return false;
  const left = a.anchor?.tree;
  const right = b.anchor?.tree;
  if (left && right) {
    if (left.role !== right.role) return false;
    if (left.identifier && right.identifier && left.identifier !== right.identifier) return false;
    const [one, other] = [normalise(left.label), normalise(right.label)];
    if (one !== other && labelOverlap(one, other) < 0.5) return false;
    return Math.hypot(left.bounds.x - right.bounds.x, left.bounds.y - right.bounds.y) <= ANCHOR_DRIFT;
  }
  if (a.point && b.point) return Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y) <= ANCHOR_DRIFT;
  if (a.point || b.point) return false;
  // Nothing to place it by: the empty "passed without acting" side of a heal,
  // or an action that never had a target. What it was called is all there is.
  return normalise(a.describeTarget) === normalise(b.describeTarget);
}

/** The same diff on the same step -- which is what a person ruled on. */
export function sameHeal(
  a: Pick<HealRecord, "step" | "before" | "after" | "kind">,
  b: Pick<HealRecord, "step" | "before" | "after" | "kind">,
): boolean {
  // A memory gone astray and a memory that passed without acting have the
  // same sides -- the remembered action, and nothing after it -- and a word
  // on one is no word on the other.
  if (a.step !== b.step || (a.kind ?? "") !== (b.kind ?? "")) return false;
  // A detour around a target never found is known by where it went. The
  // agent's words for what it could not find drift from run to run, and a
  // rejection a rewording defeats is no rejection.
  if (unplaced(a.before) && unplaced(b.before)) return a.before.action === b.before.action && sameTarget(a.after, b.after);
  return sameTarget(a.before, b.before) && sameTarget(a.after, b.after);
}

export interface AppliedDecision {
  step: string;
  /** "pending_review": a word taken back in the lock, leaving none in effect. */
  status: HealRecord["status"];
  /** A word on a memory gone astray: the executor acts on it at the step, not here. */
  kind?: HealRecord["kind"];
  /**
   * What happened to the step's memory. "restored": it holds the remembered
   * action again. "reapplied": a rejection took the substitute out, and a
   * change of mind put it back. "forgotten": neither could be done
   * faithfully, so the step was dropped rather than replayed. "unchanged":
   * nothing to do.
   */
  memory: "restored" | "reapplied" | "forgotten" | "unchanged";
}

/**
 * Applies decisions to the lock, and says what that changed.
 *
 * Only a change of mind touches the memory. The control plane hands back the
 * same decisions on every run, and re-applying an old rejection would undo
 * whatever the memory has legitimately learned since -- including a later
 * heal somebody accepted. The lock's own record of the word last acted on is
 * what makes a decision apply once.
 */
export function applyHealDecisions(lock: LockFile, decisions: readonly HealDecision[]): AppliedDecision[] {
  return decide(lock, decisions, { kindless: true });
}

/**
 * Applies the words a person wrote into the lock itself, and says what that
 * changed: each heal whose `status` is a word the memory does not follow yet,
 * acted on as a control plane's decision would be, once -- or, set back to
 * `pending_review`, taken back.
 *
 * Called after the control plane's decisions, when there are any: where both
 * have a word on one heal, the control plane's is the one kept, and the
 * file's is not acted on only to be undone a moment later.
 */
export function applyLockReviews(lock: LockFile): AppliedDecision[] {
  const words: Word[] = [];
  // The newest heal first: of two words on one diff, a person was looking at
  // the later heal of it.
  for (const heal of [...lock.heals].reverse()) {
    if (!STATUSES.has(heal.status) || heal.status === followed(heal)) continue;
    words.push({ step: heal.step, status: heal.status, before: heal.before, after: heal.after, ...(heal.kind ? { kind: heal.kind } : {}) });
  }
  return decide(lock, words, { kindless: false });
}

/**
 * A word on a heal: a control plane's decision, or a status read off the
 * lock -- where `pending_review` over a word acted on takes that word back.
 */
type Word = Omit<HealDecision, "status"> & { status: HealRecord["status"] };

/** What a status can say; anything else is a slip of the pen, not a word. */
const STATUSES: ReadonlySet<string> = new Set<HealRecord["status"]>(["pending_review", "accepted", "rejected"]);

/** The word a heal's memory follows: the one a run last acted on, or none. */
const followed = (heal: HealRecord): HealRecord["status"] => heal.applied ?? "pending_review";

function decide(lock: LockFile, decisions: readonly Word[], from: { kindless: boolean }): AppliedDecision[] {
  const applied: AppliedDecision[] = [];
  const settled: Word[] = [];
  // Newest first: a person may change their mind, and only their latest word
  // on a given diff counts.
  const newestFirst = [...decisions].sort((a, b) => (b.reviewedAt ?? "").localeCompare(a.reviewedAt ?? ""));

  for (const given of newestFirst) {
    // A store that keeps no kind hands back a word on a memory gone astray
    // as a word on any heal of those sides; it is the astray one's. Read as
    // another kind, a rejection would fail a later "passed without acting"
    // run FAIL_REJECTED_HEAL, and the person's word would never reach it.
    // A word read off the lock is on the heal it was written on.
    const decision: Word =
      from.kindless && given.kind === undefined && lock.heals.some((heal) => heal.kind === "astray" && sameHeal(heal, { ...given, kind: "astray" }))
        ? { ...given, kind: "astray" }
        : given;
    if (settled.some((earlier) => sameHeal(earlier, decision))) continue;
    settled.push(decision);

    const records = lock.heals.filter((heal) => sameHeal(heal, decision));
    const changed = records.filter((record) => followed(record) !== decision.status);
    const unrejected = changed.some((record) => followed(record) === "rejected");
    // The word is every record's of this diff; what it does to the memory is
    // done below, once, and marked done.
    for (const record of records) {
      record.status = decision.status;
      if (decision.status === "pending_review") delete record.applied;
      else record.applied = decision.status;
    }

    // Taken back: no word is in effect, and the memory is left as the word
    // left it -- never a substitute put back that nobody accepted.
    if (decision.status === "pending_review") {
      if (changed.length) applied.push({ step: decision.step, status: "pending_review", ...(decision.kind ? { kind: decision.kind } : {}), memory: "unchanged" });
      continue;
    }

    // A memory gone astray is the executor's to forget, at its step, while it
    // still holds what went astray; a rejection leaves it as it is.
    if (decision.kind === "astray") {
      if (!records.length && decision.status === "rejected") {
        lock.heals.push({
          step: decision.step,
          at: decision.reviewedAt ?? new Date().toISOString(),
          reason: "rejected on review; the heal itself was recorded elsewhere",
          before: decision.before,
          after: decision.after,
          confidence: 0,
          status: "rejected",
          applied: "rejected",
          kind: "astray",
        });
      } else if (changed.length) {
        applied.push({ step: decision.step, status: decision.status, kind: "astray", memory: "unchanged" });
      }
      continue;
    }

    if (decision.status === "accepted") {
      // The memory already holds what was accepted: the heal put it there --
      // unless a rejection heard earlier took it back out. A person who
      // changes their mind gets the substitute back, rather than one more
      // heal of the same change to accept all over again.
      if (changed.length) {
        applied.push({ step: decision.step, status: "accepted", memory: unrejected ? reapply(lock, decision) : "unchanged" });
      }
      continue;
    }

    if (!records.length) {
      // Heard about, never seen: the heal was recorded under a lock that has
      // since been reset, or by another runner. Kept, so the rejection
      // outlives the one run that happened to hear about it.
      lock.heals.push({
        step: decision.step,
        at: decision.reviewedAt ?? new Date().toISOString(),
        reason: "rejected on review; the heal itself was recorded elsewhere",
        before: decision.before,
        after: decision.after,
        confidence: 0,
        status: "rejected",
        applied: "rejected",
      });
    } else if (!changed.length) {
      continue; // Already applied on an earlier run.
    }
    applied.push({ step: decision.step, status: "rejected", memory: restore(lock, decision) });
  }
  return applied;
}

/**
 * One side of a heal as an action to remember. Heal records carry no params, so
 * they are borrowed from the action being replaced. Only a tap-like action is
 * whole without them.
 */
function actionFrom(side: Target, params?: Record<string, unknown>): ResolvedAction {
  return {
    action: side.action!,
    ...(side.describeTarget ? { describeTarget: side.describeTarget } : {}),
    ...(params ? { params } : {}),
    ...(side.point ? { point: side.point } : {}),
    ...(side.anchor ? { anchor: side.anchor } : {}),
  };
}

/** Puts the remembered action back where the substitute is. */
function restore(lock: LockFile, decision: Pick<HealDecision, "step" | "before" | "after">): AppliedDecision["memory"] {
  const memory = lock.steps[decision.step];
  const { before, after } = decision;
  if (!memory || !before.action) return "unchanged";

  // A target that was looked for and never found -- the agent went another
  // way -- has no place to put back, and a tap with nowhere to land would be
  // replayed at the corner of the screen. The step is worked out again, and
  // the same way round again is the failure the reviewer said it was.
  if (unplaced(before)) {
    delete lock.steps[decision.step];
    return "forgotten";
  }

  const rebuild = (params?: Record<string, unknown>): ResolvedAction => actionFrom(before, params);
  const needsParams = before.action === "input";

  if (!after.action) {
    // The step "passed without acting": the memory kept only what came before
    // the doubted action, so it goes back on the end.
    if (memory.actions.some((action) => sameTarget(action, before))) return "unchanged";
    if (needsParams) {
      delete lock.steps[decision.step];
      return "forgotten";
    }
    memory.actions.push(rebuild());
    return "restored";
  }

  const index = memory.actions.findIndex((action) => sameTarget(action, after));
  if (index === -1) return "unchanged";
  const replaced = memory.actions[index]!;
  if (replaced.action === before.action) {
    memory.actions[index] = rebuild(replaced.params);
    return "restored";
  }
  if (needsParams) {
    // Replaying an input with nothing to type would fail an expectation and
    // blame the app for our amnesia. Forgetting costs one model call instead.
    delete lock.steps[decision.step];
    return "forgotten";
  }
  memory.actions[index] = rebuild();
  return "restored";
}

/** Puts the substitute back where a rejection had restored the remembered action. */
function reapply(lock: LockFile, decision: Pick<HealDecision, "step" | "before" | "after">): AppliedDecision["memory"] {
  const memory = lock.steps[decision.step];
  const { before, after } = decision;
  if (!memory || !before.action) return "unchanged";
  const index = memory.actions.findIndex((action) => sameTarget(action, before));
  if (index === -1) return "unchanged";

  if (!after.action) {
    // The step "passed without acting": what was accepted is the doubted
    // action gone, and the rejection had put it back on the end.
    memory.actions.splice(index, 1);
    return "reapplied";
  }
  const replaced = memory.actions[index]!;
  if (replaced.action === after.action) {
    memory.actions[index] = actionFrom(after, replaced.params);
    return "reapplied";
  }
  if (after.action === "input") {
    delete lock.steps[decision.step];
    return "forgotten";
  }
  memory.actions[index] = actionFrom(after);
  return "reapplied";
}
