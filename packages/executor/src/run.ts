/**
 * One test, start to finish.
 *
 * W1's loop is deliberately the smallest thing that is still the real shape:
 * observe, decide, ground, act, check. The pieces that make it cheap and
 * trustworthy -- the action cache, the staleness and loop guards, the
 * stability score -- slot into this same loop in W2 and W3 without moving it.
 *
 * What it already refuses to do: report a budget overrun as a failed
 * expectation, or claim a step passed when the check never ran.
 */


import {
  adoptBuild,
  popupRules,
  PRINTS_KEPT,
  type Directive,
  type HealDecision,
  type HealRecord,
  type LockFile,
  type ResolvedAction,
  type RememberedVerdict,
  type StepResolution,
  type TestFile,
  type TestStep,
} from "@testsky/artifact";
import { type Verdict, ANCHOR_DRIFT, applyHealDecisions, applyLockReviews, relocateAnchor, sameHeal, sameTarget, screenMatches, verifyAnchor } from "@testsky/cache";
import { anchorAt, checkable, claimsIn, compactTree, fieldAt, hamming, locateInTree, pointInside, pressableAt, readSystemPrompt, textHash, treeEvidence } from "@testsky/perception";
import type {
  ActionName,
  AimResult,
  AssertResult,
  DeviceHandle,
  Engine,
  GroundResult,
  Observation,
  Journey,
  PlanHistoryEntry,
  PopupKind,
  Point,
  PopupRules,
  StepBudget,
  StepLedger,
  TreeNode,
  TreeSnapshot,
} from "@testsky/engine-core";
import { DeviceNotReadyError } from "@testsky/engine-core";
import { ESCALATE_BELOW, ModelError, NotOnScreenError, SourcesDisagreeError, type CostLedger } from "@testsky/router";

import { type Outcome, isFailure } from "./outcome.ts";
import { POPUP_NAMES, findPopup } from "./popups.ts";
import { compareTyped } from "./typed.ts";

/** Actions the agent may choose from while satisfying one authored step. */
const ACTION_SPACE: ActionName[] = [
  "tap",
  "doubleTap",
  "longPress",
  "input",
  "swipe",
  "scroll",
  "keyPress",
  "back",
  "openUrl",
  "push",
  "wait",
];

/**
 * How many device actions the agent may take in one authored step before we
 * stop it, unless it earns more. Replayed memory is not the agent's and is not
 * counted: a step learned in ten actions and doubted at its last still gets
 * its six.
 *
 * An action earns EARNED_PER_NEW_SCREEN more when it did what the agent said
 * it would -- the agent, looking at what it left, says so -- and left a screen
 * this step has not seen before. Its word about a screen it has seen buys
 * nothing: an agent going round three screens, calling each as expected, stops
 * where it always did plus what its first pass earned. "Forget every saved
 * network" earns its way: each pass leaves the list one row shorter, which is
 * a screen not seen before, and three actions is what forgetting one takes.
 */
const ACTIONS_PER_STEP = 6;
const EARNED_PER_NEW_SCREEN = 3;
/** Over what a step spells out, when that is more than six. */
const NAMED_SPARE = 2;
/**
 * However much it earns. Past this a step is not getting there one action at
 * a time -- and on a shared phone, a confused agent told to forget things is
 * doing harm with each of them. Many more than this is a job for a device
 * command, not for the screen.
 */
const ACTIONS_CEILING = 30;

/** The same action on the same screen this many times inside this window is a
 *  loop, not a plan. */
const LOOP_WINDOW = 6;
const LOOP_REPEATS = 3;

/** Actions in a row that change nothing on screen before we call it stuck. */
const NO_PROGRESS_LIMIT = 3;

/** A decision older than this is re-checked against the screen before it is
 *  carried out. Grounding alone takes several seconds on a real phone. */
const STALE_AFTER_MS = 2500;
const STALE_DISTANCE = 6;

/**
 * An expectation gets a short grace period before it is called false.
 *
 * Screens finish arriving after the action that asked for them: a search
 * result list renders a placeholder first, a network call lands a beat later.
 * Judging the first frame turns "slow" into "your app is broken", which is the
 * one verdict this product may not get wrong. Two extra looks, a second and a
 * half apart, cost two cheap calls on a step that was going to fail anyway.
 */
const EXPECT_ATTEMPTS = 3;
const EXPECT_GRACE_MS = 1500;
/** Between looks while an expectation is waited for (`within`). */
const WITHIN_LOOK_MS = 500;
/**
 * Looks between two judgements of a screen that keeps changing while it is
 * waited for -- a spinner, a clock -- unless its tree already shows what the
 * expectation quotes. A wait costs a call every few seconds at most, never
 * one a look; a still screen costs one for the whole wait.
 */
const WITHIN_ASK_LOOKS = 4;
/**
 * Looks at a screen before its expectation is answered, by a model or from
 * memory, to see whether it is still settling to the pixel: iOS fades a scroll
 * bar for a second after a list stops, and a glass bar is mid-transition as
 * often as not. Measured on Settings, three of four checks missed their memory
 * for exactly that, and cost a model call each. A page pushed onto Settings
 * still drew its scroll bar 2.4s after the tap and was at rest by 3.8s --
 * beyond two looks, when an iOS look with its tree takes over a second.
 */
const REST_LOOKS = 4;
/** Between those looks, unless settling is off, as in tests. */
const REST_MS = 300;
/**
 * Where a screen did not come to rest in those looks, one look is enough the
 * next time: a video or an autoplaying feed never does, and the looks cost it
 * about 15 s before every check of a playing video on a Nothing phone. One look
 * that agrees still counts as rest, and clears the place, so a page that does
 * stop is remembered as ever. All this can cost is a model call.
 */
/** A control, not most of the screen: a press on a container is not followed anywhere. */
/** How long the engine watches the tree for a call before the screen is looked at once. */
const CALL_EYES_EVERY_MS = 4000;
const CALL_RINGING =
  "an incoming call is ringing on this screen: an incoming-call screen or banner, with a control that accepts it (Accept, Answer, Kabul Et, a green phone, a blue check or a video-camera icon) and one that declines it";
const CALL_ACCEPT =
  "the control that ACCEPTS the incoming call -- Accept, Answer, Join, Kabul Et, Cevapla, or the green phone, blue check or video-camera answer icon -- never the one that declines, ignores or ends it";

/**
 * Waits up to the step's `ring` for a call and answers it. A ring is about
 * thirty seconds and Android folds its heads-up banner away in five, so the
 * engine's own watch, a tree read and no model, has the turn nearly all the
 * time; every few seconds the screen is looked at, for a ring drawn where the
 * tree cannot see it.
 */
