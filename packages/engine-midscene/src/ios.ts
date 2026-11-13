/**
 * The same Engine, on an iPhone simulator.
 *
 * Structurally this is the Android adapter with three differences, and each
 * one is a fact about the platform rather than a design choice:
 *
 *  - **Midscene has no tree here.** Its iOS device never implements
 *    `getUITree` and its WebDriver client wraps no `/source`, so the tree
 *    comes from our own WDA client. On iOS that is not a nicety: the same
 *    models score around 52% with the tree and 20-29% from pixels alone.
 *  - **Nothing starts WebDriverAgent.** Midscene probes port 8100 and tells
 *    the user to open Xcode. The runner starts it instead, because "open
 *    Xcode" is a support call, not an install step.
 *  - **There is no back button.** iOS navigates back with an edge swipe, so
 *    that is what `back` does here. Pretending the action exists and silently
 *    doing nothing would be worse than not offering it.
 */

import { IOSDevice } from "@midscene/ios";

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
  TreeSnapshot,
  VisionStats,
} from "@testsky/engine-core";
import { DeviceNotReadyError } from "@testsky/engine-core";
import {
  appExecutable,
  appInstalled,
  appVersion,
  bootSimulator,
  DEFAULT_WDA_PORT,
  ensureWda,
  forwardedWda,
  freezeStatusBar,
  installApp,
  launchApp,
  mjpegPortFor,
  pushNotification,
  releaseStatusBar,
  terminateApp,
  controlPredicate,
  wdaKeyboardUp,
  wdaPress,
  wdaTree,
  wdaTypeIntoFieldAt,
  type WdaHandle,
  type WdaPress,
} from "@testsky/devicectl-ios";
import { callAnswerControl, dhash, hamming, isVisionBlind, restlessRegions, sameControlAt, spotMoved, treeHash, visionStats } from "@testsky/perception";
import type { Router } from "@testsky/router";

import { controlLocator } from "./control.ts";
import { iosLogStream } from "./logs.ts";
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
const SETTLED_DISTANCE = 4;
/** How long a settle waits for an action's answer to show before taking the screen as it is. */
const CHANGE_WITHIN_MS = 1500;

/** A breath between tree reads while a call is waited for. */
const CALL_POLL_MS = 250;

/** Below this much luma spread a frame carries no content worth judging. */
const LAUNCH_CONTENT_FLOOR = 8;

export interface IosEngineOptions {
  router: Router;
  /** A WebDriverAgent port to use as given; otherwise each simulator's own. */
  wdaPort?: number;
  onProgress?: (message: string) => void;
}

export class IosMidsceneEngine implements Engine {
  readonly name = `midscene@${MIDSCENE_VERSION}+wda`;
  readonly capabilities: EngineCapabilities = {
    tree: true,
    frameStream: false,
    networkCapture: false,
    nativePlanning: true,
    appInstall: true,
    pressesControls: true,
  };

  private device?: IOSDevice;
  private handle?: DeviceHandle;
  private statusBarFrozen = false;
  private wda?: WdaHandle;
  private ratio = 1;
  private readonly router: Router;
  private readonly wdaPort?: number;
  /** Where this simulator's WebDriverAgent answers, once attached. */
  private port = DEFAULT_WDA_PORT;
  private readonly onProgress?: (message: string) => void;
  stepId?: string;
  /** The app the test launched, so a push knows who to wake. */
  private lastLaunched?: string;

  constructor(options: IosEngineOptions) {
    this.router = options.router;
    if (options.wdaPort !== undefined) this.wdaPort = options.wdaPort;
    if (options.onProgress) this.onProgress = options.onProgress;
  }

  private get connected(): IOSDevice {
    if (!this.device) throw new DeviceNotReadyError("the iOS engine is not attached to a simulator");
    return this.device;
  }

