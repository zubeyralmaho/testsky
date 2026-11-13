/**
 * A recording of the run, on the run's own clock.
 *
 * The point is not the video. Everyone in this category ships a video; the
 * universal complaint about all of them is that a failure is buried somewhere
 * in twenty unindexed minutes. What makes it useful is that the recording
 * starts at a known instant, every step event is stamped against that same
 * instant, and the report can therefore seek to the moment a step failed.
 *
 * So the one thing this module must get exactly right is `startedAt`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Recording {
  /** Epoch ms at which frame zero of the video was captured. */
  startedAt: number;
  /** Stops the recorder and returns the finished file, or null if it failed. */
  stop(): Promise<string | null>;
}

/** A recorder that records nothing, for platforms or runs that cannot. */
export const NO_RECORDING: Recording = { startedAt: Date.now(), stop: async () => null };

/**
 * A recorder that stops itself.
 *
 * `simctl io recordVideo` records until it is told to stop, and nothing tells
 * it when the process that started it dies: a run killed mid-way, a crash, a
 * closed terminal. Three such recorders were found still writing after three
 * weeks, fourteen gigabytes between them, on a disk that was then full. So the
 * recorder runs under a shell that stops it after `maxSeconds` whatever
 * happens to us, and passes on an interrupt or a hang-up when we stop it.
 */
export function selfLimiting(command: string, args: string[], maxSeconds: number): ChildProcess {
  // The recorder takes the shell's place, so an interrupt sent to the child
  // is the recorder's own -- a shell runs its background jobs deaf to one.
  // The timer beside it outlives us and goes when the recorder goes; before
  // it interrupts anything it checks the process is still this recorder,
  // because a process number can be reused.
  const seconds = Math.max(1, Math.ceil(maxSeconds));
  const script =
    `( i=0; while [ $i -lt ${seconds} ] && kill -0 $$ 2>/dev/null; do sleep 1; i=$((i+1)); done; ` +
    `[ $i -ge ${seconds} ] && ps -p $$ -o command= | grep -qF -- "$TESTSKY_RECORDING" && kill -INT $$ ) >/dev/null 2>&1 &\n` +
    `exec "$@"`;
  return spawn("/bin/sh", ["-c", script, "recorder", command, ...args], {
    stdio: "ignore",
    env: { ...process.env, TESTSKY_RECORDING: args.at(-1) ?? command },
  });
}

/** Stops a recorder once however often it is asked, and waits for it to finish its file. */
function stopper(child: ChildProcess, finish: () => Promise<string | null>): () => Promise<string | null> {
  let stopping: Promise<string | null> | undefined;
  return () => {
    stopping ??= (async () => {
      // SIGINT, not SIGTERM: simctl finalises the container on an interrupt
      // and leaves an unplayable file on anything harsher.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGINT");
        await new Promise((resolve) => {
          child.once("exit", resolve);
          setTimeout(resolve, 5000);
        });
      }
      return finish();
    })();
    return stopping;
  };
}

export async function recordIosSimulator(udid: string, outPath: string, maxSeconds = 30 * 60): Promise<Recording> {
  const child = selfLimiting("xcrun", ["simctl", "io", udid, "recordVideo", "--codec", "h264", "--force", outPath], maxSeconds);
  // simctl takes a moment to open the file; frame zero is close enough to now.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const startedAt = Date.now();
  return { startedAt, stop: stopper(child, async () => outPath) };
}

/**
 * Android's own screen recorder.
 *
 * `screenrecord` caps at three minutes and writes to the device, so the file
 * is pulled afterwards. scrcpy would stream instead and lift the cap; it is
 * worth doing when a customer's suite has runs that long, and not before.
 */
export async function recordAndroid(serial: string, outPath: string): Promise<Recording> {
  const devicePath = `/sdcard/testsky-${Date.now()}.mp4`;
  const child: ChildProcess = spawn(
    "adb",
    ["-s", serial, "shell", "screenrecord", "--bit-rate", "4M", "--time-limit", "180", devicePath],
    { stdio: "ignore" },
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  const startedAt = Date.now();

  return {
    startedAt,
    // screenrecord stops itself at its time limit, on the phone, whatever
    // happens here; stopping it is only stopping it sooner.
    stop: stopper(child, async () => {
      // screenrecord flushes its moov atom on exit; pulling too early gives a
      // file no player will open.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      try {
        await run("adb", ["-s", serial, "pull", devicePath, outPath]);
        await run("adb", ["-s", serial, "shell", "rm", devicePath]).catch(() => undefined);
        return outPath;
      } catch {
        return null;
      }
    }),
  };
}

/**
 * Makes the recording small enough to send someone.
 *
 * A phone records at its own resolution and bitrate: thirty-four seconds of an
 * iPhone simulator came out at 14.5 MB, which becomes a 21 MB report once it
 * is inlined -- for a run that short. Scaled to 720p at a low bitrate the
 * picture is still perfectly readable, because what a reviewer needs from it
 * is which screen was up and what moved, not the colour of a gradient.
 *
 * ffmpeg is optional: without it the original file is used and the report
 * simply comes out larger, rather than the run failing over a nicety.
 */
export async function compressVideo(inPath: string, outPath: string): Promise<string> {
  try {
    await run("ffmpeg", [
      "-y",
      "-i",
      inPath,
      "-vf",
      "scale=-2:720",
      "-c:v",
      "libx264",
      "-crf",
      "30",
      "-preset",
      "veryfast",
      "-movflags",
      "+faststart",
      "-an",
      outPath,
    ]);
    return outPath;
  } catch {
    return inPath;
  }
}