async function answerCall(args: {
  engine: Engine;
  step: TestStep;
  budget: StepBudget;
  emit: (event: Omit<RunEvent, "at">) => void;
  see: (opts?: { settle?: boolean }) => Promise<Observation>;
}): Promise<{ ok: boolean; detail: string }> {
  const { engine, step, budget, emit, see } = args;
  const ring = step.ring ?? 0;
  const started = Date.now();
  const deadline = started + ring;
  let looks = 0;
  let eyes = 0;
  emit({ kind: "note", stepId: step.id, message: `watching for a call for up to ${Math.round(ring / 1000)} s, to answer it the moment it rings` });
  const answered = async (pressed: string, via: "tree" | "eyes", where: string, decidedOn?: Observation): Promise<{ ok: true; detail: string }> => {
    const after = Math.round((Date.now() - started) / 1000);
    emit({
      kind: "action",
      stepId: step.id,
      message: `answer the call: pressed "${pressed}" ${where}, ${after} s into the wait`,
      data: { via, afterMs: Date.now() - started, looks, eyes, ...(decidedOn ? { screen: decidedOn.frame.size } : {}) },
      ...(decidedOn ? { screenshot: decidedOn.frame.bytes, shotId: `${step.id}.action-1` } : {}),
    });
    return { ok: true, detail: `the call rang and was answered ${after} s into the wait, by pressing "${pressed}" ${where}` };
  };
  while (Date.now() < deadline) {
    if (engine.answerCall) {
      const watched = await engine.answerCall({ withinMs: Math.min(CALL_EYES_EVERY_MS, deadline - Date.now()), since: started });
      looks += watched.looks;
      if (watched.answered) return answered(watched.pressed ?? "answer", "tree", watched.where ?? "on the screen");
    }
    if (Date.now() >= deadline) break;
    eyes += 1;
    const seen = await see({}).catch(() => undefined);
    if (!seen) continue;
    const ringing = await engine.assert({ observation: seen, assertion: CALL_RINGING }).catch(() => undefined);
    if (!ringing?.pass) {
      if (!engine.answerCall) await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    try {
      const found = await engine.ground({ observation: seen, description: CALL_ACCEPT, budget });
      const pressed = await engine.act({ name: "tap", target: found.point, decidedFrom: seen });
      if (!pressed.stale) return answered("the accept control", "eyes", "found by looking", seen);
    } catch (error) {
      emit({ kind: "note", stepId: step.id, message: `a call looked to be ringing, but its accept control was not found: ${(error as Error).message}` });
    }
  }
  return {
    ok: false,
    detail: `no call was answered in ${Math.round(ring / 1000)} s: the tree was read ${looks} times and the screen looked at ${eyes} times, and no call showed`,
  };
}

/** What the text fields on a screen hold, as the tree says: a change here is a change, whatever the picture shows. */
const FIELD_ROLE = /(?:TextField|SearchField|EditText|AutoCompleteTextView)$/;
function fieldsHold(tree: Observation["tree"]): string | undefined {
  if (!tree) return undefined;
  const held: string[] = [];
  const visit = (node: TreeNode): void => {
    if (FIELD_ROLE.test(node.role)) held.push(`${node.role}:${node.label ?? ""}:${node.value ?? ""}`);
    for (const child of node.children) visit(child);
  };
  visit(tree.root);
  return held.join("\n");
}

const smallPart = (bounds: { width: number; height: number }, size: { width: number; height: number }) =>
  bounds.width * bounds.height < 0.4 * size.width * size.height;

const placeOf = ({ appContext }: Observation) => `${appContext.appId ?? ""}/${appContext.screenId ?? ""}`;
/**
 * A remembered pass is put to a model again after this many in a row: one
 * wrong "yes" must not stand for as long as a screen stays the same, and a
 * better model or better instructions should get to look eventually.
 */
const REVERIFY_AFTER = 10;
/** Model passes on a print before it is answered from memory. */
const CONFIRMED_AFTER = 2;
/**
 * Turns one step may take, acting or not. Every other bound counts actions,
 * and a turn that plans without acting -- a pop-up named and not answered, a
 * target missed -- counts none; this one holds whatever path the step is on,
 * and with it the model calls a step can make.
 */
const TURNS_PER_STEP = 20;
/** Turns grow with the actions a step earns, and stop here. */
const TURNS_CEILING = 44;
/**
 * Times the agent may say a step without an expectation is done while what
 * it said done means does not hold. Told once and given the chance to carry
 * on; the second time it is not done, and it does not get to say it is.
 */
const DONE_REFUSALS = 2;
/**
 * Targets a step may fail to find before it gives up. A target that is not on
 * this screen is usually somewhere else -- a row the step before scrolled out
 * of view -- and the agent, told so, can go and get it; failing on the first
 * miss turned a scrolled list into "the test could not find an element".
 */
const MISSES_PER_STEP = 2;

/**
 * Pop-ups one step may answer. A long wait meets many -- notifications, an
 * update nag, a tip, the account's password prompt, and the same again. The
 * bound only stops a dialog that reopens forever.
 */
const POPUPS_PER_STEP = 12;

/**
 * Presses dropped in a row because the screen moved, before the next one is
 * pressed where it was just found. On a playing live stream every frame moves
 * and the phone's tree cannot be read: each tap at the picture was dropped until
 * the step ran out of actions, without one having been tried.
 */
const STALE_DROPS = 2;

/**
 * The test's time is checked between calls, so a call that never returns is
 * outlived by this much before the run is given up on: more than a model's
 * longest honest wait. Then the phone is still tidied, for at most TIDY_MS.
 */
const STUCK_AFTER_MS = 600_000;
const TIDY_MS = 30_000;

/** A pop-up's title that is the app's own failure, not something in the way. */
const APP_FAILURE = /\b(fail(ed|ure)?|error|unable|could not|can't|cannot|declined|denied)\b|başarısız|hata|yapılamadı|reddedildi/i;

/**
 * Why this action cannot be carried out as asked, or null if it can.
 *
 * Executing a malformed action is worse than refusing one: an `input` with no
 * text types an empty string into a field, the screen does not change, and the
 * agent reads that as "typing does not work here" and tries something else.
 * Refusing it and saying why puts the correction in the planner's own history,
 * which is the only place it will read.
 */
function rejectReason(action: { name: ActionName; describeTarget?: string; params?: Record<string, unknown> }): string | null {
  const params = action.params ?? {};
  switch (action.name) {
    case "input": {
      const value = params.value;
      if (typeof value !== "string" || !value.length) {
        return 'input needs params.value: the text to type, e.g. {"name":"input","describeTarget":"the search field","params":{"value":"bluetooth"}}';
      }
      return null;
    }
    case "openUrl":
      return typeof params.uri === "string" && params.uri ? null : "openUrl needs params.uri";
    case "push":
      return params.payload || params.title ? null : "push needs params.payload (an APNs payload) or params.title";
    case "launchApp":
    case "terminateApp":
      return typeof params.app === "string" && params.app ? null : `${action.name} needs params.app`;
    default:
      return null;
  }
}

/**
 * The actions that need a point on the screen.
 *
 * Everything else -- back, a key press, a wait, a swipe with computed ends --
 * needs no target, and asking a grounder for one invites the planner's own
 * fiction: it will happily name "waiting for the screen to load" as an element
 * and the grounder will spend a call proving it is not there.
 */
const NEEDS_TARGET: ReadonlySet<ActionName> = new Set(["tap", "doubleTap", "longPress", "input"]);

/**
 * How many actions a step spells out: "by pressing 1, 0, 0, 0, the divide key,
 * 8 and the equals key" is seven. A step that names more than six gets what
 * it names, and two to spare: on one screen whose controls never change --
 * a calculator's keys -- nothing else earns them, and seven presses ran out
 * at six. What is quoted is what is typed, not a list of things to do.
 */
export function namedActions(text: string | undefined): number {
  if (!text) return 0;
  const unquoted = text.replace(/“[^”]*”|"[^"]*"/g, "the text");
  return unquoted.split(/,|\band\b|\bthen\b/).filter((part) => part.trim()).length;
}

/**
 * Words that make what follows optional: "if an ad plays, skip it", "close the
 * dialog in case one shows", "reklam çıkarsa geç". Only conditions: "when the
 * form opens, tap Save" and "as soon as", "-ınca", "-dığında" say what comes
 * after what, and the Save is owed. English and Turkish, the two languages
 * tests here are written in; the Turkish verb forms are named, not guessed
 * from an ending -- "reverse" ends like "gelirse", and an SSID's ü is not a
 * Turkish sentence.
 */
const CONDITION_EN = /\b(?:if|in case|unless)\b/i;
const CONDITION_TR =
  /(?<!\p{L})(?:eğer|varsa|yoksa|durumunda|halinde|takdirde|çıkarsa|gelirse|olursa|görünürse|açılırsa|isterse|sorarsa|belirirse|gösterirse|kalırsa|düşerse|verirse|\p{L}+(?:yorsa|yorse|mazsa|mezse))(?!\p{L})/iu;
const conditional = (text: string) => CONDITION_EN.test(text) || CONDITION_TR.test(text);

/** The parts of a step, each one thing to do -- a condition stays with what it is the condition of. */
const CLAUSES = /;|--|—|\band\b|\bthen\b|(?<!\p{L})(?:ve|sonra|ardından)(?!\p{L})/iu;
const LINKING_WORDS = new Set(
  "the a an and or of to in on at is it its as be by for from into with that this then than there their them they one once if when soon so not no any all bir ve ile için bu şu da de ki".split(" "),
);
const contentWords = (text: string) =>
  new Set((text.toLowerCase().match(/\p{L}+/gu) ?? []).filter((word) => word.length > 1 && !LINKING_WORDS.has(word)));

/**
 * Whether the tree shows a control named in these words: "Skip ad", or
 * "Atla", in "the Atla (Reklamı atla) skip ad button". Looser than the tree's
 * own lookup, which wants the whole description to be a name: here it only
 * has to keep a target from being called gone.
 */
function treeShowsNamed(root: TreeNode, description: string): boolean {
  const wanted = contentWords(description);
  const visit = (node: TreeNode): boolean => {
    if (node.visible === false) return false;
    const named = node.interactive && node.label ? contentWords(node.label) : undefined;
    if (named?.size && [...named].every((word) => wanted.has(word))) return true;
    return node.children.some(visit);
  };
  return visit(root);
}

/**
 * Whether the step asks for this target only if something comes about: the
 * target shares more words with a part of the step under a condition than
 * with any part that is not. A target that shares no words with the
 * condition's part -- "the Login button" for "if asked, tap Sign in" -- is
 * not taken to be the one it makes optional: such a miss still counts.
 */
export function conditionalTarget(text: string | undefined, target: string): boolean {
  // What is quoted is a name on the screen -- "Notify If Left Behind" is no
  // condition -- and still the words a target is known by.
  const unquoted = (part: string) => part.replace(/“[^”]*”|"[^"]*"|‘[^’]*’|(?<!\p{L})'[^']+'(?!\p{L})/gu, "the text");
  if (!text || !conditional(unquoted(text))) return false;
  const clauses = text.split(CLAUSES).filter((part) => part.trim());
  const wanted = contentWords(target);
  let waits = 0;
  let owed = 0;
  for (const clause of clauses) {
    const words = contentWords(clause);
    const shared = [...wanted].filter((word) => words.has(word)).length;
    if (conditional(unquoted(clause))) waits = Math.max(waits, shared);
    else owed = Math.max(owed, shared);
  }
  return waits > owed;
}

/**
 * What an action was aimed at, in the words its history and the report give
 * it: its target, or for an action with none, what made it this action. Three
 * times "swipe -> the screen did not change" is a list at an end the agent
 * cannot name; "swipe down" it can, and it goes the other way.
 */
function aimOf(action: { name: ActionName; describeTarget?: string; params?: Record<string, unknown> }): string {
  if (action.describeTarget) return action.describeTarget;
  const params = action.params ?? {};
  switch (action.name) {
    case "swipe":
    case "scroll":
      // The engines' own default, so the words say what was done.
      return String(params.direction ?? "down");
    case "keyPress":
      return typeof params.key === "string" ? params.key : "";
    case "wait":
      return typeof params.ms === "number" ? `${params.ms}ms` : "";
    case "openUrl":
      return typeof params.uri === "string" ? params.uri : "";
    case "launchApp":
    case "terminateApp":
      return typeof params.app === "string" ? params.app : "";
    default:
      return "";
  }
}

/**
 * What a report says about a target a model found: what it was shown, how far
 * the router trusts the answer, the box it drew and the reason it gave.
 */
function describeGrounding(ground: GroundResult): Record<string, unknown> {
  return {
    seen: ground.provenance.channel,
    confidence: Math.round(ground.confidence * 100) / 100,
    ...(ground.rect ? { box: ground.rect } : {}),
    ...(ground.why ? { why: ground.why } : {}),
  };
}

/**
 * Times a missed target is looked for again, on a screen it was not missed
 * on, to see whether what the agent is about to act on is it in other words.
 */
const REGROUNDS_PER_MISS = 2;

/** A target the agent asked for that was not on the screen. */
interface MissedTarget {
  action: ActionName;
  describeTarget: string;
  /** What the step would have failed with there, before the agent was told. */
  detail: string;
  /** How many actions the step had taken by then: what came after is the detour. */
  at: number;
  /** The screen it was last looked for on. */
  screen: string;
  regrounds: number;
  /** The agent went and got it: a later action landed on it. */
  answered: boolean;
  /** The step asks for it only if something comes about. */
  conditional: boolean;
  /**
   * It never came about: not on the screen, by the tree or a model, and
   * nothing pressed since. That lets a step whose expectation held pass;
   * it never lets one that failed accuse the app.
   */
  moot?: boolean;
  /** The screen it was last looked for on to see whether it is still owed. */
  settledOn?: string;
}

const plainWords = (text: string | undefined) => (text ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("tr");

/** One answer to a step's expectation, as the lock is told of it. */
interface VerdictAnswer {
  print: string;
  held: boolean;
  /** Memory answered it, not a model. */
  remembered: boolean;
  /** Two looks at the screen agreed before it was answered. */
  atRest: boolean;
}

/**
 * One "no" forgets the question, whatever was said before: it outweighs any
 * number of "yes". Written as it is said, not when the step ends, so a step
 * that ends in an error does not take the "no" with it.
 */
function forgetPrint(lock: LockFile, step: string, print: string): void {
  const verdict = lock.verdicts?.[step];
  if (!verdict) return;
  verdict.prints = verdict.prints.filter((entry) => entry.print !== print);
  if (verdict.prints.length) return;
  delete lock.verdicts![step];
  if (!Object.keys(lock.verdicts!).length) delete lock.verdicts;
}

/** An answer from memory: one nearer the next look, and the first to keep. */
function touchPrint(lock: LockFile, step: string, print: string): void {
  const verdict = lock.verdicts?.[step];
  const entry = verdict?.prints.find((each) => each.print === print);
  if (!verdict || !entry) return;
  entry.since += 1;
  verdict.prints = [entry, ...verdict.prints.filter((each) => each !== entry)];
}

/** A model's "yes", from a step that passed. */
function passPrint(lock: LockFile, step: string, print: string): void {
  const verdicts = (lock.verdicts ??= {});
  const prints = verdicts[step]?.prints ?? [];
  const entry = prints.find((each) => each.print === print);
  const kept = entry ? { ...entry, passes: entry.passes + 1, since: 0 } : { print, passes: 1, since: 0 };
  verdicts[step] = { prints: [kept, ...prints.filter((each) => each.print !== print)].slice(0, PRINTS_KEPT) };
}

export interface RunEvent {
  at: number;
  /**
   * The frame the event was about, when it is worth keeping: the screen an
   * expectation was judged on, mostly. Never written to the event log -- the
   * recorder puts it in a file and leaves a path behind.
   */
  screenshot?: Buffer;
  /**
   * The name the screenshot is kept under when it is not the step's verdict
   * frame. A step can meet several pop-ups, and each keeps the screen it was
   * answered on.
   */
  shotId?: string;
  kind:
    | "run_started"
    | "step_started"
    | "action"
    | "popup"
    | "assertion"
    | "extraction"
    | "step_finished"
    | "run_finished"
    | "note";
  stepId?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface StepResult {
  stepId: string;
  outcome: Outcome;
  detail: string;
  actions: number;
  usd: number;
  startedAt: number;
  finishedAt: number;
  extracted?: Record<string, unknown>;
  /** The step replayed what it learned last time, and asked no model where to tap. */
  fromCache?: boolean;
  /** The remembered target no longer checked out and had to be re-resolved. */
  healed?: boolean;
  /** Pop-ups answered by the rules along the way. Never a heal, never a failure. */
  popups?: number;
}

export interface TestResult {
  testId: string;
  outcome: Outcome;
  detail: string;
  steps: StepResult[];
  startedAt: number;
  finishedAt: number;
  usd: number;
  /** What the memory bought, in the only terms that matter to a bill. */
  cache: { steps: number; replayed: number; heals: number };
  /** Pop-ups answered by the rules, across every step. */
  popups: number;
}

export interface RunTestOptions {
  engine: Engine & { stepId?: string };
  test: TestFile;
  device: DeviceHandle;
  ledger: CostLedger;
  onEvent?: (event: RunEvent) => void;
  /**
   * What this test learned last time. Mutated in place: resolutions are
   * recorded, heals appended. The caller decides whether to write it back --
   * a run that never finished should not overwrite a working memory.
   */
  lock?: LockFile;
  /** The build under test. A different one starts a cold cache by construction. */
  appBuild?: string;
  /**
   * What people said about earlier heals of this test, newest first. Applied
   * to `lock` before anything is replayed; without a lock there is no memory
   * to heal, so there is nothing for them to say. A word written into the
   * lock's own heals is applied too, after these, with or without them.
   */
  healDecisions?: HealDecision[];
  /**
   * Wait for the screen to stop moving before reading it. On by default: an
   * action returns before its effect is drawn, and judging a transition is how
   * a runner reports "the Settings screen is not visible" about a Settings
   * screen that had not finished drawing. Tests turn it off.
   */
  settle?: boolean;
  /**
   * The pop-up rules every test shares. A test's own `policy.popups` goes on
   * top, and the built-in defaults fill in whatever neither says.
   */
  popups?: Partial<PopupRules>;
}

/**
 * The app a test runs as on this device: the first of its targets for the
 * platform that the device has. A browser test lists Chrome and Huawei's own
 * browser, and runs on whichever the phone carries; a device that cannot say
 * what it has runs the first. None of them there is no test of the app.
 */
export async function appOn(test: TestFile, device: DeviceHandle, engine: Engine): Promise<string | undefined> {
  const apps = test.targets.filter((target) => target.platform === device.platform).map((target) => target.app);
  if (apps.length <= 1 || !engine.app.installed) return apps[0];
  for (const app of apps) if ((await engine.app.installed(app).catch(() => undefined)) !== false) return app;
  throw new DeviceNotReadyError(`none of ${apps.join(", ")} is installed on ${device.id}`);
}

export async function runTest(options: RunTestOptions): Promise<TestResult> {
  const { engine, test, device, ledger } = options;
  /** Pop-ups answered, by step -- counted where they are announced, so no step can answer one quietly. */
  const answered = new Map<string, number>();
  const emit = (event: Omit<RunEvent, "at">) => {
    if (event.kind === "popup" && event.stepId) answered.set(event.stepId, (answered.get(event.stepId) ?? 0) + 1);
    options.onEvent?.({ at: Date.now(), ...event });
  };
  const rules = popupRules(options.popups, test.policy.popups);
  const startedAt = Date.now();
  // Which of the test's apps this phone has, asked once: a phone with none of
  // them ends the run as the device's, below, not as a broken app.
  let app: string | undefined;
  let noApp: string | undefined;
  try {
    app = await appOn(test, device, engine);
  } catch (error) {
    noApp = (error as Error).message;
  }
  const budget: StepBudget = { maxUsd: test.policy.budget.maxUsd, maxLatencyMs: 60_000, maxEscalations: 2 };
  const deadline = startedAt + test.policy.budget.maxSeconds * 1000;
  const stuck = "a call to the device or a model never came back; the run is given up on";
  const steps: StepResult[] = [];
  const cacheCounts = { steps: 0, replayed: 0, heals: 0 };
  /** Some step has acted on the app: from here on, what is on screen may be its doing. */
  let touched = false;

  // A new build starts a cold cache -- by construction, not by policy. What
  // was learned on the old one is kept and marked, so it can be re-verified
  // and carried forward rather than thrown away: an app update usually moves
  // a handful of screens, not all of them. Nothing is trusted without the
  // anchor check either way, which is what makes carrying it forward safe.
  // A lock that named no build was on no other one, and is not told it was.
  if (options.lock && options.appBuild) {
    const previous = adoptBuild(options.lock, options.appBuild);
    if (previous) {
      emit({ kind: "note", message: `new build ${options.appBuild} (was ${previous}) -- last run's resolutions will be re-checked, not reused blindly` });
    }
  }

  // Before anything is replayed: a rejected heal puts the memory back, so this
  // run checks the old target again instead of trusting the substitute. The
  // words come from the control plane, and from the lock itself, where a
  // person with no control plane writes them by hand.
  if (options.lock) {
    const decided = [
      ...(options.healDecisions?.length ? applyHealDecisions(options.lock, options.healDecisions) : []),
      ...applyLockReviews(options.lock),
    ];
    for (const applied of decided) {
      // A word on a memory gone astray is acted on at its step, and said there.
      if (applied.kind === "astray" && applied.status !== "pending_review") continue;
      const said =
        applied.status === "pending_review"
          ? "a word on a heal was taken back -- the memory is left as it is, and the heal waits for review again"
          : applied.status === "accepted"
            ? applied.memory === "reapplied"
              ? "a heal once rejected was accepted after all -- the memory holds the new place again"
              : applied.memory === "forgotten"
                ? "a heal once rejected was accepted after all, and could not be put back exactly -- this step will be worked out again"
                : "a heal was accepted -- the app changed, and the memory already says so"
            : applied.memory === "restored"
              ? "a heal was rejected -- the memory is back to what it was, and the same change again will fail the run"
              : applied.memory === "forgotten"
                ? "a heal was rejected and could not be undone exactly -- this step will be worked out again"
                : "a heal was rejected -- the same change again will fail the run";
      emit({ kind: "note", stepId: applied.step, message: said, data: { review: applied.status } });
    }
  }

  emit({ kind: "run_started", message: `${test.id} on ${device.platform} ${device.id}`, data: { app } });

  const finish = (outcome: Outcome, detail: string): TestResult => {
    const result: TestResult = {
      testId: test.id,
      outcome,
      detail,
      steps,
      startedAt,
      finishedAt: Date.now(),
      usd: ledger.totalUsd(),
      cache: cacheCounts,
      popups: [...answered.values()].reduce((sum, n) => sum + n, 0),
    };
    emit({ kind: "run_finished", message: detail, data: { outcome } });
    return result;
  };

  if (noApp) return finish("DEVICE_ERROR", noApp);

  // Whatever way the run ends -- passed, failed, thrown, stuck -- what the test
  // says to undo is undone, once, and how that went changes no verdict.
  let tidied = false;
  const tidy = async () => {
    if (tidied) return;
    tidied = true;
    await within(applyDirectives(test.teardown, { engine, app, emit }), TIDY_MS, "it did not return").catch((error: unknown) =>
      emit({ kind: "note", message: `teardown did not finish: ${(error as Error).message}` }),
    );
  };
  try {
    await within(applyDirectives(test.setup, { engine, app, emit }), deadline + STUCK_AFTER_MS - Date.now(), stuck);

    // How each step reads to an agent that has to work one out again.
    const said = (each: TestStep) => (each.do ? (each.expect ? `${each.do} (then: ${each.expect})` : each.do) : each.expect ? `check: ${each.expect}` : "let time pass");
    const restless = new Set<string>();
    for (const [index, step] of test.steps.entries()) {
      engine.stepId = step.id;
      const stepStartedAt = Date.now();
      const usdBefore = ledger.totalUsd();
      emit({ kind: "step_started", stepId: step.id, message: step.do ?? step.expect ?? step.id });

      if (Date.now() > deadline) {
        steps.push(stepResult(step, "BUDGET_EXHAUSTED", "the test ran out of time", 0, ledger, usdBefore, stepStartedAt));
        return finish("BUDGET_EXHAUSTED", `out of time at step "${step.id}"`);
      }
      if (ledger.totalUsd() > test.policy.budget.maxUsd) {
        steps.push(stepResult(step, "BUDGET_EXHAUSTED", "the test ran out of budget", 0, ledger, usdBefore, stepStartedAt));
        return finish("BUDGET_EXHAUSTED", `out of budget at step "${step.id}"`);
      }

      // What the expectation was answered on, for the next run to recognise.
      // A "no" and an answer from memory are kept as they come; a model's
      // "yes" counts only on a screen seen at rest, and only from a step that
      // passed, like everything else remembered.
      const passed = new Set<string>();
      const onVerdict = (answer: VerdictAnswer) => {
        if (!options.lock) return;
        if (!answer.held) {
          forgetPrint(options.lock, step.id, answer.print);
          passed.delete(answer.print);
        } else if (answer.remembered) touchPrint(options.lock, step.id, answer.print);
        else if (answer.atRest) passed.add(answer.print);
      };
      // A memory a person agreed went somewhere its step does not say is not
      // replayed into that again: the step is worked out anew.
      // Spent once used: a memory learned anew that presses the same control
      // is the agent's own finding, not the one the person agreed was wrong.
      const recalled = options.lock?.steps[step.id];
      const agreed = recalled
        ? options.lock!.heals.find(
            (heal) => heal.step === step.id && heal.kind === "astray" && heal.status === "accepted" && recalled.actions.some((action) => sameTarget(action, heal.before)),
          )
        : undefined;
      if (agreed) {
        delete options.lock!.steps[step.id];
        options.lock!.heals.splice(options.lock!.heals.indexOf(agreed), 1);
        emit({ kind: "note", stepId: step.id, message: "a person agreed this step's memory went somewhere the step does not say; it is forgotten, and worked out again", data: { review: "accepted" } });
      }
      const outcome = await within(runStep({
        engine,
        step,
        budget,
        emit,
        settle: options.settle !== false,
        rules,
        untouched: !touched,
        ...(options.lock ? { remembered: options.lock.steps[step.id] } : {}),
        rejected: options.lock?.heals.filter((heal) => heal.step === step.id && heal.status === "rejected") ?? [],
        ...(options.lock?.verdicts?.[step.id] ? { verdict: options.lock.verdicts[step.id] } : {}),
        journey: { test: test.title, done: test.steps.slice(0, index).map(said) },
        remembering: Boolean(options.lock),
        restless,
        onVerdict,
        exhausted: () =>
          Date.now() > deadline ? "the test ran out of time" : ledger.totalUsd() > test.policy.budget.maxUsd ? "the test ran out of budget" : undefined,
      }), deadline + STUCK_AFTER_MS - Date.now(), stuck);
      const result = stepResult(step, outcome.outcome, outcome.detail, outcome.actions, ledger, usdBefore, stepStartedAt);
      if (outcome.extracted) result.extracted = outcome.extracted;
      if (outcome.fromCache) result.fromCache = true;
      if (outcome.heal) result.healed = true;
      if (answered.get(step.id)) result.popups = answered.get(step.id)!;
      if (outcome.actions > 0) touched = true;
      steps.push(result);

      cacheCounts.steps += 1;
      if (outcome.fromCache) cacheCounts.replayed += 1;
      if (options.lock) {
        if (outcome.heal) {
          cacheCounts.heals += 1;
          // One waiting for review is not filed again: a memory that goes
          // astray, kept on one model's word, would add one every run.
          if (!options.lock.heals.some((heal) => heal.status === "pending_review" && sameHeal(heal, outcome.heal!))) options.lock.heals.push(outcome.heal);
        }
        // Only a step that passed is worth remembering: recording the path of
        // a failing step teaches the cache to reproduce a failure quickly.
        if (!isFailure(outcome.outcome) && outcome.resolution) {
          const previous = options.lock.steps[step.id];
          options.lock.steps[step.id] = {
            ...outcome.resolution,
            stability: {
              runs: (previous?.stability.runs ?? 0) + 1,
              passes: (previous?.stability.passes ?? 0) + 1,
              ...(previous?.stability.carriedForwardFrom && outcome.fromCache
                ? { carriedForwardFrom: previous.stability.carriedForwardFrom }
                : {}),
            },
          };
        } else if (options.lock.steps[step.id] && outcome.forget) {
          // A memory that led the step somewhere it does not say to go is not
          // replayed into the same failure run after run: next time the step
          // is worked out again.
          delete options.lock.steps[step.id];
          emit({ kind: "note", stepId: step.id, message: "the memory of this step led it somewhere the step does not say to go; it is forgotten, and worked out again next time" });
        } else if (options.lock.steps[step.id]) {
          const stability = options.lock.steps[step.id]!.stability;
          stability.runs += 1;
        }
        if (!isFailure(outcome.outcome)) for (const print of passed) passPrint(options.lock, step.id, print);
      }
      emit({ kind: "step_finished", stepId: step.id, message: outcome.detail, data: { outcome: outcome.outcome } });

      if (isFailure(outcome.outcome)) {
        // The run is over, but the device is somebody's: what the test says
        // to undo at the end is undone now too, as far as it can be, and a
        // teardown that fails cannot change what the step found.
        await tidy();
        return finish(outcome.outcome, `step "${step.id}": ${outcome.detail}`);
      }
    }

    await tidy();
    // A run with a heal in it is green, and says so differently: somebody has
    // to look at what changed before the next run treats it as normal.
    const healed = steps.filter((entry) => entry.healed).length;
    return healed
      ? finish("HEALED_PASS", `all ${test.steps.length} steps passed, ${healed} after re-resolving a target`)
      : finish("PASS", `all ${test.steps.length} steps passed`);
  } catch (error) {
    // Anything the device or its tooling threw is infrastructure, not a verdict
    // about the app under test. Saying otherwise is the lie this taxonomy exists
    // to prevent.
    await tidy();
    return finish("DEVICE_ERROR", (error as Error).message);
  } finally {
    delete engine.stepId;
  }
}

function stepResult(
  step: TestStep,
  outcome: Outcome,
  detail: string,
  actions: number,
  ledger: CostLedger,
  usdBefore: number,
  startedAt: number,
): StepResult {
  return {
    stepId: step.id,
    outcome,
    detail,
    actions,
    usd: Number((ledger.totalUsd() - usdBefore).toFixed(6)),
    startedAt,
    finishedAt: Date.now(),
  };
}

interface StepOutcome {
  outcome: Outcome;
  detail: string;
  actions: number;
  extracted?: Record<string, unknown>;
  /** Everything the step did, for the lock file to remember. */
  resolution?: StepResolution;
  /** The step replayed its memory and asked no model where to act. */
  fromCache?: boolean;
  /** The memory no longer checked out; here is what changed. */
  heal?: HealRecord;
  /** The memory led the step somewhere it does not say to go: next time, it is worked out again. */
  forget?: boolean;
}

/** Where an action went, and the screen it was decided on: what is asked before an app is blamed. */
interface Aimed {
  action: ResolvedAction;
  point: Point;
  decidedOn: Observation;
  fromMemory: boolean;
}

async function runStep(args: {
  engine: Engine;
  step: TestStep;
  budget: StepBudget;
  emit: (event: Omit<RunEvent, "at">) => void;
  settle: boolean;
  rules: PopupRules;
  /** No step before this one has acted: the app is as it launched. */
  untouched: boolean;
  remembered?: StepResolution;
  /** Heals of this step a person has called a real failure. */
  rejected: HealRecord[];
  /** What this step's expectation was remembered to hold on. */
  verdict?: RememberedVerdict;
  /** There is a memory to keep what the expectation holds on in. */
  remembering?: boolean;
  /** The places in this run where a screen has not come to rest. */
  restless?: Set<string>;
  /** Where the step sits in its test, for an agent working it out again. */
  journey?: Journey;
  /** Told of each question the expectation was answered on, as it is answered. */
  onVerdict?: (answer: VerdictAnswer) => void;
  /** Why the test may not go on -- out of time or of money -- or nothing. Asked every turn. */
  exhausted?: () => string | undefined;
}): Promise<StepOutcome> {
  const { engine, step, budget, emit, settle } = args;
  if (step.wait) {
    emit({ kind: "note", stepId: step.id, message: `letting ${step.wait / 1000} s pass, as the step says` });
    await new Promise((resolve) => setTimeout(resolve, step.wait));
    if (!step.expect) return { outcome: "PASS", detail: `${step.wait / 1000} s passed`, actions: 0 };
  }
  const history: PlanHistoryEntry[] = [];
  const recent: string[] = [];
  let actions = 0;
  let still = 0;
  let confidence = 1;
  let refusals = 0;
  const missedTargets: MissedTarget[] = [];
  /** What a model said, by print, when it said the expectation did not hold. */
  const refused = new Map<string, AssertResult>();
  let triedTree = false;
  let resolvedBy: string | undefined;
  /** The step stopped because it ran out of moves, not because it was done. */
  let ranOut = false;
  /** What done means and how far the step has got, in the agent's words, handed back every turn. */
  const ledger: StepLedger = {};
  /** Turns the agent was asked what done means. */
  let understandAsked = 0;
  /** Actions earned by actions that did what the agent said they would. */
  let earned = 0;
  /** The last action said what it would do and left a screen not seen before: the next turn says whether it did. */
  let owedVerdict = false;
  /** Times "done" was answered while what done means did not hold. */
  let doneRefusals = 0;
  /** Actions carried out from memory before the agent took over: not the agent's to spend. */
  let replayedActions = 0;
  /**
   * Every screen this step has stood on, to tell a screen reached from one
   * come back to -- by its controls, or its pixels, and by what it says: a
   * calculator's keys never change, and the display going from 100 to 1.000
   * is all the progress a press makes. Seven presses in a step ran out at six.
   */
  const seenScreens: { phash: string; treeHash?: string; words?: string }[] = [];
  const screenWords = (seen: Observation) => (seen.tree ? textHash(seen.tree.root) : undefined);
  const seenOf = (seen: Observation) => {
    const words = screenWords(seen);
    return { ...screenOf(seen), ...(words ? { words } : {}) };
  };
  const sameScreen = (screen: (typeof seenScreens)[number], seen: Observation, words = screenWords(seen)) =>
    screenMatches(screen, seen) && (!words || !screen.words || screen.words === words);
  const sawBefore = (seen: Observation) => {
    const words = screenWords(seen);
    return seenScreens.some((screen) => sameScreen(screen, seen, words));
  };
  /** The time the agent has spent in waits of its own in this step. */
  let waitedMs = 0;
  /** Its waits that were what the step's `within` is for, and spent none of its moves. */
  let freeWaits = 0;
  const agentActions = () => actions - replayedActions - freeWaits;
  /** The actions every step gets, or the ones it spells out and two more. */
  const given = Math.max(ACTIONS_PER_STEP, namedActions(step.do) + NAMED_SPARE);
  const allowedActions = () => Math.min(ACTIONS_CEILING, given + earned);
  const allowedTurns = () => Math.min(TURNS_CEILING, TURNS_PER_STEP + (given - ACTIONS_PER_STEP) + earned);
  /** Said once, when the step first goes past the actions every step gets. */
  let saidEarned = false;
  /** A "done" was refused and the agent was told to answer again: it gets that turn, at the limit or not. */
  let owedAnswer = false;
  /** What the judge said of the agent's done-when, by the screen it said it on: a screen that has not moved is not asked twice. */
  const doneJudged = new Map<string, AssertResult>();
  /** How many actions, in words: the agent's own, and the memory's before them. */
  const tookActions = () => (replayedActions ? `${agentActions()} actions of its own after ${replayedActions} from memory` : `${actions} actions`);

  /**
   * The step's own expectation is its exit condition.
   *
   * Asking the planner "are you done?" gets a worse answer than asking the
   * test: "scroll down the settings list" has no natural end, and a model will
   * cheerfully swipe until the budget runs out. The author already wrote what
   * done looks like, so that is what decides -- and when a step has no
   * expectation, the planner's own judgement is all there is.
   */
  // Every decision sees the screen both ways: the picture says what can be seen,
  // the tree says exactly what it holds. A judge shown the picture alone failed
  // a playing video for its hidden controls, with its position in the tree. A
  // step may still ask for the picture alone.
  const wantsTree = engine.capabilities.tree && step.channel !== "vision";
  // A tree that cannot be read is no reason to end a run: the picture answers alone.
  const see = (opts: { settle?: boolean; changedFrom?: string } = {}): Promise<Observation> =>
    wantsTree ? engine.observe({ ...opts, tree: true }).catch(() => engine.observe(opts)) : engine.observe(opts);
  let observation: Observation = await see({ settle });

  // An incoming call is answered the moment it rings: the engine watches the
  // tree with no model between looks, and between its watches the screen is
  // looked at once, for a banner the tree does not hold.
  if (step.answer === "call") {
    const answered = await answerCall({ engine, step, budget, emit, see });
    if (!answered.ok) return { outcome: "FAIL_ASSERT", detail: answered.detail, actions: 0 };
    observation = await see({ settle });
    if (!step.expect) return { outcome: "PASS", detail: answered.detail, actions: 1 };
    // The call answered is the step's action: what comes up over it may be
    // the app's answer to it, here and in every step after.
    actions = 1;
  }
  let verdict: AssertResult | undefined;
  let acted = actions > 0;
  /** The agent has carried out an action of its own in this step, not only the memory. */
  let workedOut = false;

  // What we learned last time, if it still applies to this screen. The screen
  // check is cheap and the anchor checks are cheaper still -- together they
  // are the difference between a step that costs two model calls and a step
  // that costs none.
  const taken: ResolvedAction[] = [];
  const aimed: Aimed[] = [];
  let staleDrops = 0;
  const screenOf = (seen: Observation) => ({
    phash: seen.signature.phash,
    ...(seen.signature.treeHash ? { treeHash: seen.signature.treeHash } : {}),
  });
  let learnedOn = screenOf(observation);
  let fromCache = false;
  let healFrom: ResolvedAction | undefined;
  let healReason: string | undefined;
  /** How the memory failed: contradicted by the tree, by the pixels, or never checkable. */
  let healBy: Verdict["by"] | undefined;
  /** How much of `taken` is replayed memory, so a heal quotes only what came after. */
  let replayedCount = 0;

  // What was learned for other words is not replayed: a step reworded under
  // the same id says something else, and the old taps would check out on a
  // screen that still has the old target. A memory kept before the words were
  // is taken as it always was.
  const wordsOf = (text: string | undefined) => (text ?? "").trim().replace(/\s+/g, " ");
  const reworded = args.remembered?.do !== undefined && wordsOf(args.remembered.do) !== wordsOf(step.do);
  const remembered = reworded ? undefined : args.remembered;
  if (reworded) {
    emit({
      kind: "note",
      stepId: step.id,
      message: `this step's words changed since it was learned ("${args.remembered!.do}") -- working it out again`,
    });
  }

  let popups = 0;
  /**
   * The screen a pop-up was left on, for the step to deal with -- because the
   * rules leave it to the test, nothing on it answers them, or it was not
   * there when looked for. The planner is not asked about pop-ups on that
   * screen again; once the screen moves on, it is.
   */
  let leftOn: string | undefined;
  /** What the step is for, whole: a dialog is only in the way of this if it is not the answer to it. */
  const goal = step.do && step.expect ? `${step.do}, then check that ${step.expect}` : (step.do ?? step.expect);

  /**
   * Answers whatever is in the way, as the rules say, and returns whether
   * anything was.
   *
   * - `look`: whether this moment is worth a model call. The tree is always
   *   read; the eyes only where a wrong answer would cost more.
   * - `lookAgain`: whether to keep looking after an answer, for a sheet
   *   stacked behind it. Not where the planner looks next anyway -- that would
   *   double the cost of every answer -- but at the verdict, where nothing
   *   else will.
   *
   * A pop-up of no known kind is closed only before the test has acted at
   * all, whichever look finds it: after that, a dialog nobody wrote a rule
   * for is as likely the app's answer -- "Payment failed [OK]", left over
   * from the step before -- as something in its way, and closing the app's
   * answer is how a failure becomes a pass.
   */
  const answerPopups = async (at: {
    look: boolean;
    lookAgain?: boolean;
    hint?: { kind: PopupKind; title?: string };
  }): Promise<boolean> => {
    let answered = false;
    let { look, hint } = at;
    const rules: PopupRules = args.untouched && !acted ? args.rules : { ...args.rules, other: "off" };
    while (popups < POPUPS_PER_STEP) {
      let search;
      try {
        search = await findPopup({
          engine,
          observation,
          rules,
          look,
          ...(goal ? { goal } : {}),
          ...(hint ? { hint } : {}),
        });
      } catch (error) {
        emit({ kind: "note", stepId: step.id, message: `could not tell whether a pop-up is in the way -- ${(error as Error).message}` });
        break;
      }
      hint = undefined;
      const found = search.found;
      if (!found) break;
      observation = search.observation;
      const what = POPUP_NAMES[found.kind];
      // Everything in the way is put out of the way, except what says the app
      // failed: pressed, "Payment failed [OK]" is a screen with no error on it.
      if (found.press && APP_FAILURE.test(found.title ?? "")) {
        leftOn = observation.signature.phash;
        emit({ kind: "note", stepId: step.id, message: `${what} ("${found.title}") says the app failed, so it is left alone` });
        break;
      }
      if (!found.press) {
        leftOn = observation.signature.phash;
        emit({
          kind: "note",
          stepId: step.id,
          message:
            args.rules[found.kind] === "off"
              ? `${what} is up, and your rules leave it to the test`
              : rules[found.kind] === "off"
                ? `${what} is up after the test acted; with no rule for it, it may be the app's answer, so it is left alone`
                : `${what} is up, and nothing on it answers it the way your rules say`,
        });
        break;
      }
      const answeredOn = observation;
      await engine.act({ name: "tap", target: found.press.point, decidedFrom: observation });
      popups += 1;
      answered = true;
      emit({
        kind: "popup",
        stepId: step.id,
        message: `${what}${found.title ? ` ("${found.title}")` : ""} -- ${found.press.outside ? "tapped outside it to close it" : `pressed "${found.press.label || args.rules[found.kind]}"`}, as your rules say`,
        data: {
          kind: found.kind,
          answer: args.rules[found.kind],
          pressed: found.press.label,
          by: found.by,
          ...(found.title ? { title: found.title } : {}),
        },
        // What it looked like when it was answered: the report shows it, so
        // nobody has to take the rule's word for what was on screen.
        screenshot: answeredOn.frame.bytes,
        shotId: `${step.id}.popup-${popups}`,
      });
      observation = await see({ settle });
      if (observation.signature.phash === answeredOn.signature.phash) {
        emit({ kind: "note", stepId: step.id, message: `pressed "${found.press.label}" on ${what}, and the screen did not change` });
        break;
      }
      look = look && at.lookAgain === true;
    }
    // Answered before the step did anything: the screen now showing is the
    // one the step starts from, and the one its memory belongs to.
    if (answered && !acted) learnedOn = screenOf(observation);
    return answered;
  };

  /**
   * Typed is not the same as entered: a keyboard capitalises, corrects and
   * drops characters, an app formats. What the field holds is read back from
   * the tree; a field holding something else is typed into once more, and if
   * it still does, the step is told and the report says so -- as it says when
   * the text checked out, or could not be checked. Returns what the field
   * holds when that is not what was typed.
   */
  /** What the last typing into a hidden field left in it, for the planner's history. */
  let hiddenHeld: string | undefined;
  const checkTyped = async (
    action: { name: ActionName; params?: Record<string, unknown> },
    target: Point,
    decidedOn: Observation,
  ): Promise<string | undefined> => {
    hiddenHeld = undefined;
    if (action.name !== "input" || !engine.capabilities.tree) return undefined;
    const typed = String(action.params?.value ?? "");
    const append = action.params?.append === true;
    const readBack = async () => {
      const seen = await engine.observe({ tree: true }).catch(() => undefined);
      const field = seen?.tree ? fieldAt(seen.tree, target) : undefined;
      // A hidden field's dots are counted: one a character, so a password of
      // the right length is in, which is all the tree can say of it.
      const dots = field?.secret && /^[•●*·]+$/u.test(field.text) ? [...field.text].length : undefined;
      return { seen, field: field && !field.secret ? field : undefined, hidden: Boolean(field?.secret), ...(dots !== undefined ? { dots } : {}) };
    };
    // A field found elsewhere than where it was typed into is believed only
    // when it holds exactly the text: anything else may be another field.
    const compare = (back: Awaited<ReturnType<typeof readBack>>) => {
      if (!back.field) return "unread" as const;
      const verdict = compareTyped(back.field.text, typed, append);
      return back.field.atPoint || verdict === "same" ? verdict : ("unread" as const);
    };
    let back = await readBack();
    let entered = compare(back);
    // Typed once more only where it can help and cannot hurt: on the screen
    // the typing was decided on -- not a next screen a six-digit code
    // submitted itself to -- in the same field, and only when the text is not
    // already in it, which means the field could not be emptied and typing
    // again would only add another copy.
    if (
      entered === "different" &&
      !append &&
      back.seen &&
      back.field &&
      !back.field.text.includes(typed) &&
      screenMatches({ phash: decidedOn.signature.phash }, back.seen)
    ) {
      actions += 1;
      emit({ kind: "note", stepId: step.id, message: `the field held "${back.field.text}" after typing "${typed}"; typing it once more` });
      const again = await engine.act({
        name: "input",
        target,
        params: action.params ?? {},
        decidedFrom: back.seen,
        staleGuard: { maxAgeMs: STALE_AFTER_MS, maxPhashDistance: STALE_DISTANCE },
      });
      if (!again.stale) {
        back = await readBack();
        entered = compare(back);
      }
    }
    if (back.seen) observation = back.seen;
    if ((entered === "different" || entered === "recased") && back.field) {
      emit({ kind: "note", stepId: step.id, message: `typed "${typed}", but the field holds "${back.field.text}"` });
      return back.field.text;
    }
    hiddenHeld = back.hidden && back.dots !== undefined && !append ? `the password field holds ${back.dots} hidden characters${back.dots === [...typed].length ? ", as many as were typed: it is filled" : `, not the ${[...typed].length} typed`}` : undefined;
    emit({
      kind: "note",
      stepId: step.id,
      message:
        entered === "same"
          ? `read back from the tree: exactly "${typed}"`
          : back.hidden
            ? back.dots !== undefined
              ? `typed "${typed}" into a field that hides what it holds; it holds ${back.dots} characters${back.dots === [...typed].length ? ", as many as were typed" : `, and ${[...typed].length} were typed`}`
              : `typed "${typed}" into a field that hides what it holds; not read back`
            : `typed "${typed}"; the field could not be read back from the tree to check it`,
    });
    return undefined;
  };

  /**
   * Typing that is to be sent -- a search, a message -- is sent with Enter
   * while the keyboard that typed it is still up: pressed after the keyboard
   * had been put away, on a Nothing Phone it reached nothing, and the
   * search was never made. Sent after what was typed is read back, so that
   * the check reads the field and not the results it leads to.
   */
  const sendTyped = async (action: { name: ActionName; params?: Record<string, unknown> }): Promise<boolean> => {
    if (action.name !== "input" || action.params?.submit !== true) return false;
    await engine.act({ name: "keyPress", params: { key: "Enter" }, decidedFrom: observation });
    observation = await see({ settle });
    return true;
  };

  // A pop-up over a remembered screen hides it. A system prompt names itself
  // in the tree for free, and answering it is what lets the memory replay
  // instead of paying the planner to work out a step it already knows.
  if (remembered && step.do && remembered.actions.length && !screenMatches(remembered.screen, observation)) {
    await answerPopups({ look: false });
  }

  if (remembered && step.do && screenMatches(remembered.screen, observation) && remembered.actions.length) {
    for (const recorded of remembered.actions) {
      // A long memory can outlast the test's time too.
      const overNow = args.exhausted?.();
      if (overNow) return { outcome: "BUDGET_EXHAUSTED", detail: `${overNow}, while replaying "${step.do}" from memory`, actions };
      let at = recorded.point;
      let checkedBy: "tree" | "pixels" | undefined;
      if (recorded.point) {
        // The memory names a control, and the tree is the only thing that can
        // recognise it. Reading it costs a second and no model call; skipping
        // it means the check cannot be made, the step falls through to the
        // model, and the memory we went to the trouble of storing never pays
        // for itself on exactly the screens where pixels are flat.
        if (recorded.anchor?.tree && !observation.tree) {
          observation = await engine.observe({ tree: true });
        }
        let verdict = await verifyAnchor(recorded.anchor, recorded.point, observation);
        // A prompt over the control makes the memory look wrong when it is
        // not: answered, the control is where it was, and nothing is healed.
        if (!verdict.ok && (await answerPopups({ look: false }))) {
          if (recorded.anchor?.tree && !observation.tree) observation = await engine.observe({ tree: true });
          verdict = await verifyAnchor(recorded.anchor, recorded.point, observation);
        }
        // Not under its point, but on this screen: the same control, moved by
        // a scroll that never stops in the same place twice.
        const moved = !verdict.ok ? relocateAnchor(recorded.anchor, recorded.point, observation) : undefined;
        if (moved) {
          at = moved;
          emit({ kind: "note", stepId: step.id, message: `${recorded.describeTarget ?? recorded.action} has moved on this screen; pressing it where it is now` });
        } else if (!verdict.ok) {
          healFrom = recorded;
          healReason = verdict.reason;
          healBy = verdict.by;
          emit({
            kind: "note",
            stepId: step.id,
            message: `what I remembered no longer checks out -- ${verdict.reason}; working it out again`,
          });
          break;
        }
        if (verdict.ok && verdict.by !== "none") checkedBy = verdict.by;
      }
      const pressedOn = observation;
      const replayed = await engine.act({
        name: recorded.action,
        ...(at ? { target: at } : {}),
        ...(recorded.params ? { params: recorded.params } : {}),
        decidedFrom: observation,
      });
      if (replayed.stale) break;
      actions += 1;
      acted = true;
      taken.push(recorded);
      if (at && NEEDS_TARGET.has(recorded.action)) aimed.push({ action: recorded, point: at, decidedOn: pressedOn, fromMemory: true });
      const typedFromMemory =
        recorded.action === "input" ? ` "${String(recorded.params?.value ?? "")}"` : "";
      emit({
        kind: "action",
        stepId: step.id,
        message: `${recorded.action}${typedFromMemory} ${aimOf({ name: recorded.action, ...(recorded.describeTarget ? { describeTarget: recorded.describeTarget } : {}), ...(recorded.params ? { params: recorded.params } : {}) })}`.trim(),
        data: {
          target: at,
          cached: true,
          by: "memory",
          ...(replayed.via ? { via: replayed.via } : {}),
          ...(replayed.pointBecause ? { pointBecause: replayed.pointBecause } : {}),
          ...(checkedBy ? { checkedBy } : {}),
          screen: pressedOn.frame.size,
        },
        screenshot: pressedOn.frame.bytes,
        shotId: `${step.id}.action-${actions}`,
      });
      observation = await see({ settle });
      seenScreens.push(seenOf(observation));
      // Typing remembered is typing all the same: what it entered is checked.
      const holds = at ? await checkTyped({ name: recorded.action, ...(recorded.params ? { params: recorded.params } : {}) }, at, pressedOn) : undefined;
      await sendTyped({ name: recorded.action, ...(recorded.params ? { params: recorded.params } : {}) });
      // Part of this step all the same: an agent asked to go on from here
      // and told nothing of it reads a goal already reached as one not yet
      // begun.
      history.push({
        action: recorded.action,
        description: aimOf({ name: recorded.action, ...(recorded.describeTarget ? { describeTarget: recorded.describeTarget } : {}), ...(recorded.params ? { params: recorded.params } : {}) }),
        outcome:
          `carried out as in the last run; ${pressedOn.signature.phash !== observation.signature.phash ? "the screen changed" : "the screen did not change"}` +
          (holds !== undefined ? `; the field holds "${holds}", not what was typed` : ""),
      });
    }
    fromCache = taken.length === remembered.actions.length && !healReason;
    replayedCount = taken.length;
    replayedActions = actions;
  }
  seenScreens.push(seenOf(observation));

  /**
   * Reads the accessibility tree and starts the step's patience over.
   *
   * Called at the three moments the pixels have demonstrably failed: a tap that
   * changed nothing, the same action repeated, and nothing moving at all. Once
   * per step -- if the tree did not help either, the step is genuinely stuck
   * and saying so beats grinding through the budget.
   */
  const lookHarder = async (because: string): Promise<boolean> => {
    if (observation.tree || triedTree || !engine.capabilities.tree) return false;
    triedTree = true;
    // A tree that cannot be read is a harder look that cannot be had, not a
    // device that has gone: the step goes on with the picture.
    const withTree = await engine.observe({ tree: true }).catch(() => undefined);
    if (!withTree) return false;
    observation = withTree;
    recent.length = 0;
    still = 0;
    emit({
      kind: "note",
      stepId: step.id,
      message: `${because} -- reading the screen's accessibility tree and trying again`,
    });
    return true;
  };

  // A target not on this screen is told to the agent rather than ending the
  // step, a couple of times: it is usually somewhere else, and knowing how the
  // test got here, the agent can go and get it. True when it is to plan again,
  // on the screen as it is now rather than as it was when the target was
  // asked for: a list still loading has moved on.
  const missed = async (action: { name: ActionName; describeTarget?: string }, error: unknown): Promise<boolean> => {
    if (missedTargets.length >= MISSES_PER_STEP) return false;
    const target = action.describeTarget ?? "";
    // Not there, and there twice over, are different news: an agent told a
    // target is missing goes looking for it, and this one is on the screen.
    const disputed = error instanceof SourcesDisagreeError;
    missedTargets.push({
      action: action.name,
      describeTarget: target,
      detail: disputed ? `"${target}" was not pressed: ${(error as Error).message}` : `could not locate "${target}": ${(error as Error).message}`,
      at: taken.length,
      screen: observation.signature.phash,
      regrounds: 0,
      // Already pressed once in this step -- a Save that closed its form is
      // not there for a second go -- and so not gone around.
      answered: taken.some((done) => done.action === action.name && plainWords(done.describeTarget) === plainWords(target)),
      conditional: conditionalTarget(step.do, target),
    });
    history.push({
      action: action.name,
      description: target,
      outcome: disputed
        ? `not pressed -- ${(error as Error).message}; name it more exactly, or deal with what is over it`
        : `not found on this screen -- ${(error as Error).message}`,
    });
    emit({
      kind: "note",
      stepId: step.id,
      message: disputed
        ? `"${target}": the model and the tree found it in different places, so nothing was pressed; asking the agent again`
        : `"${target}" is not on this screen; asking the agent where it went`,
    });
    observation = await see({ settle });
    return true;
  };

  // The misses this action, about to be carried out on `target`, would answer:
  // one named in the same words, or one that -- looked for again on this
  // screen, which it was not missed on -- lands on the same control. Words
  // alone cannot tell "'Genel' or 'Genel yönetim'" and "'Genel'" apart from
  // "Save" and "Discard"; where the missed one is now can. On the screen it
  // was missed on, that question has already had its answer.
  const foundAgain = async (
    action: { name: ActionName; describeTarget?: string },
    target: Point,
  ): Promise<{ found: MissedTarget[]; undo: () => void }> => {
    const found: MissedTarget[] = [];
    const looked: { miss: MissedTarget; screen: string }[] = [];
    // The tree, for the control a point presses: a grounder lands anywhere
    // along a 400-point row, and the row is the thing to compare.
    let tree: TreeSnapshot | undefined | null = null;
    const treeNow = async (): Promise<TreeSnapshot | undefined> => {
      if (tree !== null) return tree;
      tree = observation.tree;
      if (!tree && engine.capabilities.tree) {
        const withTree = await engine.observe({ tree: true });
        tree = withTree.tree && screenMatches({ phash: observation.signature.phash }, withTree) ? withTree.tree : undefined;
      }
      return tree;
    };
    for (const miss of missedTargets) {
      if (miss.answered || miss.action !== action.name) continue;
      if (plainWords(action.describeTarget) === plainWords(miss.describeTarget)) {
        found.push(miss);
        continue;
      }
      if (miss.screen === observation.signature.phash || miss.regrounds >= REGROUNDS_PER_MISS) continue;
      looked.push({ miss, screen: miss.screen });
      miss.screen = observation.signature.phash;
      miss.regrounds += 1;
      const again = await engine
        .ground({ observation, description: miss.describeTarget, budget, ...(step.channel ? { hint: { preferChannel: step.channel } } : {}) })
        .catch(() => undefined);
      if (!again) continue;
      // Both ways: the two points press one control, and not merely one
      // inside the other -- a row holds its own (i) button, and pressing the
      // row is not pressing the button.
      const seen = await treeNow();
      const pressed = seen ? pressableAt(seen, target) : undefined;
      const meant = seen ? pressableAt(seen, again.point) : undefined;
      const same =
        pressed && meant
          ? pressed.x === meant.x && pressed.y === meant.y && pressed.width === meant.width && pressed.height === meant.height
          : Math.hypot(again.point.x - target.x, again.point.y - target.y) <= ANCHOR_DRIFT;
      emit({
        kind: "note",
        stepId: step.id,
        message: same
          ? `"${action.describeTarget ?? ""}" is "${miss.describeTarget}", found again on this screen`
          : `"${miss.describeTarget}" is on this screen, but not where the agent is about to ${action.name}`,
      });
      if (same) found.push(miss);
    }
    // An action that goes stale is not carried out: the looks it took are
    // given back, for when it is decided again on the screen as it is then.
    const undo = () => {
      for (const { miss, screen } of looked) {
        miss.screen = screen;
        miss.regrounds -= 1;
      }
    };
    return { found, undo };
  };

  // A target missed and never gone and got. Then the step did something
  // other than what it says, whatever the screen shows now.
  const unanswered = (): MissedTarget | undefined => missedTargets.find((miss) => !miss.answered);

  // A target the step asks for only if something comes about, gone without
  // coming about: on an iPhone 14 the agent went for YouTube's skip
  // button before the ad offered it, and the ad then ended by itself. Moot, a
  // miss no longer stands between a step whose expectation held and its pass;
  // it never turns a failure into the app's. Gone is both sources on a fresh
  // capture: the tree does not find it, and a model looks and says it is not
  // there. And nothing has been pressed since: what was pressed instead is a
  // detour, for a person to look at.
  const settleMisses = async (): Promise<void> => {
    const open = missedTargets.filter(
      (miss) => !miss.answered && !miss.moot && miss.conditional && !taken.slice(miss.at).some((done) => NEEDS_TARGET.has(done.action)),
    );
    if (!open.length) return;
    // A capture of its own: the frame the step goes on to judge, read values
    // off or remember as its end is the one it already holds.
    const withTree = engine.capabilities.tree && step.channel !== "vision";
    const now = await engine.observe({ settle, ...(withTree ? { tree: true } : {}) }).catch(() => undefined);
    if (!now) return;
    for (const miss of open) {
      if (miss.settledOn === now.signature.phash) continue;
      miss.settledOn = now.signature.phash;
      if (now.tree && (locateInTree(now.tree, miss.describeTarget, now.frame.size).target || treeShowsNamed(now.tree.root, miss.describeTarget))) continue;
      const gone = await engine
        .ground({ observation: now, description: miss.describeTarget, budget, ...(step.channel ? { hint: { preferChannel: step.channel } } : {}) })
        .then(
          () => false,
          (error: unknown) => error instanceof NotOnScreenError,
        );
      if (!gone) continue;
      miss.moot = true;
      emit({
        kind: "note",
        stepId: step.id,
        message: `"${miss.describeTarget}" was never pressed: the step asks for it only if it comes about, and it is not on the screen now`,
      });
    }
  };

  // Before an app is blamed for an expectation that did not hold: whether the
  // last press and the last typing went to what the step names, judged on the
  // screen each was decided on, never on where it led. On an iPhone
  // 14 a memory typed an address into the search box of the page Safari had
  // opened on; Google searched for it, and the app was accused. Only the last
  // of each: a tip closed or a row backed out of on the way is not where the
  // step ended up, and each press asked about is one more chance of a wrong
  // "off target". A look that cannot be had -- a black frame, a model that
  // cannot be asked -- leaves the blame where it was.
  const wentAstray = async (): Promise<{ at: Aimed; answer: AimResult } | undefined> => {
    if (!engine.aim || !step.do || !aimed.length) return undefined;
    const last = aimed[aimed.length - 1]!;
    const typed = [...aimed].reverse().find((at) => at.action.action === "input");
    let looked = 0;
    for (const at of typed && typed !== last ? [typed, last] : [last]) {
      if (at.decidedOn.visionBlind) continue;
      const answer = await engine
        .aim({
          instruction: step.do,
          observation: at.decidedOn,
          action: at.action.action,
          point: at.point,
          ...(at.action.describeTarget ? { meant: at.action.describeTarget } : {}),
          ...(at.action.action === "input" && typeof at.action.params?.value === "string" ? { text: at.action.params.value } : {}),
        })
        .catch(() => undefined);
      if (!answer) continue;
      looked += 1;
      if (!answer.onTarget) return { at, answer };
    }
    if (looked) {
      emit({ kind: "note", stepId: step.id, message: `checked where the agent last pressed and typed before blaming the app: ${looked === 1 ? "it went" : "both went"} to what the step names` });
    }
    return undefined;
  };

  // A step that could not find what it was told to act on, and went on
  // without it, has not failed on its own terms: where the detour led says
  // nothing about the app. It fails as it did before the agent was told of
  // the miss -- the element was not found -- and says what came after.
  const failed = (outcome: Outcome, detail: string): StepOutcome => {
    const miss = unanswered();
    return miss && outcome !== "FAIL_GROUND"
      ? { outcome: "FAIL_GROUND", detail: `${miss.detail}; the agent went on without it, and then: ${detail}`, actions }
      : { outcome, detail, actions };
  };

  /** The frame the expectation was last judged on -- by a model, from memory, or by a "no" already given to it. */
  let judgedOn: Observation | undefined;
  const checkNow = async (): Promise<AssertResult> => {
    // What is remembered is the screen and the words it was checked against:
    // the same step asking something else of the same screen -- a test edited
    // from "3 items" to "4 items" -- is a new question, and a model's.
    //
    // The print is the question as the engine would put it to a model --
    // instructions, model, expectation, tree lines, picture -- so a print
    // remembered is an answer the model already gave to that very input.
    const printOf = async (seen: Observation) =>
      engine.judgePrint
        ? engine.judgePrint({ observation: seen, assertion: step.expect!, ...(step.channel ? { channel: step.channel } : {}) }).catch(() => undefined)
        : undefined;
    // Answered from memory: a question a model passed twice, and not due
    // for another look after enough answers from memory.
    const answerable = (args.verdict?.prints ?? [])
      .filter((entry) => entry.passes >= CONFIRMED_AFTER && entry.since < REVERIFY_AFTER)
      .map((entry) => entry.print);
    let print = await printOf(observation);
    // A question a model has said no to in this step gets the same answer
    // without being asked: a turn that did nothing, such as a target missed,
    // or a grace look at a screen that has not moved, would put it the very
    // same question.
    const saidNo = (seen: string | undefined) => (seen ? refused.get(seen) : undefined);
    if (saidNo(print)) return saidNo(print)!;
    // Looked at again until two looks agree, so that what is judged -- by a
    // model or from memory -- and what is remembered of it is the screen at
    // rest, not a moment of its settling. Memory is not taken on one look:
    // a "Sent" that turns into "Not delivered" half a second later would be
    // passed from memory, while a model shown the screen at rest fails it.
    // Only when there is a memory to keep it in. A screen that does not come
    // to rest in those looks -- a spinner, a ring that animates in -- is never
    // answered from memory, and a model judges it as first seen; the step's
    // own view of it is left alone, because the pop-up guard knows a screen
    // by it.
    // At rest is a question for the picture: each look used to read the tree
    // too, and on an iPhone SE a tree read is 3 s, four of them before every
    // check of a screen that animates. The tree is read once, when two
    // pictures agree, and the screen is at rest only if a third agrees too.
    let atRest = false;
    if (args.remembering && print) {
      let latest = observation.signature.phash;
      const place = placeOf(observation);
      for (let look = 0; look < (args.restless?.has(place) ? 1 : REST_LOOKS); look += 1) {
        if (settle) await new Promise((resolve) => setTimeout(resolve, REST_MS));
        const glance = await engine.observe({});
        if (glance.signature.phash === latest) {
          const again = observation.tree ? await engine.observe({ tree: true }) : glance;
          const next = again.signature.phash === latest ? await printOf(again) : undefined;
          if (next) {
            observation = again;
            print = next;
            atRest = true;
          }
          break;
        }
        latest = glance.signature.phash;
      }
      if (atRest) args.restless?.delete(place);
      else args.restless?.add(place);
    }
    if (saidNo(print)) return saidNo(print)!;
    if (print && atRest && answerable.includes(print)) {
      // The very question this expectation held on before, to the pixel and
      // the word: the model would be shown the same thing, so it is not asked.
      // This is what makes a run replayed from memory cost nothing.
      args.onVerdict?.({ print, held: true, remembered: true, atRest });
      const reason = "the screen is exactly as it was when this last held";
      emit({
        kind: "assertion",
        stepId: step.id,
        message: `held, remembered: ${step.expect}`,
        data: { reason, remembered: true },
        screenshot: observation.frame.bytes,
      });
      // Put as the question was: the tree alone only when the step asked for
      // it and there was one, as the router would have put it.
      const treeOnly = step.channel === "tree" && Boolean(observation.tree);
      return { pass: true, reason, provenance: { tier: 0, usd: 0, latencyMs: 0, usedTree: treeOnly, channel: treeOnly ? "tree" : "vision" } };
    }
    // An expectation that names a page or quotes a phrase is checked against
    // the tree too: read now, from the same screen, and never shown to the
    // judge -- only its disagreement is, to a second look.
    let evidenceTree: Observation["tree"];
    if (!observation.tree && engine.capabilities.tree && checkable(claimsIn(step.expect!))) {
      const read = await engine.observe({ tree: true }).catch(() => undefined);
      if (read?.tree && screenMatches({ phash: observation.signature.phash }, read)) evidenceTree = read.tree;
    }
    const result = await engine.assert({
      observation,
      assertion: step.expect!,
      ...(step.channel ? { channel: step.channel } : {}),
      ...(evidenceTree ? { evidenceTree } : {}),
    });
    if (print) args.onVerdict?.({ print, held: result.pass, remembered: false, atRest });
    if (print && !result.pass) refused.set(print, result);
    emit({
      kind: "assertion",
      stepId: step.id,
      message: `${result.pass ? "held" : "not yet"}: ${step.expect}`,
      data: { reason: result.reason, ...(result.evidence ? { treeSaid: result.evidence } : {}) },
      // The frame the verdict was actually made on -- the one worth showing
      // next to the verdict, and the one a reader will want when they disagree
      // with it.
      screenshot: observation.frame.bytes,
    });
    return result;
  };
  const check = async (): Promise<AssertResult> => {
    const result = await checkNow();
    judgedOn = observation;
    return result;
  };

  for (let turns = 1; ; turns += 1) {
    // Whatever brought it here -- an action, a pop-up answered, a target
    // looked for, a decision dropped as stale -- the screen this turn stands
    // on is one the step has seen.
    const last = seenScreens[seenScreens.length - 1];
    if (!last || !sameScreen(last, observation)) seenScreens.push(seenOf(observation));
    if (turns > allowedTurns()) {
      return failed("BUDGET_EXHAUSTED", `took ${allowedTurns()} turns without finishing "${step.do ?? step.expect}"`);
    }
    // A step that says `do` always does it at least once, even if its
    // expectation already holds. Skipping the action because the end state
    // looks right is how a broken button passes its own test. And when the
    // memory was doubted part of the way through, what it did replay is not
    // the step done -- the action it doubted is. Seen on Android: a replayed
    // swipe, a doubted tap on "Display & touch", and a judge that read the
    // row of that name as the screen's title; the step passed where it had
    // not arrived, and the next one's back left the app.
    if (step.expect && (!step.do || (acted && (!healFrom || workedOut)))) {
      verdict = await check();
      if (verdict.pass) break;
      // Two goes and the check still has not held. The agent is not stuck --
      // each swipe moved the screen -- it simply cannot see what it is looking
      // for, which is the case the tree exists for. Waiting for the budget to
      // run out before reading it wastes the whole budget.
      if (actions >= 2) await lookHarder(`"${step.expect}" has not held after ${actions} actions`);
    }

    if (!step.do) break; // A check-only step: the expectation has spoken.
    // Nothing to check, the memory replayed in full, and the screen it left is
    // the one the agent said "done" on last time: that is the answer it gave
    // to this very screen, and it is not asked again. A replay that ends
    // anywhere else is put to the agent, with what it did in the history.
    if (turns === 1 && !step.expect && fromCache && remembered?.end && screenMatches(remembered.end, observation)) {
      emit({ kind: "note", stepId: step.id, message: "ended on the screen it was done on last time -- done, from memory" });
      break;
    }
    // Out of actions -- unless the last one is owed its verdict, which this
    // turn's plan gives, and which may earn the next action. Checked again
    // once it has.
    const atLimit = agentActions() >= allowedActions();
    if (atLimit && !owedVerdict && !owedAnswer) {
      ranOut = true;
      break;
    }
    // A step that earns its moves can outlast the test's own budget: the
    // test's time and money are counted before every plan as well as between
    // steps -- after the checks above, which spend nothing: a step whose
    // expectation already holds is not stopped for the time it took.
    const over = args.exhausted?.();
    if (over) return failed("BUDGET_EXHAUSTED", `${over}, while working on "${step.do ?? step.expect}"`);

    const askAboutPopups = popups < POPUPS_PER_STEP && observation.signature.phash !== leftOn;
    // A system prompt the tree in hand names -- the phone's own account asking
    // for its password, a permission -- is answered before the agent plans:
    // reading it costs nothing more. Met mid-step on an iPhone SE, the agent
    // pressed its Not Now as a plan, a grounding and a check -- 42 s of the
    // test's time -- and the press went into the step's memory.
    if (askAboutPopups && observation.tree && readSystemPrompt(observation.tree)?.kind && (await answerPopups({ look: false }))) continue;
    // Asked what done means until it says, twice at most: an agent that
    // cannot say is left to its judgement, as before.
    const understand = ledger.doneWhen === undefined && understandAsked < 2;
    if (understand) understandAsked += 1;
    const plan = await engine.plan({
      observation,
      goal: step.do,
      history,
      ...(args.journey ? { journey: args.journey } : {}),
      actionSpace: ACTION_SPACE,
      budget,
      ...(askAboutPopups ? { popups: true } : {}),
      ...(ledger.doneWhen || ledger.progress ? { ledger: { ...ledger } } : {}),
      ...(understand ? { understand: true } : {}),
    });
    if (plan.doneWhen && ledger.doneWhen === undefined) {
      ledger.doneWhen = plan.doneWhen;
      emit({ kind: "note", stepId: step.id, message: `done when: ${plan.doneWhen}`, data: { doneWhen: plan.doneWhen } });
    }
    if (plan.progress) ledger.progress = plan.progress;
    // The last action said what it would do and left a screen this step had
    // not seen, and the agent, looking at it, says it did: the step is
    // getting somewhere, and that buys more actions. Its word about a screen
    // it has stood on before buys nothing.
    if (owedVerdict && plan.last === "as expected") earned += EARNED_PER_NEW_SCREEN;
    owedVerdict = false;
    owedAnswer = false;
    if (!saidEarned && allowedActions() > given && agentActions() >= given) {
      saidEarned = true;
      emit({ kind: "note", stepId: step.id, message: `past ${given} actions: each one did what it said and reached a new screen, so the step goes on (up to ${ACTIONS_CEILING})` });
    }
    // The turn granted only to hear that verdict: nothing earned, and no
    // "done" said in so many words. An empty answer here is the agent with
    // nothing more to do in its budget, not an agent that has finished.
    if (atLimit && agentActions() >= allowedActions() && plan.done !== true) {
      ranOut = true;
      break;
    }
    // Named without being asked is not named: an engine that ignored the
    // question would otherwise stop the step here on every turn.
    if (askAboutPopups && plan.popup) {
      if (await answerPopups({ look: true, hint: plan.popup })) continue;
      // Not answered: the rules leave it to the test, nothing on it does what
      // they say, or a second look found nothing there. Either way the step
      // deals with this screen as it is, the way it always has.
      leftOn = observation.signature.phash;
      history.push({
        action: "wait",
        description: plan.popup.title ?? POPUP_NAMES[plan.popup.kind],
        outcome: "not answered for you -- deal with it if it is in the way",
      });
      continue;
    }
    if (plan.done || plan.actions.length === 0) {
      // A planner that declares victory before doing anything may have misread
      // the screen -- a focused search field looks a lot like a filled one --
      // so it gets told, once, that nothing has happened yet. Told only that,
      // it acts to please: on a Galaxy A53, asked to "go back until the
      // top-level Settings list is showing" with that list already showing, it
      // pressed back while saying "no need to go back", and left the app. So
      // it is told what done means: an action the goal asks for is carried
      // out; a state the goal asks to reach, already on the screen, is done.
      // Twice and we let it go: the expectation has the last word.
      // The same, after a memory doubted part of the way: what was replayed
      // is not the step done, and the action the memory doubted has not been
      // carried out.
      const doubtedAndIdle = Boolean(healFrom) && !workedOut;
      if ((!acted || doubtedAndIdle) && refusals < 1) {
        refusals += 1;
        history.push({
          action: "wait",
          description: step.do,
          outcome:
            (doubtedAndIdle
              ? `what was remembered stopped checking out (${healReason}), and nothing has been done since. `
              : "nothing has been done yet in this step. ") +
            "If the goal asks for an action, carry it out now; " +
            "if it only asks to reach a state that this screen already shows, answer done again",
        });
        continue;
      }
      // It looked for a target, did not find it, and has done nothing since:
      // the action this step is about never happened, whatever the screen
      // shows -- however much it did before the target went missing. Unless
      // the step asked for it only once it came about, and it never did.
      const miss = missedTargets[missedTargets.length - 1];
      if (miss && !miss.answered && taken.length === miss.at) await settleMisses();
      if (miss && !miss.answered && !miss.moot && taken.length === miss.at) return { outcome: "FAIL_GROUND", detail: miss.detail, actions };
      // With no expectation of the author's to decide, the agent's "done" is
      // put to the judge, as what the agent itself said done means. A planner
      // reads a goal reached where it is not -- a row named like the page it
      // opens -- and its own word is the one thing that cannot check it.
      if (!step.expect && ledger.doneWhen) {
        const doneWhen = ledger.doneWhen;
        // Checked against the tree as an expectation is: a page it names by
        // its heading, a phrase it quotes by the screen's words.
        const judgeDone = async (): Promise<AssertResult> => {
          const known = doneJudged.get(observation.signature.phash);
          if (known) return known;
          let evidenceTree: Observation["tree"];
          if (!observation.tree && engine.capabilities.tree && checkable(claimsIn(doneWhen))) {
            const read = await engine.observe({ tree: true }).catch(() => undefined);
            if (read?.tree && screenMatches({ phash: observation.signature.phash }, read)) evidenceTree = read.tree;
          }
          const answer = await engine.assert({
            observation,
            assertion: doneWhen,
            ...(step.channel ? { channel: step.channel } : {}),
            ...(evidenceTree ? { evidenceTree } : {}),
          });
          doneJudged.set(observation.signature.phash, answer);
          return answer;
        };
        // The grace an expectation gets: the screen the agent called done on
        // may still be arriving.
        let held = await judgeDone();
        for (let attempt = 1; !held.pass && attempt < EXPECT_ATTEMPTS; attempt += 1) {
          if (settle) await new Promise((resolve) => setTimeout(resolve, EXPECT_GRACE_MS));
          observation = await see({ settle });
          held = await judgeDone();
        }
        if (!held.pass) {
          doneRefusals += 1;
          emit({
            kind: "note",
            stepId: step.id,
            message: `the agent said it was done, but "${ledger.doneWhen}" does not hold: ${held.reason}`,
          });
          if (doneRefusals >= DONE_REFUSALS) {
            return failed(
              "BUDGET_EXHAUSTED",
              `the agent said "${step.do}" was done ${doneRefusals} times, and "${ledger.doneWhen}" never held: ${held.reason}`,
            );
          }
          // Not "carry on until it does": told only that, an agent acts to
          // please, and what it does is learned into the step. If the goal is
          // done and only its sentence was wrong, it says done again, and the
          // step ends there as not shown to be done -- which is the truth.
          history.push({
            action: "wait",
            description: step.do,
            outcome:
              `you answered done, but "${ledger.doneWhen}" does not hold on this screen (${held.reason}). ` +
              "If the goal is not done yet, carry on with it. If it is done as the goal says, answer done again. " +
              "Do nothing the goal does not ask for",
          });
          // Told it may answer done again, it gets the turn to, even at the limit.
          owedAnswer = true;
          continue;
        }
        emit({ kind: "note", stepId: step.id, message: `done: "${ledger.doneWhen}" holds -- ${held.reason}` });
      }
      break;
    }

    // Only the first action, however many were planned. Everything after it
    // was planned from an observation that the first action has already made
    // obsolete -- which is the same reason `act` demands the observation its
    // decision came from. In practice a model that plans three taps at once
    // has guessed at two of them.
    {
      const action = plan.actions[0]!;

      const rejected = rejectReason(action);
      if (rejected) {
        actions += 1; // bounded: a planner that keeps malforming still stops
        history.push({ action: action.name, description: aimOf(action), outcome: `rejected -- ${rejected}` });
        emit({ kind: "note", stepId: step.id, message: `rejected ${action.name}: ${rejected}` });
        continue;
      }

      let target;
      let anchor;
      let grounded: GroundResult | undefined;
      /** Whether the picture moved while this was decided, once that has been looked at. */
      let movedAlone: boolean | undefined;
      if (NEEDS_TARGET.has(action.name)) {
        if (!action.describeTarget) {
          return {
            outcome: "FAIL_GROUND",
            detail: `the agent asked to ${action.name} without saying what to ${action.name}`,
            actions,
          };
        }
        // A target is found by both sources at once -- the picture and the
        // tree, from one capture -- so the tree is read before grounding. The
        // read used to come after the tap, for the memory's anchor; made here,
        // it serves both. A screen that moved on since the plan was made is not
        // the screen the plan was for: the agent plans again on it, rather than
        // look there for what it meant on the last one -- a dialog that opened
        // while it thought has an "OK" of its own. A tree that cannot be read
        // leaves the picture to find the target alone, as it always could. A
        // plan made from a tree needs only the picture to say whether it stands:
        // a second read of the same screen cost 1-2 s on every press.
        if (engine.capabilities.tree && step.channel !== "vision") {
          let withTree: Observation | undefined;
          const planned = observation;
          const planTree = planned.tree;
          try {
            withTree = await engine.observe(planTree ? {} : { tree: true });
          } catch (error) {
            emit({
              kind: "note",
              stepId: step.id,
              message: `the accessibility tree could not be read (${(error as Error).message}); finding the target from the picture alone`,
            });
          }
          if (withTree) movedAlone = hamming(withTree.signature.phash, planned.signature.phash) > STALE_DISTANCE;
          if (withTree && !screenMatches({ phash: planned.signature.phash }, withTree) && staleDrops < STALE_DROPS) {
            // A video playing on a feed moves the picture and no control, and
            // planning again for it cost 12 s a press. The tree says which this
            // is: a plan for the same controls stands, and a dialog that opened
            // meanwhile is a control more.
            const read = withTree.tree ? withTree : await see();
            if (!planned.signature.treeHash || read.signature.treeHash !== planned.signature.treeHash) {
              staleDrops += 1;
              actions += 1; // bounded: a screen that never stops moving still stops the step
              observation = read;
              emit({ kind: "note", stepId: step.id, message: `the screen changed while deciding to ${action.name} ${aimOf(action)}; deciding again` });
              history.push({ action: action.name, description: aimOf(action), outcome: "not carried out -- the screen changed while deciding" });
              continue;
            }
            withTree = read;
          }
          if (withTree) observation = withTree.tree || !planTree ? withTree : { ...withTree, tree: planTree, signature: { ...withTree.signature, ...(planned.signature.treeHash ? { treeHash: planned.signature.treeHash } : {}) } };
        }
        try {
          const ground = await engine.ground({
            observation,
            description: action.describeTarget,
            budget,
            ...(step.channel ? { hint: { preferChannel: step.channel } } : {}),
          });
          target = ground.point;
          anchor = ground.anchor;
          confidence = ground.confidence;
          resolvedBy = ground.provenance.model;
          grounded = ground;
        } catch (error) {
          // A model that could not be asked is the tooling failing, not a
          // target that is missing: the run stops on it as such, rather than
          // send the agent looking for something that may be right there.
          if (error instanceof ModelError && !(error instanceof NotOnScreenError) && !(error instanceof SourcesDisagreeError)) {
            throw error;
          }
          // The picture alone could not find it and the tree is not in hand --
          // it could not be read a moment ago: read it once more and ask again,
          // both together. Not for a step that asked for the picture alone.
          if (!observation.tree && engine.capabilities.tree && step.channel !== "vision") {
            try {
              const withTree = await engine.observe({ tree: true });
              const retried = await engine.ground({
                observation: withTree,
                description: action.describeTarget,
                budget,
                ...(step.channel ? { hint: { preferChannel: step.channel } } : {}),
              });
              observation = withTree;
              target = retried.point;
              anchor = retried.anchor;
              confidence = retried.confidence;
              resolvedBy = retried.provenance.model;
              grounded = retried;
            } catch {
              if (await missed(action, error)) continue;
              return {
                outcome: "FAIL_GROUND",
                detail: `could not locate "${action.describeTarget}": ${(error as Error).message}`,
                actions,
              };
            }
          } else {
            if (await missed(action, error)) continue;
            return {
              outcome: "FAIL_GROUND",
              detail: `could not locate "${action.describeTarget}": ${(error as Error).message}`,
              actions,
            };
          }
        }

        // A target is remembered by its control, not only by its pixels. A
        // target on flat pixels -- most list rows -- leaves no patch worth
        // keeping at all, and any patch is good only where the target was: a
        // row a replayed swipe left somewhere else is found again by its
        // control, never by its pixels, and otherwise the next run asks the
        // model again and files a heal for an app that did not change.
        // Reading the tree here costs about a second and no model call, once,
        // when the step is learned; the replay reads it again to check the
        // control it names. When a doubted memory is being worked out again,
        // it makes the heal decision compare controls rather than coordinates,
        // and the card shows what was found. Only while the screen is still
        // the one the target was found on.
        if (target && anchor && !anchor.tree && engine.capabilities.tree) {
          // The tree in hand, from the capture the target was found on, or
          // one read now -- trusted only while the screen is still that one.
          const withTree = observation.tree ? observation : await engine.observe({ tree: true }).catch(() => undefined);
          const control =
            withTree?.tree && (withTree === observation || screenMatches({ phash: observation.signature.phash }, withTree))
              ? anchorAt(withTree.tree, target)
              : undefined;
          if (control) anchor = { ...anchor, tree: control };
        }
      }

      const actedBefore: boolean = acted;
      acted = true;
      // A step that says how long it takes may take that long: the agent's own
      // waits, until they add up to its `within`, are not a loop and spend
      // none of its moves -- and the turn stays the agent's, so it can press
      // "Skip" the moment an ad offers it, which the step's own wait never would.
      const free = step.within !== undefined && action.name === "wait" && waitedMs < step.within;
      // Oscillation guard. A model that swipes up, then down, then up again is
      // not exploring -- it is stuck, and the budget it burns buys nothing.
      const fingerprint = `${observation.signature.phash}|${action.name}|${action.describeTarget ?? ""}`;
      if (!free) recent.push(fingerprint);
      if (recent.length > LOOP_WINDOW) recent.shift();
      if (!free && recent.filter((entry) => entry === fingerprint).length >= LOOP_REPEATS) {
        // Being stuck is the loudest signal there is that the pixels are not
        // enough -- the agent swipes past the row it is looking for because it
        // cannot see the whole list. So the tree is read once here, rather
        // than giving up on a step the system can describe perfectly well.
        if (await lookHarder(`repeating "${action.name}"`)) continue;
        return failed("LOOP_DETECTED", `repeated "${`${action.name} ${action.describeTarget ?? ""}`.trim()}" on the same screen`);
      }

      // A list that moves between the decision and the press sends the press
      // to its neighbour: Settings on an iPhone pushed down by a banner that
      // loads late opened Bluetooth for Wi-Fi, and a Wi-Fi list re-sorting as
      // it scans opened another network's password for this one's gear. So the
      // control the target was found as is looked for on the tree as it is now,
      // and pressed where it is, as a remembered press is. One that is gone is
      // a screen that moved on, and the plan is made again on it.
      // An engine that presses the control itself, where it is at the press,
      // needs none of this for a tap: on an iPhone the read cost 2-3 s, and a
      // list re-sorting as it scanned moved again within them.
      let pressedOn: Observation | undefined;
      const engineFollows = engine.capabilities.pressesControls === true && action.name === "tap";
      if (!engineFollows && target && anchor?.tree?.label && NEEDS_TARGET.has(action.name) && engine.capabilities.tree && step.channel !== "vision" && smallPart(anchor.tree.bounds, observation.frame.size)) {
        const now = await engine.observe({ tree: true }).catch(() => undefined);
        if (now?.tree) {
          if (!(await verifyAnchor(anchor, target, now)).ok) {
            const moved = relocateAnchor(anchor, target, now);
            if (moved) {
              emit({ kind: "note", stepId: step.id, message: `${aimOf(action)} moved before the press: pressed where it is now` });
              target = moved;
            } else if (staleDrops < STALE_DROPS) {
              // Not carried out is not acted: the expectation does not end a step whose press never happened.
              acted = actedBefore;
              staleDrops += 1;
              actions += 1; // bounded: a screen that never stops moving still stops the step
              observation = now;
              emit({ kind: "note", stepId: step.id, message: `the screen changed while deciding to ${action.name} ${aimOf(action)}; deciding again` });
              history.push({ action: action.name, description: aimOf(action), outcome: "not carried out -- the screen changed while deciding" });
              continue;
            }
          }
          pressedOn = now;
        }
      }

      // Whether this is a target the agent missed, in other words.
      const recheck = target ? await foundAgain(action, target) : { found: [], undo: () => {} };

      const before = observation.signature.phash;
      const decidedOn = observation;
      // Added to what a field holds, the text goes at its end: a tap in the
      // middle of the field would put the caret, and the text, there.
      const appending = action.name === "input" && action.params?.append === true;
      const pressAt =
        appending && grounded?.rect
          ? {
              x: Math.round(grounded.rect.x + grounded.rect.width - Math.min(12, grounded.rect.width / 4)),
              y: Math.round(grounded.rect.y + grounded.rect.height / 2),
            }
          : target;
      // A screen that moved on its own while this was decided will not come to
      // rest, and what a press brings up on it -- a player's controls, hidden
      // again in seconds -- is gone by the time settling gives up.
      const restless = settle && pressAt ? (movedAlone ?? (pressedOn ? hamming(pressedOn.signature.phash, before) > STALE_DISTANCE : await engine.observe({}).then((seen) => hamming(seen.signature.phash, before) > STALE_DISTANCE, () => false))) : false;
      const dispatched = await engine.act({
        name: action.name,
        ...(pressAt ? { target: pressAt } : {}),
        ...(action.params ? { params: action.params } : {}),
        decidedFrom: pressedOn ?? observation,
        ...(staleDrops < STALE_DROPS ? { staleGuard: { maxAgeMs: STALE_AFTER_MS, maxPhashDistance: STALE_DISTANCE } } : {}),
      });

      if (dispatched.stale) {
        // Nothing was carried out. Look again and decide again -- and count it,
        // so a screen that never stops moving cannot spin here forever. Not
        // carried out is not acted: the expectation does not get to end a
        // step whose action never happened.
        recheck.undo();
        acted = actedBefore;
        actions += 1;
        staleDrops += 1;
        observation = await see({ settle });
        emit({ kind: "note", stepId: step.id, message: `dropped a stale ${action.name}: the screen moved while deciding` });
        history.push({ action: action.name, description: aimOf(action), outcome: "not carried out -- the screen had moved" });
        continue;
      }

      actions += 1;
      staleDrops = 0;
      if (free) {
        freeWaits += 1;
        waitedMs += Math.max(0, Number(action.params?.ms ?? 1000));
      }
      observation = await see({ settle: settle && !restless, ...(pressAt ? { changedFrom: before } : {}) });

      // What the planner needs to know next time is not that we dispatched an
      // action -- it is whether anything happened. A swipe that moved nothing
      // and a swipe that scrolled the page look identical in a list of
      // dispatches, and the difference is the whole signal. A field that now
      // holds something else changed too, though no pixel did: an iPhone's
      // screenshot shows neither a password's dots nor the keyboard typing it,
      // and a typed password read as "nothing changed" was typed again until
      // the step stopped on three actions that changed nothing.
      const heldBefore = fieldsHold(decidedOn.tree);
      const heldAfter = fieldsHold(observation.tree);
      const moved = before !== observation.signature.phash || (heldBefore !== undefined && heldAfter !== undefined && heldBefore !== heldAfter);
      still = moved || free ? 0 : still + 1;

      // Carried out, whatever comes of it: part of what the step did now, and
      // a missed target it landed on was gone and got.
      workedOut = true;
      taken.push({
        action: action.name,
        ...(action.describeTarget ? { describeTarget: action.describeTarget } : {}),
        ...(action.params ? { params: action.params } : {}),
        ...(target ? { point: target } : {}),
        ...(anchor ? { anchor } : {}),
      });
      if (target && NEEDS_TARGET.has(action.name)) aimed.push({ action: taken[taken.length - 1]!, point: target, decidedOn, fromMemory: false });
      for (const miss of recheck.found) miss.answered = true;

      // A tap that changed nothing is the signature of a mis-grounded tap, and
      // it is the moment the accessibility tree earns its seconds.
      if (!moved && !free) await lookHarder("nothing moved");
      if (still >= NO_PROGRESS_LIMIT) {
        return failed("LOOP_DETECTED", `${still} actions in a row changed nothing on screen`);
      }

      const said =
        action.name === "input" ? ` "${String(action.params?.value ?? "")}"` : "";
      emit({
        kind: "action",
        stepId: step.id,
        message: `${action.name}${said} ${aimOf(action)}`.trim(),
        data: {
          target,
          moved,
          ...(dispatched.via ? { via: dispatched.via } : {}),
          ...(dispatched.pointBecause ? { pointBecause: dispatched.pointBecause } : {}),
          // The model and the tree on the same control, or one of them alone --
          // for an action with a target; a swipe or a back was found by nobody.
          ...(grounded ? { by: grounded.foundBy ?? "model" } : {}),
          ...(grounded ? describeGrounding(grounded) : {}),
          // The tree lines exactly as the grounder read them, when it read any.
          ...(grounded && grounded.provenance.channel !== "vision" && decidedOn.tree
            ? { tree: compactTree(decidedOn.tree.root, { scaleTo: decidedOn.frame.size }).text }
            : {}),
          ...(plan.reasoning ? { thought: plan.reasoning } : {}),
          ...(action.effect ? { expected: action.effect } : {}),
          ...(ledger.progress ? { progress: ledger.progress } : {}),
          screen: decidedOn.frame.size,
        },
        screenshot: decidedOn.frame.bytes,
        shotId: `${step.id}.action-${actions}`,
      });
      const holds = target ? await checkTyped(action, target, decidedOn) : undefined;
      const sent = await sendTyped(action);
      history.push({
        action: action.name,
        description: aimOf(action),
        outcome:
          (moved ? "the screen changed" : "the screen did not change") +
          (holds !== undefined ? `; the field holds "${holds}", not what was typed` : "") +
          (action.name === "input" && hiddenHeld ? `; ${hiddenHeld}` : "") +
          (sent ? "; then Enter was pressed to send it" : ""),
        ...(action.effect ? { expected: action.effect } : {}),
      });
      // Said what it would do, and left a screen not seen before in this
      // step: the next turn, looking at what is there, says whether it did.
      const fresh = !sawBefore(observation);
      seenScreens.push(seenOf(observation));
      owedVerdict = Boolean(action.effect) && moved && fresh;
    }
  }

  // Out of moves without having carried out what the step says to do --
  // every plan dropped as the screen moved, or replanned: whatever the
  // screen shows now, the step did not do it.
  if (step.do && ranOut && !taken.length) {
    return failed("BUDGET_EXHAUSTED", `took ${tookActions()} and never carried out "${step.do}"`);
  }
  // The memory was doubted part of the way, and the agent never carried out
  // the action it doubted: what was replayed is not the step done.
  if (step.do && ranOut && healFrom && !workedOut) {
    return failed("BUDGET_EXHAUSTED", `what was remembered stopped checking out (${healReason}), and the agent never got to work it out`);
  }

  // From memory only if the memory was all it took: a replay the agent had to
  // carry on from is a step worked out again.
  if (taken.length > replayedCount) fromCache = false;
  const result: StepOutcome = {
    outcome: "PASS",
    detail: step.do ?? step.expect ?? "",
    actions,
    ...(fromCache ? { fromCache: true } : {}),
  };

  if (step.expect) {
    // Before concluding it is false, give the screen time to finish arriving.
    const giveItTime = async (first: AssertResult): Promise<AssertResult> => {
      let current = first;
      for (let attempt = 1; !current.pass && attempt < EXPECT_ATTEMPTS; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, EXPECT_GRACE_MS));
        observation = await see({ settle });
        current = await check();
        if (current.pass) {
          emit({
            kind: "note",
            stepId: step.id,
            message: `"${step.expect}" held on look ${attempt + 1} -- the screen was still arriving`,
          });
        }
      }
      return current;
    };

    // `within`: the author's word for how long this takes -- a network joined,
    // a page loaded. Looked at until then, and put to a model only when the
    // question it would be asked has changed since its last answer: the print
    // of that question -- the picture to the pixel, as the model would see it
    // -- or, between looks that read it, any word the tree shows. treeHash is
    // the screen's controls, and a row going from "Connecting" to "Connected"
    // leaves those as they were; dHash barely moves for a word. The tree is
    // read to see the screen change, never shown to the judge: what it is asked
    // is what a step without a wait would ask.
    const waitStarted = Date.now();
    // What the agent already waited of it is spent; never less patient than an
    // expectation without one.
    const until = step.within ? waitStarted + Math.max(step.within - waitedMs, (EXPECT_ATTEMPTS - 1) * EXPECT_GRACE_MS) : 0;
    const lookMs = settle ? WITHIN_LOOK_MS : 5;
    const expectation = step.expect;
    const claims = claimsIn(expectation);
    const readTree = wantsTree || engine.capabilities.tree;
    const printOf = async (seen: Observation): Promise<string> =>
      (engine.judgePrint
        ? await engine.judgePrint({ observation: seen, assertion: expectation, ...(step.channel ? { channel: step.channel } : {}) }).catch(() => undefined)
        : undefined) ?? seen.signature.phash;
    // A look: the picture, and the tree when it can be read -- a tree that
    // cannot be read this once is no reason to end the run.
    const look = (): Promise<Observation> => (readTree ? engine.observe({ tree: true }).catch(() => engine.observe({})) : engine.observe({}));
    // What the judge is shown of a look: what it would be shown with no wait.
    const asJudged = (seen: Observation): Observation => {
      if (wantsTree || !seen.tree) return seen;
      const { tree: _tree, ...bare } = seen;
      const { treeHash: _treeHash, ...signature } = seen.signature;
      return { ...bare, signature };
    };
    const wordsOf = (seen: Observation) => (seen.tree ? textHash(seen.tree.root) : undefined);
    let outOfTime: string | undefined;
    const poppedUp = new Set<string | undefined>();
    const waitFor = async (first: AssertResult): Promise<AssertResult> => {
      if (first.pass) return first;
      let current = first;
      const last = judgedOn ?? observation;
      let judged = { print: await printOf(asJudged(last)), words: wordsOf(last) };
      let looks = 0;
      let against: boolean | undefined;
      const judge = async (seen: Observation, print: string) => {
        observation = asJudged(seen);
        const asked = observation;
        current = await check();
        // Its own looks at rest may have judged a later frame.
        judged = { print: judgedOn === asked ? print : await printOf(asJudged(judgedOn ?? observation)), words: wordsOf(seen) };
        looks = 0;
      };
      while (Date.now() < until) {
        if (current.pass) {
          // A link that comes up and drops again says "Connected" for a moment:
          // what held is looked at once more, and holds if it still shows.
          await new Promise((resolve) => setTimeout(resolve, lookMs * 2));
          const again = await look();
          const print = await printOf(asJudged(again));
          if (print === judged.print) return current;
          await judge(again, print);
          if (current.pass) return current;
          continue;
        }
        outOfTime = args.exhausted?.();
        if (outOfTime) return current;
        // Each screen that does not hold is looked at for something in front
        // of it, and what the rules answer is put out of the way at once -- a
        // dialog of no known kind only while the test has not acted. What is
        // the app's own answer -- an error, a confirmation -- the model is
        // told to leave.
        if (!poppedUp.has(judged.print)) {
          poppedUp.add(judged.print);
          if (await answerPopups({ look: true, lookAgain: true })) looks = WITHIN_ASK_LOOKS;
        }
        await new Promise((resolve) => setTimeout(resolve, lookMs));
        const seen = await look();
        looks += 1;
        const print = await printOf(asJudged(seen));
        const words = wordsOf(seen);
        // The tree said no a look ago and says yes now: a model is asked at
        // once. Not merely "it does not disagree": the words an expectation
        // quotes are often the very row it is about, there all along.
        const disagrees = seen.tree && checkable(claims) ? treeEvidence(seen.tree, claims, seen.frame.size).length > 0 : undefined;
        const turned = against === true && disagrees === false;
        against = disagrees;
        const changed = print !== judged.print || (words !== undefined && judged.words !== undefined && words !== judged.words);
        if (!changed) continue;
        if (looks < WITHIN_ASK_LOOKS && !turned && Date.now() + lookMs < until) continue;
        await judge(seen, print);
      }
      // Time is up. What fails is the screen as it ended: one that changed since
      // its last answer -- while that answer was being given -- is asked again.
      if (!current.pass && !outOfTime) {
        const seen = await look();
        const print = await printOf(asJudged(seen));
        if (print !== judged.print) await judge(seen, print);
      }
      return current;
    };
    const waitOrGrace = async (first: AssertResult): Promise<AssertResult> =>
      step.within && Date.now() < until ? waitFor(first) : giveItTime(first);

    // The planner can declare itself done without ever moving, and a step
    // whose expectation was never evaluated has proved nothing either way.
    verdict = verdict ?? (await check());
    if (!verdict.pass && step.within) emit({ kind: "note", stepId: step.id, message: `waiting up to ${step.within / 1000} s for "${step.expect}"` });
    verdict = await waitOrGrace(verdict);

    // Before the app is blamed, look for something sitting on top of what the
    // expectation is about. A rating sheet over the chat hides the "sent" mark
    // as thoroughly as a bug that never drew it, and only one of the two is
    // the app's fault. It costs a call, on a step that was about to fail.
    // Once the test has acted, a dialog of no known kind is left for the
    // verdict: this late, it is the likeliest thing on screen to be the
    // failure itself.
    if (!verdict.pass && !outOfTime && (await answerPopups({ look: true, lookAgain: true }))) {
      verdict = await waitOrGrace(await check());
    }

    // The test's own time ran out while it waited: nobody can say whether the
    // expectation would have held.
    if (!verdict.pass && outOfTime) return failed("BUDGET_EXHAUSTED", `${outOfTime}, while waiting for "${step.expect}"`);

    if (!verdict.pass) {
      // Which of the two is true matters: an agent that ran out of moves has
      // not shown the app is broken, and saying it has is how a tool loses the
      // room.
      // Ran out, not "took a lot": an agent that said done on its last
      // earned action finished, and its expectation's answer is a verdict.
      if (ranOut) return failed("BUDGET_EXHAUSTED", `took ${tookActions()} and "${step.expect}" never held`);
      const said = step.within ? `did not hold within ${step.within / 1000} s: ${verdict.reason}` : verdict.reason;
      // A target missed and never gone and got -- moot or not -- fails the
      // step as a lost target; only then is where the agent went asked about.
      if (unanswered()) return failed("FAIL_ASSERT", said);
      const astray = await wentAstray();
      if (astray) {
        const { at, answer } = astray;
        const went = `${at.action.action === "input" ? "typed into" : "pressed"} ${at.action.describeTarget ? `"${at.action.describeTarget}"` : "a point"}`;
        // A memory that did it is for a person to look at, like any memory
        // that stopped checking out. It is forgotten -- and the phones that
        // share it work the step out again -- only on two models' word.
        const before: HealRecord["before"] = {
          action: at.action.action,
          ...(at.action.describeTarget ? { describeTarget: at.action.describeTarget } : {}),
          point: at.point,
          ...(at.action.anchor ? { anchor: at.action.anchor } : {}),
        };
        // A person who looked at this memory going astray and said it did
        // not: the press was the step's, and so is the failure after it.
        if (at.fromMemory && args.rejected.some((record) => record.kind === "astray" && sameTarget(record.before, before))) {
          emit({ kind: "note", stepId: step.id, message: `a model said the memory ${went} where the step does not say, but a person ruled it is what the step names`, data: { review: "rejected" } });
          return failed("FAIL_ASSERT", said);
        }
        const heal: HealRecord | undefined = at.fromMemory
          ? {
              step: step.id,
              at: new Date().toISOString(),
              reason: `the memory ${went}, which is not what the step names: ${answer.reason}; the step then failed: ${said}`,
              before,
              after: {},
              confidence,
              status: "pending_review",
              kind: "astray",
            }
          : undefined;
        return {
          outcome: "FAIL_GROUND",
          detail: `the ${at.fromMemory ? "memory" : "agent"} ${went}, which is not what the step names: ${answer.reason}; and then: ${said}`,
          actions,
          ...(heal ? { heal } : {}),
          ...(heal && answer.confirmed ? { forget: true } : {}),
        };
      }
      return failed("FAIL_ASSERT", said);
    }
    if (step.within && Date.now() - waitStarted >= 1000) {
      emit({ kind: "note", stepId: step.id, message: `"${step.expect}" held after ${Math.round((Date.now() - waitStarted) / 1000)} s` });
    }
    result.detail = verdict.reason;
  } else if (ranOut) {
    return failed("BUDGET_EXHAUSTED", `took ${tookActions()} without finishing "${step.do}"`);
  }

  // Held, but nothing was done since the step's last target went missing:
  // what the step is about never happened -- the screen got there by itself.
  // Not so for a target the step asked for only once it came about, gone
  // without coming about; the look also takes it off the heal below.
  if (unanswered()) await settleMisses();
  const lastMiss = missedTargets[missedTargets.length - 1];
  if (lastMiss && !lastMiss.answered && !lastMiss.moot && taken.length === lastMiss.at) return { outcome: "FAIL_GROUND", detail: lastMiss.detail, actions };

  if (step.extract) {
    const extracted = await engine.extract({
      observation,
      schema: step.extract,
      ...(step.channel ? { channel: step.channel } : {}),
    });
    result.extracted = extracted.data as Record<string, unknown>;
    emit({ kind: "extraction", stepId: step.id, message: "read values off the screen", data: extracted.data });
  }

  // What this step did, for next time. Stability is the caller's to count.
  result.resolution = {
    ...(step.do ? { do: step.do } : {}),
    screen: learnedOn,
    actions: taken,
    // Where it was done, when nothing else says it was.
    ...(step.do && !step.expect ? { end: screenOf(observation) } : {}),
    tier: fromCache ? 0 : 1,
    ...(resolvedBy ? { model: resolvedBy } : {}),
    confidence,
    stability: { runs: 0, passes: 0 },
  };
  // The memory replayed whole and undoubted, and the step still needed the
  // agent: what it added is this run's, not the step's. A swipe flings to a
  // different place every time, and adding each run's corrections to the
  // memory lengthens it run after run -- 4, 8, 12, 16 -- each run replaying
  // more of what went wrong the last time. The memory is kept as it was; a
  // change in the app shows up as a memory that stops checking out, and is a
  // heal for a person.
  if (remembered && replayedCount === remembered.actions.length && !healReason && taken.length > replayedCount) {
    const { stability: _kept, ...asItWas } = remembered;
    result.resolution = { ...asItWas, stability: { runs: 0, passes: 0 } };
    emit({
      kind: "note",
      stepId: step.id,
      message: `the memory replayed in full and the step still took ${taken.length - replayedCount} more actions; the memory is kept as it was, not lengthened`,
    });
  }

  // A heal is not "the agent recovered" -- it is "what we remembered stopped
  // being true, and here is the diff". It is recorded even though the step
  // passed, the run is marked HEALED_PASS rather than PASS, and a person
  // decides whether the change was a copy edit or a broken flow. Every
  // competitor in this category heals silently; that is the part that makes
  // self-healing dangerous rather than useful.
  let heal: HealRecord | undefined;
  if (healFrom && healReason) {
    // What we did instead, in order of usefulness to somebody reviewing it:
    // the same kind of action, then any action with a target, then whatever
    // was done at all. Only what happened *after* the memory was doubted
    // counts -- the actions before it are the memory, and quoting one of them
    // back as the discovery ("we remembered a tap, we found a swipe") reads
    // like a finding when it is just the replay that got that far.
    const found = taken.slice(replayedCount);
    const after =
      found.find((entry) => entry.action === healFrom.action && entry.point) ??
      found.find((entry) => entry.point) ??
      found.find((entry) => entry.action === healFrom.action) ??
      found[found.length - 1];
    if (!after) {
      // The step passed without doing anything: the screen was already where
      // the test wanted it. Worth recording, because a remembered tap that is
      // never needed again is a test that has stopped testing.
      heal = {
        step: step.id,
        at: new Date().toISOString(),
        reason: `${healReason}; the step then passed without acting`,
        before: { action: healFrom.action, ...(healFrom.point ? { point: healFrom.point } : {}) },
        after: {},
        confidence,
        status: "pending_review",
      };
    } else if (!foundWhatWasMeant(healBy, healFrom, after)) {
      heal = {
        step: step.id,
        at: new Date().toISOString(),
        reason: healReason,
        before: {
          action: healFrom.action,
          ...(healFrom.describeTarget ? { describeTarget: healFrom.describeTarget } : {}),
          ...(healFrom.point ? { point: healFrom.point } : {}),
          ...(healFrom.anchor ? { anchor: healFrom.anchor } : {}),
        },
        after: {
          action: after.action,
          ...(after.describeTarget ? { describeTarget: after.describeTarget } : {}),
          ...(after.point ? { point: after.point } : {}),
          ...(after.anchor ? { anchor: after.anchor } : {}),
        },
        ...(resolvedBy ? { resolvedBy } : {}),
        confidence,
        status: "pending_review",
      };
    }
  }
  if (!heal) {
    // A target missed and never gone and got, on a step that passed anyway:
    // the step did not do what it says, and the way it went instead is what
    // the next run replays. That is for a person to look at, like a memory
    // that stopped checking out -- not a quiet pass. Also when the memory's
    // own check found nothing to say: a detour can land where the remembered
    // tap was, and a point is not a control. A target that never came
    // about was not gone around.
    const miss = missedTargets.find((each) => !each.answered && !each.moot);
    if (miss) {
      const found = taken.slice(miss.at);
      const after =
        found.find((entry) => entry.action === miss.action && entry.point) ?? found.find((entry) => entry.point) ?? found[found.length - 1];
      heal = {
        step: step.id,
        at: new Date().toISOString(),
        reason: `${miss.detail}; the step passed ${after ? "by doing something else" : "without it"}`,
        before: { action: miss.action, describeTarget: miss.describeTarget },
        after: after
          ? {
              action: after.action,
              ...(after.describeTarget ? { describeTarget: after.describeTarget } : {}),
              ...(after.point ? { point: after.point } : {}),
              ...(after.anchor ? { anchor: after.anchor } : {}),
            }
          : {},
        ...(resolvedBy ? { resolvedBy } : {}),
        confidence,
        status: "pending_review",
      };
    }
  }

  if (heal) {
    // A person has already seen this diff and called it a real failure.
    // Healing it again would file the same proposal and paint the run green
    // a second time -- the silent drift a rejection exists to stop. Nothing
    // is remembered either: the memory stays on the target the reviewer
    // wanted, so the next run asks the same question again.
    if (args.rejected.some((record) => sameHeal(record, heal))) {
      const detail = `a person rejected this change, and it happened again: ${describeSide(heal.before)} became ${describeSide(heal.after)} (${healReason ?? heal.reason})`;
      emit({ kind: "note", stepId: step.id, message: `not healing: ${detail}` });
      return { outcome: "FAIL_REJECTED_HEAL", detail, actions };
    }
    result.heal = heal;
    result.outcome = "HEALED_PASS";
  }

  return result;
}

/**
 * Whether a step worked out again found what its memory meant -- a cache miss,
 * not a heal. A heal card says the app changed; one filed when it did not is
 * noise a reviewer learns to click through, and then the real one goes by too.
 * What counts as "the same" depends on how the memory failed:
 *
 *  - by the tree: it named a control and the screen contradicted it. Controls
 *    are compared as controls, so a renamed button that has not moved an inch
 *    is a change, and the same row re-found a few points away is not.
 *  - by the pixels: something visible changed under the point, and with no
 *    control on the remembered side there is no telling a repaint from a
 *    rename. A person decides, as before.
 *  - by nothing: there was nothing to check it by, so it says nothing about a
 *    change. If the remembered tap would still land on the control found now
 *    -- anywhere along a 400-point row, where grounding lands anywhere -- the
 *    app did not move.
 */
function foundWhatWasMeant(by: Verdict["by"] | undefined, before: ResolvedAction, after: ResolvedAction): boolean {
  if (by === "tree") return sameTarget(after, before);
  if (by !== "none" || before.action !== after.action) return false;
  if (before.point && after.anchor?.tree) return pointInside(before.point, after.anchor.tree.bounds, 0);
  return sameTarget(after, before);
}

/** One side of a heal, in the words a reviewer saw on the card. */
function describeSide(side: HealRecord["after"]): string {
  if (!side.action) return "nothing (the step passed without acting)";
  const label = side.anchor?.tree?.label ?? side.describeTarget;
  if (label) return `${side.action} "${label}"`;
  return side.point ? `${side.action} at (${side.point.x},${side.point.y})` : side.action;
}

/** What is left of a run when a call never returns: the promise is given up on, with this message. */
function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(ms, 0));
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

async function applyDirectives(
  directives: Directive[],
  ctx: { engine: Engine; app?: string; emit: (event: Omit<RunEvent, "at">) => void },
): Promise<void> {
  for (const directive of directives) {
    switch (directive.kind) {
      case "launch":
        await ctx.engine.app.launch(directive.app ?? ctx.app ?? "");
        break;
      case "terminate":
        await ctx.engine.app.terminate(directive.app ?? ctx.app ?? "");
        break;
      case "fixture":
        // Fixtures (seeded accounts, pre-filled carts, entitlement state) are a
        // month-4 feature. Announcing the gap beats silently running a test
        // whose preconditions were never met.
        ctx.emit({
          kind: "note",
          message: `fixture "${directive.name}" was not applied -- fixtures are not implemented yet`,
        });
        break;
      case "do":
        ctx.emit({ kind: "note", message: `setup step "${directive.text}" is not run yet` });
        break;
    }
  }
}
