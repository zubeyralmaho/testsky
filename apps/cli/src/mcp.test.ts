import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { parseTestFile } from "@testsky/artifact";
import type { AssertResult, DeviceHandle, Engine, ExtractResult, GroundResult, Lease, Observation, PlanResult, Provenance } from "@testsky/engine-core";
import { fixtureScreen } from "@testsky/perception";
import { CostLedger } from "@testsky/router";

import { serveStdio, TestskyMcp, TOOLS, type McpDeps, type ToolResult } from "./mcp.ts";

// A saved step's memory is written under a lock kept in testsky's home: this one, not the real one.
process.env.TESTSKY_HOME = await mkdtemp(join(tmpdir(), "testsky-home-"));

const PHONE: DeviceHandle = { id: "emulator-5554", platform: "android", osVersion: "15", kind: "emulator", size: { width: 360, height: 720 } };
const OTHER: DeviceHandle = { id: "R58M", platform: "android", osVersion: "14", kind: "physical" };
const PROVENANCE: Provenance = { tier: 1, model: "fake", usd: 0.001, latencyMs: 5, usedTree: false, channel: "vision" };
const FRAME = (await fixtureScreen()).png;

let screens = 0;
function observation(): Observation {
  return {
    frame: { bytes: FRAME, capturedAt: Date.now(), size: { width: 360, height: 720 }, pixelRatio: 3 },
    visionBlind: false,
    visionStats: { meanLuma: 120, stdLuma: 40, uniqueColors: 9000 },
    signature: { phash: `screen-${(screens += 1)}`, maskedRegions: [] },
    appContext: { appId: "com.acme.shop" },
    observedAt: Date.now(),
    tree: {
      platform: "android",
      capturedAt: Date.now(),
      source: "uiautomator",
      truncated: false,
      captureMs: 10,
      root: {
        ref: "root",
        role: "FrameLayout",
        bounds: { x: 0, y: 0, width: 360, height: 720 },
        enabled: true,
        interactive: false,
        children: [{ ref: "pay", role: "Button", label: "Pay now", bounds: { x: 20, y: 600, width: 320, height: 48 }, enabled: true, interactive: true, children: [] }],
      },
    },
  };
}

function fakeEngine(over: { assert?: () => Promise<AssertResult>; slowAct?: number; onAct?: () => void } = {}) {
  const calls: string[] = [];
  const acted: string[] = [];
  const engine: Engine & { calls: string[] } = {
    name: "fake",
    capabilities: { tree: true, frameStream: false, networkCapture: false, nativePlanning: false, appInstall: false },
    calls,
    attach: async () => {
      calls.push("attach");
    },
    detach: async () => {
      calls.push("detach");
    },
    observe: async () => observation(),
    openFrameStream: async () => undefined,
    ground: async (): Promise<GroundResult> => ({ point: { x: 180, y: 624 }, confidence: 0.9, anchor: {}, provenance: PROVENANCE }),
    act: async (request) => {
      over.onAct?.();
      if (over.slowAct) await new Promise((resolve) => setTimeout(resolve, over.slowAct));
      acted.push(request.name);
      return { dispatchedAt: Date.now(), stale: false };
    },
    assert: over.assert ?? (async (): Promise<AssertResult> => ({ pass: true, reason: "the order is confirmed", provenance: PROVENANCE })),
    extract: (async (): Promise<ExtractResult> => ({ data: { answer: "$146.00" }, provenance: PROVENANCE })) as Engine["extract"],
    plan: async (): Promise<PlanResult> =>
      acted.length
        ? { actions: [], done: true, provenance: PROVENANCE }
        : { actions: [{ name: "tap", describeTarget: "the Pay now button" }], done: false, provenance: PROVENANCE },
    popup: async () => ({ found: false, provenance: PROVENANCE }),
    app: { launch: async () => {}, terminate: async () => {}, install: async () => {}, currentBuildId: async () => "com.acme.shop@1.0+1" },
    logs: { open: async () => { throw new Error("no logs"); } },
  };
  return engine;
}

/** Fakes for everything the server does to the world, and what it did. */
function world(over: { engine?: ReturnType<typeof fakeEngine>; spawnRun?: McpDeps["spawnRun"] } = {}) {
  const engine = over.engine ?? fakeEngine();
  const taken: string[] = [];
  const picked: (string | undefined)[] = [];
  const released: string[] = [];
  const spawned: string[][] = [];
  const envs: Record<string, string>[] = [];
  const deps: McpDeps = {
    devices: async () => ({ devices: [PHONE, OTHER], problems: [] }),
    pick: async (_platform, id) => {
      picked.push(id);
      const found = [PHONE, OTHER].find((device) => !id || device.id.startsWith(id));
      if (!found) throw new Error(`No device "${id}"`);
      return found;
    },
    holder: async (device) => (device.id === OTHER.id ? "run nightly (pid 4242)" : undefined),
    take: async (device): Promise<Lease> => {
      taken.push(device.id);
      return { path: `/leases/${device.id}`, holder: { pid: process.pid } as Lease["holder"], release: async () => void released.push(device.id) };
    },
    attach: async () => {
      await engine.attach(PHONE);
      return { engine, ledger: new CostLedger() };
    },
    spawnRun: (args, env) => {
      spawned.push(args);
      envs.push(env);
      if (!over.spawnRun) throw new Error("no runs in this test");
      return over.spawnRun(args, env);
    },
  };
  return { deps, engine, taken, released, spawned, envs, picked };
}

