/**
 * The two files that make up a test.
 *
 * `.testsky.yaml` is written by a human and owned by the customer: plain English,
 * no selectors, diffable in a pull request, exportable by copying the file.
 * `.testsky.lock.<platform>.<layout>.yaml` is written by the machine: what the
 * agent resolved, on which build and screen layout, with what confidence.
 *
 * Keeping them apart is the whole trick. When the agent re-resolves a step
 * because the app changed, the change lands in the lock file as a reviewable
 * diff instead of silently drifting inside a black box -- which is the failure
 * every "self-healing" product in this category has and does not show you.
 */

import type { Platform, PopupAnswer, PopupKind, PopupRules } from "@testsky/engine-core";

export type { PopupAnswer, PopupKind, PopupRules } from "@testsky/engine-core";

export interface TestTarget {
  platform: Platform;
  /** Package name or bundle id. */
  app: string;
}

export interface TestBudget {
  maxSteps: number;
  maxUsd: number;
  maxSeconds: number;
}

export interface TestPolicy {
  /** How many times to run before believing the result. */
  runs: number;
  /** How many of those must pass. `runs` for a new test. */
  passThreshold: number;
  budget: TestBudget;
  /**
   * How this test answers pop-ups, where it differs from the rules every test
   * shares. A test about a prompt sets that prompt's kind to `off`, so the
   * prompt is left for its own steps to answer.
   */
  popups?: Partial<PopupRules>;
}

/** A setup/teardown line, parsed into the few things it is allowed to be. */
export type Directive =
  | { kind: "launch"; app?: string }
  | { kind: "terminate"; app?: string }
  | { kind: "fixture"; name: string }
  | { kind: "do"; text: string };

export interface TestStep {
  /** Cache key, video index key and heal identity. Derived when unwritten. */
  id: string;
  /** True when we derived the id; the CLI offers to write it back. */
  idGenerated: boolean;
  /** What to do, in plain English. */
  do?: string;
  /** What must be true afterwards. Falsifiable, or the linter complains. */
  expect?: string;
  /**
   * How long the expectation may take to hold, in milliseconds: it is looked
   * at until then, and fails only when it never did. Checked once, after a
   * moment's grace, when absent.
   */
  within?: number;
  /**
   * How long the step lets pass before anything else, in milliseconds, with no
   * model asked: a soak, where the time itself is the point. An agent told to
   * "wait 30 seconds" waited one.
   */
  wait?: number;
  /**
   * What the step waits for and answers the moment it comes, before anything
   * else: an incoming call, pressed the instant its answer control shows. An
   * agent planning each look missed a thirty-second ring.
   */
  answer?: "call";
  /** How long the call may take to ring, in milliseconds. */
  ring?: number;
  /** field -> plain-English description of what to read off the screen. */
  extract?: Record<string, string>;
  /**
   * Author's hint about which channel to read the screen with. The blind-frame
   * detector already handles secure screens; this only saves it a round trip.
   */
  channel?: "vision" | "tree";
}

export interface TestFile {
  id: string;
  title: string;
  targets: TestTarget[];
  policy: TestPolicy;
  setup: Directive[];
  steps: TestStep[];
  teardown: Directive[];
  /** Where it was read from, for error messages and lock-file siting. */
  path?: string;
}

export const DEFAULT_POLICY: TestPolicy = {
  runs: 3,
  passThreshold: 3,
  budget: { maxSteps: 40, maxUsd: 0.1, maxSeconds: 300 },
};

/** Every kind of pop-up, in the order a person reads them. */
export const POPUP_KINDS: readonly PopupKind[] = [
  "notifications",
  "location",
  "camera",
  "tracking",
  "rating",
  "promo",
  "account",
  "cookies",
  "other",
];

/**
 * The answers each kind may be given. A permission is allowed or denied; a
 * sheet is closed. "Allow" on a rating sheet would mean writing a review, which
 * no test should do by accident.
 */
export const POPUP_ANSWERS: Record<PopupKind, readonly PopupAnswer[]> = {
  notifications: ["allow", "deny", "off"],
  location: ["allow", "deny", "off"],
  camera: ["allow", "deny", "off"],
  tracking: ["allow", "deny", "off"],
  rating: ["dismiss", "off"],
  promo: ["dismiss", "off"],
  account: ["dismiss", "off"],
  cookies: ["allow", "deny", "off"],
  other: ["dismiss", "off"],
};

/**
 * What every test answers unless it says otherwise.
 *
 * Allow what the app needs to do what the test asks -- a location prompt that
 * is denied turns a map test into a test of the "location is off" screen --
 * and decline what only the app's owners want: notifications, tracking,
 * reviews, cookies. The phone's own account asking for its password is put
 * off: no test types a password into a system prompt. Anything unrecognised
 * is closed, which is what a person running the test by hand would do.
 */
export const DEFAULT_POPUP_RULES: PopupRules = {
  notifications: "deny",
  location: "allow",
  camera: "allow",
  tracking: "deny",
  rating: "dismiss",
  promo: "dismiss",
  account: "dismiss",
  cookies: "deny",
  other: "dismiss",
};

/** The rules a run uses: the shared ones, then the test's own on top. */
export function popupRules(shared: Partial<PopupRules> = {}, own: Partial<PopupRules> = {}): PopupRules {
  return { ...DEFAULT_POPUP_RULES, ...shared, ...own };
}

/**
 * Rules that came over the wire or out of a database: a known kind with an
 * answer it may be given is kept, and anything else is dropped rather than
 * trusted. A control plane newer than the runner may know a kind this one
 * does not, and that is no reason to refuse the rest.
 */
export function knownPopupRules(raw: unknown): Partial<PopupRules> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const rules: Partial<PopupRules> = {};
  for (const kind of POPUP_KINDS) {
    const answer = (raw as Record<string, unknown>)[kind];
    if (typeof answer === "string" && (POPUP_ANSWERS[kind] as readonly string[]).includes(answer)) {
      rules[kind] = answer as PopupAnswer;
    }
  }
  return rules;
}
