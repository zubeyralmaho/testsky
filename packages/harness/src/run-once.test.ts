import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { lockPathFor, parseLockFile, parseTestFile } from "@testsky/artifact";
import type { AssertResult, DeviceHandle, Engine, GroundResult, LogStream, Observation, PlanResult, Provenance } from "@testsky/engine-core";

import { openLock } from "./memory.ts";
import { RunRecord } from "./record.ts";
import { runOnce, TestRun } from "./run-once.ts";

// A run's memory is written under a lock kept in testsky's home: this one, not the real one.
process.env.TESTSKY_HOME = await mkdtemp(join(tmpdir(), "testsky-home-"));

const SIZE = { width: 360, height: 800 };
const EMULATOR: DeviceHandle = { id: "emulator-5554", platform: "android", osVersion: "15", kind: "emulator", size: SIZE };
const PHONE: DeviceHandle = { ...EMULATOR, id: "R58M", kind: "physical" };
const PROVENANCE: Provenance = { tier: 1, model: "fake", usd: 0, latencyMs: 5, usedTree: false, channel: "vision" };
const AT = Date.parse("2026-11-13T10:00:00.000Z");

let screens = 0;
function observation(): Observation {
  return {
    frame: { bytes: Buffer.alloc(0), capturedAt: Date.now(), size: SIZE, pixelRatio: 3 },
    visionBlind: false,
    visionStats: { meanLuma: 120, stdLuma: 40, uniqueColors: 9000 },
    // A different screen every time, so a tap always "changes something".
    signature: { phash: `screen-${(screens += 1)}`, maskedRegions: [] },
    appContext: { appId: "com.acme.shop" },
    observedAt: Date.now(),
  };
}

function fakeEngine(over: { log?: string[]; plan?: () => Promise<PlanResult> } = {}) {
  let logsOpened = 0;
  const calls: string[] = [];
  const acted: string[] = [];
  const engine: Engine & { calls: string[] } = {
    name: "fake",
    capabilities: { tree: false, frameStream: false, networkCapture: false, nativePlanning: false, appInstall: false },
    calls,
    attach: async () => {
      calls.push("attach");
    },
    detach: async () => {
      calls.push("detach");
    },
    observe: async () => observation(),
    openFrameStream: async () => undefined,
    ground: async (): Promise<GroundResult> => ({ point: { x: 180, y: 600 }, confidence: 0.9, anchor: {}, provenance: PROVENANCE }),
    act: async (request) => {
      acted.push(request.name);
      return { dispatchedAt: Date.now(), stale: false };
    },
    assert: async (): Promise<AssertResult> => ({ pass: true, reason: "the cart shows one item", provenance: PROVENANCE }),
    extract: (async () => ({ data: {}, provenance: PROVENANCE })) as Engine["extract"],
    plan:
      over.plan ??
      (async (): Promise<PlanResult> =>
        acted.length
          ? { actions: [], done: true, provenance: PROVENANCE }
          : { actions: [{ name: "tap", describeTarget: "the cart icon" }], done: false, provenance: PROVENANCE }),
    popup: async () => ({ found: false, provenance: PROVENANCE }),
    app: {
      launch: async () => {},
      terminate: async () => {
        calls.push("terminate");
      },
      install: async () => {},
      currentBuildId: async () => "com.acme.shop@1.0+1",
    },
    logs: {
      open: async (): Promise<LogStream> => {
        logsOpened += 1;
        if (!over.log) throw new Error("no logs");
        const lines = over.log;
        return {
          lines: async function* () {
            for (const text of lines) yield { at: Date.now(), text };
          },
          close: async () => {},
        } as LogStream;
      },
    },
  };
  return Object.assign(engine, { logsOpened: () => logsOpened });
}

const SOURCE = `id: cart
title: The cart
targets: [{ platform: android, app: com.acme.shop }]
steps:
  - id: cart
    do: tap the cart icon
    expect: the cart shows at least one line item
teardown:
  - terminate app
`;

async function testOnDisk(): Promise<{ path: string; file: ReturnType<typeof parseTestFile> }> {
  const path = join(await mkdtemp(join(tmpdir(), "testsky-tests-")), "cart.testsky.yaml");
  await writeFile(path, SOURCE);
  return { path, file: parseTestFile(SOURCE, path) };
}

