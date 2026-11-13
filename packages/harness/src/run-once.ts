/**
 * One test, one device, everything that goes with it.
 *
 * `testsky run`, the benchmark and whatever drives testsky for somebody else
 * do the same work and answer to different people: one prints to a terminal,
 * one adds up numbers, one hands an agent a verdict. The part in between --
 * attach, record, execute, keep the memory, build the evidence -- is the
 * product, and it lives here so they cannot drift into several behaviours
 * with one name. They had: `testsky run` kept a copy of its own, and its
 * timeline promised the app's log that only this one read.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { HealDecision, LockFile, PopupRules, TestFile } from "@testsky/artifact";
import type { DeviceHandle, Engine, Platform } from "@testsky/engine-core";
import { AndroidMidsceneEngine, IosMidsceneEngine } from "@testsky/engine-midscene";
import {
  buildMidsceneReport,
  buildReport,
  compressVideo,
  NO_RECORDING,
  recordAndroid,
  recordIosSimulator,
  type Recording,
} from "@testsky/evidence";
import { appOn, runTest, type RunEvent, type TestResult } from "@testsky/executor";
import { toJpeg, toWebp } from "@testsky/perception";
import { CostLedger, Router, routerConfigFromEnv, type RouterConfig } from "@testsky/router";

import { saveLock, type OpenedLock } from "./memory.ts";
import type { RunRecord } from "./record.ts";

export interface RunOnceOptions {
  test: TestFile;
  device: DeviceHandle;
  platform: Platform;
  /**
   * Where the run is kept as it happens: what it is, then every event and
   * frame the moment it comes, then the result and the report. Opened here.
   * Without one -- a benchmark -- nothing is kept but what is returned.
   */
  record?: RunRecord;
  /** Where the recording goes when there is no record to put it in. */
  workDir?: string;
  /** A memory in hand, replayed and learned into; the caller keeps it. */
  lock?: LockFile;
  /**
   * The memory to replay and learn into, opened once the device is attached
   * and its screen layout is known, and written back the moment the run is
   * over: before the video and the report, which a full disk may cost.
   */
  memory?: (device: DeviceHandle) => Promise<OpenedLock | undefined>;
  /** What people said about this test's heals; applied to the memory before the run. */
  healDecisions?: HealDecision[];
  /** The organisation's shared pop-up rules; the test's own policy goes on top. */
  popups?: Partial<PopupRules>;
  /** A pull request's run: its heal is not put up for review, and the report must not say it is. */
  pullRequest?: boolean;
  routerConfig?: RouterConfig;
  /** The engine to drive the device with; one for the platform is made when none is given. Tests give a fake. */
  engine?: Engine & { stepId?: string };
  video?: boolean;
  /**
   * The app's own log, read alongside the run into the timeline. On unless
   * false: `testsky run` asks for it (--device-log), because reading it puts
   * adb calls through the whole run and up to half a minute at its end.
   */
  deviceLog?: boolean;
  settle?: boolean;
  /** The local port a physical iPhone's WebDriverAgent is forwarded to. */
  wdaPort?: number;
  /** testsky's own version, as the report says it. */
  version?: string;
  /**
   * The report viewer, built by ui/report. Given, the report is the viewer
   * and the timeline -- with the video and the app's log -- goes beside it;
   * without it, the timeline is the report.
   */
  reportTemplate?: string;
  /** Wraps the attach, for a caller that keeps the device stack's chatter off its terminal. */
  attach?: (attach: () => Promise<void>) => Promise<void>;
  onEvent?: (event: RunEvent) => void;
  onProgress?: (message: string) => void;
  /**
   * Something the run did not do that a person would otherwise expect: no
   * video (`info`), or what it learned not kept (`warn`).
   */
  onNote?: (message: string, level: "info" | "warn") => void;
  /**
   * The verdict, as soon as there is one and before the report is built: a
   * report that cannot be built, on a full disk, must not cost anyone the
   * verdict.
   */
  onVerdict?: (result: TestResult, ledger: CostLedger) => Promise<void> | void;
}

export interface RunOnceResult {
  result: TestResult;
  /** The memory the run replayed and learned into, when it had one. */
  lock?: LockFile;
  events: RunEvent[];
  ledger: CostLedger;
  /** The timeline: the whole run in one file, ready to send someone. */
  html: string;
  /** Where the report was written, when the run was kept. */
  reportPath?: string;
  appBuild?: string;
  videoPath?: string;
}

