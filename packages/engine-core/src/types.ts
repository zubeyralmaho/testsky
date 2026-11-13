/**
 * The vocabulary every other package speaks.
 *
 * Two rules hold throughout, and breaking either one breaks the product:
 *
 * 1. **Every coordinate is a logical device point, origin top-left.** Not image
 *    pixels, not normalised fractions, not CSS pixels. A screenshot is scaled
 *    before it reaches a model and scaled back after; that conversion happens
 *    in exactly one place (`perception`), and nothing downstream may re-learn
 *    it. A cached tap that lands 40pt off because two layers each applied the
 *    device pixel ratio is the kind of bug that takes a week to find.
 *
 * 2. **An observation is a value, not a live view of the screen.** It is what
 *    the device looked like at `observedAt`, and nothing else. Decisions carry
 *    the observation they were made from, so the executor can refuse to
 *    dispatch an action whose screen has already moved on.
 */

export type Platform = "android" | "ios" | "web";

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A single captured screen image. */
export interface Frame {
  /** PNG or WebP bytes. */
  bytes: Buffer;
  /** Epoch ms. Shares its clock with the run's video and log timestamps. */
  capturedAt: number;
  /** Logical size in device points -- NOT the image's pixel size. */
  size: Size;
  /** Image pixels per logical point. 3 on most phones, 1 on many emulators. */
  pixelRatio: number;
}

/**
 * One node of the platform's accessibility hierarchy, normalised across
 * uiautomator (Android) and XCUITest (iOS) so the rest of the system never
 * branches on platform.
 */
export interface TreeNode {
  /** Stable within one snapshot only. Never persist it. */
  ref: string;
  /** Button, TextField, Tab, Image, ... -- platform roles mapped to one set. */
  role: string;
  /** content-desc / accessibilityLabel / visible text. */
  label?: string;
  value?: string;
  /** resource-id / accessibilityIdentifier. The most stable thing a screen has. */
  identifier?: string;
  bounds: Rect;
  enabled: boolean;
  focused?: boolean;
  /** clickable, editable or scrollable -- i.e. worth showing a model. */
  interactive: boolean;
  /** False when the platform says it is not drawn: scrolled out of its container, hidden. */
  visible?: boolean;
  children: TreeNode[];
}

export interface TreeSnapshot {
  platform: Platform;
  capturedAt: number;
  source: "uiautomator" | "xcuitest" | "dom";
  root: TreeNode;
  /** The capture hit a node budget; deepest levels are missing. */
  truncated: boolean;
  /** uiautomator can take two seconds. Measured so a slow tree is visible. */
  captureMs: number;
}

/**
 * What makes one screen the same screen as another.
 *
 * `phash` survives a repaint and a one-pixel shift; `treeHash` survives an
 * animation and a changed timestamp label. Neither is reliable alone, which is
 * why the cache verifies an anchor before it trusts a signature match.
 */
export interface ScreenSignature {
  /** 64-bit difference hash of the masked frame, hex. */
  phash: string;
  /** Hash of the interactive nodes (role, label, identifier, bucketed bounds). */
  treeHash?: string;
  /** Regions excluded from the hash: status bar, video, ads, carousels. */
  maskedRegions: Rect[];
}

export interface VisionStats {
  meanLuma: number;
  stdLuma: number;
  uniqueColors: number;
}

/** Which app and screen the device reported at capture time. */
export interface AppContext {
  /** Package name (Android) or bundle id (iOS). */
  appId?: string;
  /** Activity (Android) or top view controller (iOS), when the platform says. */
  screenId?: string;
}

export interface Observation {
  frame: Frame;
  tree?: TreeSnapshot;
  /**
   * The frame carries no usable visual signal -- a FLAG_SECURE screen, a blank
   * splash, a half-rendered view. When this is true the image is never sent to
   * a model: a VLM asked about a black rectangle does not say "I cannot see",
   * it invents a plausible screen. The step runs from the tree instead, and
   * the report says it ran blind.
   */
  visionBlind: boolean;
  visionStats: VisionStats;
  signature: ScreenSignature;
  appContext: AppContext;
  observedAt: number;
}

/** Where an answer came from and what it cost. Written for every model call. */
export interface Provenance {
  tier: 0 | 1 | 2 | 3;
  model?: string;
  /** Who served the call, when a router says: OpenRouter spreads one model over many hosts and prices. */
  provider?: string;
  tokensIn?: number;
  tokensOut?: number;
  usd: number;
  latencyMs: number;
  usedTree: boolean;
  channel: "vision" | "tree" | "fused";
}

export interface StepBudget {
  maxUsd: number;
  maxLatencyMs: number;
  /** How many times one step may climb the tier ladder. Typically 2. */
  maxEscalations: number;
}

/**
 * How to find this target again on a later run, cheaply and without a model.
 *
 * The anchor is what makes a cache hit trustworthy: a stored point alone says
 * nothing about whether the button moved, but a stored point plus the node
 * that was under it can be checked against the live screen for free.
 */
export interface Anchor {
  tree?: {
    role: string;
    label?: string;
    identifier?: string;
    bounds: Rect;
  };
  /** dhash of a 96x96pt patch centred on the point, for tree-less screens. */
  patchPhash?: string;
}

