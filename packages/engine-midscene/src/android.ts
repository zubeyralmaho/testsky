/**
 * Midscene's Android device, wearing our `Engine`.
 *
 * What we take from Midscene is the boring, expensive half: an adb client that
 * survives real phones, input primitives that already handle the IME and
 * coordinate adjustment, a uiautomator dump with retries, a scrcpy frame
 * source. What we do not take is its `Agent` -- perception and planning are
 * ours, because its agent owns both internally and would make the action
 * cache, the staleness guard and per-step evidence impossible.
 *
 * Everything here is mechanical. If Midscene is ever swapped out, this file
 * and its iOS sibling are the whole of the rewrite.
 */

import { AndroidDevice } from "@midscene/android";

import type {
  AimRequest,
  AimResult,
  ActionRequest,
  ActionResult,
  AppControl,
  AssertRequest,
  AssertResult,
  DeviceHandle,
  Engine,
  EngineCapabilities,
  ExtractRequest,
  ExtractResult,
  Frame,
  FrameStream,
  GroundRequest,
  GroundResult,
  LogStream,
  ObserveOptions,
  Observation,
  PlanRequest,
  PlanResult,
  PopupRequest,
  PopupResult,
  Point,
  CallAnswer,
  CallAnswerRequest,
  TreeNode,
  TreeSnapshot,
  VisionStats,
} from "@testsky/engine-core";
import { DeviceNotReadyError } from "@testsky/engine-core";
import { callAnswerControl, dhash, hamming, isVisionBlind, restlessRegions, sameControlAt, spotMoved, treeHash, visionStats } from "@testsky/perception";
import type { Router } from "@testsky/router";

import { LAYOUT_COMMAND, layoutToTree } from "./android-layout.ts";
import { androidLogStream } from "./logs.ts";
import { pngSize } from "./png.ts";

const MIDSCENE_VERSION = "1.13.3";
/** Actions aimed at a spot, whose staleness is that spot's. */
const AIMED = new Set(["tap", "doubleTap", "longPress", "input"]);
/** How long a swipe's finger travels, and a scroll's: a flick, and a drag that stops. */
const SWIPE_MS = 300;
const SCROLL_MS = 1000;
/** Actions nothing on the screen can make stale: a wait touches nothing, and a
 *  swipe or a scroll is aimed at no spot and moves whatever screen it lands on. */
const NEVER_STALE = new Set(["wait", "swipe", "scroll"]);

/** Two frames this close are the same screen: the clock and a cursor move a
 *  bit or two, a transition moves far more. */
const SETTLED_DISTANCE = 4;
/** How long a settle waits for an action's answer to show before taking the screen as it is. */
const CHANGE_WITHIN_MS = 1500;

/** Below this much luma spread a frame carries no content worth judging. */
const LAUNCH_CONTENT_FLOOR = 8;

/** How long a tree that would not come is not asked for again. */
const TREE_BACKOFF_MS = 30_000;

export interface AndroidEngineOptions {
  router: Router;
  /** Step id, for the cost ledger. Set by the executor before each step. */
  stepId?: string;
}

/**
 * Midscene's node, as `@midscene/core` defines it: the class name in `type`,
 * every other XML attribute in `attrs`, and bounds ALREADY divided by the
 * device pixel ratio -- so they are logical points, like everything else here.
 */
interface RawTreeNode {
  type?: string;
  attrs?: Record<string, string | undefined>;
  bounds?: { left: number; top: number; width: number; height: number };
  children?: RawTreeNode[];
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "true" || value === "1";
}

/**
 * uiautomator's node, normalised to ours.
 *
 * The normalisation is the point: an iOS tree and an Android tree must look
 * identical by the time anything upstream reads them, or every consumer grows
 * a platform branch. Roles lose their package (android.widget.Button becomes
 * Button) because that is what a model reads and what a person writing a test
 * would say.
 */
