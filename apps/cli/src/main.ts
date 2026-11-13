#!/usr/bin/env node
/**
 * `testsky` -- the whole product from a terminal.
 *
 * Three commands in W1: run a test, list devices, and check the setup. The
 * third one exists because in a customer's POC "it doesn't work" has to become
 * one line of output, and every hour spent on `doctor` is an hour not spent on
 * a support call.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  exportMarkdown,
  importTestCases,
  isTestFile,
  parseCsv,
  parseTestFile,
  serializeDraft,
  TestFileError,
} from "@testsky/artifact";
import {
  describeHolder,
  deviceLeasePath,
  leaseDevice,
  leaseHolder,
  type DeviceHandle,
  type Lease,
  type LeaseAttempt,
  type Platform,
} from "@testsky/engine-core";
import type { RunEvent } from "@testsky/executor";
import { engineFor, openLock, RunRecord, TestRun } from "@testsky/harness";
import { startPlayground } from "@testsky/playground";
import { fixtureScreen, pointInside } from "@testsky/perception";
import { allowedHosts, CostLedger, modelsFilePath, Router, routerConfigFromEnv } from "@testsky/router";

import { busyWithOthers, findDevices, listDevices, onePerPhone, readyDevices, resolveDevice } from "./devices.ts";
import { lanesExitCode, lanesSummary, passedRow, planLanes, RunGroups, runLanes, unplaced, type LaneRow, type LaneTest } from "./lanes.ts";
import { installLogFilter, isDeviceChatter, quietly } from "./quiet.ts";
import { commandBench } from "./bench.ts";
import { commandReport, commandValidate } from "./inspect.ts";
import { JsonAnswer } from "./json.ts";
import { commandMcp } from "./mcp.ts";
import { commandLook, commandStep } from "./phone.ts";
import { AMBER, exitCodeFor, GREEN, laneAnswer, printReport, RED, runAnswer } from "./report.ts";

const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

/** The answer on stdout, when the command was asked for `--json`. */
let json: JsonAnswer | undefined;
/** The commands that answer `--json`. */
const JSON_COMMANDS = new Set(["run", "devices", "validate", "report", "step", "look"]);

/**
 * Model configuration lives in the runner's environment, and a `.env` beside
 * the tests is how a person actually keeps it. Read here and nowhere else --
 * a key that reaches the control plane is a liability we cannot insure.
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env, or an unreadable one. Real configuration errors are reported by
    // the router with an instruction attached; a missing file is not one.
  }
}

/**
 * Errors that carry an instruction for a person, matched by name rather than
 * by `instanceof`.
 *
 * pnpm links the same package into several node_modules trees, and on a
 * case-insensitive filesystem Node can load the same file under two URLs --
 * two classes, one source, and an `instanceof` that quietly says false. A
 * name check cannot drift that way.
 */
const INSTRUCTIONS = new Set(["TestFileError", "ConfigError", "SetupError", "DeviceNotReadyError"]);

