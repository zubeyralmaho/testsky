import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { emptyLock, lockPathFor, parseLockFile, parseTestFile } from "@testsky/artifact";
import type { AssertResult, DeviceHandle, Engine, GroundResult, Observation, PlanResult, Provenance } from "@testsky/engine-core";
import { runTest } from "@testsky/executor";
import { CostLedger } from "@testsky/router";

import { fetchHealDecisions, type ControlPlaneRequest } from "./decisions.ts";
import { openLock, saveLock } from "./memory.ts";

// The write lease a saved lock takes, kept out of the real ~/.testsky.
process.env.TESTSKY_HOME = await mkdtemp(join(tmpdir(), "testsky-home-"));

/** A control plane that answers every request with `handler`. */
async function controlPlane(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; request: ControlPlaneRequest }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, request: (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init) };
}

/** Where a control plane was a moment ago: a port nobody is listening on. */
async function nobodyHome(): Promise<ControlPlaneRequest> {
  const { server, request } = await controlPlane(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  return request;
}

const BEFORE = { action: "tap", point: { x: 180, y: 596 }, anchor: { tree: { role: "Button", label: "Continue", bounds: { x: 60, y: 560, width: 240, height: 72 } } } };
const AFTER = { action: "tap", point: { x: 180, y: 596 }, anchor: { tree: { role: "Button", label: "Devam et", bounds: { x: 60, y: 560, width: 240, height: 72 } } } };

test("decisions come back as the executor wants them, and rows that are not decisions are dropped", async () => {
  let asked = "";
  const { server, request } = await controlPlane((req, res) => {
    asked = req.url ?? "";
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify([
        { step_id: "press", status: "rejected", before_json: BEFORE, after_json: AFTER, reviewed_at: "2026-09-22T09:00:00.000Z" },
        { step_id: "press", status: "pending_review", before_json: BEFORE, after_json: AFTER },
        { step_id: "press", status: "accepted", before_json: "not json", after_json: AFTER },
        { status: "accepted", before_json: BEFORE, after_json: AFTER },
      ]),
    );
  });
  try {
    const fetched = await fetchHealDecisions(request, "check out", "ios");
    assert.equal(asked, "/v1/tests/check%20out/heal-decisions?platform=ios");
    assert.equal(fetched.error, undefined);
    assert.deepEqual(fetched.decisions, [
      { step: "press", status: "rejected", before: BEFORE, after: AFTER, reviewedAt: "2026-09-22T09:00:00.000Z" },
    ]);
  } finally {
    server.close();
  }
});

