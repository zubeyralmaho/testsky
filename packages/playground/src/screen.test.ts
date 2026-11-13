import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { DeviceHandle, Engine } from "@testsky/engine-core";
import { CostLedger } from "@testsky/router";

import { AccessUnits, type AccessUnit, codecOf, MESSAGE, messageOf, type Recorder, streamScreen, videoSize } from "./screen.ts";
import { startPlayground } from "./server.ts";

// NAL units as screenrecord sends them: a 4-byte start code, a header byte, a body free of start codes.
const nal = (header: number, ...body: number[]) => Buffer.from([0, 0, 0, 1, header, ...body]);
const SPS = nal(0x67, 0x42, 0xc0, 0x29, 0x8d, 0x68, 0x08, 0x80);
const PPS = nal(0x68, 0xce, 0x3c, 0x80);
const IDR = nal(0x65, 0x88, 0x84, 0x21, 0x7f, 0x3e);
// A picture's first slice has first_mb_in_slice 0: the byte after the header starts with a 1 bit.
const P1 = nal(0x41, 0x9a, 0x11, 0x22);
const P2 = nal(0x41, 0x9a, 0x33, 0x44);
const P2_SECOND_SLICE = nal(0x41, 0x5a, 0x55, 0x66);

const units = (list: AccessUnit[]) => list.map((unit) => ({ key: unit.key, data: [...unit.data] }));
const picture = (key: boolean, ...parts: Buffer[]) => ({ key, data: [...Buffer.concat(parts)] });

test("a stream is cut into pictures: the parameter sets go with the key picture they start", () => {
  const cutter = new AccessUnits();
  const got = [...cutter.push(Buffer.concat([SPS, PPS, IDR, P1, P2])), ...cutter.flush()];
  assert.deepEqual(units(got), [picture(true, SPS, PPS, IDR), picture(false, P1), picture(false, P2)]);
  assert.equal(cutter.codec, "avc1.42c029");
});

test("however the bytes were split on the way", () => {
  const stream = Buffer.concat([SPS, PPS, IDR, P1, P2, P2_SECOND_SLICE]);
  const cutter = new AccessUnits();
  const got: AccessUnit[] = [];
  for (const byte of stream) got.push(...cutter.push(Buffer.from([byte])));
  got.push(...cutter.flush());
  assert.deepEqual(units(got), [picture(true, SPS, PPS, IDR), picture(false, P1), picture(false, P2, P2_SECOND_SLICE)], "two slices of one picture are one picture");
  assert.equal(cutter.damaged, false);
});

test("a screen that stopped changing is shown: the picture in hand goes out when the stream goes quiet", () => {
  const cutter = new AccessUnits();
  assert.deepEqual(cutter.push(Buffer.concat([SPS, PPS, IDR])), [], "the last NAL unit is not known to be whole yet");
  assert.deepEqual(units(cutter.flush()), [picture(true, SPS, PPS, IDR)]);
  assert.deepEqual(cutter.flush(), [], "and only once");
  assert.deepEqual(units([...cutter.push(P1), ...cutter.flush()]), [picture(false, P1)], "the next change starts a picture of its own");
  assert.equal(cutter.damaged, false);
});

test("a start code split across the pause is no damage", () => {
  const cutter = new AccessUnits();
  cutter.push(Buffer.concat([SPS, PPS, IDR]));
  cutter.flush();
  assert.deepEqual(cutter.push(P1.subarray(0, 2)), []);
  assert.deepEqual(units([...cutter.push(P1.subarray(2)), ...cutter.flush()]), [picture(false, P1)]);
  assert.equal(cutter.damaged, false);
});

test("a picture cut short by a pause is damage, and the stream takes up again at the next start code", () => {
  const cutter = new AccessUnits();
  const cut = 7;
  cutter.push(Buffer.concat([SPS, PPS, IDR.subarray(0, cut)]));
  assert.deepEqual(units(cutter.flush()), [picture(true, SPS, PPS, IDR.subarray(0, cut))], "it went out as whole: nothing said otherwise");
  assert.deepEqual(units([...cutter.push(Buffer.concat([IDR.subarray(cut), P1])), ...cutter.flush()]), [picture(false, P1)]);
  assert.equal(cutter.damaged, true, "the rest of the key picture came after it was sent");
});