test("a kept run leaves its folder, and says its verdict before the report is built", async () => {
  const { file } = await testOnDisk();
  const record = new RunRecord(await mkdtemp(join(tmpdir(), "testsky-runs-")), "cart", AT, EMULATOR.id);
  const seen: string[] = [];
  const run = new TestRun({
    test: file,
    device: EMULATOR,
    platform: "android",
    record,
    video: false,
    settle: false,
    engine: fakeEngine(),
    onVerdict: (result) => {
      seen.push(result.outcome);
      // Kept by then, and the report not yet: a report a full disk cannot take must not cost the verdict.
      assert.ok(existsSync(join(record.dir, "result.json")));
      assert.ok(!existsSync(join(record.dir, "report.html")));
    },
  });
  const ran = await run.execute();
  assert.equal(ran.result.outcome, "PASS");
  assert.deepEqual(seen, ["PASS"]);
  for (const name of ["run.json", "events.jsonl", "result.json", "report.html"]) assert.ok(existsSync(join(record.dir, name)), name);
  assert.equal(ran.reportPath, join(record.dir, "report.html"));
  assert.equal(JSON.parse(await readFile(join(record.dir, "result.json"), "utf8")).outcome, "PASS");
  assert.ok(ran.events.some((event) => event.kind === "step_finished"), "the events returned are the ones kept");
});

test("the memory is opened on the attached device and kept before the report", async () => {
  const { path, file } = await testOnDisk();
  const engine = fakeEngine();
  const ran = await new TestRun({
    test: file,
    device: EMULATOR,
    platform: "android",
    workDir: await mkdtemp(join(tmpdir(), "testsky-work-")),
    video: false,
    settle: false,
    engine,
    memory: (attached) => {
      assert.deepEqual(engine.calls, ["attach"], "the layout is known once the device is attached");
      return openLock(path, file.id, "android", attached.size);
    },
  }).execute();
  assert.equal(ran.result.outcome, "PASS");
  const kept = parseLockFile(await readFile(lockPathFor(path, "android", SIZE), "utf8"));
  assert.ok(kept?.steps.cart, "what the step learned is on disk for the next run");
});

test("the app's own log is in the timeline when it is read, and not read when it is not wanted", async () => {
  const { file } = await testOnDisk();
  const ran = await new TestRun({
    test: file,
    device: EMULATOR,
    platform: "android",
    video: false,
    settle: false,
    engine: fakeEngine({ log: ["PaymentSheet: card declined"] }),
  }).execute();
  assert.ok(ran.html.includes("PaymentSheet: card declined"));

  // As `testsky run` has it without --device-log: no adb calls through the run for a log nobody asked for.
  const quiet = fakeEngine({ log: ["PaymentSheet: card declined"] });
  const without = await new TestRun({ test: file, device: EMULATOR, platform: "android", video: false, settle: false, deviceLog: false, engine: quiet }).execute();
  assert.equal(quiet.logsOpened(), 0);
  assert.ok(!without.html.includes("PaymentSheet: card declined"));
});

test("a run leaves its device to its caller until it is closed; runOnce closes it itself", async () => {
  const { file } = await testOnDisk();
  const engine = fakeEngine();
  const run = new TestRun({ test: file, device: EMULATOR, platform: "android", video: false, settle: false, engine });
  await run.execute();
  const detached = (calls: string[]) => calls.filter((call) => call === "detach").length;
  assert.equal(detached(engine.calls), 0, "still attached while the caller says what the run did");
  await run.close();
  await run.close();
  assert.equal(detached(engine.calls), 2, "and closing twice is nothing");

  const once = fakeEngine();
  await runOnce({ test: file, device: EMULATOR, platform: "android", video: false, settle: false, engine: once });
  assert.deepEqual([detached(once.calls), once.calls.at(-1)], [1, "detach"]);
});

test("a phone is not recorded, and the run says so", async () => {
  const { file } = await testOnDisk();
  const notes: string[] = [];
  await new TestRun({
    test: file,
    device: PHONE,
    platform: "android",
    workDir: await mkdtemp(join(tmpdir(), "testsky-work-")),
    settle: false,
    engine: fakeEngine(),
    onNote: (message, level) => notes.push(`${level}: ${message}`),
  }).execute();
  assert.deepEqual(notes, ["info: no video: a phone's screen is not recorded, only an emulator's or a simulator's"]);
});

test("a run stopped from outside closes the app its test closes, and lets go of the device", async () => {
  const { file } = await testOnDisk();
  let planned!: () => void;
  const thinking = new Promise<void>((resolve) => (planned = resolve));
  const engine = fakeEngine({
    // The model is still thinking when the stop comes.
    plan: async () => {
      await thinking;
      return { actions: [], done: true, provenance: PROVENANCE };
    },
  });
  let started!: () => void;
  const stepStarted = new Promise<void>((resolve) => (started = resolve));
  const run = new TestRun({
    test: file,
    device: EMULATOR,
    platform: "android",
    video: false,
    settle: false,
    engine,
    onEvent: (event) => {
      if (event.kind === "step_started") started();
    },
  });
  const executing = run.execute();
  await stepStarted;
  await run.abandon();
  assert.deepEqual(engine.calls.slice(0, 3), ["attach", "terminate", "detach"]);
  planned();
  await executing.catch(() => undefined);
});
