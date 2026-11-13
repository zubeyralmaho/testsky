/**
 * Tests on several phones at once.
 *
 * A phone runs its tests one after another -- it does one thing at a time --
 * and phones run side by side. Every run is its own `testsky run` in its own
 * process: a phone whose driver hangs or crashes takes only its own run with
 * it, and each run is exactly the run that phone would get on its own, with
 * its lease, its memory and its evidence.
 */

import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { DeviceHandle, Platform } from "@testsky/engine-core";

export interface LaneTest {
  path: string;
  id: string;
  platforms: Platform[];
}

export interface Lane {
  device: DeviceHandle;
  tests: LaneTest[];
}

/** How one test went on one phone, as its own run said. */
export interface LaneRow {
  device: string;
  platform: Platform;
  test: string;
  /** The run's outcome; BUSY, NO_RESULT, STOPPED or NOT_RUN when it could not say one. */
  outcome: string;
  detail?: string;
  usd?: number;
  ms?: number;
  report?: string;
  /** The run's exit code; null when a signal stopped it or it never started. */
  code: number | null;
}

/** Each phone, with the tests written for its platform, in the order they were given. */
export function planLanes(tests: LaneTest[], devices: DeviceHandle[]): Lane[] {
  return devices
    .map((device) => ({ device, tests: tests.filter((test) => test.platforms.includes(device.platform)) }))
    .filter((lane) => lane.tests.length > 0);
}

/**
 * A row for each test and platform no phone here runs it on. A test written
 * for a platform with no phone did not run there, and is never left out of
 * the count: a run of two tests once said "1 of 1 passed", and a test for
 * both platforms run with no simulator up said it passed everywhere. Only a
 * platform the run was told to leave out (`--platform`) is not asked about.
 */
export function unplaced(tests: LaneTest[], lanes: Lane[]): LaneRow[] {
  const rows: LaneRow[] = [];
  for (const test of tests) {
    for (const platform of test.platforms) {
      const ran = lanes.some((lane) => lane.device.platform === platform && lane.tests.some((each) => each.path === test.path));
      if (!ran) rows.push({ device: "-", platform, test: test.id, outcome: "NOT_RUN", detail: `no ${platform} phone among these`, code: null });
    }
  }
  return rows;
}

/** Names short enough to sit in front of every line, and still telling the phones apart. */
export function laneLabels(devices: DeviceHandle[]): Map<string, string> {
  const short = (id: string) => (id.length > 16 ? id.slice(0, 8) : id);
  const clash = new Set(devices.map((device) => short(device.id))).size !== devices.length;
  const labels = devices.map((device) => (clash ? device.id : short(device.id)));
  const width = Math.max(0, ...labels.map((label) => label.length));
  return new Map(devices.map((device, index) => [device.id, labels[index]!.padEnd(width)]));
}

export interface RunLanesOptions {
  /** Phones running at once; the others wait for one to finish. */
  parallel: number;
  /** Starts one test on one phone; the run writes how it went to `resultFile`. */
  start: (device: DeviceHandle, test: LaneTest, resultFile: string) => ChildProcess;
  print: (line: string) => void;
  /** True once the lanes are to stop: no test starts after that. */
  stopped?: () => boolean;
  /**
   * Lines not passed on. A run's own filter sees what it writes in pieces,
   * and the device stack's chatter got through in a run on several phones;
   * here every line arrives whole.
   */
  drop?: (line: string) => boolean;
}

export async function runLanes(lanes: Lane[], options: RunLanesOptions): Promise<LaneRow[]> {
  const labels = laneLabels(lanes.map((lane) => lane.device));
  const scratch = await mkdtemp(join(tmpdir(), "testsky-lanes-"));
  const rows: LaneRow[][] = lanes.map(() => []);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < lanes.length; index = next++) {
      const lane = lanes[index]!;
      for (const [n, test] of lane.tests.entries()) {
        if (options.stopped?.()) {
          rows[index]!.push({ device: lane.device.id, platform: lane.device.platform, test: test.id, outcome: "NOT_RUN", code: null });
          continue;
        }
        rows[index]!.push(await runOne(lane.device, test, join(scratch, `${index}-${n}.json`), labels.get(lane.device.id)!, options));
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.parallel, lanes.length)) }, worker));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return rows.flat();
}

