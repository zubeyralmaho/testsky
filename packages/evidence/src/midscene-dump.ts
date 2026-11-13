/**
 * A run, written the way Midscene's report viewer reads one.
 *
 * The viewer is Midscene's report app, carried in ui/report, so a run is
 * translated into its dump: one execution per step, and in it the tasks
 * Midscene itself would have recorded -- a plan, a locate, an action, an
 * assertion -- each on the frame it was decided on. What Midscene has no word
 * for travels in fields it already has or ignores: an action replayed from
 * memory is a cache hit, a target the tree held when the model found nothing
 * is a locate with no usage, and who found a target and what a model was
 * shown ride along as `testsky`.
 */

import type { RunEvent } from "@testsky/executor";
import { type LedgerEntry, parseJsonAnswer } from "@testsky/router";

import { type ReportInput, verdictFor } from "./report.ts";

interface ScreenshotRef {
  type: "midscene_screenshot_ref";
  id: string;
  capturedAt: number;
  mimeType: string;
  storage: "inline";
}

interface UiContext {
  size: { width: number; height: number; dpr: number };
  shotSize: { width: number; height: number };
  screenshot: ScreenshotRef;
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  time_cost: number;
  model_name?: string;
  intent: string;
}

export interface DumpTask {
  taskId: string;
  type: "Planning" | "Insight" | "Action Space" | "Log";
  subType: string;
  status: "finished" | "failed";
  subTask?: boolean;
  param?: unknown;
  thought?: string;
  output?: unknown;
  log?: unknown;
  usage?: Usage;
  hitBy?: { from: string; context: Record<string, unknown> };
  uiContext?: UiContext;
  recorder?: { type: "screenshot"; ts: number; screenshot: ScreenshotRef; timing: string }[];
  timing: { start: number; end: number; cost: number };
  errorMessage?: string;
  /** What only testsky knows: who found a target, and from what. */
  testsky?: Record<string, unknown>;
}

export interface DumpExecution {
  logTime: number;
  name: string;
  tasks: DumpTask[];
}

export interface MidsceneDump {
  sdkVersion: string;
  groupName: string;
  groupDescription: string;
  platform: string;
  modelBriefs: [];
  executions: DumpExecution[];
}

const PLATFORM: Record<string, string> = { android: "Android", ios: "iOS" };

/** The intents Midscene's model configuration speaks of, by what a call was for. */
const INTENT: Record<LedgerEntry["purpose"], string> = {
  plan: "planning",
  ground: "default",
  assert: "insight",
  extract: "insight",
  popup: "insight",
};

/** Action names as Midscene's action space spells them -- on iOS, without Android's buttons. */
const actionName = (name: string, platform: string): string =>
  platform === "ios" && (name === "back" || name === "home") ? (name === "back" ? "Back" : "Home") : (ACTION[name] ?? name);

const ACTION: Record<string, string> = {
  tap: "Tap",
  doubleTap: "DoubleClick",
  longPress: "LongPress",
  input: "Input",
  swipe: "Swipe",
  scroll: "Scroll",
  keyPress: "KeyboardPress",
  back: "AndroidBackButton",
  home: "AndroidHomeButton",
  wait: "Sleep",
  openUrl: "OpenUrl",
  launchApp: "Launch",
  terminateApp: "Terminate",
};

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