  async attach(device: DeviceHandle): Promise<void> {
    if (device.platform !== "ios") {
      throw new Error(`the iOS engine cannot drive a ${device.platform} device`);
    }

    if (device.kind === "physical") {
      // A phone is driven through the WebDriverAgent already running on it:
      // building and signing one takes a team and a profile per phone, which
      // a lab rig has and testsky does not.
      this.wda = await forwardedWda(device.id, this.wdaPort);
    } else {
      await bootSimulator(device.id);
      this.wda = await ensureWda({
        udid: device.id,
        ...(this.wdaPort !== undefined ? { port: this.wdaPort } : {}),
        ...(this.onProgress ? { onProgress: this.onProgress } : {}),
      });
    }
    this.port = this.wda.port;

    // A simulator's own MJPEG port too: left to the default, every simulator's
    // frames would be read off the first simulator's stream. A phone's stream
    // is forwarded by the rig, if at all.
    const ios = new IOSDevice({ wdaPort: this.port, ...(device.kind === "physical" ? {} : { wdaMjpegPort: mjpegPortFor(this.port) }) });
    await ios.connect();
    this.device = ios;
    this.handle = device;
    // Memory is kept per screen layout, and this is where the layout is
    // learned. Unknown, the platform's one lock is used, as before layouts.
    const size = await ios.size().catch(() => undefined);
    if (size) device.size = { width: size.width, height: size.height };
    // A still clock, so that an unchanged screen is the same screen from one
    // run to the next. Without it every check is a model's again. Only a
    // simulator's status bar can be frozen.
    this.statusBarFrozen = device.kind === "physical" ? false : await freezeStatusBar(device.id).catch(() => false);
  }

  /** The control under a point now is the one the decision saw there -- read from a fresh tree. */
  private async sameControl(decidedFrom: Observation, point: Point): Promise<boolean> {
    if (!decidedFrom.tree) return false;
    // Which control is under a point, not whether it is drawn: the quick read.
    const now = await wdaTree(this.port, { visibility: false }).catch(() => undefined);
    return Boolean(now) && sameControlAt(decidedFrom.tree.root, now!.root, point);
  }

  /** A phone on a cable, rather than a simulator: what simctl does for a simulator, WebDriverAgent does for it, or nobody. */
  private get physical(): boolean {
    return this.handle?.kind === "physical";
  }

  private unsupported(what: string): never {
    throw new DeviceNotReadyError(`${what} on a physical iPhone is not supported yet`);
  }

  async detach(): Promise<void> {
    if (this.statusBarFrozen && this.handle) await releaseStatusBar(this.handle.id);
    this.statusBarFrozen = false;
    await this.device?.destroy?.();
    // Only stop what we started: a WebDriverAgent somebody else is using
    // outlives our run.
    this.wda?.stop();
    delete this.device;
    delete this.handle;
    delete this.wda;
  }

