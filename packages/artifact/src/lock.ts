/**
 * The other half of a test: what the machine learned.
 *
 * `.testsky.yaml` is the human's file -- plain English, diffable, theirs. This is
 * the machine's: which screen each step ran on, where the agent resolved each
 * target, and how to check that resolution is still valid before trusting it.
 *
 * Keeping them apart is the point. When the app changes and a step has to be
 * re-resolved, the change lands here as a diff somebody can read and accept,
 * instead of drifting invisibly inside a black box -- which is the failure
 * every self-healing product in this category has and none of them shows you.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { ActionName, Anchor, Platform, Point } from "@testsky/engine-core";

export interface ResolvedAction {
  action: ActionName;
  describeTarget?: string;
  params?: Record<string, unknown>;
  point?: Point;
  anchor?: Anchor;
}

export interface StepResolution {
  /**
   * The step's `do` when this was learned. A step reworded under the same id
   * is another step, and what was learned for the old words is not replayed:
   * "the Wi-Fi row" edited to "the Bluetooth row" would otherwise replay a tap
   * on Wi-Fi that checks out. Absent in locks written before it was kept.
   */
  do?: string;
  /** The screen this was learned on, for deciding whether it still applies. */
  screen: { phash: string; treeHash?: string };
  actions: ResolvedAction[];
  /**
   * Where a step with nothing to check was done: the screen the agent said
   * "done" on. A replay that ends there is done again, and no model is asked;
   * one that ends anywhere else is put to the agent.
   */
  end?: { phash: string; treeHash?: string };
  tier: number;
  model?: string;
  confidence: number;
  stability: { runs: number; passes: number; carriedForwardFrom?: string };
}

export interface HealRecord {
  step: string;
  at: string;
  reason: string;
  /** What was done, not only where: a swipe has no coordinates to diff, and a
   *  card that shows an empty "found" tells a reviewer nothing. */
  before: { action?: ActionName; describeTarget?: string; point?: Point; anchor?: Anchor };
  after: { action?: ActionName; describeTarget?: string; point?: Point; anchor?: Anchor };
  resolvedBy?: string;
  confidence: number;
  /** Nothing is auto-accepted that a person has not seen, except by policy. */
  status: "pending_review" | "accepted" | "rejected";
  /**
   * The word a run last acted on: what the step's memory was made to follow.
   * Written by testsky, never by hand. A review without a control plane is an
   * edit of `status`, and a status this does not match is a word no run has
   * acted on yet -- the next one does, once.
   */
  applied?: "accepted" | "rejected";
  /**
   * "astray": not a memory that stopped checking out, but one that went
   * somewhere its step does not name, and the step failed. Accepted, the
   * memory is forgotten and the step worked out again; rejected, the press
   * was the step's, and the failure after it the app's. Never the same diff
   * as a heal of another kind.
   */
  kind?: "astray";
}

/**
 * What a person said about a heal, as the control plane hands it back.
 *
 * It carries the diff rather than an id: the control plane gives a heal its
 * own id when it is uploaded, and the lock never learns it. The before/after
 * pair is the identity both sides already share.
 */
export interface HealDecision {
  step: string;
  status: "accepted" | "rejected";
  before: HealRecord["before"];
  after: HealRecord["after"];
  /** ISO time of the review. A person may change their mind; the newest word counts. */
  reviewedAt?: string;
  kind?: HealRecord["kind"];
}

export interface LockFile {
  version: 1;
  test: string;
  platform: Platform;
  /** e.g. "com.acme.shop@4.12.0+1877". A new build starts a cold cache. */
  appBuild?: string;
  /** The screen layout this memory was learned on, e.g. "440x956": points, the short side first. */
  layout?: string;
  steps: Record<string, StepResolution>;
  /** By step: what its expectation was remembered to hold on. */
  verdicts?: Record<string, RememberedVerdict>;
  heals: HealRecord[];
}

/**
 * What a step's expectation was remembered to hold on: the prints of the
 * questions a model passed -- the same question on the same input is not put
 * to it a second time.
 */
export interface RememberedVerdict {
  /**
   * The newest first, and a few of them: phones of one layout whose screens
   * differ in density see the same step in different pixels.
   */
  prints: RememberedPrint[];
}