/** The engine for a platform, asking its models through this router. */
export function engineFor(
  platform: Platform,
  router: Router,
  options: { wdaPort?: number; onProgress?: (message: string) => void } = {},
): Engine & { stepId?: string } {
  return platform === "ios"
    ? new IosMidsceneEngine({
        router,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.wdaPort !== undefined ? { wdaPort: options.wdaPort } : {}),
      })
    : new AndroidMidsceneEngine({ router });
}

/** Inline the recording only while it stays attachable. */
const INLINE_LIMIT = 12 * 1024 * 1024;
/** Enough of the app's log to read around a failure, not the whole run's. */
const LOG_LIMIT = 3000;

/**
 * A run being made, with the one thing a caller needs before it starts: a way
 * to stop it from outside in order. A run stopped mid-way still closes the
 * app a test closes, stops its recorder and lets go of the device -- a
 * recorder left running writes until the disk is full.
 */
export class TestRun {
  readonly ledger = new CostLedger();
  readonly engine: Engine & { stepId?: string };
  private readonly options: RunOnceOptions;
  private recording: Recording = NO_RECORDING;
  private closeOnStop: (() => Promise<void>) | undefined;

  constructor(options: RunOnceOptions) {
    this.options = options;
    this.engine =
      options.engine ??
      engineFor(options.platform, new Router(options.routerConfig ?? routerConfigFromEnv(), this.ledger), {
        ...(options.wdaPort !== undefined ? { wdaPort: options.wdaPort } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      });
  }

  /** For a stop from outside: the app closed first, while the device is still held, and never for long. */
  async abandon(): Promise<void> {
    const close = this.closeOnStop
      ? Promise.race([this.closeOnStop().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 10_000))])
      : Promise.resolve();
    await close;
    await Promise.allSettled([this.recording.stop(), this.engine.detach()]);
  }

  /**
   * The recorder stopped and the device let go of; twice is nothing. The
   * caller's, after it has said what the run did: a run that let go of its
   * device before its summary and its last word was a run a stop in that
   * moment cost both.
   */
  async close(): Promise<void> {
    await this.recording.stop().catch(() => null);
    await this.engine.detach().catch(() => undefined);
  }

  async execute(): Promise<RunOnceResult> {
    const { options, engine, ledger } = this;
    const { test, device, platform, record } = options;
    const events: RunEvent[] = [];
    const shots = new Map<string, Buffer>();
    const collect = (event: RunEvent) => {
      if (record) record.write(event);
      else {
        const { screenshot, ...rest } = event;
        events.push(rest);
        const shot = event.shotId ?? event.stepId;
        if (screenshot && shot) shots.set(shot, screenshot);
      }
      options.onEvent?.(event);
    };
    const kept = () => (record ? { events: record.events, shots: record.shots } : { events, shots });

    await record?.open({ test: test.id, title: test.title, device, engine: engine.name, startedAt: Date.now() });

    // An attach that fails half-way -- a WebDriverAgent started, a session
    // never made -- is let go of by close(), like any other.
    const attach = () => engine.attach(device);
    await (options.attach ? options.attach(attach) : attach());
    // The app as the run will choose it: the first of the test's that this phone has.
    const app = await appOn(test, device, engine).catch(() => undefined);
    if (app && test.teardown.some((directive) => directive.kind === "terminate")) this.closeOnStop = () => engine.app.terminate(app);

    // The app's own log, from before the first step: what it said while a
    // step failed is often the diagnosis a screenshot cannot give. A device
    // that will not give one costs the report a section, never the run.
    const deviceLog: { at: number; text: string }[] = [];
    let dropped = 0;
    const logs = app && options.deviceLog !== false ? await engine.logs.open(app).catch(() => undefined) : undefined;
    const reading = logs
      ? (async () => {
          for await (const line of logs.lines()) {
            deviceLog.push(line);
            if (deviceLog.length > LOG_LIMIT) {
              deviceLog.shift();
              dropped += 1;
            }
          }
        })().catch(() => undefined)
      : Promise.resolve();

    try {
      // What this test learned last time on a screen of this layout -- the
      // layout is known once the device is attached.
      const opened = options.memory ? await options.memory(device) : undefined;
      const lock = opened?.lock ?? options.lock;

      // The recording starts before the first step and its first frame is
      // stamped, because a video whose zero is unknown cannot be seeked to a step.
      const workDir = record?.dir ?? options.workDir;
      const wanted = options.video !== false && workDir !== undefined;
      // A phone's screen is not recorded: simctl records simulators only,
      // and no phone has been recorded since iPhones on a cable came in.
      const recordable = wanted && device.kind !== "physical";
      if (wanted && !recordable) options.onNote?.("no video: a phone's screen is not recorded, only an emulator's or a simulator's", "info");
      const videoPath = workDir ? join(workDir, "run.mp4") : "";
      if (recordable) {
        this.recording = await (platform === "ios"
          ? recordIosSimulator(device.id, videoPath, test.policy.budget.maxSeconds + 120)
          : recordAndroid(device.id, videoPath)
        ).catch(() => NO_RECORDING);
      }

      const appBuild = app ? await engine.app.currentBuildId(app).catch(() => undefined) : undefined;
      const result = await runTest({
        engine,
        test,
        device,
        ledger,
        onEvent: collect,
        ...(lock ? { lock } : {}),
        ...(options.healDecisions ? { healDecisions: options.healDecisions } : {}),
        ...(options.popups ? { popups: options.popups } : {}),
        ...(appBuild ? { appBuild } : {}),
        ...(options.settle === false ? { settle: false } : {}),
      });
      // A memory that cannot be written costs the next run its memory, not
      // this run its verdict and its report.
      if (opened) await saveLock(opened).catch((error: unknown) => options.onNote?.(`what this run learned was not kept: ${(error as Error).message}`, "warn"));
      // The verdict before anything that can take long or fail: the video,
      // the app's log, the report.
      await record?.close(result, ledger);
      await options.onVerdict?.(result, ledger);

      // Together: the log is read out for the run's window while the
      // recording stops, and each takes a couple of seconds.
      const [raw] = await Promise.all([this.recording.stop().catch(() => null), logs?.close().catch(() => undefined)]);
      await reading;
      // Small enough to attach to an email, or it is not evidence anyone
      // will look at. Above the limit the video stays beside the report
      // instead of inside it, and the report says so.
      const small = raw && workDir ? await compressVideo(raw, join(workDir, "run-small.mp4")) : null;
      const bytes = small ? await readFile(small).catch(() => null) : null;

      const meta = {
        test: test.id,
        title: test.title,
        platform,
        device: device.id,
        engine: engine.name,
        ...(options.version ? { version: options.version } : {}),
        ...(appBuild ? { appBuild } : {}),
        ...(options.pullRequest ? { pullRequest: true } : {}),
      };
      const { events: all, shots: frames } = kept();
      const encoded = (encode: (png: Buffer) => Promise<Buffer>) =>
        Promise.all([...frames].map(async ([id, png]) => [id, (await encode(png)).toString("base64")] as const)).then(Object.fromEntries);
      const html = buildReport({
        result,
        events: all,
        calls: ledger.all(),
        meta,
        videoStartedAt: this.recording.startedAt,
        ...(logs ? { deviceLog: { lines: deviceLog.sort((a, b) => a.at - b.at), dropped } } : {}),
        ...(bytes && bytes.length <= INLINE_LIMIT ? { videoBase64: bytes.toString("base64"), videoMime: "video/mp4" } : {}),
        shots: await encoded(toWebp),
      });

      let reportPath: string | undefined;
      if (record) {
        const template = options.reportTemplate;
        reportPath = template
          ? await record.writeReport(buildMidsceneReport({ result, events: all, calls: ledger.all(), meta, shots: await encoded(toJpeg) }, template))
          : await record.writeReport(html);
        if (template) await record.writeReport(html, "timeline.html");
      }

      return {
        result,
        ...(lock ? { lock } : {}),
        events: all,
        ledger,
        html,
        ...(reportPath ? { reportPath } : {}),
        ...(appBuild ? { appBuild } : {}),
        ...(small ? { videoPath: small } : {}),
      };
    } finally {
      // Closed twice on the way through is nothing; left open, a log reader
      // outlives the run it was reading for.
      await logs?.close().catch(() => undefined);
    }
  }
}

/** A run start to end, let go of whatever happens. */
export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const run = new TestRun(options);
  try {
    return await run.execute();
  } finally {
    await run.close();
  }
}