const ANSI = /\u001B\[[0-9;]*m/g;

async function runOne(device: DeviceHandle, test: LaneTest, resultFile: string, label: string, options: RunLanesOptions): Promise<LaneRow> {
  const child = options.start(device, test, resultFile);
  // The last thing a run said: when it ends without a result -- a setup error,
  // a crash -- that line is usually why.
  let last = "";
  const relay = (stream: NodeJS.ReadableStream | null): Promise<void> => {
    if (!stream) return Promise.resolve();
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (options.drop?.(line)) return;
      if (line.trim()) last = line.replace(ANSI, "").trim();
      options.print(`${label}  ${line}`);
    });
    return new Promise((resolve) => lines.once("close", resolve));
  };
  const ended = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  const [code] = await Promise.all([ended, relay(child.stdout), relay(child.stderr)]);
  // Half a file -- the run killed while writing it, a full disk -- is no
  // result, and costs this one row, not every phone's summary.
  const said = await readFile(resultFile, "utf8").then(
    (text) => {
      try {
        return JSON.parse(text) as Partial<LaneRow>;
      } catch {
        return undefined;
      }
    },
    () => undefined,
  );
  const detail = said?.detail ?? (last || undefined);
  return {
    device: device.id,
    platform: device.platform,
    test: test.id,
    // Told to stop, a run exits 130 or 143 before it has a result to write.
    outcome: said?.outcome ?? (code === null || code === 130 || code === 143 ? "STOPPED" : "NO_RESULT"),
    ...(detail ? { detail } : {}),
    ...(typeof said?.usd === "number" ? { usd: said.usd } : {}),
    ...(typeof said?.ms === "number" ? { ms: said.ms } : {}),
    ...(typeof said?.report === "string" ? { report: said.report } : {}),
    code,
  };
}

/**
 * The process groups of the runs started, until each is empty. A run and
 * whatever it started -- xcodebuild, a recorder -- share its group, and the
 * group is not done when the run is: a WebDriverAgent build begun while it
 * attached, or one left by a crash, kept its simulator's port for good. What
 * is left when a run exits is given a moment -- a recorder may still be
 * finishing its file -- and then ended.
 */
export class RunGroups {
  private readonly groups = new Set<number>();
  private readonly ending = new Set<Promise<void>>();
  private readonly timing: { graceMs: number; termMs: number };

  constructor(timing = { graceMs: 15_000, termMs: 5_000 }) {
    this.timing = timing;
  }

  /** Watches a run started in a process group of its own (`detached: true`). */
  track(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid) return;
    this.groups.add(pid);
    child.once("exit", () => {
      const done = this.end(pid);
      this.ending.add(done);
      void done.finally(() => this.ending.delete(done));
    });
  }

  /** Every group not yet empty, now. */
  kill(signal: NodeJS.Signals): void {
    for (const pid of this.groups) signalGroup(pid, signal);
  }

  /** Once every run that has exited has nothing of its own left running. */
  async settled(): Promise<void> {
    while (this.ending.size) await Promise.all(this.ending);
  }

  private async end(pid: number): Promise<void> {
    await gone(pid, this.timing.graceMs);
    if (groupAlive(pid)) signalGroup(pid, "SIGTERM");
    await gone(pid, this.timing.termMs);
    if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
    this.groups.delete(pid);
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is gone already.
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number, ms: number): Promise<void> {
  for (let waited = 0; groupAlive(pid) && waited < ms; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
}

/** A run that passed and said so: an exit of 0 with no result to show is no pass. */
export function passedRow(row: LaneRow): boolean {
  return row.code === 0 && (row.outcome === "PASS" || row.outcome === "HEALED_PASS");
}

/** Green when every run passed; an app at fault says so over a run that could not tell. */
export function lanesExitCode(rows: LaneRow[]): number {
  if (rows.length && rows.every(passedRow)) return 0;
  if (rows.some((row) => row.code === 1)) return 1;
  return 2;
}

/** The table at the end: one line per test per phone. */
export function lanesSummary(rows: LaneRow[], colour: (row: LaneRow, text: string) => string = (_row, text) => text): string[] {
  if (!rows.length) return [];
  const labels = laneLabels(rows.map((row) => ({ id: row.device, platform: row.platform, osVersion: "", kind: "physical" as const })));
  const testWidth = Math.max(...rows.map((row) => row.test.length));
  const outcomeWidth = Math.max(...rows.map((row) => row.outcome.length));
  const lines = rows.map((row) => {
    const time = row.ms === undefined ? "" : duration(row.ms);
    const usd = row.usd === undefined ? "" : `$${row.usd.toFixed(4)}`;
    const why = passedRow(row) || !row.detail ? "" : `  ${row.detail}`;
    return `  ${labels.get(row.device)}  ${row.test.padEnd(testWidth)}  ${colour(row, row.outcome.padEnd(outcomeWidth))}  ${time.padStart(6)}  ${usd}${why}`;
  });
  const passed = rows.filter(passedRow).length;
  return [...lines, "", `  ${passed} of ${rows.length} passed`];
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