/** One question a step's expectation held on, as a model was asked it. */
export interface RememberedPrint {
  print: string;
  /**
   * Passes a model gave it. Two before it is answered from memory: one "yes"
   * from an inconsistent judge must not be worth ten.
   */
  passes: number;
  /** Answers from memory since a model last looked at it. */
  since: number;
}

export function emptyLock(test: string, platform: Platform, appBuild?: string): LockFile {
  return { version: 1, test, platform, ...(appBuild ? { appBuild } : {}), steps: {}, heals: [] };
}

/**
 * Puts a lock on the build it is used with, and says which build it was on
 * when that was another one. What was learned on the old build is kept and
 * marked, to be checked and carried forward rather than thrown away: an app
 * update usually moves a handful of screens, not all of them. A lock that
 * never named a build was on no other build: it is given this one, quietly.
 */
export function adoptBuild(lock: LockFile, build: string): string | undefined {
  const previous = lock.appBuild;
  lock.appBuild = build;
  if (!previous || previous === build) return undefined;
  for (const resolution of Object.values(lock.steps)) resolution.stability.carriedForwardFrom = previous;
  return previous;
}

/**
 * A screen's layout, as memory is kept by: its size in points, the short side
 * first -- a phone met sideways is the same phone.
 */
export function layoutOf(size: { width: number; height: number }): string {
  const short = Math.round(Math.min(size.width, size.height));
  const long = Math.round(Math.max(size.width, size.height));
  return `${short}x${long}`;
}

/**
 * The lock that belongs to a test file, per platform and screen layout.
 *
 * A resolution is a place on a screen. The same test on iOS and on Android is
 * two different screens, and so are two phones of one platform whose screens
 * differ: one file for both replayed one phone's taps on the other, missed,
 * and filed the difference as a change in the app -- the kind of bug that
 * looks like a flaky model. Phones that share a layout share a lock. Without a
 * known size it is the platform's file, as every lock was before layouts.
 */
export function lockPathFor(testPath: string, platform: Platform, size?: { width: number; height: number }): string {
  const layout = size ? `.${layoutOf(size)}` : "";
  return `${testPath.replace(TEST_FILE, "")}.testsky.lock.${platform}${layout}.yaml`;
}

const TEST_FILE = /\.testsky\.ya?ml$/i;

/** A test file, and not the lock beside it. */
export function isTestFile(name: string): boolean {
  return TEST_FILE.test(name) && !/\.testsky\.lock\./i.test(name);
}

export function parseLockFile(source: string): LockFile | null {
  const doc = parseYaml(source) as Partial<LockFile> | null;
  if (!doc || typeof doc !== "object" || doc.version !== 1 || typeof doc.test !== "string") return null;
  return {
    version: 1,
    test: doc.test,
    platform: (doc.platform ?? "android") as Platform,
    ...(doc.appBuild ? { appBuild: doc.appBuild } : {}),
    ...(typeof doc.layout === "string" ? { layout: doc.layout } : {}),
    steps: doc.steps ?? {},
    ...(verdictsOf(doc.verdicts) ? { verdicts: verdictsOf(doc.verdicts)! } : {}),
    heals: Array.isArray(doc.heals) ? doc.heals : [],
  };
}

/** Only what reads as a remembered verdict: a lock is edited by hand, and read by the next run. */
function verdictsOf(raw: unknown): Record<string, RememberedVerdict> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const kept: Record<string, RememberedVerdict> = {};
  for (const [step, value] of Object.entries(raw as Record<string, unknown>)) {
    const verdict = value as { prints?: unknown } | null;
    if (!verdict || !Array.isArray(verdict.prints)) continue;
    const prints = verdict.prints.filter(
      (entry): entry is RememberedPrint =>
        !!entry && typeof entry.print === "string" && typeof entry.passes === "number" && typeof entry.since === "number",
    );
    if (prints.length) kept[step] = { prints };
  }
  return Object.keys(kept).length ? kept : undefined;
}

export function serializeLockFile(lock: LockFile): string {
  return (
    "# Written by testsky. The agent's resolutions, kept beside the test so a\n" +
    "# change in the app shows up as a diff you can read -- review the heals.\n" +
    // No anchors or aliases: the same point object appears in a step's
    // resolution and in a heal's `after`, and YAML would write the second one
    // as `*a1`. A heal a person cannot read is not a record of anything, which
    // is the whole reason this file exists.
    stringifyYaml(lock, { lineWidth: 100, aliasDuplicateObjects: false })
  );
}