test("a control plane that is down, hung or unwell yields no decisions and a reason, never an exception", async () => {
  const down = await fetchHealDecisions(await nobodyHome(), "cached", "android");
  assert.deepEqual(down.decisions, []);
  assert.equal(down.error, "ECONNREFUSED");

  const hung = await controlPlane(() => undefined); // accepts, never answers
  try {
    const started = Date.now();
    const result = await fetchHealDecisions(hung.request, "cached", "android", 200);
    assert.deepEqual(result.decisions, []);
    assert.ok(result.error);
    assert.ok(Date.now() - started < 2000, "a hung control plane costs the timeout, not the run");
  } finally {
    hung.server.closeAllConnections();
    hung.server.close();
  }

  const unwell = await controlPlane((_, res) => res.writeHead(500).end("boom"));
  try {
    assert.deepEqual(await fetchHealDecisions(unwell.request, "cached", "android"), {
      decisions: [],
      error: "the control plane answered 500",
    });
  } finally {
    unwell.server.close();
  }

  const odd = await controlPlane((_, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"rows":[]}'));
  try {
    assert.deepEqual((await fetchHealDecisions(odd.request, "cached", "android")).decisions, []);
  } finally {
    odd.server.close();
  }
});

// ── The run itself, fed from a control plane that is not there ──────────

const DEVICE: DeviceHandle = { id: "emulator-5554", platform: "android", osVersion: "15", kind: "emulator" };
const PROVENANCE: Provenance = { tier: 1, model: "fake", usd: 0, latencyMs: 1, usedTree: false, channel: "vision" };
const TEST = parseTestFile(`
id: cached
targets: [{ platform: android, app: com.acme }]
steps:
  - id: press
    do: press continue
    expect: the next screen is visible
`);

/** A screen with one button on it, whose words are `label`. */
function engineShowing(label: string): Engine & { stepId?: string } {
  const bounds = { x: 60, y: 560, width: 240, height: 72 };
  const observation = (): Observation => ({
    frame: { bytes: Buffer.alloc(0), capturedAt: 0, size: { width: 360, height: 720 }, pixelRatio: 3 },
    visionBlind: false,
    visionStats: { meanLuma: 100, stdLuma: 30, uniqueColors: 90 },
    signature: { phash: "aaaabbbbccccdddd", treeHash: "screen-1", maskedRegions: [] },
    appContext: {},
    observedAt: Date.now(),
    tree: {
      platform: "android",
      capturedAt: 0,
      source: "uiautomator",
      truncated: false,
      captureMs: 1,
      root: {
        ref: "root",
        role: "FrameLayout",
        bounds: { x: 0, y: 0, width: 360, height: 720 },
        enabled: true,
        interactive: false,
        children: [{ ref: "b", role: "Button", label, bounds, enabled: true, interactive: true, children: [] }],
      },
    },
  });
  return {
    name: "fake",
    capabilities: { tree: true, frameStream: false, networkCapture: false, nativePlanning: false, appInstall: false },
    attach: async () => {},
    detach: async () => {},
    observe: async () => observation(),
    openFrameStream: async () => undefined,
    ground: async (): Promise<GroundResult> => ({
      point: { x: 180, y: 596 },
      confidence: 0.9,
      anchor: { tree: { role: "Button", label, bounds } },
      provenance: PROVENANCE,
    }),
    act: async () => ({ dispatchedAt: Date.now(), stale: false }),
    assert: async (): Promise<AssertResult> => ({ pass: true, reason: "it is there", provenance: PROVENANCE }),
    extract: (async () => ({ data: {}, provenance: PROVENANCE })) as Engine["extract"],
    plan: async (): Promise<PlanResult> => ({ actions: [{ name: "tap", describeTarget: "the Continue button" }], done: false, provenance: PROVENANCE }),
    popup: async () => ({ found: false, provenance: PROVENANCE }),
    app: { launch: async () => {}, terminate: async () => {}, install: async () => {}, currentBuildId: async () => "com.acme@1.0+1" },
    logs: { open: async () => { throw new Error("no logs"); } },
  };
}

test("an unreachable control plane does not stop a run, and does not unmake a rejection the lock already holds", async () => {
  // The runner's path: ask, shrug, run with whatever came back.
  const run = async (request: ControlPlaneRequest, label: string, lock: ReturnType<typeof emptyLock>) => {
    const decided = await fetchHealDecisions(request, "cached", "android");
    return runTest({
      engine: engineShowing(label),
      test: TEST,
      device: DEVICE,
      ledger: new CostLedger(),
      settle: false,
      lock,
      healDecisions: decided.decisions,
    });
  };

  const gone = await nobodyHome();
  const lock = emptyLock("cached", "android");
  assert.equal((await run(gone, "Continue", lock)).outcome, "PASS", "learning works with nobody to ask");
  assert.equal((await run(gone, "Devam et", lock)).outcome, "HEALED_PASS", "and so does healing");

  // A person rejects the heal; the control plane serves that for one run...
  const heal = lock.heals[0]!;
  const { server, request } = await controlPlane((_, res) =>
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify([{ step_id: heal.step, status: "rejected", before_json: heal.before, after_json: heal.after }]),
    ),
  );
  try {
    assert.equal((await run(request, "Devam et", lock)).outcome, "FAIL_REJECTED_HEAL");
  } finally {
    server.close();
  }

  // ...and then goes away. The lock heard it, so the next run still knows.
  assert.equal((await run(gone, "Devam et", lock)).outcome, "FAIL_REJECTED_HEAL");
  assert.equal((await run(gone, "Continue", lock)).outcome, "PASS", "until the app is fixed");
});

test("with no control plane at all, a heal rejected by editing the lock file fails the same change on the next run", async () => {
  // `testsky run`'s path: the memory for this phone opened, the run, what changed written back.
  const path = join(await mkdtemp(join(tmpdir(), "testsky-review-")), "cached.testsky.yaml");
  const size = { width: 360, height: 720 };
  const run = async (label: string) => {
    const opened = (await openLock(path, "cached", "android", size))!;
    const result = await runTest({ engine: engineShowing(label), test: TEST, device: DEVICE, ledger: new CostLedger(), settle: false, lock: opened.lock });
    await saveLock(opened);
    return result.outcome;
  };
  assert.equal(await run("Continue"), "PASS");
  assert.equal(await run("Devam et"), "HEALED_PASS");

  // The review: one word changed in the file, by hand.
  const file = lockPathFor(path, "android", size);
  const text = await readFile(file, "utf8");
  assert.equal(text.split("status: pending_review").length, 2, "one heal to review");
  await writeFile(file, text.replace("status: pending_review", "status: rejected"));

  assert.equal(await run("Devam et"), "FAIL_REJECTED_HEAL");
  const kept = parseLockFile(await readFile(file, "utf8"))!;
  assert.deepEqual([kept.heals[0]!.status, kept.heals[0]!.applied], ["rejected", "rejected"], "acted on, and written down as acted on");
  assert.equal(kept.steps.press!.actions[0]!.anchor?.tree?.label, "Continue", "the memory on the old target, in the file");

  assert.equal(await run("Devam et"), "FAIL_REJECTED_HEAL", "on every run after, from the file alone");
  assert.equal(await run("Continue"), "PASS", "until the app is fixed");
});
