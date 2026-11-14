/**
 * What a run left behind, on disk, as it happened.
 *
 * One JSON object per line, written as each event arrives rather than at the
 * end, because the runs worth reading are the ones that were killed or hung.
 * The step-indexed video and the HTML report (W6) are built from exactly this
 * file, which is why every line already carries the step id and the clock the
 * video will use.
 *
 * It stays on the machine that ran it. The runner uploads step events and the
 * failure clip; a full run's artefacts never leave unless someone asks.
 */

import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RunEvent, TestResult } from "@testsky/executor";
import type { CostLedger, LedgerEntry } from "@testsky/router";
import { toPng } from "@testsky/perception";

export class RunRecord {
  /** Final once `open` has made it: two runs that start together are given two folders. */
  dir: string;
  private readonly root: string;
  private readonly name: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(root: string, testId: string, startedAt: number, device?: string) {
    // Sortable, and named for the phone: runs on several phones at once land
    // side by side, and a folder says which phone it was without opening it.
    const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
    this.root = root;
    this.name = `${stamp}-${testId}${device ? `-${device.replace(/[^A-Za-z0-9._-]+/g, "_")}` : ""}`;
    this.dir = join(root, this.name);
  }

  private get eventsPath(): string {
    return join(this.dir, "events.jsonl");
  }

  async open(meta: Record<string, unknown>): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (let n = 1; ; n += 1) {
      const dir = join(this.root, n === 1 ? this.name : `${this.name}-${n}`);
      try {
        await mkdir(dir);
        this.dir = dir;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || n >= 100) throw error;
      }
    }
    await writeFile(join(this.dir, "run.json"), `${JSON.stringify(meta, null, 2)}\n`);
  }

  /** The frames worth keeping: newest per step, what the verdict was made on, and each pop-up's own. */
  readonly shots = new Map<string, Buffer>();
  /** Every event, kept in memory for the report. */
  readonly events: RunEvent[] = [];

  /** Never throws into the run: losing a log line must not fail a test. */
  write(event: RunEvent): void {
    const { screenshot, ...rest } = event;
    this.events.push(rest);
    const shot = event.shotId ?? event.stepId;
    if (screenshot && shot) this.shots.set(shot, screenshot);
    this.queue = this.queue
      .then(async () => {
        if (screenshot && shot) {
          // An agent's frames are JPEGs: a frame on disk is a PNG, as every reader of a run expects.
          await writeFile(join(this.dir, `${shot}.png`), await toPng(screenshot));
        }
        await appendFile(this.eventsPath, `${JSON.stringify(rest)}\n`);
      })
      .catch(() => undefined);
  }

  /** The one file worth sending someone, and any beside it. */
  async writeReport(html: string, name = "report.html"): Promise<string> {
    const path = join(this.dir, name);
    await writeFile(path, html);
    return path;
  }

  async close(result: TestResult, ledger: CostLedger): Promise<void> {
    await this.queue;
    await writeFile(
      join(this.dir, "result.json"),
      `${JSON.stringify({ ...result, calls: ledger.all(), usd: ledger.totalUsd() }, null, 2)}\n`,
    );
  }
}

/** A run's folder, read back: what it was, and its result once it has one. */
export interface KeptRun {
  dir: string;
  /** What run.json says: the test, its title, the device, the engine, when it started. */
  meta: Record<string, unknown>;
  /** The result, with the model calls and what they cost; absent while the run is going, or when it was stopped before its verdict. */
  result?: TestResult & { calls?: LedgerEntry[]; usd?: number };
  /** How many events were written: how far a run with no result got. */
  events: number;
  /** The last step that started. */
  lastStep?: string;
  /** The report, once there is one. */
  report?: string;
}

/** Reads a run's folder; one that is not a run's -- no run.json -- is said to be so. */
export async function readRun(dir: string): Promise<KeptRun> {
  const meta = JSON.parse(await readFile(join(dir, "run.json"), "utf8").catch(() => {
    throw new Error(`${dir} is not a run's folder: it has no run.json`);
  })) as Record<string, unknown>;
  const result = await readFile(join(dir, "result.json"), "utf8").then(
    (text) => JSON.parse(text) as KeptRun["result"],
    () => undefined,
  );
  const lines = (await readFile(join(dir, "events.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  let lastStep: string | undefined;
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Partial<RunEvent>;
      if (event.kind === "step_started" && event.stepId) lastStep = event.stepId;
    } catch {
      // A line cut short by a run killed mid-write is no event.
    }
  }
  const report = await stat(join(dir, "report.html")).then(() => join(dir, "report.html"), () => undefined);
  return { dir, meta, ...(result ? { result } : {}), events: lines.length, ...(lastStep ? { lastStep } : {}), ...(report ? { report } : {}) };
}

/** The newest run's folder under a root of runs: their names begin with when they started. */
export async function latestRun(root: string): Promise<string | undefined> {
  const names = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of names) {
    if (await stat(join(root, name, "run.json")).then(() => true, () => false)) return join(root, name);
  }
  return undefined;
}
