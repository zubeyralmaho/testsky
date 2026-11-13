/**
 * The phone's screen as it moves, for the page to show: Android's own
 * screenrecord, H.264 straight off the phone's encoder, cut into pictures
 * here and passed on as they come.
 *
 * A screenshot costs two to ten seconds on an emulator and most of a second
 * on a phone, so a polled screen shows what an instruction did long after it
 * did it. The encoder runs on the phone's media chip, sends a picture only
 * when the screen changes, and the page decodes it with WebCodecs. It is for
 * the person watching: a run never reads it. iOS has no such stream, and its
 * page polls screenshots as before.
 *
 * The page gets messages of [length, 4 bytes big-endian][kind, 1 byte]
 * [payload]: the codec's name once it is known, then pictures in Annex B,
 * start codes and all, a key picture first. So the page needs no H.264
 * parsing of its own, only the decoder.
 */

import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import type { ServerResponse } from "node:http";
import type { Readable } from "node:stream";

/** One picture's NAL units, in Annex B, and whether a decoder can start at it. */
export interface AccessUnit {
  key: boolean;
  data: Buffer;
}

/** Where the next start code begins at or after `from`, and where its NAL unit does. */
function startCodeAt(bytes: Buffer, from: number): { at: number; nal: number } | undefined {
  for (let index = Math.max(0, from); index + 2 < bytes.length; index += 1) {
    if (bytes[index] !== 0 || bytes[index + 1] !== 0) continue;
    if (bytes[index + 2] === 1) return { at: index > 0 && bytes[index - 1] === 0 ? index - 1 : index, nal: index + 3 };
  }
  return undefined;
}

const hex = (byte: number | undefined) => (byte ?? 0).toString(16).padStart(2, "0");

/** The WebCodecs name of the stream a sequence parameter set describes: avc1, profile, constraints, level. */
export function codecOf(sps: Buffer): string {
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

/**
 * Cuts an H.264 Annex B byte stream into pictures, however the bytes were
 * split on the way.
 *
 * A NAL unit ends where the next start code begins, so the last one in
 * hand is not known to be whole until more bytes come -- and on a screen
 * that has stopped changing, none do: the encoder sent its last picture and
 * fell silent. So when the stream goes quiet, `flush` takes what is in hand
 * as whole. The encoder writes a picture in one go, so a pause inside one is
 * rare; when it happens, the bytes after the pause do not start with a start
 * code, and `damaged` says the picture sent was cut short.
 */
export class AccessUnits {
  private pending: Buffer = Buffer.alloc(0);
  private unit: Buffer[] = [];
  private sliced = false;
  private key = false;
  /** Whatever was in hand went out at the last quiet: the next bytes must begin a NAL unit. */
  private flushed = false;
  /** The stream's codec, from the first sequence parameter set seen. */
  codec?: string;
  /** A picture already sent was cut short: a decoder must wait for the next key picture. */
  damaged = false;

  push(bytes: Buffer): AccessUnit[] {
    let data = this.pending.length ? Buffer.concat([this.pending, bytes]) : bytes;
    const out: AccessUnit[] = [];
    if (this.flushed) {
      // Too few bytes yet to tell a start code from the tail of a picture.
      if (data.length < 4) {
        this.pending = data;
        return out;
      }
      this.flushed = false;
      const first = startCodeAt(data, 0);
      if (!first || first.at !== 0) {
        this.damaged = true;
        if (!first) {
          this.pending = Buffer.alloc(0);
          return out;
        }
        data = data.subarray(first.at);
      }
    }
    let start = startCodeAt(data, 0);
    if (!start) {
      this.pending = data;
      return out;
    }
    for (;;) {
      const next = startCodeAt(data, start.nal);
      if (!next) break;
      this.nal(data.subarray(start.at, next.at), start.nal - start.at, out);
      start = next;
    }
    this.pending = data.subarray(start.at);
    return out;
  }

  /** The stream went quiet: what is in hand is whole, and so is the picture it ends. */
  flush(): AccessUnit[] {
    const out: AccessUnit[] = [];
    const start = startCodeAt(this.pending, 0);
    if (start && start.nal < this.pending.length) this.nal(this.pending.subarray(start.at), start.nal - start.at, out);
    this.pending = Buffer.alloc(0);
    if (this.sliced) this.close(out);
    this.flushed = true;
    return out;
  }

  private nal(nal: Buffer, header: number, out: AccessUnit[]): void {
    const type = (nal[header] ?? 0) & 0x1f;
    const slice = type === 1 || type === 5;
    // A slice whose first macroblock is 0 begins a picture: first_mb_in_slice
    // is the header's first exp-Golomb number, and 0 is the single bit 1.
    const begins = slice && ((nal[header + 1] ?? 0) & 0x80) !== 0;
    // After a picture's slices, a parameter set, a delimiter, an SEI or the
    // next picture's first slice starts the next picture.
    if (this.sliced && (begins || type === 6 || type === 7 || type === 8 || type === 9)) this.close(out);
    if (type === 7 && !this.codec) this.codec = codecOf(nal.subarray(header));
    this.unit.push(nal);
    if (slice) this.sliced = true;
    if (type === 5) this.key = true;
  }

  private close(out: AccessUnit[]): void {
    out.push({ key: this.key, data: Buffer.concat(this.unit) });
    this.unit = [];
    this.sliced = false;
    this.key = false;
  }
}

/** What a message to the page carries. */
export const MESSAGE = { picture: 0, keyPicture: 1, codec: 2 } as const;

/** A message to the page: its payload's length, its kind, its payload. */
export function messageOf(kind: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length, 0);
  head[4] = kind;
  return Buffer.concat([head, payload]);
}