function isInstruction(error: unknown): error is Error {
  return error instanceof Error && INSTRUCTIONS.has(error.name);
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  // The next flag is no flag's value: `--devices --out runs` gave no devices.
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function usage(): void {
  console.log(`testsky -- vision-driven mobile tests

  testsky run <test.testsky.yaml> [--platform android|ios] [--device <id>] [--out <dir>]
         [--no-cache] [--no-video] [--device-log] [--verbose] [--wda-port <n>] [--json]
         --device-log reads the app's own log into the timeline: adb calls through the run,
         and up to half a minute at its end
         --wda-port is the local port a physical iPhone's WebDriverAgent is forwarded to, for
         when iproxy's command lines are not to be trusted to say
  testsky run <test.testsky.yaml>... --devices <id,id,...|all> [--parallel <n>] [--out <dir>] [--json]
         every test on every phone given, the phones at once; "all" is every usable
         Android device and every booted simulator
  testsky devices [--json]
  testsky validate <test.testsky.yaml>... [--json]
         reads each test as a run would, with no device and no model
  testsky report [<run folder>] [--out <dir>] [--json | --md]
         a kept run, read back from its folder; the newest in --out (runs) when none is named
  testsky step --do "<what to do>" [--expect "<what must hold>"] [--read "<what to read>"]
         [--platform android|ios] [--device <id>] [--save <file.testsky.yaml> [--app <id>]] [--shot <file>] [--json]
         one step, run as a test of one step; --save adds it to the file, with what it learned, when it passed
  testsky look [--tree] [--platform android|ios] [--device <id>] [--shot <file>] [--json]
         the screen, and its accessibility tree with --tree
  testsky mcp [--devices <id,id,...>] [--out <dir>] [--idle <seconds>]
         an MCP server on stdio for coding agents -- runs, steps, the screen -- on the phones
         given, or every phone here; started over ssh on the machine the phones are on
  testsky doctor [--samples <n>]
  testsky bench <dir> [--platform android|ios] [--runs <n>] [--cache] [--out bench.json]
  testsky playground [--platform android|ios] [--device <id>] [--port <n>] [--test <file.testsky.yaml>] [--app <id>]
  testsky import <export.csv> --app <id> [--platform android|ios] [--out <dir>]
  testsky export <test.testsky.yaml> [--format markdown|json]

--json: stdout is one JSON object, the answer, and nothing else; what a person reads goes to stderr.
Exit codes: 0 passed; 1 the app may be broken; 2 could not tell, or could not run.

Environment:
  TESTSKY_MODEL_BASE_URL   an OpenAI-compatible endpoint (cloud gateway or local vLLM)
  TESTSKY_MODEL_NAME       the model to ask
  TESTSKY_MODEL_API_KEY    omitted for an open endpoint
`);
}

/**
 * The report viewer: Midscene's report app with testsky's changes, built by
 * ui/report into one HTML file. Absent until that build has run.
 */
async function reportTemplate(): Promise<string | undefined> {
  const path = process.env.TESTSKY_REPORT_TEMPLATE ?? fileURLToPath(new URL("../../../ui/report/dist/index.html", import.meta.url));
  return readFile(path, "utf8").catch(() => undefined);
}

/** The playground page, built by ui/playground. Absent until that build has run. */
async function playgroundPage(): Promise<string | undefined> {
  const path = process.env.TESTSKY_PLAYGROUND_PAGE ?? fileURLToPath(new URL("../../../ui/playground/dist/index.html", import.meta.url));
  return readFile(path, "utf8").catch(() => undefined);
}

/**
 * A phone in the browser: Midscene's playground conversation on one side,
 * the screen and its accessibility tree on the other, and every instruction
 * run by testsky as a one-step test.
 */
async function commandPlayground(argv: string[]): Promise<number> {
  const verbose = argv.includes("--verbose");
  installLogFilter(verbose);
  const platform = (flag(argv, "platform") ?? "android") as Platform;
  if (platform !== "android" && platform !== "ios") {
    console.error("--platform must be android or ios");
    return 2;
  }
  const port = Number(flag(argv, "port") ?? 5800);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error("--port is a port number");
    return 2;
  }
  const page = await playgroundPage();
  if (!page) {
    console.error("the playground page is not built: run pnpm build:playground");
    return 2;
  }

  const device = await resolveDevice(platform, flag(argv, "device"), verbose);
  // The phone is the playground's while it is open: a run started beside it
  // would tap on the same screen.
  const lease = await takePhone(device, "playground");
  if (!lease) return 2;
  const ledger = new CostLedger();
  const engine = engineFor(platform, new Router(routerConfigFromEnv(), ledger), { onProgress: (message) => console.log(`${DIM}  ${message}${RESET}`) });
  await quietly(() => engine.attach(device), verbose);

  // "Save as a step" writes here; a file not there yet is begun, for --app or the app in front.
  const test = flag(argv, "test");
  if (test !== undefined && !isTestFile(test)) {
    console.error("--test names a test file: <name>.testsky.yaml");
    return 2;
  }
  const app = flag(argv, "app");
  const playground = await startPlayground({
    engine,
    device,
    ledger,
    page,
    port,
    ...(test ? { test: resolve(test) } : {}),
    ...(app ? { app } : {}),
  });
  console.log(`testsky playground: ${playground.url}`);
  if (test) console.log(`${DIM}steps are saved to ${resolve(test)}${RESET}`);
  console.log(`${DIM}${device.kind} ${device.id} · ${engine.name} · Ctrl+C to stop${RESET}`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await playground.close();
  await engine.detach();
  await lease.release();
  const spent = ledger.totalUsd();
  if (ledger.all().length) {
    console.log(`${DIM}${ledger.all().length} model call(s)${spent > 0 ? `, $${spent.toFixed(4)}` : ""}${RESET}`);
  }
  return 0;
}

async function ownVersion(): Promise<string | undefined> {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8").catch(() => "{}");
  return (JSON.parse(raw) as { version?: string }).version;
}

/** The arguments that are not flags, nor a flag's value. */
function positionals(argv: string[], valued: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      if (valued.includes(arg.slice(2)) && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) i += 1;
      continue;
    }
    found.push(arg);
  }
  return found;
}

