/**
 * The app's own device log, on the run's clock.
 *
 * What the app said while a step failed is often the whole diagnosis -- an
 * exception, a refused request, a permission it never got -- and a
 * screenshot of the error dialog says none of it. Only the app under test is
 * read: a device logs thousands of lines a minute, and a report that holds
 * the system's chatter holds nobody's attention.
 *
 * The log is read once the run is over, for the run's own window, rather than
 * streamed while it goes. A streamed log reaches a pipe in blocks, and a
 * stopped stream drops the block it had not written yet -- the last seconds
 * before a failure, the ones a report is read for: stopped 300ms after an app
 * opened, `log stream` had handed over nothing, where `log show` had it all.
 */

import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import type { LogStream } from "@testsky/engine-core";

const run = promisify(execFile);

export interface LogLine {
  at: number;
  text: string;
}

/** A line longer than this is a payload dump, and the start of it says what it was. */
const TEXT_LIMIT = 500;
/** A log that has not been read out by then is not worth holding the report up for. */
const READ_LIMIT_MS = 30_000;
/** Lines from the second before the log was opened still belong to the run: a launch is quick. */
const LEAD_MS = 1000;

/** Lines as they arrive, handed out in order to the one reader, until closed. */
export class LineQueue {
  private readonly buffer: LogLine[] = [];
  private wake: (() => void) | undefined;
  private ended = false;

