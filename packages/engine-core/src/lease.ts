/**
 * One holder at a time, across processes.
 *
 * A phone runs one test at a time and a memory file takes one writer at a
 * time. Once runs go to several phones at once, "at a time" has to hold across
 * processes, and a process that dies holding something must not hold it for
 * ever. So a lease is a file created exclusively, naming the process that
 * holds it, and one whose process is gone is taken over.
 *
 * Not `flock`: Node has no binding for it, and as a command it does not exist
 * on these Macs -- where a missing lock command fails open, silently.
 */

import { execFile } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { DeviceHandle } from "./types.ts";

const exec = promisify(execFile);

/** Where testsky keeps what outlives a run: ~/.testsky, unless TESTSKY_HOME says elsewhere. */
export function testskyHome(): string {
  return process.env.TESTSKY_HOME ?? join(homedir(), ".testsky");
}

export interface LeaseHolder {
  pid: number;
  host: string;
  /** When the holding process started: a later process given the same pid is not the holder. */
  started: number;
  /** When the lease was taken, as ISO time. */
  since: string;
  /** What it is held for, in a person's words: "run wifi-connect". */
  what?: string;
}

export interface Lease {
  path: string;
  holder: LeaseHolder;
  release(): Promise<void>;
}

/** Held by somebody else -- who, when the file says so. */
export type LeaseAttempt = { lease: Lease } | { busy: LeaseHolder | undefined };

/** This process's start, as the clock had it. */
const STARTED = Math.round(Date.now() - process.uptime() * 1000);
/** A lease younger than this with nothing readable in it is being written, not abandoned. */
const WRITING_MS = 5_000;
/** A takeover guard older than this was left by a process that died in the middle of one. */
const GUARD_MS = 10_000;
/** How far a process's start, as `ps` tells it to the second, may be from the one it wrote. */
const START_SLACK_MS = 3_000;
const ATTEMPTS = 5;

const held = new Map<string, LeaseHolder>();
let hooked = false;

export async function acquireLease(path: string, what?: string): Promise<LeaseAttempt> {
  await mkdir(dirname(path), { recursive: true });
  const mine: LeaseHolder = {
    pid: process.pid,
    host: hostname(),
    started: STARTED,
    since: new Date().toISOString(),
    ...(what ? { what } : {}),
  };
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (await create(path, mine)) return { lease: taken(path, mine) };
    const holder = await holderOf(path);
    // Let go of between the two looks: try again.
    if (holder === "gone") continue;
    if (holder !== "stale") return { busy: holder === "writing" ? undefined : holder };
    // Taken over under a guard, so two processes that both found it stale do
    // not both end up holding it.
    if (!(await guard(path))) {
      await sleep(20);
      continue;
    }
    try {
      const again = await holderOf(path);
      if (again !== "stale" && again !== "gone") return { busy: again === "writing" ? undefined : again };
      await unlink(path).catch(() => undefined);
      if (await create(path, mine)) return { lease: taken(path, mine) };
    } finally {
      await rmdir(`${path}.takeover`).catch(() => undefined);
    }
  }
  const last = await holderOf(path);
  return { busy: typeof last === "object" ? last : undefined };
}

/** `fn`, while holding the lease at `path`; waits for a holder that lets go soon. */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, options: { timeoutMs?: number; what?: string } = {}): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  for (;;) {
    const attempt = await acquireLease(path, options.what);
    if ("lease" in attempt) {
      try {
        return await fn();
      } finally {
        await attempt.lease.release();
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`${path} stayed held${attempt.busy ? ` by ${describeHolder(attempt.busy)}` : ""}`);
    }
    await sleep(15 + Math.random() * 35);
  }
}

/** Who holds a lease now, without taking it; nobody when it is free or its holder is gone. */
export async function leaseHolder(path: string): Promise<LeaseHolder | undefined> {
  const holder = await holderOf(path).catch(() => "gone" as const);
  return typeof holder === "object" ? holder : undefined;
}

/** Where the lease that says a phone is in use is kept: by its own serial when it is known. */
export function deviceLeasePath(device: Pick<DeviceHandle, "platform" | "id" | "serial">, home = testskyHome()): string {
  return join(home, "devices", `${device.platform}-${(device.serial ?? device.id).replace(/[^A-Za-z0-9._-]+/g, "_")}.lease`);
}