const json = (result: ToolResult) => JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;

test("a step is tried on a phone held between steps, kept when it passed, and the phone let go of", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testsky-mcp-"));
  const { deps, engine, taken, released } = world();
  const server = new TestskyMcp({ allow: [], out: join(dir, "runs"), idleMs: 60_000, settle: false }, deps);
  try {
    const tried = await server.call("try_step", { do: "tap the Pay now button", expect: "the order is confirmed" });
    assert.equal(tried.isError, undefined);
    const answer = json(tried);
    assert.deepEqual([answer.outcome, answer.passed, answer.exitCode, answer.device], ["PASS", true, 0, PHONE.id]);
    assert.equal(tried.content[1]?.type, "image", "the screen after the step");
    assert.equal((tried.content[1] as { mimeType: string }).mimeType, "image/jpeg");

    const read = json(await server.call("try_step", { read: "the order total" }));
    assert.equal(read.answer, "$146.00");
    assert.deepEqual(taken, [PHONE.id], "taken once and held between steps");

    const looked = await server.call("look", { tree: true });
    assert.deepEqual(json(looked).tree, ['Button "Pay now" (20,600 320x48)']);
    assert.equal(looked.content[1]?.type, "image");

    const path = join(dir, "checkout.testsky.yaml");
    const saved = json(await server.call("save_step", { step_id: answer.step_id, test: path, app: "com.acme.shop" }));
    assert.equal(saved.remembered, true);
    assert.deepEqual(parseTestFile(await readFile(path, "utf8")).steps.map((step) => step.expect), ["the order is confirmed"]);
    const readSaved = await server.call("save_step", { step_id: read.step_id, test: path });
    assert.equal(readSaved.isError, true, "a read is no step of its own");

    assert.deepEqual(json(await server.call("release_device", {})).released, [PHONE.id]);
    assert.deepEqual(released, [PHONE.id]);
    assert.ok(engine.calls.includes("detach"));
  } finally {
    await server.close();
  }
});

test("a step that did not pass is not saved, and a phone not allowed is not touched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testsky-mcp-"));
  const engine = fakeEngine({ assert: async () => ({ pass: false, reason: "no order number", provenance: PROVENANCE }) });
  const { deps, taken } = world({ engine });
  const server = new TestskyMcp({ allow: [PHONE.id], out: join(dir, "runs"), idleMs: 60_000, settle: false }, deps);
  try {
    const failed = json(await server.call("try_step", { expect: "an order number is visible" }));
    assert.deepEqual([failed.outcome, failed.passed, failed.exitCode], ["FAIL_ASSERT", false, 1]);
    const refused = await server.call("save_step", { step_id: failed.step_id, test: join(dir, "x.testsky.yaml") });
    assert.equal(refused.isError, true);
    assert.match((refused.content[0] as { text: string }).text, /did not pass/);

    const other = await server.call("look", { device: OTHER.id });
    assert.equal(other.isError, true);
    assert.match((other.content[0] as { text: string }).text, /not one of the phones this server may use/);
    assert.deepEqual(taken, [PHONE.id], "the other phone was never taken");

    const listed = json(await server.call("devices"));
    assert.deepEqual((listed.devices as { id: string }[]).map((device) => device.id), [PHONE.id], "only the phones allowed are listed");
  } finally {
    await server.close();
  }
});

/** A `testsky run --json` stand-in: says progress on stderr, then answers on stdout -- or waits to be stopped. */
const fakeRun = (body: string) => (_args: string[], env: Record<string, string>) =>
  spawn(process.execPath, ["-e", body], { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, ...env } });