  private async captureFrame(): Promise<{ bytes: Buffer; stats: VisionStats; blind: boolean; phash: string; at: number }> {
    const device = this.connected;
    let bytes = Buffer.alloc(0);
    let stats: VisionStats = { meanLuma: 0, stdLuma: 0, uniqueColors: 0 };
    let blind = true;
    let at = Date.now();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400));
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
   * Captures until the screen stops moving, after first waiting -- up to
   * CHANGE_WITHIN_MS -- for it to show something other than `changedFrom`,
   * the screen before an action. A press that changes nothing costs that
   * wait; one the app answers late is judged on its answer.
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
    const frameData = opts?.settle ? await this.captureSettled(6000, opts.changedFrom) : await this.captureFrame();
    const logical = await device.size();
    const pixels = pngSize(frameData.bytes);
    this.ratio = logical.width > 0 ? pixels.width / logical.width : 1;

    const frame: Frame = {
      bytes: frameData.bytes,
      capturedAt: frameData.at,
      size: logical,
      pixelRatio: this.ratio,
    };

    const wantTree = opts?.tree === true || (opts?.tree !== false && frameData.blind);
    let tree: TreeSnapshot | undefined;
    if (wantTree) tree = await wdaTree(this.port).catch(() => undefined);

    const observation: Observation = {
      frame,
      appContext: {},
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

    // A tap on a control the tree names is made as XCUITest makes one, on the
    // control wherever it is at that moment: a Wi-Fi list re-sorting as it
    // scans moved the row the agent chose between the tree read and the tap,
    // and the coordinates opened another network's password sheet. One that is
    // gone is a screen that moved on.
    let pointBecause: string | undefined;
    if (req.name === "tap" && req.target && req.decidedFrom.tree) {
      const locator = controlLocator(req.decidedFrom.tree, req.target);
      if (locator) {
        const dispatchedAt = Date.now();
        const pressed = await wdaPress(this.port, locator).catch((): WdaPress => "unavailable");
        if (pressed === "pressed") return { dispatchedAt, stale: false, via: "control" };
        // Gone is gone, guard or not: a remembered press replayed at its
        // point on a list re-sorting as it scanned opened another network's
        // password sheet. Nothing pressed; the step decides again.
        if (pressed === "absent") return { dispatchedAt, stale: true };
        pointBecause = `${pressed}: ${locator.value}`;
      } else pointBecause = "the tree names no one control there";
    }

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
    const { width, height } = await device.size();

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
        // in it goes first, unless the step said to add to it.
        if (params.append !== true) await input.keyboard.clearInput(undefined);
        const text = String(params.value ?? "");
        // A tap on the password field of iOS 27's join sheet left the keyboard
        // down, and every key went nowhere. With no keyboard, the field at the
        // point is typed into as an element, which brings the keyboard itself.
        if (req.target && (await wdaKeyboardUp(this.port)) === false && (await wdaTypeIntoFieldAt(this.port, target, text))) {
          if (params.submit === true) await input.keyboard.keyboardPress("Enter");
          break;
        }
        // Typing to be sent keeps its keyboard: Enter is pressed into it next.
        await input.keyboard.typeText(text, { autoDismissKeyboard: params.submit !== true });
        break;
      }
      case "clearInput":
        await input.keyboard.clearInput(undefined);
        break;
      case "swipe":
      case "scroll": {
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
        // iOS has no back button. The edge swipe is the gesture people
        // actually use, and it is what "go back" has to mean here.
        await input.touch.swipe(
          { x: 2, y: Math.round(height / 2) },
          { x: Math.round(width * 0.8), y: Math.round(height / 2) },
          { duration: 300 },
        );
        break;
      case "home":
        await input.system?.homeButton?.();
        break;
      case "recentApps":
        throw new Error("the task switcher is not available on iOS");
      case "launchApp":
      case "openUrl":
        await device.launch(String(params.uri ?? params.app ?? ""));
        break;
      case "push": {
        // A real notification, delivered by the system: simctl hands APNs the
        // payload, so what the app receives is what it would receive in the
        // wild. Tests that reach a screen through a push are testing the thing
        // people actually do, and nobody in this category supports it.
        const udid = this.handle?.id;
        const bundle = String(params.app ?? this.lastLaunched ?? "");
        if (!udid || !bundle) throw new Error("push needs a launched app to deliver to");
        if (this.physical) this.unsupported("a push notification");
        await pushNotification(udid, bundle, {
          aps: {
            alert: { title: String(params.title ?? "Notification"), body: String(params.body ?? "") },
            ...(params.badge ? { badge: Number(params.badge) } : {}),
          },
          ...((params.payload as Record<string, unknown>) ?? {}),
        });
        break;
      }
      case "terminateApp":
        if (this.physical) await device.terminate(String(params.app ?? ""));
        else if (this.handle) await terminateApp(this.handle.id, String(params.app ?? ""));
        break;
      case "wait":
        await new Promise((resolve) => setTimeout(resolve, Number(params.ms ?? 1000)));
        break;
      default: {
        const never: never = req.name;
        throw new Error(`unsupported action: ${String(never)}`);
      }
    }

    return { dispatchedAt, stale: false, ...(pointBecause ? { pointBecause } : {}) };
  }

  /**
   * Watches for a call and answers it: the app in front's tree, read without
   * asking what is drawn (0.2 s instead of 2-3 s), and the answer control
   * pressed as an element once XCUITest says it is drawn. A ring the tree in
   * front does not hold -- a banner over another app -- is the eyes' to find.
   */
  async answerCall(req: CallAnswerRequest): Promise<CallAnswer> {
    const deadline = Date.now() + req.withinMs;
    let looks = 0;
    while (Date.now() < deadline) {
      looks += 1;
      const tree = await wdaTree(this.port, { visibility: false }).catch(() => undefined);
      const control = tree ? callAnswerControl(tree) : undefined;
      if (control) {
        const predicate = controlPredicate({ role: control.node.role, ...(control.node.label ? { label: control.node.label } : {}), ...(control.node.identifier ? { identifier: control.node.identifier } : {}) });
        const pressed: WdaPress = predicate ? await wdaPress(this.port, { using: "predicate string", value: predicate }, undefined, { drawnOnly: true }).catch((): WdaPress => "unavailable") : "unavailable";
        if (pressed === "pressed") return { answered: true, afterMs: Date.now() - req.since, pressed: control.label, where: "on the screen", looks };
        if (pressed !== "absent") {
          const { x, y, width, height } = control.bounds;
          await this.connected.inputPrimitives.pointer.tap({ x: Math.round(x + width / 2), y: Math.round(y + height / 2) });
          return { answered: true, afterMs: Date.now() - req.since, pressed: control.label, where: "on the screen, at its place", looks };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, CALL_POLL_MS));
    }
    return { answered: false, afterMs: Date.now() - req.since, looks };
  }

  readonly app: AppControl = {
    launch: async (id: string) => {
      const udid = this.handle?.id;
      if (!udid) throw new DeviceNotReadyError("no simulator attached");
      this.lastLaunched = id;
      // A test starts from a known place, on iOS as on Android.
      const before = (await this.captureFrame()).phash;
      if (this.physical) {
        const device = this.connected;
        await device.terminate(id).catch(() => undefined);
        await device.launch(id);
      } else {
        await terminateApp(udid, id);
        await launchApp(udid, id);
      }
      await this.settleAfterLaunch(before);
    },
    terminate: async (id: string) => {
      if (this.physical) await this.connected.terminate(id).catch(() => undefined);
      else if (this.handle) await terminateApp(this.handle.id, id);
    },
    install: async (path: string) => {
      if (!this.handle) throw new DeviceNotReadyError("no simulator attached");
      if (this.physical) this.unsupported("installing an app");
      await installApp(this.handle.id, path);
    },
    // A phone does not say what it has installed yet.
    installed: async (appId: string) => {
      if (!this.handle || this.physical) return undefined;
      return appInstalled(this.handle.id, appId);
    },
    // A phone's installed build is not read yet: its memory is kept without one.
    currentBuildId: async (appId: string) => {
      if (!this.handle || this.physical) return undefined;
      return appVersion(this.handle.id, appId);
    },
  };

  readonly logs = {
    open: async (appId?: string): Promise<LogStream> => {
      if (!this.handle) throw new DeviceNotReadyError("no simulator attached");
      if (this.physical) this.unsupported("reading the device log");
      if (!appId) throw new Error("a device log is read for one app, and none was named");
      // The log goes by the process's name, which is usually the bundle id's
      // last word when the container cannot be read.
      const processName = (await appExecutable(this.handle.id, appId)) ?? appId.split(".").pop()!;
      return iosLogStream(this.handle.id, processName);
    },
  };
}