const RUN_VALUED = ["platform", "device", "devices", "out", "parallel", "wda-port"];
const RUN_SWITCHES = ["no-cache", "no-video", "device-log", "verbose", "json"];

/** A flag `run` does not know: with tests named by position, a stray value would be taken for one. */
function unknownFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("-")) continue;
    const name = arg.slice(2);
    if (!arg.startsWith("--") || (!RUN_VALUED.includes(name) && !RUN_SWITCHES.includes(name))) return arg;
    if (RUN_VALUED.includes(name) && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) i += 1;
  }
  return undefined;
}

/** For `run --devices`: each phone's run says how it went, in a file the run on all of them names. */
async function laneResult(result: Record<string, unknown>): Promise<void> {
  const path = process.env.TESTSKY_RESULT_FILE;
  if (path) await writeFile(path, `${JSON.stringify(result)}\n`).catch(() => undefined);
}

/**
 * The phone to this run alone: testsky's lease, and nobody else at work on
 * it -- another automation run, a mirror somebody has open -- which the lease cannot
 * know about. Undefined, and said why, when it is not to be had.
 */
async function takePhone(device: DeviceHandle, what: string): Promise<Lease | undefined> {
  const lease = await leaseDevice(device, what);
  if ("busy" in lease) {
    busy(device, lease);
    const detail = lease.busy ? `in use by ${describeHolder(lease.busy)}` : "in use";
    await laneResult({ outcome: "BUSY", detail });
    json?.answer({ outcome: "BUSY", exitCode: 2, detail, device: device.id });
    return undefined;
  }
  const others = await busyWithOthers(device);
  if (others.length) {
    await lease.lease.release();
    console.error(`the ${device.platform} device ${device.id} is in use by another program: ${others.join("; ")}`);
    const detail = `in use by another program: ${others.join("; ")}`;
    await laneResult({ outcome: "BUSY", detail });
    json?.answer({ outcome: "BUSY", exitCode: 2, detail, device: device.id });
    return undefined;
  }
  return lease.lease;
}

/** Says who holds a phone, and how to let go of it if they are gone. */
function busy(device: { platform: Platform; id: string }, attempt: Extract<LeaseAttempt, { busy: unknown }>): void {
  console.error(`the ${device.platform} device ${device.id} is in use${attempt.busy ? ` by ${describeHolder(attempt.busy)}` : ""}`);
  console.error(`${DIM}one run per phone at a time. If that run is gone, delete ${deviceLeasePath(device)}${RESET}`);
}