test("the codec is named from the sequence parameter set", () => {
  assert.equal(codecOf(Buffer.from([0x67, 0x64, 0x00, 0x1f])), "avc1.64001f");
});

test("the encoder is asked for the screen's shape, its long side 1280, both sides a multiple of 16", () => {
  assert.deepEqual(videoSize({ width: 411, height: 914 }), { width: 576, height: 1280 });
  assert.deepEqual(videoSize({ width: 914, height: 411 }), { width: 1280, height: 576 });
  assert.deepEqual(videoSize({ width: 390, height: 844 }), { width: 592, height: 1280 });
  assert.deepEqual(videoSize({ width: 10, height: 2000 }), { width: 16, height: 1280 });
});

test("a message to the page is its payload's length, its kind and its payload", () => {
  assert.deepEqual([...messageOf(MESSAGE.keyPicture, Buffer.from([9, 8, 7]))], [0, 0, 0, 3, 1, 9, 8, 7]);
  assert.deepEqual([...messageOf(MESSAGE.codec, Buffer.from("avc1"))].slice(0, 5), [0, 0, 0, 4, 2]);
});

// ── The stream, end to end over HTTP ─────────────────────────────────────────

interface FakeRecorder extends Recorder {
  stdout: PassThrough;
  killed: boolean;
  close(): void;
}

function fakeRecorder(): FakeRecorder {
  const stdout = new PassThrough();
  const listeners: (() => void)[] = [];
  const recorder: FakeRecorder = {
    stdout,
    killed: false,
    kill() {
      if (recorder.killed) return;
      recorder.killed = true;
      recorder.close();
    },
    close() {
      stdout.end();
      for (const listener of listeners.splice(0)) setImmediate(listener);
    },
    once(_event, listener) {
      listeners.push(listener);
      return recorder;
    },
  };
  return recorder;
}