test("a run is started in the background, waited for, and answers as `testsky run --json` did", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testsky-mcp-"));
  const path = join(dir, "checkout.testsky.yaml");
  await writeFile(path, "id: checkout\ntargets: [{ platform: android, app: com.acme.shop }]\nsteps:\n  - do: tap the cart icon\n");
  const answer = { outcome: "PASS", exitCode: 0, detail: "all steps passed", steps: [{ id: "tap-the-cart-icon" }], dir };
  const { deps, spawned } = world({
    spawnRun: fakeRun(`process.stderr.write("\\u001b[2m  -> tap the cart icon\\u001b[0m\\n"); setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(answer))} + "\\n"), 300);`),
  });
  const server = new TestskyMcp({ allow: [], out: join(dir, "runs"), idleMs: 60_000 }, deps);
  try {
    const started = json(await server.call("run_test", { path, device: PHONE.id }));
    assert.equal(started.run_id, "run-1");
    assert.deepEqual(spawned[0]!.slice(0, 7), ["run", path, "--device", PHONE.id, "--platform", "android", "--json"]);

    const early = json(await server.call("get_run", { run_id: "run-1", wait_seconds: 0 }));
    assert.equal(early.status, "running");
    const finished = json(await server.call("get_run", { run_id: "run-1", wait_seconds: 10 }));
    assert.deepEqual([finished.status, finished.outcome, finished.exitCode], ["finished", "PASS", 0]);

    const missing = await server.call("run_test", { path: join(dir, "nope.testsky.yaml") });
    assert.equal(missing.isError, true, "a file that is not there is refused before any phone is asked for");
    assert.equal(spawned.length, 1);
  } finally {
    await server.close();
  }
});

test("a run is stopped the way Ctrl+C stops it, and says so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testsky-mcp-"));
  const path = join(dir, "soak.testsky.yaml");
  await writeFile(path, "id: soak\ntargets: [{ platform: android, app: com.acme.shop }]\nsteps:\n  - wait: 60s\n");
  const { deps } = world({
    spawnRun: fakeRun(`process.on("SIGTERM", () => { process.stderr.write("stopping: the phone is let go of\\n"); process.exit(143); }); setInterval(() => {}, 1000); process.stderr.write("  -> wait\\n");`),
  });
  const server = new TestskyMcp({ allow: [], out: join(dir, "runs"), idleMs: 60_000 }, deps);
  try {
    await server.call("run_test", { path, device: PHONE.id });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(json(await server.call("cancel_run", { run_id: "run-1" })).status, "stopped");
    const after = json(await server.call("get_run", { run_id: "run-1", wait_seconds: 0 }));
    assert.deepEqual([after.status, after.outcome, after.exitCode], ["finished", "STOPPED", 2]);
  } finally {
    await server.close();
  }
});

test("the protocol: a version agreed on, the tools listed, a tool not there refused", async () => {
  const { deps } = world();
  const server = new TestskyMcp({ allow: [], out: "runs", idleMs: 60_000 }, deps);
  const input = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  const serving = serveStdio(server, { input, write: (line) => void lines.push(JSON.parse(line)) }, "9.9.9");
  const send = (message: unknown) => input.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", method: "tools/list" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tap_at", arguments: { x: 1, y: 2 } } });
  input.write("not json\n");
  input.end();
  await serving;
  await server.close();
  const byId = new Map(lines.map((line) => [line.id, line]));
  const init = byId.get(1)!.result as { protocolVersion: string; serverInfo: { version: string }; instructions: string };
  assert.equal(init.protocolVersion, "2025-06-18", "a version it does not speak is answered with its newest");
  assert.equal(init.serverInfo.version, "9.9.9");
  assert.match(init.instructions, /FAIL_GROUND/);
  assert.deepEqual((byId.get(2)!.result as { tools: { name: string }[] }).tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
  assert.equal((byId.get(3)!.error as { code: number }).code, -32602, "there is no tool that taps at x,y");
  assert.equal((byId.get(null)!.error as { code: number }).code, -32700);
  assert.equal(lines.length, 4, "a notification is answered with nothing");
});

test("a phone held between steps is let go of once it has been idle", async () => {
  const { deps, released } = world();
  const server = new TestskyMcp({ allow: [], out: "runs", idleMs: 150, settle: false }, deps);
  try {
    const asked = Date.now();
    await server.call("look", {});
    // Measured, not slept on: a loaded machine runs timers late, never early.
    let releasedAt = 0;
    for (const until = Date.now() + 10_000; !released.length && Date.now() < until; ) await new Promise((resolve) => setTimeout(resolve, 20));
    releasedAt = Date.now();
    assert.deepEqual(released, [PHONE.id], "free for a run elsewhere without anybody asking");
    assert.ok(releasedAt - asked >= 150, "and not before it was idle");
  } finally {
    await server.close();
  }
});