/** A phone to this process alone, until released or until the process is gone. */
export function leaseDevice(device: Pick<DeviceHandle, "platform" | "id" | "serial">, what?: string, home?: string): Promise<LeaseAttempt> {
  return acquireLease(deviceLeasePath(device, home), what);
}

export function describeHolder(holder: LeaseHolder): string {
  const since = new Date(holder.since);
  const at = Number.isNaN(since.getTime())
    ? holder.since
    : since.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const where = holder.host === hostname() ? "" : ` on ${holder.host}`;
  return `testsky (pid ${holder.pid}${where}) since ${at}${holder.what ? `, for ${holder.what}` : ""}`;
}

async function create(path: string, holder: LeaseHolder): Promise<boolean> {
  try {
    await writeFile(path, `${JSON.stringify(holder)}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function holderOf(path: string): Promise<LeaseHolder | "gone" | "stale" | "writing"> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw error;
  }
  const holder = parseHolder(text);
  if (!holder) {
    const age = await stat(path).then((info) => Date.now() - info.mtimeMs, () => undefined);
    if (age === undefined) return "gone";
    return age < WRITING_MS ? "writing" : "stale";
  }
  return (await alive(holder)) ? holder : "stale";
}

function parseHolder(text: string): LeaseHolder | undefined {
  try {
    const raw = JSON.parse(text) as Partial<LeaseHolder>;
    if (typeof raw.pid !== "number" || typeof raw.host !== "string" || typeof raw.started !== "number" || typeof raw.since !== "string") {
      return undefined;
    }
    return { pid: raw.pid, host: raw.host, started: raw.started, since: raw.since, ...(typeof raw.what === "string" ? { what: raw.what } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * Whether the process a lease names still holds it. Every holder is judged
 * as a process on this machine, whatever the machine was called when it
 * wrote the lease: testsky's home is local, and a Mac's name changes with its
 * network -- a lease that waited for a host of another name never let go.
 */
async function alive(holder: LeaseHolder): Promise<boolean> {
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    // EPERM is somebody else's process, alive.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  const started = await startOf(holder.pid);
  return started === undefined || Math.abs(started - holder.started) <= START_SLACK_MS;
}

/**
 * When a process started, to the second; unknown when `ps` cannot say.
 * Worked out from how long it has run, not from the date `ps` prints: that
 * date is local time, and the hour that repeats when the clocks go back
 * would have made a live run's lease look like a dead one's.
 */
async function startOf(pid: number): Promise<number | undefined> {
  if (pid === process.pid) return STARTED;
  try {
    const { stdout } = await exec("ps", ["-o", "etime=", "-p", String(pid)], { timeout: 5_000 });
    const seconds = elapsed(stdout);
    return seconds === undefined ? undefined : Date.now() - seconds * 1000;
  } catch {
    return undefined;
  }
}

/** `ps`'s elapsed time, [[days-]hours:]minutes:seconds, in seconds. */
export function elapsed(text: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

async function guard(path: string): Promise<boolean> {
  const dir = `${path}.takeover`;
  try {
    await mkdir(dir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const age = await stat(dir).then((info) => Date.now() - info.mtimeMs, () => 0);
  if (age > GUARD_MS) await rmdir(dir).catch(() => undefined);
  return false;
}

function taken(path: string, holder: LeaseHolder): Lease {
  held.set(path, holder);
  if (!hooked) {
    hooked = true;
    // A run that exits on a signal or an error still lets go: the next run
    // should not have to wait to find out that this one is gone.
    process.once("exit", releaseAll);
  }
  return {
    path,
    holder,
    release: async () => {
      if (held.get(path) !== holder) return;
      held.delete(path);
      if (isHolder(await readFile(path, "utf8").catch(() => ""), holder)) await unlink(path).catch(() => undefined);
    },
  };
}

function releaseAll(): void {
  for (const [path, holder] of held) {
    try {
      if (isHolder(readFileSync(path, "utf8"), holder)) unlinkSync(path);
    } catch {
      // Gone already.
    }
  }
  held.clear();
}

function isHolder(text: string, holder: LeaseHolder): boolean {
  const on = parseHolder(text);
  return !!on && on.pid === holder.pid && on.started === holder.started && on.since === holder.since;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