function pointOf(value: unknown): { x: number; y: number } | undefined {
  const point = value as { x?: unknown; y?: unknown } | null | undefined;
  const x = num(point?.x);
  const y = num(point?.y);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function sizeOf(value: unknown): { width: number; height: number } | undefined {
  const size = value as { width?: unknown; height?: unknown } | null | undefined;
  const width = num(size?.width);
  const height = num(size?.height);
  return width && height ? { width, height } : undefined;
}

function rectOf(value: unknown): { left: number; top: number; width: number; height: number } | undefined {
  const corner = pointOf(value);
  const size = sizeOf(value);
  return corner && size ? { left: corner.x, top: corner.y, ...size } : undefined;
}

function usageOf(call: LedgerEntry): Usage {
  return {
    ...(call.tokensIn !== undefined ? { prompt_tokens: call.tokensIn } : {}),
    ...(call.tokensOut !== undefined ? { completion_tokens: call.tokensOut } : {}),
    ...(call.tokensIn !== undefined || call.tokensOut !== undefined
      ? { total_tokens: (call.tokensIn ?? 0) + (call.tokensOut ?? 0) }
      : {}),
    time_cost: call.latencyMs,
    ...(call.model ? { model_name: call.model } : {}),
    intent: INTENT[call.purpose],
  };
}

const timing = (start: number, end: number) => ({ start, end: Math.max(start, end), cost: Math.max(0, end - start) });

/** What a step was asked to do: the words it started with, or its id. */
function instructionOf(step: { stepId: string }, events: RunEvent[]): string {
  const started = events.find((event) => event.kind === "step_started");
  return started?.message || step.stepId;
}

const answerOf = (call: LedgerEntry): { answer?: string } => (call.answer === undefined ? {} : { answer: call.answer });

/** A call's verdict and its reason, from what the model answered. An answer that cannot be read is still there to read as it came. */
function saidIn(call: LedgerEntry): { verdict?: boolean; reason?: string } {
  if (call.answer === undefined) return {};
  let said: Record<string, unknown>;
  try {
    said = parseJsonAnswer<Record<string, unknown>>(call.answer);
  } catch {
    return {};
  }
  const verdict = call.purpose !== "assert" ? undefined : typeof said.pass === "boolean" ? said.pass : typeof said.onTarget === "boolean" ? said.onTarget : undefined;
  const reason = [said.reason, said.reasoning, said.why, said.progress].find((text) => typeof text === "string" && text.trim()) as string | undefined;
  return { ...(verdict !== undefined ? { verdict } : {}), ...(reason ? { reason } : {}) };
}

/** The image types and id characters Midscene's viewer accepts for a screenshot. */
export type ScreenshotMime = "image/jpeg" | "image/png";
const imageId = (shotId: string): string => shotId.replace(/[^a-z0-9_-]/gi, "_").slice(0, 128);

/**
 * The dump of a run, and the frames it points at as data URIs by id. A frame
 * that was not kept is simply not there, and its tasks are shown without a
 * picture. `input.shots` must hold `mimeType` images:
 * the viewer refuses a screenshot of any other type.
 */
export function toMidsceneDump(
  input: ReportInput,
  mimeType: ScreenshotMime = "image/jpeg",
): { dump: MidsceneDump; images: Record<string, string> } {
  const { result, events, calls, meta } = input;
  const images: Record<string, string> = {};
  const shots = input.shots ?? {};

  const ref = (shotId: string | undefined, at: number): ScreenshotRef | undefined => {
    if (!shotId || !shots[shotId]) return undefined;
    const id = imageId(shotId);
    images[id] = `data:${mimeType};base64,${shots[shotId]}`;
    return { type: "midscene_screenshot_ref", id, capturedAt: at, mimeType, storage: "inline" };
  };

  // A frame is placed by the screen it was taken of. Steps that never acted
  // say nothing about the screen, so they borrow the nearest size the run knows.
  const sizes = events.map((event) => sizeOf(event.data?.screen));
  const anySize = sizes.find(Boolean);
  let screen = anySize;
  const context = (shot: ScreenshotRef | undefined): UiContext | undefined =>
    shot && screen
      ? { size: { ...screen, dpr: 1 }, shotSize: screen, screenshot: shot }
      : undefined;

  const executions: DumpExecution[] = result.steps.map((step) => {
    const own = events.filter((event) => event.stepId === step.stepId).sort((a, b) => a.at - b.at);
    const pending = calls.filter((call) => call.stepId === step.stepId).sort((a, b) => a.at - b.at);
    const instruction = instructionOf(step, own);
    const tasks: DumpTask[] = [];
    let id = 0;
    let cursor = step.startedAt;
    const nextId = () => `${step.stepId}-${(id += 1)}`;

    /** The model calls made before `at`, in order, taken off the queue. */
    const callsUntil = (at: number): LedgerEntry[] => {
      const taken: LedgerEntry[] = [];
      while (pending.length && pending[0]!.at <= at) taken.push(pending.shift()!);
      return taken;
    };

    /** A model call with no event of its own: a plan that ended the step, a judge asked again while a wait went on. What it said is all there is to show. */
    const callTask = (call: LedgerEntry, ui: UiContext | undefined): DumpTask => {
      const { verdict, reason } = saidIn(call);
      return {
        taskId: nextId(),
        type: call.purpose === "plan" ? "Planning" : call.purpose === "ground" ? "Planning" : "Insight",
        subType: call.purpose === "plan" ? "Plan" : call.purpose === "ground" ? "Locate" : call.purpose === "assert" ? "Assert" : call.purpose === "extract" ? "Query" : "Popup",
        status: "finished",
        ...(call.purpose === "plan" ? { param: { userInstruction: instruction } } : {}),
        // Without it the viewer ticks a judge that said no.
        ...(verdict !== undefined ? { output: verdict } : {}),
        ...(reason ? { thought: reason } : {}),
        usage: usageOf(call),
        ...(ui ? { uiContext: ui } : {}),
        timing: timing(call.at - call.latencyMs, call.at),
        testsky: { shown: call.channel, ...answerOf(call) },
      };
    };

    const actionEvents = own.filter((event) => event.kind === "action");
    own.forEach((event) => {
      const data = event.data ?? {};
      if (sizeOf(data.screen)) screen = sizeOf(data.screen);
      const shot = ref(event.shotId, event.at);
      const ui = context(shot);

      if (event.kind === "action") {
        const made = callsUntil(event.at);
        const target = pointOf(data.target);
        const box = rectOf(data.box);
        const description = event.message.replace(/^\S+\s*/, "") || event.message;
        const element = target
          ? {
              center: [target.x, target.y],
              rect: box ?? { left: target.x - 4, top: target.y - 4, width: 8, height: 8 },
              description,
            }
          : undefined;

        // The call that produced the answer is the last locate; when the tree
        // held alone, no call did.
        const answering = data.by === "tree" ? undefined : made.filter((call) => call.purpose === "ground").at(-1);
        for (const call of made) {
          const task = callTask(call, ui);
          if (call.purpose === "plan") {
            task.output = {
              actions: [{ type: actionName(event.message.split(" ")[0] ?? "", meta.platform), ...(element ? { param: { locate: element } } : {}) }],
              ...(typeof data.thought === "string" ? { log: data.thought } : {}),
            };
            if (typeof data.thought === "string") task.thought = data.thought;
          } else if (call.purpose === "ground" && call !== answering) {
            // A locate that did not answer: it found nothing, or found what a
            // second look then corrected.
            task.param = { prompt: description };
            task.subTask = true;
            task.testsky = { shown: call.channel, answered: false, ...answerOf(call) };
          } else if (call.purpose === "ground") {
            task.param = { prompt: description };
            task.subTask = true;
            if (typeof data.why === "string") task.thought = data.why;
            if (element) {
              task.output = { element };
              task.log = {
                dump: {
                  type: "locate",
                  userQuery: { element: description },
                  matchedElement: [element],
                  ...(box ? { matchedRect: box } : {}),
                },
              };
            }
            task.testsky = {
              shown: call.channel,
              ...(data.by === "both" ? { by: "both" } : {}),
              ...(typeof data.seen === "string" ? { seen: data.seen } : {}),
              ...(num(data.confidence) !== undefined ? { confidence: data.confidence } : {}),
              ...(typeof data.tree === "string" ? { tree: data.tree } : {}),
              ...answerOf(call),
            };
          }
          tasks.push(task);
          cursor = Math.max(cursor, call.at);
        }

        // Held by the tree when the model found nothing. Midscene always
        // locates with a model, so it is shown as the locate it stands in for:
        // the box and the reason, and no usage, because the tree spent nothing.
        if (data.by === "tree" && element) {
          tasks.push({
            taskId: nextId(),
            type: "Planning",
            subType: "Locate",
            status: "finished",
            subTask: true,
            param: { prompt: description },
            ...(typeof data.why === "string" ? { thought: data.why } : {}),
            output: { element },
            log: {
              dump: {
                type: "locate",
                userQuery: { element: description },
                matchedElement: [element],
                ...(box ? { matchedRect: box } : {}),
              },
            },
            ...(ui ? { uiContext: ui } : {}),
            timing: timing(cursor, cursor),
            testsky: {
              by: "tree",
              seen: "tree",
              ...(num(data.confidence) !== undefined ? { confidence: data.confidence } : {}),
              ...(typeof data.tree === "string" ? { tree: data.tree } : {}),
            },
          });
        }

        // What the screen looked like once the action was done: the next
        // action's frame, or the one the step ended on.
        const later = actionEvents[actionEvents.indexOf(event) + 1];
        const after = later ? ref(later.shotId, later.at) : ref(step.stepId, step.finishedAt);
        const name = event.message.split(" ")[0] ?? "";
        tasks.push({
          taskId: nextId(),
          type: "Action Space",
          subType: actionName(name, meta.platform),
          status: "finished",
          subTask: true,
          param: element ? { locate: element } : {},
          ...(data.by === "memory" || data.cached === true
            ? { hitBy: { from: "Cache", context: { ...(typeof data.checkedBy === "string" ? { checkedBy: data.checkedBy } : {}) } } }
            : {}),
          ...(ui ? { uiContext: ui } : {}),
          ...(after ? { recorder: [{ type: "screenshot" as const, ts: event.at, screenshot: after, timing: "after-calling" }] } : {}),
          timing: timing(cursor, event.at),
          testsky: {
            ...(data.by === "memory" || data.cached === true
              ? { by: "memory" }
              : typeof data.by === "string"
                ? { by: data.by }
                : {}),
            ...(typeof data.checkedBy === "string" ? { checkedBy: data.checkedBy } : {}),
            ...(typeof data.moved === "boolean" ? { moved: data.moved } : {}),
          },
        });
        cursor = event.at;
        return;
      }

      if (event.kind === "assertion") {
        const made = callsUntil(event.at);
        const judged = made.filter((call) => call.purpose === "assert");
        for (const call of made.filter((call) => call.purpose !== "assert")) tasks.push(callTask(call, undefined));
        const held = /^held/.test(event.message);
        const last = own.filter((other) => other.kind === "assertion").at(-1) === event;
        const verdictFrame = last ? context(ref(step.stepId, event.at)) : undefined;
        const expectation = event.message.replace(/^[^:]*:\s*/, "");
        const call = judged.at(-1);
        tasks.push({
          taskId: nextId(),
          type: "Insight",
          subType: "Assert",
          status: "finished",
          param: { dataDemand: expectation },
          output: held,
          ...(typeof data.reason === "string" ? { thought: data.reason } : {}),
          log: { dump: { type: "extract", userQuery: { dataDemand: expectation }, data: { StatementIsTruthy: held } } },
          ...(call ? { usage: usageOf(call) } : {}),
          ...(verdictFrame ? { uiContext: verdictFrame } : {}),
          timing: timing(call ? call.at - call.latencyMs : cursor, event.at),
          testsky: {
            ...(data.remembered === true ? { remembered: true } : {}),
            ...(call ? { shown: call.channel, ...answerOf(call) } : {}),
            ...(Array.isArray(data.treeSaid) ? { treeSaid: data.treeSaid } : {}),
          },
        });
        cursor = event.at;
        return;
      }

      if (event.kind === "popup" || event.kind === "note" || event.kind === "extraction") {
        for (const call of callsUntil(event.at)) tasks.push(callTask(call, undefined));
        tasks.push({
          taskId: nextId(),
          type: "Log",
          subType: event.kind === "popup" ? "Popup" : event.kind === "extraction" ? "Extract" : "Note",
          status: "finished",
          param: { content: event.message, ...(event.kind === "extraction" ? { data } : {}) },
          ...(ui ? { uiContext: ui } : {}),
          timing: timing(event.at, event.at),
        });
        cursor = event.at;
      }
    });

    for (const call of pending) tasks.push(callTask(call, undefined));

    // A step that failed says so on its last task, in its own words.
    if (!["PASS", "HEALED_PASS"].includes(step.outcome)) {
      const last = tasks.at(-1);
      if (last) {
        last.status = "failed";
        last.errorMessage = `${step.outcome}: ${step.detail}`;
      } else {
        tasks.push({
          taskId: nextId(),
          type: "Log",
          subType: "Note",
          status: "failed",
          param: { content: step.detail },
          errorMessage: `${step.outcome}: ${step.detail}`,
          timing: timing(step.startedAt, step.finishedAt),
        });
      }
    }

    return {
      logTime: step.startedAt,
      name: instruction === step.stepId ? step.stepId : `${step.stepId} - ${instruction}`,
      tasks,
    };
  });

  return {
    dump: {
      sdkVersion: meta.version ?? "",
      groupName: meta.title,
      groupDescription: `${meta.test} · ${meta.platform} · ${meta.device}`,
      platform: PLATFORM[meta.platform] ?? meta.platform,
      modelBriefs: [],
      executions,
    },
    images,
  };
}

/** A box in screen points, as the engine measures one. */
type Box = { x: number; y: number; width: number; height: number };

/** A playground Locate: what testsky would press for a description, on one frame, pressing nothing. */
export interface LocateInput {
  description: string;
  meta: { platform: string; device: string };
  /** The frame it was asked on, base64, of the dump's image type. */
  shot: string;
  /** That frame's size in points, and when it was taken. */
  size: { width: number; height: number };
  at: number;
  /** The model calls the locate made, in order. */
  calls: LedgerEntry[];
  /** Where a step's tap would land, who found it and why; absent when nothing would be pressed. */
  found?: { point: { x: number; y: number }; rect?: Box; foundBy?: string; why?: string; confidence?: number };
  /** Why nothing would be pressed. */
  refused?: string;
  /** The tree's own answer, in words: what it names, or why it names nothing. */
  tree?: string;
}

/**
 * A Locate as the viewer replays one: the frame, the locate calls with what
 * they cost, and the element testsky would press boxed on it. Nothing was
 * pressed, so there is no action. The tree's own answer has no place in
 * Midscene's tasks, so it is a note beside them.
 */
export function locateDump(input: LocateInput, mimeType: ScreenshotMime = "image/jpeg"): { dump: MidsceneDump; images: Record<string, string> } {
  const { description, found } = input;
  const id = imageId(`locate-${input.at}`);
  const images = { [id]: `data:${mimeType};base64,${input.shot}` };
  const screenshot: ScreenshotRef = { type: "midscene_screenshot_ref", id, capturedAt: input.at, mimeType, storage: "inline" };
  const ui: UiContext = { size: { ...input.size, dpr: 1 }, shotSize: input.size, screenshot };
  // A note is replayed on the frame its recorder holds; without one the player shows black.
  const recorder = [{ type: "screenshot" as const, ts: input.at, screenshot, timing: "after-calling" }];
  const element = found
    ? {
        center: [found.point.x, found.point.y],
        rect: found.rect
          ? { left: found.rect.x, top: found.rect.y, width: found.rect.width, height: found.rect.height }
          : { left: found.point.x - 4, top: found.point.y - 4, width: 8, height: 8 },
        description,
      }
    : undefined;
  const located = element
    ? {
        output: { element },
        log: { dump: { type: "locate", userQuery: { element: description }, matchedElement: [element], matchedRect: element.rect } },
        ...(found?.why ? { thought: found.why } : {}),
      }
    : {};
  const who = found
    ? { ...(found.foundBy ? { by: found.foundBy } : {}), ...(num(found.confidence) !== undefined ? { confidence: found.confidence } : {}) }
    : {};

  const tasks: DumpTask[] = [];
  let n = 0;
  const nextId = () => `locate-${(n += 1)}`;
  // The call that produced the answer is the last locate; when the tree held alone, none did.
  const answering = found && found.foundBy !== "tree" ? input.calls.filter((call) => call.purpose === "ground").at(-1) : undefined;
  for (const call of input.calls) {
    tasks.push({
      taskId: nextId(),
      type: "Planning",
      subType: "Locate",
      status: "finished",
      param: { prompt: description },
      ...(call === answering ? located : {}),
      usage: usageOf(call),
      uiContext: ui,
      timing: timing(call.at - call.latencyMs, call.at),
      testsky: call === answering ? { shown: call.channel, ...who } : { shown: call.channel, answered: false },
    });
  }
  if (found && !answering) {
    tasks.push({
      taskId: nextId(),
      type: "Planning",
      subType: "Locate",
      status: "finished",
      param: { prompt: description },
      ...located,
      uiContext: ui,
      timing: timing(input.at, input.at),
      testsky: { seen: "tree", ...who },
    });
  }
  if (input.tree) {
    tasks.push({
      taskId: nextId(),
      type: "Log",
      subType: "Note",
      status: "finished",
      param: { content: `The tree alone: ${input.tree}` },
      uiContext: ui,
      recorder,
      timing: timing(input.at, input.at),
    });
  }
  if (input.refused) {
    tasks.push({
      taskId: nextId(),
      type: "Log",
      subType: "Note",
      status: "failed",
      param: { content: input.refused },
      errorMessage: input.refused,
      uiContext: ui,
      recorder,
      timing: timing(input.at, input.at),
    });
  }
  return {
    dump: {
      sdkVersion: "",
      groupName: `Locate ${description}`,
      groupDescription: `playground · ${input.meta.platform} · ${input.meta.device}`,
      platform: PLATFORM[input.meta.platform] ?? input.meta.platform,
      modelBriefs: [],
      executions: [{ logTime: input.at, name: `Locate - ${description}`, tasks }],
    },
    images,
  };
}

/**
 * The dump with its frames in place of their references, for a viewer that
 * gets the dump as JSON rather than in a report's <script> tags -- the
 * playground. A reference whose image is missing is left as it is.
 */
export function inlineScreenshots<T>(dump: T, images: Record<string, string>): T {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (record.type === "midscene_screenshot_ref" && typeof record.id === "string" && images[record.id]) {
      return { base64: images[record.id], capturedAt: record.capturedAt };
    }
    return Object.fromEntries(Object.entries(record).map(([key, inner]) => [key, walk(inner)]));
  };
  return walk(dump) as T;
}