  push(line: LogLine): void {
    if (this.ended) return;
    this.buffer.push(line);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *lines(): AsyncGenerator<LogLine> {
    for (;;) {
      const next = this.buffer.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }
}

/** Every line a command prints, as it prints it; stopped if it takes too long. */
async function eachLine(command: string, args: string[], onLine: (raw: string) => void): Promise<void> {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
  const reader = createInterface({ input: child.stdout! });
  reader.on("line", onLine);
  const late = setTimeout(() => child.kill("SIGKILL"), READ_LIMIT_MS);
  await new Promise<void>((resolve) => {
    reader.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  clearTimeout(late);
}

/** Read once, however many times the caller closes. */
export function readOnClose(read: () => Promise<void>, queue: LineQueue): LogStream {
  let closing: Promise<void> | undefined;
  return {
    lines: () => queue.lines(),
    close: () =>
      (closing ??= read()
        .catch(() => undefined)
        .finally(() => queue.end())),
  };
}

/** "2026-09-25 20:14:32.815860+0300", as `log show` writes it. */
function appleTime(stamp: string): number {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.(\d{3})\d*([+-]\d{2})(\d{2})$/.exec(stamp);
  return match ? Date.parse(`${match[1]}T${match[2]}.${match[3]}${match[4]}:${match[5]}`) : Number.NaN;
}

/** "2026-09-25 20:14:31", this machine's local time, as `log show --start` reads it. */
function localSecond(epoch: number): string {
  const date = new Date(epoch);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/**
 * One line of `log show --style ndjson`, or nothing when it is not worth a
 * reader's time. The app's own lines are kept, and every error and fault;
 * the frameworks' ordinary chatter, which is most of what a process logs, is
 * not -- six seconds of Settings opening are 2,700 lines, and 33 of these.
 */
export function iosLogLine(raw: string): LogLine | undefined {
  // What the tool says on the way, and the count it closes with.
  if (!raw.startsWith("{")) return undefined;
  let entry: { eventType?: string; messageType?: string; subsystem?: string; eventMessage?: string; timestamp?: string };
  try {
    entry = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (entry.eventType !== "logEvent" || !entry.timestamp) return undefined;
  const serious = entry.messageType === "Error" || entry.messageType === "Fault";
  if (!serious && entry.messageType !== "Default") return undefined;
  const subsystem = entry.subsystem ?? "";
  if (!serious && subsystem.startsWith("com.apple.")) return undefined;
  const at = appleTime(entry.timestamp);
  if (Number.isNaN(at)) return undefined;
  const level = serious ? `${entry.messageType!.toLowerCase()}: ` : "";
  return { at, text: `${level}${subsystem ? `[${subsystem}] ` : ""}${entry.eventMessage ?? ""}`.slice(0, TEXT_LIMIT) };
}

/**
 * A simulator's log for one process, from when this was opened until it is
 * closed. A simulator shares this machine's clock, so its timestamps are
 * already the run's.
 */
export function iosLogStream(udid: string, processName: string): LogStream {
  const queue = new LineQueue();
  const since = Date.now() - LEAD_MS;
  const predicate = `process == "${processName.replace(/["\\]/g, "\\$&")}"`;
  return readOnClose(
    () =>
      eachLine(
        "xcrun",
        ["simctl", "spawn", udid, "log", "show", "--style", "ndjson", "--start", localSecond(since), "--predicate", predicate],
        (raw) => {
          const line = iosLogLine(raw);
          // --start is to the second; the run began within it.
          if (line && line.at >= since) queue.push(line);
        },
      ),
    queue,
  );
}

/** "1695657662.123456  1234  1250 I Tag: message", as `logcat -v epoch` writes it. */
export function logcatLine(raw: string): (LogLine & { pid: number }) | undefined {
  const match = /^\s*(\d+)\.(\d+)\s+(\d+)\s+\d+\s+([VDIWEFA])\s+(.*?)\s*: (.*)$/.exec(raw);
  if (!match) return undefined;
  const at = Number(match[1]) * 1000 + Math.floor(Number(`0.${match[2]}`) * 1000);
  return { at, pid: Number(match[3]), text: `${match[4]} ${match[5]}: ${match[6]}`.slice(0, TEXT_LIMIT) };
}

/**
 * How far a phone's clock is from this machine's, measured once. Half the
 * round trip is the error, which is a few milliseconds over USB; without
 * EPOCHREALTIME in the device's shell it falls back to whole seconds.
 */
async function clockOffset(serial: string): Promise<number> {
  const ask = async (command: string) => {
    const before = Date.now();
    const { stdout } = await run("adb", ["-s", serial, "shell", command]).catch(() => ({ stdout: "" }));
    return { device: Number(stdout.trim()), host: (before + Date.now()) / 2 };
  };
  const precise = await ask("echo $EPOCHREALTIME");
  if (Number.isFinite(precise.device) && precise.device > 0) return Math.round(precise.host - precise.device * 1000);
  const coarse = await ask("date +%s");
  if (Number.isFinite(coarse.device) && coarse.device > 0) return Math.round(coarse.host - coarse.device * 1000);
  return 0;
}

/**
 * A phone's log for one app, from when this was opened until it is closed.
 * A phone keeps its own clock, so its timestamps are moved onto this
 * machine's by the offset measured on opening. An app that restarts -- or
 * crashes -- is a new process, gone by the end: its ids are looked up every
 * two seconds while the run goes, not only once it is over.
 *
 * Read from the phone's log buffer, which holds the last few minutes of a
 * busy device; a longer run keeps its end, which is the part that matters.
 */
export async function androidLogStream(serial: string, packageName: string): Promise<LogStream> {
  const offset = await clockOffset(serial);
  const since = Date.now() - LEAD_MS;
  const pids = new Set<number>();
  const lookup = async () => {
    const { stdout } = await run("adb", ["-s", serial, "shell", "pidof", packageName]).catch(() => ({ stdout: "" }));
    for (const pid of stdout.trim().split(/\s+/).filter(Boolean)) pids.add(Number(pid));
  };
  await lookup();
  const timer = setInterval(() => void lookup(), 2000);

  const queue = new LineQueue();
  return readOnClose(async () => {
    clearInterval(timer);
    await lookup();
    // -d: what the buffer holds, then exit; -T: from the phone's own moment of opening.
    const from = ((since - offset) / 1000).toFixed(3);
    await eachLine("adb", ["-s", serial, "logcat", "-d", "-v", "epoch", "-T", from], (raw) => {
      const line = logcatLine(raw);
      if (!line || !pids.has(line.pid)) return;
      const at = line.at + offset;
      if (at >= since) queue.push({ at, text: line.text });
    });
  }, queue);
}