function normaliseNode(raw: RawTreeNode, index: number): TreeNode {
  const attrs = raw.attrs ?? {};
  const bounds = raw.bounds ?? { left: 0, top: 0, width: 0, height: 0 };
  const label = (attrs["content-desc"] || attrs.text || "").trim();
  const identifier = (attrs["resource-id"] || "").trim();
  const node: TreeNode = {
    ref: `n${index}`,
    role: (raw.type ?? "View").split(".").pop() ?? "View",
    bounds: {
      x: Math.round(bounds.left),
      y: Math.round(bounds.top),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    },
    enabled: attrs.enabled === undefined ? true : truthy(attrs.enabled),
    interactive:
      truthy(attrs.clickable) ||
      truthy(attrs["long-clickable"]) ||
      truthy(attrs.scrollable) ||
      truthy(attrs.checkable) ||
      truthy(attrs.editable),
    children: (raw.children ?? []).map((child, i) => normaliseNode(child, index * 100 + i + 1)),
  };
  if (label) node.label = label;
  if (identifier) node.identifier = identifier;
  if (truthy(attrs.focused)) node.focused = true;
  const value = (attrs.text || "").trim();
  if (value && value !== label) node.value = value;
  return node;
}

/**
 * The command that starts an app's launcher activity with its task cleared.
 * The component is quoted for the phone's shell: YouTube's is
 * `.app.honeycomb.Shell$HomeActivity`, and unquoted the phone's sh read
 * `$HomeActivity` as an empty variable and was asked for a class that does
 * not exist.
 */
export function launchCommand(component: string): string {
  return `am start -S --activity-clear-task -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n '${component.replace(/'/g, "")}'`;
}

/** The system's permission dialog, which asks on behalf of whichever app is in front. */
/** How often a call is looked for: one tree read is 0.5-2 s on these phones, so this is mostly a breath between reads. */
const CALL_POLL_MS = 250;
/** How long the notification shade takes to come down before its tree is read. */
const SHADE_MS = 700;

/**
 * The keys of the call notifications showing now -- a ring, or a call that is
 * missed or going on -- from `dumpsys notification`: only its list of what is
 * posted, not the archive of what was.
 */