/**
 * JSON that cannot end, or confuse, the <script> tag it sits in: every "<" is
 * written as JSON's own escape for it, which only a string can contain.
 */
const LT = `${"\\"}u003c`;
const inScript = (json: string): string => json.replace(/</g, LT);

/** What the viewer's frame says about a run: its verdict, where it ran, what it cost. */
export interface RunSummary {
  test: string;
  title: string;
  platform: string;
  device: string;
  engine: string;
  version?: string;
  appBuild?: string;
  outcome: string;
  verdict: string;
  /** neutral, ice (healed), amber (the app may be broken) -- Tesky's tones for a verdict. */
  tone: "neutral" | "ice" | "amber";
  detail: string;
  startedAt: number;
  finishedAt: number;
  usd: number;
  tokensIn: number;
  calls: number;
  steps: number;
  passed: number;
  remembered: number;
  /** Targets the model and the tree found on the same control. */
  agreed: number;
  /** Targets the tree held when the model found nothing. */
  treeAlone: number;
}

const TONE: Record<string, RunSummary["tone"]> = {
  PASS: "neutral",
  HEALED_PASS: "ice",
  FAIL_ASSERT: "amber",
  FAIL_REJECTED_HEAL: "amber",
};

export function summarize(input: ReportInput): RunSummary {
  const { result, events, calls, meta } = input;
  return {
    test: meta.test,
    title: meta.title,
    platform: meta.platform,
    device: meta.device,
    engine: meta.engine,
    ...(meta.version ? { version: meta.version } : {}),
    ...(meta.appBuild ? { appBuild: meta.appBuild } : {}),
    outcome: result.outcome,
    verdict: verdictFor(result.outcome, meta.pullRequest === true),
    tone: TONE[result.outcome] ?? "neutral",
    detail: result.detail,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    usd: calls.reduce((sum, call) => sum + call.usd, 0),
    tokensIn: calls.reduce((sum, call) => sum + (call.tokensIn ?? 0), 0),
    calls: calls.length,
    steps: result.steps.length,
    passed: result.steps.filter((step) => step.outcome === "PASS" || step.outcome === "HEALED_PASS").length,
    remembered: result.cache.replayed,
    agreed: events.filter((event) => event.kind === "action" && event.data?.by === "both").length,
    treeAlone: events.filter((event) => event.kind === "action" && event.data?.by === "tree").length,
  };
}

/**
 * The viewer's template with a run in it: each frame as its own image tag,
 * then the dump, before </html> -- where Midscene's own writer puts them --
 * and the run's summary, which only testsky's frame reads.
 */
export function buildMidsceneReport(input: ReportInput, template: string, mimeType: ScreenshotMime = "image/jpeg"): string {
  const { dump, images } = toMidsceneDump(input, mimeType);
  const tags = [
    ...Object.entries(images).map(([id, uri]) => `<script type="midscene-image" data-id="${id.replace(/"/g, "&quot;")}">${uri}</script>`),
    `<script type="midscene_web_dump" type="application/json">${inScript(JSON.stringify(dump))}</script>`,
    `<script type="testsky_run" type="application/json">${inScript(JSON.stringify(summarize(input)))}</script>`,
  ].join("\n");
  const end = template.lastIndexOf("</html>");
  return end === -1 ? `${template}\n${tags}\n` : `${template.slice(0, end)}${tags}\n${template.slice(end)}`;
}
