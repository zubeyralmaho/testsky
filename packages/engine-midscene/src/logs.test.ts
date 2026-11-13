import assert from "node:assert/strict";
import test from "node:test";

import { LineQueue, iosLogLine, logcatLine, readOnClose } from "./logs.ts";

// Lines as a simulator wrote them, opening Settings: trimmed to what is read.
const APPLE_CHATTER = JSON.stringify({
  eventType: "logEvent",
  messageType: "Default",
  subsystem: "com.apple.containermanager",
  eventMessage: "Requesting container lookup; class = 13, identifier = (null)",
  timestamp: "2026-09-25 20:14:29.748782+0300",
});
const APPLE_ERROR = JSON.stringify({
  eventType: "logEvent",
  messageType: "Error",
  subsystem: "com.apple.Settings",
  eventMessage: "Failed to process records: 'Yardımcı uygulamayla iletişim kurulamadı.'",
  timestamp: "2026-09-25 20:14:30.195210+0300",
});
const OWN = JSON.stringify({
  eventType: "logEvent",
  messageType: "Default",
  subsystem: "",
  eventMessage: "No persisted cache on this platform.",
  timestamp: "2026-09-25 20:14:29.832343+0300",
});
const ACTIVITY = JSON.stringify({
  eventType: "activityCreateEvent",
  subsystem: "",
  eventMessage: "container_system_group_path_for_identifier",
  timestamp: "2026-09-25 20:14:29.748497+0300",
});

test("a simulator's log keeps the app's own lines and every error, not the frameworks' chatter", () => {
  assert.equal(iosLogLine(APPLE_CHATTER), undefined);
  assert.equal(iosLogLine(ACTIVITY), undefined);
  assert.equal(iosLogLine('Filtering the log data using "process == "Preferences""'), undefined);
  assert.deepEqual(iosLogLine(OWN), { at: Date.parse("2026-09-25T20:14:29.832+03:00"), text: "No persisted cache on this platform." });
  assert.deepEqual(iosLogLine(APPLE_ERROR), {
    at: Date.parse("2026-09-25T20:14:30.195+03:00"),
    text: "error: [com.apple.Settings] Failed to process records: 'Yardımcı uygulamayla iletişim kurulamadı.'",
  });
});

test("a line that is a payload dump is cut, not dropped", () => {
  const long = JSON.stringify({ ...JSON.parse(OWN), eventMessage: "x".repeat(2000) });
  assert.equal(iosLogLine(long)?.text.length, 500);
});

test("a phone's log line is read with its process, on the phone's own clock", () => {
  assert.deepEqual(logcatLine("  1695657662.123456  4211  4230 E AndroidRuntime: FATAL EXCEPTION: main"), {
    at: 1695657662123,
    pid: 4211,
    text: "E AndroidRuntime: FATAL EXCEPTION: main",
  });
  assert.deepEqual(logcatLine("1695657662.500000  4211  4211 I okhttp.OkHttpClient: <-- 401 https://api.acme.test/cart"), {
    at: 1695657662500,
    pid: 4211,
    text: "I okhttp.OkHttpClient: <-- 401 https://api.acme.test/cart",
  });
  assert.equal(logcatLine("--------- beginning of main"), undefined);
});

test("a log is read once, however many times it is closed, and a failed read still ends it", async () => {
  const queue = new LineQueue();
  let reads = 0;
  const stream = readOnClose(async () => {
    reads += 1;
    queue.push({ at: 1, text: "read out at the end" });
  }, queue);
  await Promise.all([stream.close(), stream.close()]);
  await stream.close();
  const seen: string[] = [];
  for await (const line of stream.lines()) seen.push(line.text);
  assert.deepEqual([reads, seen], [1, ["read out at the end"]]);

  const broken = readOnClose(async () => {
    throw new Error("the device went away");
  }, new LineQueue());
  await broken.close();
  for await (const line of broken.lines()) assert.fail(`nothing to read, got ${line.text}`);
});

test("lines come out in the order they went in, to a reader that was already waiting too", async () => {
  const queue = new LineQueue();
  queue.push({ at: 1, text: "one" });
  const read = (async () => {
    const seen: string[] = [];
    for await (const line of queue.lines()) seen.push(line.text);
    return seen;
  })();
  await new Promise((resolve) => setTimeout(resolve, 5));
  queue.push({ at: 2, text: "two" });
  queue.end();
  queue.push({ at: 3, text: "after the end" });
  assert.deepEqual(await read, ["one", "two"]);
});