export function callNotificationKeys(dumpsys: string): string[] {
  const posted = dumpsys.split(/\n {2}(?:Notification attention state|mArchive|Snoozed notifications)/)[0] ?? "";
  const keys: string[] = [];
  for (const block of posted.split(/\n(?= {4}NotificationRecord\()/)) {
    if (!/\bcategory=call\b/.test(block)) continue;
    const key = /\bkey=(\S+?):?(?:\s|$)/.exec(block)?.[1];
    if (key) keys.push(key);
  }
  return keys;
}

const PERMISSION_DIALOG = /^com\.(?:google\.)?android\.(?:permissioncontroller|packageinstaller)$/;

/**
 * Whether what is in front after launching `id` is that app coming up: the
 * app, one of its relatives -- or a permission dialog. One is only ever shown
 * for the app in front, so an app that asks for one as it opens has opened;
 * the pop-up rules answer it on the first step, as they would at any other.
 */
export function launchedInFront(front: string | undefined, id: string): boolean {
  if (!front) return false;
  return front === id || front.startsWith(id) || id.startsWith(front) || PERMISSION_DIALOG.test(front);
}

/**
 * Whether the app came up behind something else in front: stopped just before
 * the launch, so a process means it started, and what is in front is neither
 * nothing nor the launcher it would have fallen back to. A full-screen system
 * activity -- Huawei's updater -- holds both focus and resume, and the first
 * step's pop-up rules answer it; the expectation has the last word.
 */
export function launchedBehind(front: string | undefined, home: string | undefined, pid: string): boolean {
  return Boolean(pid.trim() && front && front !== home);
}

/**
 * The package of the activity resumed under whatever window has focus, from
 * `dumpsys activity activities`. A system overlay -- Huawei's "Software
 * update" sheet, a window of type 2003 -- takes the focus from an app that
 * has opened beneath it, and leaves it resumed.
 */
export function resumedPackage(dumpsys: string): string | undefined {
  const line = dumpsys.split("\n").find((each) => /topResumedActivity|mResumedActivity/.test(each)) ?? "";
  return /ActivityRecord\{\S+ u\d+ ([A-Za-z0-9_.]+)\//.exec(line)?.[1];
}

/**
 * What is in front, from `dumpsys window`: the window with the focus, or the app
 * with it where no window has. IxChariot's first activity on a Nothing phone
 * stays at `mCurrentFocus=null` under `mFocusedApp=...` for as long as it is up,
 * which read as nothing in front and failed its launch.
 */
export function focusIn(dumpsys: string): { appId?: string; screenId?: string } {
  for (const line of dumpsys.split("\n")) {
    if (!/mCurrentFocus|mFocusedApp/.test(line)) continue;
    const match = /([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/.exec(line);
    if (!match) continue;
    const activity = match[2]!;
    return { appId: match[1]!, screenId: activity.startsWith(".") ? `${match[1]!}${activity}` : activity };
  }
  return {};
}

export class AndroidMidsceneEngine implements Engine {
  readonly name = `midscene@${MIDSCENE_VERSION}`;
  readonly capabilities: EngineCapabilities = {
    tree: true,
    // Frame streaming and log capture arrive with the evidence package (W6).
    frameStream: false,
    networkCapture: false,
    nativePlanning: true,
    appInstall: true,
  };

  private device?: AndroidDevice;
  private handle?: DeviceHandle;
  private ratio = 1;
  /** Until when the tree is not asked for, after uiautomator gave up on a busy screen. */
  private treeBackoffUntil = 0;
  private readonly router: Router;
  /** Set by the executor so the cost ledger can attribute each call to a step. */
  stepId?: string;
  /** The phone's own stay-awake setting, put back on detach. */
  private stayOnBefore?: string;

  constructor(options: AndroidEngineOptions) {
    this.router = options.router;
    if (options.stepId !== undefined) this.stepId = options.stepId;
  }

  /**
   * What is in front, and whether the lock screen is over it.
   *
   * Both come out of one `dumpsys window`, because this runs on every capture
   * and a second adb round trip per observation is a second paid on every step
   * of every test. The focus is the app half of every cache key; the lock state
   * is what stops a run from judging a lock screen it cannot see past.
   */
  private async deviceState(): Promise<{ appId?: string; screenId?: string; locked: boolean }> {
    try {
      const adb = await this.connected.connect();
      const out = await adb.shell(
        "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp|mDreamingLockscreen|mShowingLockscreen'",
      );
      const locked = /(mDreamingLockscreen|mShowingLockscreen)=true/.test(out);
      return { ...focusIn(out), locked };
    } catch {
      // A phone that will not answer dumpsys has bigger problems, and they will
      // surface on the next screenshot with a better error than this one.
      return { locked: false };
    }
  }

  /**
   * Wakes the screen, and says so plainly when it cannot.
   *
   * A sleeping phone still reports the app as focused, and `screencap` still
   * succeeds -- it just returns black. Real test phones sleep all the time, so
   * this is not an edge case; it is the default state of a phone on a desk.
   */
  private async ensureAwake(): Promise<void> {
    const adb = await this.connected.connect();
    const power = await adb.shell("dumpsys power | grep -E 'mWakefulness='");
    if (!/mWakefulness=Awake/.test(power)) {
      await adb.shell("input keyevent KEYCODE_WAKEUP");
      await new Promise((resolve) => setTimeout(resolve, 600));
    }

    if ((await this.deviceState()).locked) {
      // Works on a swipe-only lock screen; a PIN or pattern needs a person.
      await adb.shell("wm dismiss-keyguard");
      await new Promise((resolve) => setTimeout(resolve, 600));
      if ((await this.deviceState()).locked) {
        throw new DeviceNotReadyError(
          "The phone is locked, and a PIN or pattern cannot be entered from adb.\n" +
            "  Unlock it once by hand, then leave it unlocked while the run goes.\n" +
            "  For a phone you test on often: turn the screen lock off, and in Developer options\n" +
            "  switch on 'Stay awake while charging' so it never sleeps again.",
        );
      }
    }
  }

  /**
   * Keeps the screen on for the length of the run, and puts the setting back.
   *
   * A phone that dims mid-run does not fail loudly: screencap still succeeds
   * and returns black, the lock screen takes focus, and the agent starts
   * answering questions about a screen the app is not on. Borrowing the setting
   * is cheaper than teaching every later step to suspect it -- and it is
   * restored on detach, because this is somebody's phone.
   */
  private async holdScreenAwake(): Promise<void> {
    const adb = await this.connected.connect();
    const current = (await adb.shell("settings get global stay_on_while_plugged_in")).trim();
    this.stayOnBefore = /^\d+$/.test(current) ? current : undefined;
    await adb.shell("svc power stayon usb");
  }

  private async releaseScreen(): Promise<void> {
    if (this.stayOnBefore === undefined) return;
    try {
      const adb = await this.connected.connect();
      await adb.shell(`settings put global stay_on_while_plugged_in ${this.stayOnBefore}`);
    } catch {
      // The phone went away mid-restore. Saying so here helps nobody.
    }
    this.stayOnBefore = undefined;
  }

  /** By yadb, and by uiautomator on a phone where yadb gives nothing. */
  private async captureTree(device: AndroidDevice): Promise<{ root?: RawTreeNode; capturedAt?: number }> {
    try {
      const raw = device as unknown as { ensureYadb(): Promise<void>; getAdb(): Promise<{ shell(command: string, options?: { timeout?: number }): Promise<string> }> };
      await raw.ensureYadb();
      const root = layoutToTree(await (await raw.getAdb()).shell(LAYOUT_COMMAND, { timeout: 8000 }), this.ratio);
      if (root) return { root, capturedAt: Date.now() };
    } catch {
      // uiautomator's turn.
    }
    return (await device.getUITree()) as unknown as { root?: RawTreeNode; capturedAt?: number };
  }

  private get connected(): AndroidDevice {
    if (!this.device) throw new Error("engine is not attached to a device");
    return this.device;
  }

  async attach(device: DeviceHandle): Promise<void> {
    if (device.platform !== "android") {
      throw new Error(`the Android engine cannot drive a ${device.platform} device`);
    }
    // The screen's size is read again on every look, not kept from the
    // first: a phone with auto-rotate on turns while a run goes, and a size
    // kept from portrait sends every tap of a landscape screen off its edge.
    // Seen on a Galaxy A53: three taps on "Connections" landed below
    // the bottom of a landscape screen and the step stopped as a loop.
    const android = new AndroidDevice(device.id, { autoDismissKeyboard: true, alwaysRefreshScreenInfo: true });
    await android.connect();
    this.device = android;
    this.handle = device;
    // Memory is kept per screen layout, and this is where the layout is
    // learned. Unknown, the platform's one lock is used, as before layouts.
    const size = await android.size().catch(() => undefined);
    if (size) device.size = { width: size.width, height: size.height };
    // Borrow the stay-awake setting BEFORE checking the lock: the setting does
    // not need an unlocked screen. A phone that cannot be used -- locked with
    // a PIN -- gets it back at once: a run that never started does not get to
    // leave somebody's phone changed.
    await this.holdScreenAwake();
    try {
      await this.ensureAwake();
    } catch (error) {
      await this.releaseScreen();
      throw error;
    }
  }

  async detach(): Promise<void> {
    if (this.device) await this.releaseScreen();
    await this.device?.destroy();
    delete this.device;
    delete this.handle;
  }

  /** The control under a point now is the one the decision saw there -- read from a fresh tree. */
  private async sameControl(decidedFrom: Observation, point: Point): Promise<boolean> {
    if (!decidedFrom.tree) return false;
    const raw = (await this.connected.getUITree().catch(() => undefined)) as unknown as { root?: RawTreeNode } | undefined;
    return Boolean(raw?.root) && sameControlAt(decidedFrom.tree.root, normaliseNode(raw!.root!, 0), point);
  }

  /** One capture, measured and hashed. Blank frames are retried: a phone that
   *  dozed off or a frame caught mid-render both come back black, and only the
   *  second kind resolves by trying again. */
  private async captureFrame(): Promise<{ bytes: Buffer; stats: VisionStats; blind: boolean; phash: string; at: number }> {
    const device = this.connected;
    let bytes = Buffer.alloc(0);
    let stats: VisionStats = { meanLuma: 0, stdLuma: 0, uniqueColors: 0 };
    let blind = true;
    let at = Date.now();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        await this.ensureAwake();
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      const base64 = await device.screenshotBase64();
      at = Date.now();
      bytes = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
      stats = await visionStats(bytes);
      blind = isVisionBlind(stats);
      if (!blind) break;
    }
    return { bytes, stats, blind, phash: await dhash(bytes), at };
  }

  /**
   * Captures until the screen stops moving.
   *
   * An app reports itself focused, and an action returns, well before the
   * pixels settle -- so the first frame after either is usually a transition:
   * a status bar over a blank page, a half-drawn list. Judging that frame is
   * how a runner reports "the Settings screen is not visible" about a Settings
   * screen that simply had not drawn yet.
   *
   * Given the screen before an action, it first waits -- CHANGE_WITHIN_MS at
   * most -- for a picture other than that one. A press that changes nothing
   * costs that wait; one the app answers late is judged on its answer.
   */
  private async captureSettled(maxMs: number, changedFrom?: string): Promise<Awaited<ReturnType<typeof this.captureFrame>>> {
    const deadline = Date.now() + maxMs;
    let previous = await this.captureFrame();
    if (changedFrom) {
      const until = Date.now() + Math.min(CHANGE_WITHIN_MS, maxMs);
      while (hamming(previous.phash, changedFrom) <= SETTLED_DISTANCE && Date.now() < until) previous = await this.captureFrame();
    }
    while (Date.now() < deadline) {
      const next = await this.captureFrame();
      if (hamming(previous.phash, next.phash) <= SETTLED_DISTANCE) return next;
      previous = next;
    }
    return previous;
  }

  /**
   * Waits for a launched app to actually be on screen.
   *
   * Settling alone is not enough: an app's launch screen is blank and
   * perfectly still, so two identical captures of nothing agree with each
   * other and the run goes on to judge a white rectangle. What says the app
   * arrived is that the screen became *different from what was there before*
   * and then stopped changing.
   */
  private async settleAfterLaunch(before: string, maxMs = 9000): Promise<void> {
    const deadline = Date.now() + maxMs;
    let previous = await this.captureFrame();
    while (Date.now() < deadline) {
      const next = await this.captureFrame();
      const changed = hamming(before, next.phash) > SETTLED_DISTANCE;
      const still = hamming(previous.phash, next.phash) <= SETTLED_DISTANCE;
      // A launch screen is blank, perfectly still, and different from whatever
      // was there before -- so "changed and still" settles on nothing at all,
      // and the first assertion then judges a white rectangle. What tells them
      // apart is the number we already compute for every frame: a blank screen
      // measured 4.35 of luma spread on the simulator, the drawn Settings
      // screen 13.3. Featureless frames keep waiting, until the deadline says
      // the emptiness is the truth.
      if (changed && still && next.stats.stdLuma >= LAUNCH_CONTENT_FLOOR) return;
      previous = next;
    }
  }

  async observe(opts?: ObserveOptions): Promise<Observation> {
    const device = this.connected;
    // Checked before the capture, not after: a lock screen makes everything
    // that follows a fiction, and it is dismissible more often than not.
    const state = await this.deviceState();
    if (state.locked) await this.ensureAwake();
    const focus: { appId?: string; screenId?: string } = {};
    if (state.appId) focus.appId = state.appId;
    if (state.screenId) focus.screenId = state.screenId;
    const frameData = opts?.settle ? await this.captureSettled(opts.settleMs ?? 6000, opts.changedFrom) : await this.captureFrame();
    const logical = await device.size();
    const pixels = pngSize(frameData.bytes);
    // The device reports points; the screenshot arrives in pixels. One place
    // learns the ratio between them, and it is here.
    this.ratio = logical.width > 0 ? pixels.width / logical.width : 1;

    const frame: Frame = {
      bytes: frameData.bytes,
      capturedAt: frameData.at,
      size: logical,
      pixelRatio: this.ratio,
    };

    // `auto` -- the default -- captures the tree only when the pixels cannot
    // answer. It costs seconds (2.5s on the phone this was written against),
    // so it is not paid on the happy path; but a blind frame has nothing else,
    // and that is precisely where every vision-only competitor stops working.
    const wantTree = opts?.tree === true || (opts?.tree !== false && frameData.blind);

    let tree: TreeSnapshot | undefined;
    if (wantTree && Date.now() >= this.treeBackoffUntil) {
      const startedAt = Date.now();
      try {
        const raw = await this.captureTree(device);
        if (raw?.root) {
          tree = {
            platform: "android",
            capturedAt: raw.capturedAt ?? startedAt,
            source: "uiautomator",
            root: normaliseNode(raw.root, 0),
            truncated: false,
            captureMs: Date.now() - startedAt,
          };
        }
      } catch {
        // uiautomator dumps only a screen that has gone idle, and a playing
        // video never does: its three attempts time out, 15 s gone, and the
        // run used to end there as the device's fault. The frame answers on
        // its own, as it does on an iPhone whose tree will not come -- and the
        // tree is left alone until the screen may have calmed down.
        this.treeBackoffUntil = Date.now() + TREE_BACKOFF_MS;
      }
    }

    const observation: Observation = {
      frame,
      appContext: focus,
      visionBlind: frameData.blind,
      visionStats: frameData.stats,
      signature: {
        phash: frameData.phash,
        ...(tree ? { treeHash: treeHash(tree.root) } : {}),
        maskedRegions: tree ? restlessRegions(tree.root) : [],
      },
      observedAt: frameData.at,
    };
    if (tree) observation.tree = tree;
    return observation;
  }

  async openFrameStream(): Promise<FrameStream | undefined> {
    return undefined;
  }

  ground(req: GroundRequest): Promise<GroundResult> {
    return this.router.ground(req, this.stepId);
  }

  judgePrint(req: AssertRequest): Promise<string | undefined> {
    return this.router.judgePrint(req);
  }

  assert(req: AssertRequest): Promise<AssertResult> {
    return this.router.assert(req, this.stepId);
  }

  aim(req: AimRequest): Promise<AimResult> {
    return this.router.aim(req, this.stepId);
  }

  extract<T = Record<string, unknown>>(req: ExtractRequest): Promise<ExtractResult<T>> {
    return this.router.extract<T>(req, this.stepId);
  }

  plan(req: PlanRequest): Promise<PlanResult> {
    return this.router.plan(req, this.stepId);
  }

  popup(req: PopupRequest): Promise<PopupResult> {
    return this.router.popup(req, this.stepId);
  }

  async act(req: ActionRequest): Promise<ActionResult> {
    const device = this.connected;
    const input = device.inputPrimitives;
    const params = req.params ?? {};
    const target: Point = req.target ?? { x: 0, y: 0 };

    // Deciding takes seconds -- a grounding call is five on a real phone --
    // and screens move while we think: a list finishes loading, a toast slides
    // in, a dialog takes focus. Tapping a point chosen for a screen that has
    // since moved is not a mis-grounding; it is a tap on whatever slid into
    // that spot, and it is invisible in the logs afterwards. So when the
    // decision has gone stale, look once more before acting.
    // On a playing video every frame differs from the one decided on, so the
    // frame says nothing against an action no spot can make stale: every wait
    // was dropped, and on a Shorts feed six swipes in a row, until the step ran
    // out of actions.
    if (req.staleGuard && !NEVER_STALE.has(req.name) && Date.now() - req.decidedFrom.observedAt > req.staleGuard.maxAgeMs) {
      const now = await this.captureFrame();
      const moved = hamming(req.decidedFrom.signature.phash, now.phash) > req.staleGuard.maxPhashDistance;
      // The screen moved -- but an action aimed at a spot is about that spot:
      // a preview playing elsewhere on the page does not move the search icon,
      // and where the spot itself is the playing video, the tree says whether
      // the control under it is still the one decided on.
      const aimed = req.target && AIMED.has(req.name);
      if (moved && (!aimed || ((await spotMoved(req.decidedFrom.frame.bytes, now.bytes, req.target!, req.decidedFrom.frame)) && !(await this.sameControl(req.decidedFrom, req.target!))))) {
        return { dispatchedAt: Date.now(), stale: true };
      }
    }

    const dispatchedAt = Date.now();

    switch (req.name) {
      case "tap":
        await input.pointer.tap(target);
        break;
      case "doubleTap":
        await input.pointer.doubleClick(target);
        break;
      case "longPress":
        await input.pointer.longPress(target, { duration: Number(params.duration ?? 800) });
        break;
      case "input": {
        if (req.target) await input.pointer.tap(target);
        // Typing appends; the step said what the field should hold. What was
        // in it goes first, unless the step said to add to it -- and then the
        // caret goes to the end, wherever the tap put it.
        if (params.append !== true) await input.keyboard.clearInput(undefined);
        else await input.keyboard.keyboardPress("End");
        // Typing to be sent keeps its keyboard: Enter is pressed into it next.
        await input.keyboard.typeText(String(params.value ?? ""), { autoDismissKeyboard: params.submit !== true });
        break;
      }
      case "clearInput":
        await input.keyboard.clearInput(undefined);
        break;
      case "swipe":
      case "scroll": {
        // Scrolling is a swipe until the scroll action's own parameters earn
        // their place (W2). A swipe that starts in the middle of the screen
        // and travels 40% of its height reads as a page scroll on every app
        // we have tried, and it never needs a scrollable container to exist.
        const { width, height } = await device.size();
        const direction = String(params.direction ?? "down");
        const from = (params.from as Point | undefined) ?? { x: Math.round(width / 2), y: Math.round(height / 2) };
        const travel = Math.round(height * 0.4);
        const to =
          (params.to as Point | undefined) ??
          (direction === "up"
            ? { x: from.x, y: from.y + travel }
            : direction === "left"
              ? { x: from.x + Math.round(width * 0.6), y: from.y }
              : direction === "right"
                ? { x: from.x - Math.round(width * 0.6), y: from.y }
                : { x: from.x, y: from.y - travel });
        // A swipe is a flick, and flings: what a page turns on -- the next
        // short, a carousel. A scroll is a drag that stops where the finger
        // does: in 300 ms the list flung past the row the agent was after,
        // both ways, six times running on a Xiaomi's Settings.
        await input.touch.swipe(from, to, { duration: Number(params.duration ?? (req.name === "scroll" ? SCROLL_MS : SWIPE_MS)) });
        break;
      }
      case "keyPress":
        await input.keyboard.keyboardPress(String(params.key ?? "Enter"));
        break;
      case "back":
        await input.system?.backButton?.();
        break;
      case "home":
        await input.system?.homeButton?.();
        break;
      case "recentApps":
        await input.system?.recentAppsButton?.();
        break;
      case "launchApp":
      case "openUrl":
        await device.launch(String(params.uri ?? params.app ?? ""));
        break;
      case "terminateApp": {
        const adb = await device.connect();
        await adb.shell(`am force-stop ${String(params.app ?? "")}`);
        break;
      }
      case "push":
        // FCM needs the app's own server key and a registered token, neither
        // of which a test runner can invent. Saying so beats doing nothing and
        // reporting success.
        throw new Error(
          "push notifications are not supported on Android yet -- they need the app's FCM credentials. " +
            "Deep links (openUrl) work today.",
        );
      case "wait":
        await new Promise((resolve) => setTimeout(resolve, Number(params.ms ?? 1000)));
        break;
      default: {
        const never: never = req.name;
        throw new Error(`unsupported action: ${String(never)}`);
      }
    }

    return { dispatchedAt, stale: false };
  }

  /** The calls notified before the current wait began, and which wait that was. */
  private callsBefore?: { since: number; keys: Set<string> };

  /** The tree alone, with no picture: what a watch for a call reads, many times a second if it can. */
  private async treeOnly(): Promise<TreeSnapshot | undefined> {
    const startedAt = Date.now();
    const raw = await this.captureTree(this.connected).catch(() => undefined);
    if (!raw?.root) return undefined;
    return { platform: "android", capturedAt: raw.capturedAt ?? startedAt, source: "uiautomator", root: normaliseNode(raw.root, 0), truncated: false, captureMs: Date.now() - startedAt };
  }

  /**
   * Watches for a call and answers it. A call screen in front is answered from
   * its tree. A ring that comes as a heads-up notification is not in the tree
   * of the app in front at all -- measured on a Pixel, which showed the
   * chat list and nothing else while the banner rang -- so when a new call
   * notification is posted the shade is pulled down, and its Answer pressed
   * there.
   */
  async answerCall(req: CallAnswerRequest): Promise<CallAnswer> {
    const device = this.connected;
    const adb = await device.connect();
    const started = Date.now();
    const deadline = started + req.withinMs;
    const notified = async () => callNotificationKeys(await adb.shell("dumpsys notification --noredact").catch(() => ""));
    if (this.callsBefore?.since !== req.since) this.callsBefore = { since: req.since, keys: new Set(await notified()) };
    const before = this.callsBefore.keys;
    let looks = 0;
    const press = async (where: string): Promise<CallAnswer | undefined> => {
      looks += 1;
      const tree = await this.treeOnly();
      const control = tree ? callAnswerControl(tree) : undefined;
      if (!control) return undefined;
      const { x, y, width, height } = control.bounds;
      await device.inputPrimitives.pointer.tap({ x: Math.round(x + width / 2), y: Math.round(y + height / 2) });
      return { answered: true, afterMs: Date.now() - req.since, pressed: control.label, where, looks };
    };
    while (Date.now() < deadline) {
      const onScreen = await press("on the screen");
      if (onScreen) return onScreen;
      const fresh = (await notified()).filter((key) => !before.has(key));
      if (fresh.length) {
        await adb.shell("cmd statusbar expand-notifications").catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, SHADE_MS));
        const inShade = await press("in the notification shade");
        if (inShade) return inShade;
        // Nothing there answers it: this notification is the eyes' to judge, not the shade's again.
        await adb.shell("cmd statusbar collapse").catch(() => undefined);
        for (const key of fresh) before.add(key);
      }
      await new Promise((resolve) => setTimeout(resolve, CALL_POLL_MS));
    }
    return { answered: false, afterMs: Date.now() - req.since, looks };
  }

  readonly app: AppControl = {
    launch: async (id: string) => {
      // A test starts from a known place. Two things get in the way of that on
      // a real phone: the app may be sitting three screens deep from the last
      // run, and an app's screens are not all in its own package -- Settings
      // keeps its search in com.android.settings.intelligence, which survives
      // force-stopping Settings and is restored on the next launch. So: stop
      // the package and its relatives, then start the launcher activity with
      // the task cleared, which is the only combination that reliably lands on
      // an app's first screen.
      const adb = await this.connected.connect();
      const before = (await this.captureFrame()).phash;
      await adb.shell(`am force-stop ${id}`);
      const recents = await adb.shell("dumpsys activity recents | grep -o 'A=[0-9]*:[a-zA-Z0-9_.]*'").catch(() => "");
      const relatives = new Set(
        [...recents.matchAll(/A=[0-9]*:([a-zA-Z0-9_.]+)/g)]
          .map((match) => match[1]!)
          .filter((pkg) => pkg !== id && pkg.startsWith(id)),
      );
      for (const relative of relatives) await adb.shell(`am force-stop ${relative}`);

      const resolved = (await adb.shell(`cmd package resolve-activity --brief ${id}`).catch(() => "")).trim();
      const component = resolved.split("\n").pop()?.trim();
      if (component?.includes("/")) {
        await adb.shell(launchCommand(component));
      } else {
        await this.connected.launch(id);
      }

      // An app opened under a system overlay has opened: the overlay is a
      // pop-up, and the first step's pop-up rules answer it. On a Huawei
      // phone the update sheet over Calculator failed every launch for 10 s.
      const resumed = async () => resumedPackage(await adb.shell("dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity'").catch(() => ""));
      const deadline = Date.now() + 10_000;
      for (;;) {
        const focus = await this.deviceState();
        if (launchedInFront(focus.appId, id) || (focus.appId !== undefined && launchedInFront(await resumed(), id))) {
          // Focus arrives before the first frame does, and an app's launch
          // screen is blank and perfectly still -- so waiting for stillness
          // alone settles on nothing. Wait for the screen to differ from what
          // was there before the launch, and then stop moving.
          await this.settleAfterLaunch(before);
          return;
        }
        if (Date.now() > deadline) {
          const pid = await adb.shell(`pidof ${id}`).catch(() => "");
          const home = (await adb.shell("cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME").catch(() => "")).trim().split("\n").pop()?.split("/")[0]?.trim();
          if (launchedBehind(focus.appId, home, pid)) {
            await this.settleAfterLaunch(before);
            return;
          }
          throw new Error(
            `${id} did not come to the foreground within 10s` +
              (focus.appId ? ` -- ${focus.appId} is in front instead` : ""),
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    },
    terminate: async (id: string) => {
      const adb = await this.connected.connect();
      const before = (await this.captureFrame()).phash;
      await adb.shell(`am force-stop ${id}`);
    },
    install: async (path: string) => {
      const adb = await this.connected.connect();
      await adb.install(path);
    },
    installed: async (appId: string) => {
      const adb = await this.connected.connect();
      return /^package:/m.test(await adb.shell(`pm path ${appId}`).catch(() => ""));
    },
    currentBuildId: async (appId: string) => {
      const adb = await this.connected.connect();
      const out = await adb.shell(`dumpsys package ${appId} | grep -E "versionName|versionCode"`);
      const name = /versionName=(\S+)/.exec(out)?.[1];
      const code = /versionCode=(\d+)/.exec(out)?.[1];
      if (!name && !code) return undefined;
      return `${appId}@${name ?? "?"}+${code ?? "?"}`;
    },
  };

  readonly logs = {
    open: async (appId?: string): Promise<LogStream> => {
      if (!this.handle) throw new DeviceNotReadyError("no device attached");
      if (!appId) throw new Error("a device log is read for one app, and none was named");
      return androidLogStream(this.handle.id, appId);
    },
  };
}