test("a phone a step is at work on is not pulled from under it: neither a release nor a run takes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testsky-mcp-"));
  const path = join(dir, "cart.testsky.yaml");
  await writeFile(path, "id: cart\ntargets: [{ platform: android, app: com.acme.shop }]\nsteps:\n  - do: tap the cart icon\n");
  let acting!: () => void;
  const pressing = new Promise<void>((resolve) => (acting = resolve));
  const { deps, engine, released, spawned } = world({ engine: fakeEngine({ slowAct: 400, onAct: () => acting() }) });
  const server = new TestskyMcp({ allow: [], out: join(dir, "runs"), idleMs: 60_000, settle: false }, deps);
  try {
    const stepping = server.call("try_step", { do: "tap the Pay now button" });
    // The step is pressing: on a loaded machine that is a moment later than anybody would guess.
    await pressing;
    const release = json(await server.call("release_device", {}));
    assert.deepEqual([release.released, release.inUse], [[], [PHONE.id]]);
    const run = await server.call("run_test", { path, device: PHONE.id });
    assert.equal(run.isError, true);
    assert.match((run.content[0] as { text: string }).text, /a step is running/);
    assert.equal(json(await stepping).passed, true, "the step was let finish");
    assert.deepEqual([released, spawned.length, engine.calls.includes("detach")], [[], 0, false]);
  } finally {
    await server.close();
  }
});

test("two calls at once take a free phone once", async () => {
  const { deps, taken } = world();
  const server = new TestskyMcp({ allow: [], out: "runs", idleMs: 60_000, settle: false }, deps);
  try {
    const [looked, tried] = await Promise.all([server.call("look", {}), server.call("try_step", { expect: "the order is confirmed" })]);
    assert.deepEqual([looked.isError, tried.isError, taken], [undefined, undefined, [PHONE.id]]);
  } finally {
    await server.close();
  }
});

test("--devices names a phone whole: a start of an id is not a phone, and one not named is never asked anything", async () => {
  const short = world();
  const server = new TestskyMcp({ allow: ["emulator-555"], out: "runs", idleMs: 60_000, settle: false }, short.deps);
  try {
    const refused = await server.call("look", {});
    assert.equal(refused.isError, true, "emulator-555 is not emulator-5554");
    assert.deepEqual(short.taken, []);
  } finally {
    await server.close();
  }
  const exact = world();
  const strict = new TestskyMcp({ allow: [PHONE.id], out: "runs", idleMs: 60_000, settle: false }, exact.deps);
  try {
    assert.equal((await strict.call("look", { device: "R58" })).isError, true);
    assert.deepEqual(exact.picked, [], "a phone not on the list is not even looked up");
    assert.equal((await strict.call("look", { device: "emulator" })).isError, undefined, "a start of a phone on the list names it");
    assert.deepEqual(exact.picked, [PHONE.id]);
  } finally {
    await strict.close();
  }
});

test("a run is told to stop once however often it is asked, and answers from its lane file when stdout says nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testsky-mcp-"));
  const path = join(dir, "soak.testsky.yaml");
  await writeFile(path, "id: soak\ntargets: [{ platform: android, app: com.acme.shop }]\nsteps:\n  - wait: 60s\n");
  const stopping = world({
    spawnRun: fakeRun(
      `let told = 0; process.on("SIGTERM", () => { told += 1; process.stderr.write(told === 1 ? "stopping\\n" : "told twice\\n"); setTimeout(() => process.exit(143), 300); }); setInterval(() => {}, 1000); process.stderr.write("listening\\n");`,
    ),
  });
  const server = new TestskyMcp({ allow: [], out: join(dir, "runs"), idleMs: 60_000 }, stopping.deps);
  try {
    await server.call("run_test", { path, device: PHONE.id });
    // Told to stop once it listens for it, however long a loaded machine takes to start it.
    for (const until = Date.now() + 10_000; Date.now() < until; ) {
      const progress = json(await server.call("get_run", { run_id: "run-1", wait_seconds: 0 })).progress as string[] | undefined;
      if (progress?.includes("listening")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await Promise.all([server.call("cancel_run", { run_id: "run-1" }), server.call("cancel_run", { run_id: "run-1" })]);
    const after = json(await server.call("get_run", { run_id: "run-1", wait_seconds: 5 }));
    assert.deepEqual([after.outcome, after.detail], ["STOPPED", "stopping"]);
    assert.match(stopping.envs[0]!.TESTSKY_RESULT_FILE ?? "", /testsky-mcp-/, "the run carries on if this server goes, and says how it went in a file");
  } finally {
    await server.close();
  }

  const quiet = world({
    spawnRun: fakeRun(`require("node:fs").writeFileSync(process.env.TESTSKY_RESULT_FILE, JSON.stringify({ outcome: "PASS", detail: "all steps passed" }));`),
  });
  const lane = new TestskyMcp({ allow: [], out: join(dir, "runs"), idleMs: 60_000 }, quiet.deps);
  try {
    await lane.call("run_test", { path, device: PHONE.id });
    const finished = json(await lane.call("get_run", { run_id: "run-1", wait_seconds: 10 }));
    assert.deepEqual([finished.status, finished.outcome, finished.exitCode], ["finished", "PASS", 0]);
  } finally {
    await lane.close();
  }
});