async function commandRun(argv: string[]): Promise<number> {
  const stray = unknownFlag(argv);
  if (stray) {
    console.error(`run does not take ${stray}`);
    usage();
    return 2;
  }
  // Started by `run --devices`: a run that loses the process reading its
  // output still finishes, lets go of its phone and writes its result,
  // rather than dying on the next line it prints.
  if (process.env.TESTSKY_RESULT_FILE) for (const stream of [process.stdout, process.stderr]) stream.on("error", () => undefined);
  const paths = positionals(argv, RUN_VALUED);
  if (argv.includes("--devices") || paths.length > 1) return commandRunMany(paths, argv);
  const path = paths[0];
  if (!path) {
    usage();
    return 2;
  }

  const source = await readFile(resolve(path), "utf8");
  const test = parseTestFile(source, path);
  const verbose = argv.includes("--verbose");
  installLogFilter(verbose);

  // The platform comes from the flag, or from the test itself when it names
  // only one -- a test written for iOS should not need to say so twice.
  const asked = flag(argv, "platform") as Platform | undefined;
  const platform: Platform = asked ?? (test.targets.length === 1 ? test.targets[0]!.platform : "android");
  if (!test.targets.some((target) => target.platform === platform)) {
    throw new TestFileError(path, `this test has no ${platform} target`);
  }
  const wdaPort = flag(argv, "wda-port") === undefined ? undefined : Number(flag(argv, "wda-port"));
  if (wdaPort !== undefined && (!Number.isInteger(wdaPort) || wdaPort <= 0)) {
    console.error("--wda-port is a port number");
    return 2;
  }
  const device = await resolveDevice(platform, flag(argv, "device"), verbose);

  const onEvent = (event: RunEvent) => {
    if (!verbose && event.kind === "action") return;
    if (event.kind === "step_started") console.log(`${DIM}  -> ${event.message}${RESET}`);
    // Always said, not only when asked: a run that answered a prompt on
    // somebody's behalf should not leave them to find out from the report.
    else if (event.kind === "popup") console.log(`${DIM}     pop-up: ${event.message}${RESET}`);
    // So is a person's word on a heal, acted on: for one who reviews by
    // editing the lock, this line is how they know the edit was read.
    else if (event.kind === "note" && event.data?.review) console.log(`${DIM}  step "${event.stepId}": ${event.message}${RESET}`);
    else if (verbose) console.log(`${DIM}     ${event.kind}: ${event.message}${RESET}`);
  };

  // The report is the viewer when ui/report has been built; the timeline,
  // with the video and the app's log the viewer does not show yet, stays
  // beside it. Without the build the timeline is the report, as it was.
  const template = await reportTemplate();
  const version = await ownVersion();
  const record = new RunRecord(flag(argv, "out") ?? "runs", test.id, Date.now(), device.id);
  const run = new TestRun({
    test,
    device,
    platform,
    record,
    video: !argv.includes("--no-video"),
    deviceLog: argv.includes("--device-log"),
    ...(wdaPort !== undefined ? { wdaPort } : {}),
    ...(template ? { reportTemplate: template } : {}),
    ...(version ? { version } : {}),
    attach: (attach) => quietly(attach, verbose),
    // What this test learned last time on a screen of this layout, if anyone
    // is willing to let it remember.
    ...(argv.includes("--no-cache")
      ? {}
      : {
          memory: async (attached: DeviceHandle) => {
            const opened = await openLock(resolve(path), test.id, platform, attached.size);
            if (!opened) console.log(`${DIM}the device did not say its screen size, so this run has no memory and keeps none${RESET}`);
            return opened;
          },
        }),
    onEvent,
    onProgress: (message) => console.log(`${DIM}  ${message}${RESET}`),
    onNote: (message, level) => console.log(level === "warn" ? `${AMBER}  ${message}${RESET}` : `${DIM}${message}${RESET}`),
    // Before the report: one that cannot be built, on a full disk, must not cost a run its verdict.
    onVerdict: (result, ledger) => laneResult(laneAnswer(result, ledger.totalUsd())),
  });

  // A run stopped from outside still stops its recorder and lets go of the
  // device: a recorder left running writes until the disk is full. Listened
  // for before the phone is taken, so a stop that comes while WebDriverAgent
  // is still building lets go of everything too.
  const interrupted = (signal: NodeJS.Signals) => {
    void run.abandon().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);

  // A phone runs one test at a time, whoever asks: taken before anything
  // touches it, let go of when the run is over or its process is gone.
  const lease = await takePhone(device, `run ${test.id}`);
  if (!lease) {
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    return 2;
  }

  console.log(`${DIM}${test.title}${RESET}`);
  console.log(`${DIM}${device.kind} ${device.id} · ${run.engine.name}${RESET}`);

  try {
    const { result, ledger, reportPath } = await run.execute();
    if (!template) console.log(`  ${DIM}the report viewer is not built (pnpm build:report): this report is the timeline${RESET}`);
    printReport(result, ledger);
    console.log(`  ${DIM}${reportPath}${RESET}\n`);
    const report = reportPath ? { report: resolve(reportPath) } : {};
    await laneResult({ ...laneAnswer(result, ledger.totalUsd()), ...report });
    json?.answer(runAnswer(result, ledger, { path: resolve(path), platform, device: device.id, dir: resolve(record.dir), ...report }));
    return exitCodeFor(result);
  } finally {
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    await run.close();
    await lease.release();
  }
}