/** Serves one stream; `onRecorder` hears of every encoder the stream starts. */
async function serve(options: { quietMs?: number; onRecorder: (recorder: FakeRecorder, count: number) => void }) {
  const recorders: FakeRecorder[] = [];
  let finished = 0;
  const server = createServer((_request, response) => {
    void streamScreen(response, {
      serial: "emulator-5554",
      size: { width: 411, height: 914 },
      quietMs: options.quietMs ?? 20,
      record: () => {
        const recorder = fakeRecorder();
        recorders.push(recorder);
        setImmediate(() => options.onRecorder(recorder, recorders.length));
        return recorder;
      },
    }).then(() => {
      finished += 1;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return { url, recorders, finished: () => finished, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

type Message = { kind: number; data: number[] } | { kind: "codec"; codec: string };

/** Reads messages off a response until `count` have come, or it ends. */
async function messages(response: Response, count = Number.POSITIVE_INFINITY): Promise<Message[]> {
  const reader = response.body!.getReader();
  let buffer = Buffer.alloc(0);
  const out: Message[] = [];
  while (out.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer = Buffer.concat([buffer, Buffer.from(value)]);
    while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(0)) {
      const length = buffer.readUInt32BE(0);
      const payload = buffer.subarray(5, 5 + length);
      out.push(buffer[4] === MESSAGE.codec ? { kind: "codec", codec: payload.toString() } : { kind: buffer[4]!, data: [...payload] });
      buffer = buffer.subarray(5 + length);
    }
  }
  await reader.cancel();
  return out;
}

const key = (...parts: Buffer[]) => ({ kind: MESSAGE.keyPicture, data: [...Buffer.concat(parts)] });
const delta = (...parts: Buffer[]) => ({ kind: MESSAGE.picture, data: [...Buffer.concat(parts)] });
const CODEC = { kind: "codec" as const, codec: "avc1.42c029" };

const until = async (check: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("the page gets the size at once, then the codec and the pictures, a still screen's included", async () => {
  const served = await serve({
    onRecorder: (recorder) => {
      recorder.stdout.write(Buffer.concat([SPS, PPS, IDR]));
      setTimeout(() => recorder.stdout.write(P1), 60);
    },
  });
  try {
    const response = await fetch(served.url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-video-width"), "576");
    assert.equal(response.headers.get("x-video-height"), "1280");
    assert.deepEqual(await messages(response, 3), [CODEC, key(SPS, PPS, IDR), delta(P1)]);
    await until(() => served.recorders[0]!.killed);
  } finally {
    await served.close();
  }
});

test("a screen that does not change sends nothing, and the stream waits rather than giving up", async () => {
  const served = await serve({ onRecorder: () => {} });
  try {
    const controller = new AbortController();
    const response = await fetch(served.url, { signal: controller.signal });
    assert.equal(response.status, 200, "the headers come before any picture");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(served.finished(), 0);
    controller.abort();
    await until(() => served.recorders[0]!.killed && served.finished() === 1);
  } finally {
    await served.close();
  }
});

test("an encoder that stops is started again, and one that cut a picture short is restarted for a key picture", async () => {
  const served = await serve({
    onRecorder: (recorder, count) => {
      if (count === 1) {
        recorder.stdout.write(Buffer.concat([SPS, PPS, IDR]));
        setTimeout(() => recorder.close(), 50); // its three minutes are up
      } else if (count === 2) {
        recorder.stdout.write(Buffer.concat([SPS, PPS, IDR.subarray(0, 7)]));
        setTimeout(() => recorder.stdout.write(Buffer.concat([IDR.subarray(7), P1])), 60);
      } else {
        recorder.stdout.write(Buffer.concat([SPS, PPS, IDR]));
      }
    },
  });
  try {
    const response = await fetch(served.url);
    assert.deepEqual(await messages(response, 4), [
      CODEC,
      key(SPS, PPS, IDR),
      key(SPS, PPS, IDR.subarray(0, 7)),
      key(SPS, PPS, IDR),
    ], "the cut picture went out before anything said it was short; the restarted encoder's key picture follows, and the codec is said once");
    assert.equal(served.recorders[1]!.killed, true);
    assert.equal(served.recorders.length, 3);
  } finally {
    await served.close();
  }
});

test("an encoder that cannot start ends the stream, and the page polls", async () => {
  const served = await serve({ onRecorder: (recorder) => recorder.close() });
  try {
    const response = await fetch(served.url);
    assert.equal(response.status, 200);
    assert.deepEqual(await messages(response), []);
    assert.equal(served.recorders.length, 2, "tried twice, then left alone");
  } finally {
    await served.close();
  }
});

test("closing the playground ends the streams it serves, and stops the phone's encoders", async () => {
  const recorders: FakeRecorder[] = [];
  const device: DeviceHandle = { id: "emulator-5554", platform: "android", osVersion: "15", kind: "emulator", size: { width: 411, height: 914 } };
  const playground = await startPlayground({
    engine: { name: "fake", capabilities: { tree: false } } as unknown as Engine,
    device,
    ledger: new CostLedger(),
    page: "<html></html>",
    port: 0,
    record: () => {
      const recorder = fakeRecorder();
      recorders.push(recorder);
      setImmediate(() => recorder.stdout.write(Buffer.concat([SPS, PPS, IDR])));
      return recorder;
    },
  });
  const response = await fetch(`${playground.url}/api/screen`);
  const reading = messages(response, 2).catch(() => []);
  await until(() => recorders.length === 1);
  await playground.close();
  assert.equal(recorders[0]!.killed, true);
  await reading;
});

test("an iPhone's screen is not streamed", async () => {
  const device: DeviceHandle = { id: "5F3C1A90", platform: "ios", osVersion: "18.1", kind: "simulator", size: { width: 402, height: 874 } };
  const playground = await startPlayground({
    engine: { name: "fake", capabilities: { tree: false } } as unknown as Engine,
    device,
    ledger: new CostLedger(),
    page: "<html></html>",
    port: 0,
  });
  try {
    const status = (await (await fetch(`${playground.url}/api/status`)).json()) as { live: boolean };
    assert.equal(status.live, false);
    assert.equal((await fetch(`${playground.url}/api/screen`)).status, 404);
  } finally {
    await playground.close();
  }
});
