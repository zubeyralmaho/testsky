/**
 * A phone held open for one instruction at a time.
 *
 * A test is written a step at a time: try one, look at what it did, keep it.
 * The playground does that from a browser, an agent from `testsky mcp`, a
 * person from `testsky step`. Every instruction runs through the executor as
 * a one-step test -- the planner, grounding, memory and checks a real run
 * uses -- so a step that passes here passes the same way in the test it is
 * saved to, and what it learned goes with it.
 */

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  adoptBuild,
  appendSteps,
  DEFAULT_POLICY,
  emptyLock,
  parseTestFile,
  type RememberedVerdict,
  type StepResolution,
  type TestFile,
  type TestStep,
} from "@testsky/artifact";
import type { DeviceHandle, Engine, GroundResult, Observation, StepBudget } from "@testsky/engine-core";
import { runTest, type RunEvent, type TestResult } from "@testsky/executor";
import { locateInTree } from "@testsky/perception";
import type { CostLedger, LedgerEntry } from "@testsky/router";

import { openLock, saveLock } from "./memory.ts";

/** A step as it is written, before it has an id: something to do, something that must hold, something to read. */
export type StepBody = Omit<TestStep, "id" | "idGenerated">;

/**
 * Why an instruction was not taken, with the status an HTTP server would
 * answer it with: 400 it cannot be done, 404 nothing by that name, 409 not
 * now or not again. `reason` names the one a caller words its own way --
 * how to name an app depends on where the person is.
 */
export class StepError extends Error {
  readonly status: number;
  readonly reason: "no-app" | undefined;
  constructor(status: number, message: string, reason?: "no-app") {
    super(message);
    this.name = "StepError";
    this.status = status;
    this.reason = reason;
  }
}

export interface StepSessionOptions {
  engine: Engine & { stepId?: string };
  device: DeviceHandle;
  ledger: CostLedger;
  /** Let the screen settle between actions, as a run does. Tests turn it off. */
  settle?: boolean;
}

/** An instruction run, and everything it left. */
export interface TriedStep {
  /** Its id in this session: what saving it names. */
  id: string;
  step: StepBody;
  result: TestResult;
  events: RunEvent[];
  /** The frames it kept, by id: its verdict's, each pop-up's, and the screen it left. */
  shots: Map<string, Buffer>;
  /** The model calls it made. */
  calls: LedgerEntry[];
  /** The pictures those calls were shown, by the ids their records name. */
  pictures: Map<string, Buffer>;
  passed: boolean;
  /** What it read off the screen for a read; whether it held for a check; nothing for an action. */
  answer: unknown;
  /** Why it did not pass, in the taxonomy's own words; null when it did. */
  failure: string | null;
}

/** Where testsky would press for a description, pressing nothing. */
export interface Located {
  observation: Observation;
  found?: GroundResult;
  /** Why nothing would be pressed. */
  refused?: string;
  /** What the accessibility tree alone says, in words. */
  tree?: string;
  calls: LedgerEntry[];
  /** The pictures those calls were shown, by the ids their records name. */
  pictures: Map<string, Buffer>;
}

/** What saving an instruction did. */
export interface SavedStep {
  /** The test file, and the step it was saved as. */
  test: string;
  stepId: string;
  /** Whether what the run learned went with it, for the next run to replay without a model. */
  remembered: boolean;
}

/** An instruction run, as it can be saved: its step, and what the run learned when it passed. */
interface Ran {
  step: StepBody;
  passed: boolean;
  resolution?: StepResolution;
  verdict?: RememberedVerdict;
  size?: { width: number; height: number };
  /** The step it was saved as, once it was. */
  savedAs?: string;
}

/** What a Locate may spend: what one step's tap may, so it answers as the step would. */
const LOCATE_BUDGET: StepBudget = { maxUsd: DEFAULT_POLICY.budget.maxUsd, maxLatencyMs: 60_000, maxEscalations: 2 };

export const boxWords = (rect: { x: number; y: number; width: number; height: number }) =>
  `(${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)})`;

/** What an instruction gives back: the value read, the verdict, or nothing at all for an action. */
function answerOf(step: StepBody, result: TestResult): unknown {
  const first = result.steps[0];
  if (step.extract) return first?.extracted?.answer ?? null;
  if (step.expect) return first ? ["PASS", "HEALED_PASS"].includes(first.outcome) : null;
  return undefined;
}