export interface GroundRequest {
  observation: Observation;
  /** Plain English, as the test author wrote it: "the Submit button". */
  description: string;
  hint?: {
    nearRect?: Rect;
    role?: string;
    preferChannel?: "vision" | "tree";
  };
  budget: StepBudget;
}

export interface GroundResult {
  point: Point;
  rect?: Rect;
  /** 0..1, calibrated by the router -- no grounder reports a usable one. */
  confidence: number;
  anchor: Anchor;
  candidates?: { point: Point; score: number }[];
  /** The model's own one-sentence reason for the point, when it gave one. */
  why?: string;
  provenance: Provenance;
  /**
   * Who found it: the model and the tree on the same control -- the point is
   * then the tree's measure of it -- or one of them, when the other found
   * nothing or was outranked.
   */
  foundBy?: "both" | "model" | "tree";
  /**
   * What the accessibility tree answered on its own, in its words: the one
   * control it names, or why it names none. Kept whoever won, so a report
   * shows the tree's side of every target it was asked about.
   */
  treeSaid?: string;
}

export type ActionName =
  | "tap"
  | "doubleTap"
  | "longPress"
  | "input"
  | "clearInput"
  | "swipe"
  | "scroll"
  | "keyPress"
  | "back"
  | "home"
  | "recentApps"
  | "launchApp"
  | "terminateApp"
  | "openUrl"
  | "push"
  | "wait";

export interface ActionRequest {
  name: ActionName;
  target?: Point;
  params?: Record<string, unknown>;
  /**
   * The observation this decision was made from. Required, because the guard
   * below is the only defence against the single most common mis-tap: the
   * screen moved between deciding and acting, and the tap landed on whatever
   * slid into that spot.
   */
  decidedFrom: Observation;
  staleGuard?: {
    maxAgeMs: number;
    maxPhashDistance: number;
  };
}

export interface ActionResult {
  dispatchedAt: number;
  /** The guard tripped: nothing was dispatched, and nothing changed. */
  stale: boolean;
  /** When the screen stopped changing, if the caller waited for it. */
  settledAt?: number;
  /** Pressed as the control the tree named, found at the press, rather than at a point. */
  via?: "control";
  /** Why a press that could have been made as a control was made at a point: for the report. */
  pointBecause?: string;
}

export interface AssertRequest {
  observation: Observation;
  assertion: string;
  /**
   * Force a reading channel. A test author who knows a screen is secure -- or
   * who wants the exactness of labels rather than a description of pixels --
   * writes `channel: tree` on the step, and it arrives here.
   */
  channel?: "vision" | "tree";
  /**
   * Also evaluate the negation. If both come back true the assertion cannot
   * fail, and an assertion that cannot fail is not an assertion.
   */
  probeNegation?: boolean;
  /**
   * The screen's tree, read to check a pass against -- the heading it has,
   * the words on it -- and never shown to the judge. When it disagrees, the
   * second look is told what it says.
   */
  evidenceTree?: TreeSnapshot;
}

export interface AssertResult {
  pass: boolean;
  reason: string;
  negationPass?: boolean;
  provenance: Provenance;
  /** What the tree said against the first pass, when it said anything -- the second look was told it. */
  evidence?: string[];
}

/**
 * Whether an action went where its step says, asked of the screen it was
 * decided on -- not of where it led. Asked before an app is blamed for an
 * expectation that did not hold: on an iPhone 14, a memory typed an
 * address into the search box of the page Safari opened on, and the app was
 * accused of what the agent did.
 */
export interface AimRequest {
  /** The step's instruction, in its author's words. */
  instruction: string;
  /** The screen the action was decided on. */
  observation: Observation;
  action: ActionName;
  /** Where it went, in device points. */
  point: Point;
  /** What the agent said it was aiming at. */
  meant?: string;
  /** What was typed, for an input. */
  text?: string;
}

export interface AimResult {
  /**
   * True unless it plainly went to something other than what the step names,
   * and the thing the step names was seen elsewhere on that screen.
   */
  onTarget: boolean;
  reason: string;
  /** Off target on two different models' word, not one. */
  confirmed?: boolean;
  provenance: Provenance;
}

export interface ExtractRequest {
  observation: Observation;
  /** field name -> plain-English description of what to read off the screen. */
  schema: Record<string, string>;
  channel?: "vision" | "tree";
}

export interface ExtractResult<T = Record<string, unknown>> {
  data: T;
  provenance: Provenance;
}

export interface PlanHistoryEntry {
  action: ActionName;
  description: string;
  outcome: string;
  /** What the agent said this action would do to the screen, when it said. */
  expected?: string;
}

/**
 * What one step's agent carries from turn to turn besides the history: what
 * done means, and how far it has got. A planner that keeps no count loses
 * it -- "forget every saved network" is the same screen-shaped question on
 * every turn, and only a note of what is done tells the fourth turn from the
 * first.
 */