/**
 * Every test given, on every phone given, the phones at once. Each test on
 * each phone is its own `testsky run`, started here and reported here.
 */
async function commandRunMany(paths: string[], argv: string[]): Promise<number> {
  if (!paths.length) {
    usage();
    return 2;
  }
  const verbose = argv.includes("--verbose");
  installLogFilter(verbose);
  const tests: LaneTest[] = [];
  for (const path of paths) {
    const test = parseTestFile(await readFile(resolve(path), "utf8"), path);
    tests.push({ path: resolve(path), id: test.id, platforms: test.targets.map((target) => target.platform) });
  }
  const asked = flag(argv, "platform") as Platform | undefined;
  if (asked && asked !== "android" && asked !== "ios") {
    console.error("--platform must be android or ios");
    return 2;
  }
  const platforms = asked ? [asked] : [...new Set(tests.flatMap((test) => test.platforms))];
  const spec = flag(argv, "devices");
  if (argv.includes("--devices") && !spec) {
    console.error("--devices takes phone ids separated by commas, or all");
    return 2;
  }
  const devices =
    spec === "all"
      ? (await Promise.all(platforms.map((platform) => readyDevices(platform, verbose).catch(() => [])))).flat()
      : spec
        ? await findDevices(spec.split(",").map((id) => id.trim()).filter(Boolean), platforms, verbose)
        : [await resolveDevice(asked ?? (platforms.length === 1 ? platforms[0]! : "android"), flag(argv, "device"), verbose)];
  const wanted = tests.map((test) => ({ ...test, platforms: test.platforms.filter((platform) => platforms.includes(platform)) }));
  const lanes = planLanes(wanted, devices);
  if (!lanes.length) {
    console.error(devices.length ? "none of these phones is on a platform these tests are written for" : `no ${platforms.join(" or ")} phone is ready`);
    return 2;
  }
  // Left out on purpose -- `--platform` asked for one the test is not written
  // for -- a test is said to be skipped, and is not a failure.
  for (const test of wanted) if (!test.platforms.length) console.log(`${DIM}skipped ${test.id}: it is not written for ${asked}${RESET}`);
  const left = unplaced(wanted, lanes);
  const missing = [...new Set(left.map((row) => row.platform))];
  if (missing.length && !asked) {
    const others = platforms.filter((platform) => !missing.includes(platform));
    console.log(
      `${DIM}no ${missing.join(" or ")} phone among these: those runs are counted as not run${others.length ? `; --platform ${others[0]} runs on ${others[0]} alone` : ""}${RESET}`,
    );
  }
  const parallel = Number(flag(argv, "parallel") ?? lanes.length);
  if (!Number.isInteger(parallel) || parallel < 1) {
    console.error("--parallel is how many phones run at once: 1 or more");
    return 2;
  }

  const out = flag(argv, "out") ?? "runs";
  const forwarded = [...(flag(argv, "out") ? ["--out", out] : []), ...["--no-cache", "--no-video", "--device-log", "--verbose"].filter((name) => argv.includes(name))];
  const runs = lanes.reduce((sum, lane) => sum + lane.tests.length, 0);
  console.log(`${DIM}${tests.length} test(s) on ${lanes.length} phone(s), ${Math.min(parallel, lanes.length)} at a time: ${runs} run(s)${RESET}\n`);

  // Output nobody reads any more -- a closed pipe, a gone terminal -- is not
  // a reason to stop scheduling, or to stop waiting for the runs.
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => undefined);
  const children = new Set<ChildProcess>();
  const groups = new RunGroups();
  let stopping: NodeJS.Signals | undefined;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) {
      // Asked twice: no more waiting for anybody to tidy up.
      groups.kill("SIGKILL");
      return;
    }
    stopping = signal;
    console.log(`${DIM}stopping: each phone's run is told to stop and let go of its phone${RESET}`);
    // Told first, so it stops its recorder and lets go of its phone in order;
    // a run still tidying up after half a minute is not waited for.
    for (const child of children) child.kill(signal);
    setTimeout(() => groups.kill("SIGKILL"), 30_000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const ran = await runLanes(lanes, {
      parallel,
      stopped: () => stopping !== undefined,
      print: (line) => console.log(line),
      ...(verbose ? {} : { drop: isDeviceChatter }),
      start: (device, test, resultFile) => {
        const child = spawn(
          process.execPath,
          [...process.execArgv, process.argv[1]!, "run", test.path, "--platform", device.platform, "--device", device.id, ...forwarded],
          {
            stdio: ["ignore", "pipe", "pipe"],
            // Its own process group: a Ctrl+C in the terminal reaches this
            // process alone, and each run is told once, by it -- told twice,
            // a run is killed before it has stopped its recorder.
            detached: true,
            env: { ...process.env, TESTSKY_RESULT_FILE: resultFile },
          },
        );
        children.add(child);
        groups.track(child);
        child.once("exit", () => children.delete(child));
        return child;
      },
    });

    await groups.settled();
    const rows = [...ran, ...left];
    const colour = (row: LaneRow, text: string) => `${passedRow(row) ? GREEN : row.code === 1 ? RED : AMBER}${text}${RESET}`;
    console.log("");
    for (const line of lanesSummary(rows, colour)) console.log(line);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const summary = join(out, `summary-${stamp}.json`);
    await mkdir(out, { recursive: true });
    await writeFile(summary, `${JSON.stringify({ at: new Date().toISOString(), tests: paths, rows }, null, 2)}\n`);
    console.log(`  ${DIM}${summary}${RESET}\n`);
    const code = stopping ? (stopping === "SIGINT" ? 130 : 143) : lanesExitCode(rows);
    json?.answer({ exitCode: code, passed: rows.filter(passedRow).length, total: rows.length, rows, summary: resolve(summary) });
    return code;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

/**
 * Turns an export full of manual cases into drafts.
 *
 * Deliberately loud about what it is not: every file it writes says "read me
 * before you run me" at the top, and the summary counts the things a person
 * has to fix. Quietly producing runnable-looking tests from cases written for
 * a human is how a tool earns a reputation for lying.
 */
async function commandImport(argv: string[]): Promise<number> {
  const source = argv[0];
  const app = flag(argv, "app");
  const platform = (flag(argv, "platform") ?? "android") as Platform;
  if (!source || !app) {
    console.log("  testsky import <export.csv> --app <package-or-bundle-id> [--platform android|ios] [--out <dir>]");
    return 2;
  }

  const out = flag(argv, "out") ?? "tests";
  const drafts = importTestCases(parseCsv(await readFile(resolve(source), "utf8")), { platform, app });
  if (!drafts.length) {
    console.log(`  nothing to import from ${source} -- no rows with an action or an expected result`);
    return 2;
  }

  await mkdir(out, { recursive: true });
  let flagged = 0;
  for (const draft of drafts) {
    const path = join(out, `${draft.file.id}.testsky.yaml`);
    await writeFile(path, serializeDraft(draft, source));
    flagged += draft.warnings.length;
    const mark = draft.warnings.length ? `${AMBER}${draft.warnings.length} to fix${RESET}` : `${DIM}clean${RESET}`;
    console.log(`  ${path}  ${DIM}${draft.file.steps.length} steps${RESET}  ${mark}`);
    for (const warning of draft.warnings) console.log(`      ${DIM}${warning}${RESET}`);
  }

  console.log("");
  console.log(`  ${drafts.length} draft(s) in ${out}/, ${flagged} thing(s) a person has to decide.`);
  console.log(`  ${DIM}These are drafts, not tests. Read one, run it, then trust it.${RESET}\n`);
  return 0;
}

async function commandExport(argv: string[]): Promise<number> {
  const path = argv[0];
  if (!path) {
    console.log("  testsky export <test.testsky.yaml> [--format markdown|json]");
    return 2;
  }
  const file = parseTestFile(await readFile(resolve(path), "utf8"), path);
  if ((flag(argv, "format") ?? "markdown") === "json") console.log(JSON.stringify(file, null, 2));
  else console.log(exportMarkdown(file));
  return 0;
}

async function commandDevices(argv: string[]): Promise<number> {
  const verbose = argv.includes("--verbose");
  const rows: Record<string, unknown>[] = [];
  const problems: { platform: Platform; detail: string }[] = [];
  for (const platform of ["android", "ios"] as Platform[]) {
    try {
      // Each phone once, by its own serial -- which is also what its lease is kept by.
      const devices = platform === "android" ? await onePerPhone(await listDevices(platform, verbose)) : await listDevices(platform, verbose);
      for (const device of devices) {
        // Who has it, if anybody: the question to ask before touching a phone on a shared rig.
        const holder = await leaseHolder(deviceLeasePath(device));
        rows.push({ id: device.id, platform, kind: device.kind, osVersion: device.osVersion, ...(holder ? { inUseBy: describeHolder(holder) } : {}) });
        const using = holder ? `  ${AMBER}in use by ${describeHolder(holder)}${RESET}` : "";
        console.log(`  ${device.id}  ${DIM}${platform} ${device.kind}${device.osVersion ? ` ${device.osVersion}` : ""}${RESET}${using}`);
      }
    } catch (error) {
      const detail = (error as Error).message.split("\n")[0]!;
      problems.push({ platform, detail });
      console.log(`  ${DIM}${platform}: ${detail}${RESET}`);
    }
  }
  json?.answer({ devices: rows, problems });
  return rows.length ? 0 : 2;
}

async function commandDoctor(argv: string[] = []): Promise<number> {
  let bad = 0;
  const ok = (line: string) => console.log(`  \u001b[32mok\u001b[0m    ${line}`);
  const fail = (line: string) => {
    bad += 1;
    console.log(`  \u001b[31mfail\u001b[0m  ${line}`);
  };
  const note = (line: string) => console.log(`        ${DIM}${line}${RESET}`);

  for (const platform of ["android", "ios"] as Platform[]) {
    try {
      const devices = await listDevices(platform);
      if (devices.length) ok(`${platform}: ${devices.length} device(s), first is ${devices[0]!.id}`);
      else fail(`${platform}: nothing available`);
    } catch (error) {
      fail(`${platform}: ${(error as Error).message.split("\n")[0]}`);
    }
  }

  let config;
  try {
    config = routerConfigFromEnv();
  } catch (error) {
    fail((error as Error).message);
    console.log("");
    return 2;
  }

  ok(`models from ${existsSync(modelsFilePath()) ? modelsFilePath() : "the environment"}`);
  if (config.offline) note("offline: only " + allowedHosts(config).join(", ") + " may be reached");

  // How many times to ask, so a latency figure means something. One call tells
  // you it answered; a handful tells you what a run will feel like.
  const samples = Math.max(1, Number(flag(argv, "samples") ?? 1));
  const fixture = await fixtureScreen();

  for (const [name, tier] of Object.entries(config.tiers)) {
    if (!tier) continue;
    const ledger = new CostLedger();
    // Each tier is asked with its own model -- a router built on it alone --
    // or a second-look model nobody ever asked would pass as checked.
    const router = new Router({ ...config, tiers: { ground: tier } }, ledger);
    // The grounder and the second look both point at things; the others judge.
    const points = name === "ground" || name === "escalation";
    const latencies: number[] = [];
    let landed = 0;

    try {
      for (let i = 0; i < samples; i += 1) {
        // The ground tier is checked against a screen whose answer we know:
        // an endpoint that replies is not the same as a model that can see,
        // and a model that can see is not the same as one that answers in the
        // coordinate space we asked for.
        const observation = {
          frame: { bytes: fixture.png, capturedAt: Date.now(), size: fixture.size, pixelRatio: fixture.pixelRatio },
          visionBlind: false,
          visionStats: { meanLuma: 128, stdLuma: 40, uniqueColors: 64 },
          signature: { phash: "", maskedRegions: [] },
          appContext: {},
          observedAt: Date.now(),
        };
        const result =
          points
            ? await router.ground({
                observation,
                description: fixture.targetDescription,
                budget: { maxUsd: 0.05, maxLatencyMs: 60_000, maxEscalations: 0 },
              })
            : await router.assert({ observation, assertion: "a blue button is visible near the bottom" });
        latencies.push(result.provenance.latencyMs);
        if (points && "point" in result && pointInside(result.point, fixture.target)) landed += 1;
      }
    } catch (error) {
      fail(`${name} (${tier.model}): ${(error as Error).message}`);
      continue;
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const timing = samples > 1 ? `p50 ${p(0.5)}ms, p95 ${p(0.95)}ms over ${samples}` : `${sorted[0]}ms`;

    if (points && landed < samples) {
      fail(`${name} (${tier.model}): landed on the target ${landed}/${samples} -- ${timing}`);
      note("a model that answers in image pixels instead of 0-1000 lands in the top-left quadrant");
    } else {
      ok(`${name} (${tier.model}): ${timing}`);
    }
    const spent = ledger.totalUsd();
    if (spent > 0) note(`$${spent.toFixed(4)} for ${samples} call(s)`);
  }

  if (!config.tiers.reason) {
    note("no reason tier: judging and planning use the grounder. Configure tiers.reason for the ladder.");
  }
  if (!config.tiers.escalation) {
    note("no escalation tier: a second look asks the same model again. Configure tiers.escalation for a better one.");
  }

  console.log("");
  return bad === 0 ? 0 : 2;
}

async function main(): Promise<number> {
  loadDotEnv();
  const [command, ...argv] = process.argv.slice(2);
  // First, before anything can write to stdout.
  if (command && JSON_COMMANDS.has(command) && argv.includes("--json")) json = new JsonAnswer();
  switch (command) {
    case "run":
      return commandRun(argv);
    case "devices":
      return commandDevices(argv);
    case "validate":
      return commandValidate(argv, json);
    case "report":
      return commandReport(argv, json, flag);
    case "step":
      return commandStep(argv, { json, flag, takePhone });
    case "look":
      return commandLook(argv, { json, flag, takePhone });
    case "mcp":
      return commandMcp(argv, flag, (await ownVersion()) ?? "0.0.0");
    case "doctor":
      return commandDoctor(argv);
    case "playground":
      return commandPlayground(argv);
    case "bench":
      return commandBench(argv, flag);
    case "import":
      return commandImport(argv);
    case "export":
      return commandExport(argv);
    case undefined:
    case "help":
    case "--help":
      usage();
      return 0;
    default:
      console.error(`unknown command: ${command}`);
      usage();
      return 2;
  }
}

main()
  .then((code) => {
    json?.end(code);
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (isInstruction(error)) console.error(`\n${(error as Error).message}\n`);
    else console.error(`\n${(error as Error).stack ?? String(error)}\n`);
    // The message, not the stack's last frame: what went wrong, for whoever parses the answer.
    json?.answer({ outcome: "ERROR", exitCode: 2, detail: String((error as Error).message ?? error).split("\n").find(Boolean) ?? "" });
    process.exitCode = 2;
  });