function failureOf(result: TestResult): string | null {
  const first = result.steps[0];
  const outcome = first?.outcome ?? result.outcome;
  if (outcome === "PASS" || outcome === "HEALED_PASS") return null;
  return `${outcome}: ${first?.detail ?? result.detail}`;
}

export class StepSession {
  readonly engine: Engine & { stepId?: string };
  readonly device: DeviceHandle;
  readonly ledger: CostLedger;
  /** This session, as against one before a restart, whose instruction ids this one reuses. */
  readonly id = randomBytes(6).toString("hex");
  /** An instruction or a Locate is running. */
  busy = false;
  /** The last frame anyone took. While an instruction runs, it is the run's own. */
  latest: { bytes: Buffer; size: Observation["frame"]["size"]; at: number } | undefined;
  private readonly settle: boolean;
  private runs = 0;
  /** The instructions run, by their step id: what saving can save. */
  private readonly history = new Map<string, Ran>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: StepSessionOptions) {
    this.engine = options.engine;
    this.device = options.device;
    this.ledger = options.ledger;
    this.settle = options.settle ?? true;
  }

  /**
   * One thing touches the phone at a time: a tree read and a run must never
   * interleave, or the run decides on a screen the read was changing.
   */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** The screen as it is now, and its tree when asked. Not exclusive: callers that share the phone wrap it. */
  async observe(tree: boolean): Promise<Observation> {
    const observation = await this.engine.observe({ fresh: true, ...(tree ? { tree: true } : {}) });
    this.latest = { bytes: observation.frame.bytes, size: observation.frame.size, at: Date.now() };
    return observation;
  }

  /** The screen, waiting its turn with anything else on the phone. */
  look(tree = false): Promise<Observation> {
    return this.exclusive(() => this.observe(tree));
  }

  /**
   * Where testsky would press for a description, pressing nothing: asked of
   * the model and the tree on one capture, exactly as a step's tap asks (the
   * router's ground), with the tree's own answer said beside it. An author
   * learns from it how a step will find its target -- one the two agree on is
   * pressed where the tree measures it -- before writing it.
   */
  async locate(description: string): Promise<Located> {
    if (this.busy) throw new StepError(409, "an instruction is already running");
    this.busy = true;
    try {
      const before = this.ledger.all().length;
      const asked = await this.exclusive(async () => {
        const observation = await this.observe(true);
        try {
          return { observation, found: await this.engine.ground({ observation, description, budget: LOCATE_BUDGET }) };
        } catch (error) {
          return { observation, refused: (error as Error).message };
        }
      });
      const { observation } = asked;
      const named = observation.tree ? locateInTree(observation.tree, description, observation.frame.size) : undefined;
      const tree = named
        ? named.target
          ? `${named.target.node.role} "${named.target.node.label ?? named.target.node.identifier ?? ""}" at ${boxWords(named.target.rect)} -- ${named.reason}`
          : named.reason
        : undefined;
      const calls = this.ledger.all().slice(before);
      return {
        observation,
        ...(asked.found ? { found: asked.found } : {}),
        ...(asked.refused ? { refused: asked.refused } : {}),
        ...(tree ? { tree } : {}),
        calls,
        pictures: this.ledger.takePictures(calls),
      };
    } finally {
      this.busy = false;
    }
  }

  /** An instruction, run as a one-step test on the phone. */
  async attempt(step: StepBody, title?: string): Promise<TriedStep> {
    if (!step.do && !step.expect && !step.extract) throw new StepError(400, "a step does something, checks something or reads something");
    if (this.busy) throw new StepError(409, "an instruction is already running");
    this.busy = true;
    try {
      this.runs += 1;
      const { device, engine, ledger } = this;
      const test: TestFile = {
        id: "playground",
        title: title ?? step.do ?? step.expect ?? Object.values(step.extract ?? {})[0] ?? "an instruction",
        targets: [{ platform: device.platform, app: "" }],
        policy: DEFAULT_POLICY,
        setup: [],
        steps: [{ id: `instruction-${this.runs}`, idGenerated: false, ...step }],
        teardown: [],
      };
      const events: RunEvent[] = [];
      const shots = new Map<string, Buffer>();
      const before = ledger.all().length;
      const stepId = test.steps[0]!.id;
      // A memory of its own: nothing to replay, and what the run learns is kept for saving.
      const lock = emptyLock("playground", device.platform);
      const result = await this.exclusive(async () => {
        const ran = await runTest({
          engine,
          test,
          device,
          ledger,
          lock,
          settle: this.settle,
          onEvent: (event) => {
            const { screenshot: bytes, ...rest } = event;
            events.push(rest);
            const shot = event.shotId ?? event.stepId;
            if (!bytes || !shot) return;
            shots.set(shot, bytes);
            const screen = rest.data?.screen as Observation["frame"]["size"] | undefined;
            this.latest = { bytes, size: screen ?? this.latest?.size ?? { width: 0, height: 0 }, at: Date.now() };
          },
        });
        // The screen the instruction left behind: a replay ends on it, and a
        // step with nothing to check took no frame of its own at the end.
        if (!shots.has(stepId)) shots.set(stepId, (await this.observe(false)).frame.bytes);
        return ran;
      });
      const failure = failureOf(result);
      const resolution = lock.steps[stepId];
      const verdict = lock.verdicts?.[stepId];
      const size = this.latest?.size.width ? this.latest.size : device.size;
      this.history.set(stepId, {
        step,
        passed: failure === null,
        ...(resolution ? { resolution } : {}),
        ...(verdict ? { verdict } : {}),
        ...(size ? { size } : {}),
      });
      const calls = ledger.all().slice(before);
      return {
        id: stepId,
        step,
        result,
        events,
        shots,
        calls,
        pictures: ledger.takePictures(calls),
        passed: failure === null,
        answer: answerOf(step, result),
        failure,
      };
    } finally {
      this.busy = false;
    }
  }

  /** Refuses an instruction as saving it would: one not run here, saved already, or a read. */
  savable(id: string): void {
    const ran = this.history.get(id);
    if (!ran) throw new StepError(404, `no instruction ${id} was run here`);
    if (ran.savedAs) throw new StepError(409, `${id} is saved already, as ${ran.savedAs}`);
    if (!ran.step.do && !ran.step.expect) {
      throw new StepError(400, "a read is no step of its own: write it as the `extract` of the step it belongs to");
    }
  }

  /** The build of the app a test file runs, as it is installed now. */
  private async buildOf(source: string): Promise<string | undefined> {
    let app: string | undefined;
    try {
      app = parseTestFile(source).targets.find((target) => target.platform === this.device.platform)?.app;
    } catch {
      return undefined;
    }
    return app ? this.exclusive(() => this.engine.app.currentBuildId(app)).catch(() => undefined) : undefined;
  }

  /**
   * An instruction as a step of a test file, begun if it is not there yet,
   * and -- when it passed -- what the run learned with it, into the file's
   * memory for the screen's layout: the next run replays it once the
   * remembered target checks out, with no model, and asks a model as usual
   * when it does not.
   */
  async save(id: string, into: { test: string; app?: string }): Promise<SavedStep> {
    this.savable(id);
    const ran = this.history.get(id)!;
    const path = into.test;
    const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    let app = into.app;
    if (existing === undefined && !app) app = (await this.look(false)).appContext.appId;
    if (existing === undefined && !app) {
      throw new StepError(400, "name the app to begin a test file with: a test names the app it runs", "no-app");
    }
    const testId = basename(path).replace(/\.testsky\.ya?ml$/i, "") || "playground";
    let appended;
    try {
      appended = appendSteps(existing, [ran.step], { id: testId, title: testId, target: { platform: this.device.platform, app: app ?? "" } }, path);
    } catch (error) {
      if ((error as Error).name === "TestFileError") throw new StepError(409, (error as Error).message);
      throw error;
    }
    const stepId = appended.ids[0]!;
    await writeFile(path, appended.source);
    let remembered = false;
    if (ran.passed && ran.resolution && ran.size) {
      // Through the same door as a run's memory: a run on another phone of
      // this layout may be writing the same file at this moment.
      const opened = (await openLock(path, testId, this.device.platform, ran.size))!;
      // The build it was learned on, as a run records it: a lock that names
      // none has the test's first run take its own build for a new one.
      const build = await this.buildOf(appended.source);
      if (build) adoptBuild(opened.lock, build);
      opened.lock.steps[stepId] = ran.resolution;
      if (ran.verdict) opened.lock.verdicts = { ...(opened.lock.verdicts ?? {}), [stepId]: ran.verdict };
      await saveLock(opened);
      remembered = true;
    }
    ran.savedAs = stepId;
    return { test: path, stepId, remembered };
  }
}