export interface StepLedger {
  /** What the screen shows once the goal is done, in the agent's words from the step's first turn. */
  doneWhen?: string;
  /** What of the goal is done and what is left, in the agent's words, rewritten every turn. */
  progress?: string;
}

/**
 * Where a step sits in its test: what came before it. A step whose memory no
 * longer matches is worked out by an agent that knows how it got here -- a
 * list the step before scrolled down is scrolled back up, not searched for at
 * the top.
 *
 * Not what comes after. An agent shown the steps to come starts on them: on
 * a Galaxy A53, a planner that had just opened "Connections" was asked
 * ten times whether its goal was done, and with the next step in view it
 * opened that step's Wi-Fi row ten times; without it, it said done ten times.
 */
export interface Journey {
  test: string;
  done: string[];
}

export interface PlanRequest {
  observation: Observation;
  goal: string;
  history: PlanHistoryEntry[];
  journey?: Journey;
  actionSpace: ActionName[];
  budget: StepBudget;
  /**
   * Name a pop-up that is in the way instead of acting on it. The planner is
   * already looking at the screen, so noticing one here costs nothing; letting
   * it answer one itself files the answer into the step's memory, and the next
   * run -- with no pop-up -- replays a tap on nothing.
   */
  popups?: boolean;
  /** What the step has established so far; absent before its first answer. */
  ledger?: StepLedger;
  /** Ask, as well, what the screen will show once the goal is done: the step's first turns. */
  understand?: boolean;
}

/** What the agent, looking at the screen it left, says its last action did. */
export type LastActionVerdict = "as expected" | "something else" | "nothing";

export interface PlanResult {
  actions: {
    name: ActionName;
    describeTarget?: string;
    params?: Record<string, unknown>;
    /** What the screen will show once this action is carried out. */
    effect?: string;
  }[];
  done: boolean;
  reasoning?: string;
  /** Something unrelated to the goal covers the app; answering it is not the step's job. */
  popup?: { kind: PopupKind; title?: string };
  /** What the screen shows once the goal is done, when asked to understand it. */
  doneWhen?: string;
  /** What of the goal is done and what is left. */
  progress?: string;
  /** Whether the last action did what it was expected to, judged on this screen. */
  last?: LastActionVerdict;
  provenance: Provenance;
}

/**
 * What turns up over an app at random and has to be answered before a test
 * can carry on. Named by what it asks rather than by who drew it: a
 * notification prompt is one rule on Android and iOS, in every app.
 */
export type PopupKind =
  | "notifications"
  | "location"
  /** Camera, microphone, and the photo library. */
  | "camera"
  /** iOS App Tracking Transparency. */
  | "tracking"
  | "rating"
  /** The app's own what's-new, offer and promotional sheets. */
  | "promo"
  /** The operating system asking for its own account's password again -- Apple Account Verification. */
  | "account"
  | "cookies"
  | "other";

/**
 * How a kind is answered. `allow` and `deny` are for whatever asks permission;
 * `dismiss` closes a sheet without accepting anything on it; `off` leaves the
 * pop-up to the test's own steps.
 */
export type PopupAnswer = "allow" | "deny" | "dismiss" | "off";

export type PopupRules = Record<PopupKind, PopupAnswer>;

export interface PopupRequest {
  observation: Observation;
  /** What the step is for, so a sheet the step itself opened is not taken for one in its way. */
  goal?: string;
  rules: PopupRules;
  /** What the planner already said it saw. */
  hint?: { kind: PopupKind; title?: string };
}

export interface PopupResult {
  found: boolean;
  kind?: PopupKind;
  /** The pop-up's own words, for the report. */
  title?: string;
  /**
   * The control that carries out the rule. Absent when the rule is off, or nothing on screen does it.
   * `outside` when it is no control but empty background beside a tip, which a tap there closes.
   */
  press?: { label: string; point: Point; outside?: boolean };
  provenance: Provenance;
}

export interface DeviceHandle {
  id: string;
  /**
   * The phone's own serial, the same however it is reached: an Android phone
   * on a cable and over `adb connect` is two ids and one phone. Leases are
   * kept by it. Absent when the phone was not asked.
   */
  serial?: string;
  platform: Platform;
  osVersion: string;
  kind: "emulator" | "simulator" | "physical";
  /** Discovered on attach, in logical points. Absent until then. */
  size?: Size;
}

export interface EngineCapabilities {
  tree: boolean;
  frameStream: boolean;
  networkCapture: boolean;
  /** The engine has its own planner. We do not use it; we record that it exists. */
  nativePlanning: boolean;
  appInstall: boolean;
  /**
   * A tap at a control the decision's tree names is pressed as that control,
   * found where it is at the moment of the press -- so nothing needs to read
   * the tree again before it to follow a list that moved.
   */
  pressesControls?: boolean;
}

/** A live stream of frames, used for settle detection and video evidence. */
export interface FrameStream {
  /** The most recent decoded frame, or undefined before the first one lands. */
  latest(): Promise<Frame | undefined>;
  close(): Promise<void>;
}

export interface LogStream {
  /** Device log lines, already stamped on the run's clock. */
  lines(): AsyncIterable<{ at: number; text: string }>;
  close(): Promise<void>;
}
