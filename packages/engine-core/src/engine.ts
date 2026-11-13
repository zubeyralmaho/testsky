/**
 * The seam between "drive a device" and "decide what to do".
 *
 * The important thing about this interface is not that it lets us replace the
 * engine. It is the direction of the `ground` call: it takes an `Observation`
 * the caller already holds, instead of telling the engine to go and look at the
 * screen. Perception belongs to us, and that inversion is what makes the action
 * cache, the staleness guard and step-indexed evidence possible at all -- an
 * engine that owns perception internally can offer none of the three.
 *
 * So the adapter implements the mechanical half (attach, observe, act, stream,
 * app, logs) and delegates the thinking half (ground, assert, extract, plan) to
 * the router, which is the only module allowed to construct a model client.
 */

import type {
  ActionRequest,
  ActionResult,
  AimRequest,
  AimResult,
  AssertRequest,
  AssertResult,
  DeviceHandle,
  EngineCapabilities,
  ExtractRequest,
  ExtractResult,
  FrameStream,
  GroundRequest,
  GroundResult,
  LogStream,
  Observation,
  PlanRequest,
  PlanResult,
  PopupRequest,
  PopupResult,
} from "./types.ts";

export interface ObserveOptions {
  /**
   * `true` always captures the tree, `false` never does, `'auto'` captures it
   * only when it will be used -- a cache miss, a low-confidence step, or a
   * blind frame. The default is `'auto'` because a uiautomator dump costs
   * hundreds of milliseconds and the happy path does not need it.
   */
  tree?: boolean | "auto";
  /** Bypass any cached frame and capture a new one. */
  fresh?: boolean;
  /**
   * Keep capturing until the screen stops changing. Costs at least one extra
   * capture, and is worth it after anything that moves the screen: an app
   * launch, a tap, a swipe. Without it the next decision is made about a
   * transition rather than about a screen.
   */
  settle?: boolean;
  /** How long settling may take before we accept whatever is there. */
  settleMs?: number;
  /**
   * The screen as it was before an action: settling first waits, a moment at
   * most, for a picture that differs from it. A Settings app on a Nothing
   * phone answered a press so slowly that two still frames of the screen
   * before it read as settled, and each decision was made one press late.
   */
  changedFrom?: string;
}

export interface AppControl {
  launch(id: string): Promise<void>;
  terminate(id: string): Promise<void>;
  install(path: string): Promise<void>;
  /**
   * e.g. "com.acme.shop@4.12.0+1877" -- the action cache's invalidation key.
   * Keyed by app because a run may touch more than one, and a cache entry that
   * outlives the build it was learned on is the "stale memory after an app
   * update" failure every competitor documents and none prevents.
   */
  currentBuildId(appId: string): Promise<string | undefined>;
  /**
   * Whether an app is on the device; undefined when the device cannot say.
   * A test lists the apps it may run as -- Chrome, and Huawei's own browser
   * where there is no Chrome -- and runs as the first one a phone has.
   */
  installed?(appId: string): Promise<boolean | undefined>;
}

export interface Engine {
  /** Identifies the implementation and its version, e.g. "midscene@1.13.3". */
  readonly name: string;
  readonly capabilities: EngineCapabilities;

  attach(device: DeviceHandle): Promise<void>;
  detach(): Promise<void>;

  observe(opts?: ObserveOptions): Promise<Observation>;
  openFrameStream(): Promise<FrameStream | undefined>;

  ground(req: GroundRequest): Promise<GroundResult>;
  act(req: ActionRequest): Promise<ActionResult>;
  assert(req: AssertRequest): Promise<AssertResult>;
  /**
   * An assertion as the engine would put it to a model, as a print: equal
   * prints are the same question on the same input. An engine without it has
   * no checks remembered.
   */
  judgePrint?(req: AssertRequest): Promise<string | undefined>;
  /**
   * Whether an action went to what its step names, judged on the screen it
   * was decided on. An engine without it never takes the blame off an app.
   */
  aim?(req: AimRequest): Promise<AimResult>;
  extract<T = Record<string, unknown>>(req: ExtractRequest): Promise<ExtractResult<T>>;
  /** The escape hatch for an unknown screen -- never the main path. */
  plan(req: PlanRequest): Promise<PlanResult>;
  /** Whether a pop-up is in the way, and the control that answers it by the rules. */
  popup(req: PopupRequest): Promise<PopupResult>;
  /**
   * Watches for an incoming call for up to `withinMs` and presses its answer
   * control the moment the device shows one, asking no model: a ring lasts
   * about thirty seconds and a heads-up banner folds away in five. An engine
   * without it leaves the call to the eyes.
   */
  answerCall?(req: CallAnswerRequest): Promise<CallAnswer>;

  readonly app: AppControl;
  /** The named app's own device log, on the run's clock, from now until closed. */
  readonly logs: { open(appId?: string): Promise<LogStream> };
}

export interface CallAnswerRequest {
  /** How long to watch before giving the turn back. */
  withinMs: number;
  /** When the whole wait began: a call already notified before it is an old one. */
  since: number;
}

export interface CallAnswer {
  answered: boolean;
  /** From the start of the watch to the press, or to giving up. */
  afterMs: number;
  /** The words of the control pressed. */
  pressed?: string;
  /** Where it was found: on the screen, in the notification shade, ... */
  where?: string;
  /** How many times the device was looked at. */
  looks: number;
}