/**
 * The size to ask the encoder for: the screen's shape, its long side 1280,
 * both sides a multiple of 16 -- what an AVC encoder takes on any phone, and
 * plenty for a picture a person watches at the side of a page.
 */
export function videoSize(screen: { width: number; height: number }, longest = 1280): { width: number; height: number } {
  const portrait = screen.height >= screen.width;
  const long = Math.max(screen.width, screen.height);
  const short = Math.max(16, Math.round((longest * Math.min(screen.width, screen.height)) / long / 16) * 16);
  return portrait ? { width: short, height: longest } : { width: longest, height: short };
}

/** The encoder, as the streamer needs it: its bytes, and a way to stop it. */
export interface Recorder {
  stdout: Readable;
  kill(): void;
  once(event: "close", listener: () => void): unknown;
}

/**
 * screenrecord on the phone, H.264 to its standard output, over adb. It stops
 * itself after three minutes.
 *
 * Stopping adb does not stop it: on a screen that is not changing it writes
 * nothing, so it never learns that nobody reads, and it holds the encoder
 * until its three minutes are up -- while the next one waits. So the shell
 * says its process id before it becomes screenrecord, and stopping kills that
 * process on the phone.
 */
export function recordH264(serial: string, video: { width: number; height: number }): Recorder {
  const command = `echo $$; exec screenrecord --output-format=h264 --bit-rate 4000000 --size ${video.width}x${video.height} -`;
  const child = spawn("adb", ["-s", serial, "exec-out", command], { stdio: ["ignore", "pipe", "ignore"] });
  const stdout = new PassThrough();
  let pid: string | undefined;
  let head = Buffer.alloc(0);
  child.stdout.on("data", (bytes: Buffer) => {
    if (pid !== undefined) {
      stdout.write(bytes);
      return;
    }
    head = Buffer.concat([head, bytes]);
    const line = head.indexOf(10);
    if (line < 0) return;
    pid = /^\d+$/.test(head.subarray(0, line).toString("latin1").trim()) ? head.subarray(0, line).toString("latin1").trim() : "";
    if (head.length > line + 1) stdout.write(head.subarray(line + 1));
  });
  child.stdout.once("end", () => stdout.end());
  // An adb that cannot start is an encoder that gave nothing.
  child.once("error", () => stdout.end());
  let killed = false;
  return {
    stdout,
    kill() {
      if (killed) return;
      killed = true;
      child.kill();
      if (pid) spawn("adb", ["-s", serial, "shell", "kill", pid], { stdio: "ignore" }).once("error", () => undefined);
    },
    once(_event, listener) {
      stdout.once("close", listener);
      return this;
    },
  };
}

export interface ScreenStreamOptions {
  serial: string;
  /** The screen as it is now, in points: the picture keeps its shape. */
  size: { width: number; height: number };
  record?: (serial: string, video: { width: number; height: number }) => Recorder;
  /** How long a silence makes the picture in hand whole. */
  quietMs?: number;
  /** An encoder that stops this soon, having sent nothing, failed to start. */
  failedWithinMs?: number;
}

/**
 * Streams the screen to one page until it goes away.
 *
 * A screen that is not changing sends nothing, at first too: the page shows
 * a screenshot until the first picture comes. The encoder is started again
 * whenever it stops -- after its three minutes, and at once when a picture
 * was cut short, for the key picture a decoder needs to start over -- unless
 * it twice stopped at once having sent nothing, as an encoder that cannot
 * start does. Then the stream ends, and the page polls.
 */
export function streamScreen(response: ServerResponse, options: ScreenStreamOptions): Promise<void> {
  const video = videoSize(options.size);
  const record = options.record ?? recordH264;
  const quietMs = options.quietMs ?? 60;
  const failedWithinMs = options.failedWithinMs ?? 5000;

  return new Promise<void>((resolve) => {
    let stopped = false;
    let recorder: Recorder | undefined;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let codec: string | undefined;
    let keyed = false;
    let failures = 0;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(quiet);
      recorder?.kill();
      if (!response.writableEnded) response.end();
      resolve();
    };

    const send = (units: AccessUnit[], named: string | undefined) => {
      if (stopped) return;
      if (named && named !== codec) {
        codec = named;
        response.write(messageOf(MESSAGE.codec, Buffer.from(codec)));
      }
      for (const unit of units) {
        // A decoder starts at a key picture: anything before the first one is of no use to it.
        if (!keyed && !unit.key) continue;
        keyed = true;
        response.write(messageOf(unit.key ? MESSAGE.keyPicture : MESSAGE.picture, unit.data));
      }
    };

    const start = () => {
      if (stopped) return;
      const units = new AccessUnits();
      const current = record(options.serial, video);
      const startedAt = Date.now();
      let sent = 0;
      recorder = current;
      current.stdout.on("data", (bytes: Buffer) => {
        sent += bytes.length;
        clearTimeout(quiet);
        send(units.push(bytes), units.codec);
        if (units.damaged) {
          current.kill();
          return;
        }
        quiet = setTimeout(() => send(units.flush(), units.codec), quietMs);
      });
      current.once("close", () => {
        clearTimeout(quiet);
        if (stopped || recorder !== current) return;
        if (!units.damaged) send(units.flush(), units.codec);
        failures = !sent && Date.now() - startedAt < failedWithinMs ? failures + 1 : 0;
        if (failures >= 2) return stop();
        start();
      });
    };

    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-video-width": String(video.width),
      "x-video-height": String(video.height),
    });
    response.flushHeaders();
    // The response's close, not the request's: a GET's request closes as soon as it has been read.
    response.once("close", stop);
    start();
  });
}
