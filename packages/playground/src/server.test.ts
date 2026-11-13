import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AssertResult,
  DeviceHandle,
  Engine,
  ExtractResult,
  GroundResult,
  Observation,
  PlanResult,
  Provenance,
} from "@testsky/engine-core";
import { lockPathFor, parseLockFile, parseTestFile } from "@testsky/artifact";
import { fixtureScreen } from "@testsky/perception";
import { CostLedger } from "@testsky/router";

import { locateWords, startPlayground, stepFor, type ExecuteResponse } from "./server.ts";

// A saved step's memory is written under a lock kept in testsky's home: this one, not the real one.
process.env.TESTSKY_HOME = await mkdtemp(join(tmpdir(), "testsky-home-"));

const DEVICE: DeviceHandle = { id: "emulator-5554", platform: "android", osVersion: "15", kind: "emulator", size: { width: 360, height: 720 } };
const PROVENANCE: Provenance = { tier: 1, model: "fake", usd: 0, latencyMs: 5, usedTree: false, channel: "vision" };
const FRAME = (await fixtureScreen()).png;

let screens = 0;
function observation(): Observation {
  return {
    frame: { bytes: FRAME, capturedAt: Date.now(), size: { width: 360, height: 720 }, pixelRatio: 3 },
    visionBlind: false,
    visionStats: { meanLuma: 120, stdLuma: 40, uniqueColors: 9000 },
    // A different screen every time, so a tap always "changes something".
    signature: { phash: `screen-${(screens += 1)}`, maskedRegions: [] },
    appContext: {},
    observedAt: Date.now(),
    tree: {
      platform: "android",
      capturedAt: Date.now(),
      source: "uiautomator",
      truncated: false,
      captureMs: 10,
      root: { ref: "root", role: "FrameLayout", bounds: { x: 0, y: 0, width: 360, height: 720 }, enabled: true, interactive: false, children: [] },
    },
  };
}

function fakeEngine(over: { assert?: () => Promise<AssertResult>; slowAct?: number; build?: string } = {}) {
  const acted: string[] = [];
  const engine: Engine & { acted: string[] } = {
    name: "fake",
    capabilities: { tree: true, frameStream: false, networkCapture: false, nativePlanning: false, appInstall: false },
    acted,
    attach: async () => {},
    detach: async () => {},
    observe: async () => observation(),
    openFrameStream: async () => undefined,
    ground: async (): Promise<GroundResult> => ({ point: { x: 180, y: 600 }, confidence: 0.9, anchor: {}, provenance: PROVENANCE }),
    act: async (request) => {
      if (over.slowAct) await new Promise((resolve) => setTimeout(resolve, over.slowAct));
      acted.push(request.name);
      return { dispatchedAt: Date.now(), stale: false };
    },
    assert: over.assert ?? (async (): Promise<AssertResult> => ({ pass: true, reason: "it is there", provenance: PROVENANCE })),
    extract: (async (): Promise<ExtractResult> => ({ data: { answer: "$146.00" }, provenance: PROVENANCE })) as Engine["extract"],
    // One tap, then the goal is met: what a planner says once it has done the job.
    plan: async (): Promise<PlanResult> =>
      acted.length
        ? { actions: [], done: true, provenance: PROVENANCE }
        : { actions: [{ name: "tap", describeTarget: "the Pay button" }], done: false, provenance: PROVENANCE },
    popup: async () => ({ found: false, provenance: PROVENANCE }),
    app: { launch: async () => {}, terminate: async () => {}, install: async () => {}, currentBuildId: async () => over.build },
    logs: { open: async () => { throw new Error("no logs"); } },
  };
  return engine;
}

async function withPlayground(
  engine: ReturnType<typeof fakeEngine>,
  run: (url: string) => Promise<void>,
  saving: { test?: string; app?: string } = {},
) {
  const playground = await startPlayground({ engine, device: DEVICE, ledger: new CostLedger(), page: "<html>the page</html>", port: 0, settle: false, ...saving });
  try {
    await run(playground.url);
  } finally {
    await playground.close();
  }
}

const post = (url: string, body: unknown) =>
  fetch(`${url}/api/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("the page, the device and its screen", async () => {
  await withPlayground(fakeEngine(), async (url) => {
    assert.equal(await (await fetch(url)).text(), "<html>the page</html>");
    const status = (await (await fetch(`${url}/api/status`)).json()) as Record<string, unknown>;
    assert.deepEqual([status.platform, status.device, status.tree, status.busy], ["android", "emulator-5554", true, false]);
    const shot = await fetch(`${url}/api/screenshot`);
    assert.equal(shot.headers.get("content-type"), "image/png");
    assert.equal(shot.headers.get("x-screen-width"), "360");
    assert.deepEqual(Buffer.from(await shot.arrayBuffer()), FRAME);
  });
});

test("the tree, for the inspector", async () => {
  await withPlayground(fakeEngine(), async (url) => {
    const tree = (await (await fetch(`${url}/api/tree`)).json()) as { size: unknown; root: { role: string } };
    assert.deepEqual(tree.size, { width: 360, height: 720 });
    assert.equal(tree.root.role, "FrameLayout");
  });
});

test("an instruction runs as a step and comes back as a dump the playground replays", async () => {
  const engine = fakeEngine();
  await withPlayground(engine, async (url) => {
    const answer = (await (await post(url, { type: "aiAct", prompt: "pay for the order" })).json()) as ExecuteResponse;
    assert.equal(answer.error, null);
    assert.deepEqual(engine.acted, ["tap"]);
    const dump = answer.dump as { executions: { tasks: { type: string; subType: string; uiContext?: { screenshot: { base64: string } } }[] }[] };
    const tap = dump.executions[0]!.tasks.find((task) => task.subType === "Tap")! as (typeof dump.executions)[0]["tasks"][0] & {
      recorder?: { screenshot: { base64: string } }[];
    };
    assert.equal(tap.type, "Action Space");
    assert.match(tap.uiContext!.screenshot.base64, /^data:image\/jpeg;base64,/, "frames travel inside the dump");
    assert.match(tap.recorder?.[0]?.screenshot.base64 ?? "", /^data:image\/jpeg/, "and the replay ends on the screen the tap left");
    assert.equal("result" in answer, false, "an action answers with nothing, not null");
  });
});

test("a check that fails says so, and a read gives back what it read", async () => {
  const engine = fakeEngine({ assert: async () => ({ pass: false, reason: "no order number", provenance: PROVENANCE }) });
  await withPlayground(engine, async (url) => {
    const checked = (await (await post(url, { type: "aiAssert", prompt: "an order number is visible" })).json()) as ExecuteResponse;
    assert.equal(checked.result, false);
    assert.match(checked.error ?? "", /^FAIL_ASSERT/);
    const read = (await (await post(url, { type: "aiQuery", prompt: "the total" })).json()) as ExecuteResponse;
    assert.equal(read.result, "$146.00");
  });
});

test("one instruction at a time, and nothing the phone cannot do", async () => {
  await withPlayground(fakeEngine({ slowAct: 300 }), async (url) => {
    const first = post(url, { type: "aiTap", prompt: "the Pay button" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await post(url, { type: "aiTap", prompt: "the Pay button" });
    assert.equal(second.status, 409);
    assert.equal((await first).status, 200);
    const hover = await post(url, { type: "aiHover", prompt: "the menu" });
    assert.equal(hover.status, 400);
    assert.match(((await hover.json()) as { error: string }).error, /not something testsky does/);
  });
});

/** The fake screen, with a General row the tree can name. */
function withGeneral(): Observation {
  const seen = observation();
  const root = seen.tree!.root;
  const general = { ref: "general", role: "Button", label: "General", bounds: { x: 20, y: 580, width: 320, height: 40 }, enabled: true, interactive: true, children: [] };
  return { ...seen, tree: { ...seen.tree!, root: { ...root, children: [general] } } };
}

type LocateDump = { executions: { name: string; tasks: { subType: string; status: string; output?: { element: { rect: unknown } }; param?: { content?: string } }[] }[] };

test("Locate says where testsky would press and what the tree alone would, and presses nothing", async () => {
  const engine = fakeEngine();
  engine.observe = async () => withGeneral();
  engine.ground = async (): Promise<GroundResult> => ({
    point: { x: 180, y: 600 },
    rect: { x: 20, y: 580, width: 320, height: 40 },
    confidence: 0.95,
    anchor: {},
    provenance: PROVENANCE,
    foundBy: "both",
    why: "the General row",
  });
  await withPlayground(engine, async (url) => {
    const answer = (await (await post(url, { type: "aiLocate", prompt: "General" })).json()) as ExecuteResponse;
    assert.equal(answer.error, null);
    assert.deepEqual(engine.acted, [], "a locate presses nothing");
    assert.equal(
      answer.result,
      "testsky would press (180, 600) in (20,580 320x40): the model and the tree agree -- the General row.\n" +
        'The tree alone: Button "General" at (20,580 320x40) -- the tree has one Button called "General".',
    );
    const tasks = (answer.dump as LocateDump).executions[0]!.tasks;
    assert.deepEqual(tasks.find((task) => task.subType === "Locate")?.output?.element.rect, { left: 20, top: 580, width: 320, height: 40 });
    assert.match(tasks.find((task) => task.subType === "Note")?.param?.content ?? "", /^The tree alone: Button "General"/);
  });
});

test("a Locate that finds nothing says why, and still says what the tree alone would", async () => {
  const engine = fakeEngine();
  engine.ground = async () => {
    throw new Error('could not find "the Pay button" on this screen -- there is no such button');
  };
  await withPlayground(engine, async (url) => {
    const answer = (await (await post(url, { type: "aiLocate", prompt: "the Pay button" })).json()) as ExecuteResponse;
    assert.equal(
      answer.result,
      'testsky would press nothing: could not find "the Pay button" on this screen -- there is no such button.\n' +
        'The tree alone: no node in the tree is called "pay".',
    );
    assert.deepEqual(engine.acted, []);
    const failed = (answer.dump as LocateDump).executions[0]!.tasks.at(-1)!;
    assert.equal(failed.status, "failed");
  });
});

test("a Locate's words name who found the target", () => {
  const found = (foundBy: "both" | "tree" | "model"): GroundResult => ({ point: { x: 1.4, y: 2.6 }, confidence: 1, anchor: {}, provenance: PROVENANCE, foundBy });
  assert.equal(locateWords(found("tree"), undefined, undefined), "testsky would press (1, 3): the tree, with no picture for the model.");
  assert.equal(locateWords(found("model"), undefined, "two controls are called OK"), "testsky would press (1, 3): the model; the tree names nothing there.\nThe tree alone: two controls are called OK.");
  assert.equal(locateWords(undefined, "the model and the tree disagree", undefined), "testsky would press nothing: the model and the tree disagree.");
});

/** Saves an instruction run by this playground, as the page does: with the playground's session. */
const saveStep = async (url: string, instruction: unknown, session?: string) => {
  const current = session ?? ((await (await fetch(`${url}/api/status`)).json()) as { session: string }).session;
  return fetch(`${url}/api/steps`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction, session: current }) });
};

test("an instruction that passed is saved as a step, and what it learned goes into the test's memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testsky-save-"));
  const path = join(dir, "checkout.testsky.yaml");
  try {
    await withPlayground(
      fakeEngine({ build: "com.acme.shop@4.2+42" }),
      async (url) => {
        const ran = (await (await post(url, { type: "aiTap", prompt: "the Pay button" })).json()) as ExecuteResponse;
        assert.deepEqual({ ...ran.testsky, session: "" }, { instruction: "instruction-1", session: "", savable: true });
        assert.equal((await saveStep(url, "instruction-1", "from-before-a-restart")).status, 410, "an id from another playground is not this one's");
        const saved = (await (await saveStep(url, "instruction-1")).json()) as Record<string, unknown>;
        assert.deepEqual(saved, { test: path, stepId: "tap-the-pay-button", remembered: true });

        const file = parseTestFile(await readFile(path, "utf8"));
        assert.equal(file.id, "checkout");
        assert.deepEqual(file.targets, [{ platform: "android", app: "com.acme.shop" }]);
        assert.deepEqual(file.setup, [{ kind: "launch" }]);
        assert.deepEqual(file.steps.map((step) => [step.id, step.do]), [["tap-the-pay-button", "tap the Pay button"]]);

        const lock = parseLockFile(await readFile(lockPathFor(path, "android", { width: 360, height: 720 }), "utf8"));
        assert.equal(lock?.layout, "360x720");
        assert.deepEqual(lock?.steps["tap-the-pay-button"]?.actions.map((action) => action.point), [{ x: 180, y: 600 }]);
        // The build it was learned on: without it, the test's first run takes
        // its own build for a new one.
        assert.equal(lock?.appBuild, "com.acme.shop@4.2+42");
        assert.equal(lock?.steps["tap-the-pay-button"]?.do, "tap the Pay button", "the words it was learned for");
        assert.match(lock?.steps["tap-the-pay-button"]?.end?.phash ?? "", /^screen-\d+$/, "and where it was done: a step with nothing to check");

        const again = await saveStep(url, "instruction-1");
        assert.equal(again.status, 409);
        assert.match(((await again.json()) as { error: string }).error, /saved already, as tap-the-pay-button/);

        await post(url, { type: "aiAssert", prompt: "the order is paid" });
        const check = (await (await saveStep(url, "instruction-2")).json()) as Record<string, unknown>;
        assert.equal(check.stepId, "the-order-is-paid");
        assert.deepEqual(parseTestFile(await readFile(path, "utf8")).steps.map((step) => step.id), ["tap-the-pay-button", "the-order-is-paid"], "added to the same file");
      },
      { test: path, app: "com.acme.shop" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a step that failed is saved without memory; a read, an unknown instruction and no test file are refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testsky-save-"));
  const path = join(dir, "bugs.testsky.yaml");
  try {
    await writeFile(path, "# Kept by hand.\nid: bugs\ntargets:\n  - { platform: android, app: com.acme.shop }\nsteps:\n  - do: open the cart\n");
    const failing = fakeEngine({ assert: async () => ({ pass: false, reason: "no order number", provenance: PROVENANCE }) });
    await withPlayground(
      failing,
      async (url) => {
        await post(url, { type: "aiAssert", prompt: "an order number is visible" });
        assert.deepEqual(await (await saveStep(url, "instruction-1")).json(), { test: path, stepId: "an-order-number-is-visible", remembered: false });
        assert.match(await readFile(path, "utf8"), /^# Kept by hand\./, "the person's file is kept as they wrote it");

        await post(url, { type: "aiQuery", prompt: "the total" });
        const read = await saveStep(url, "instruction-2");
        assert.equal(read.status, 400);
        assert.match(((await read.json()) as { error: string }).error, /a read is no step of its own/);

        assert.equal((await saveStep(url, "instruction-9")).status, 404);
      },
      { test: path },
    );
    await withPlayground(fakeEngine(), async (url) => {
      const ran = (await (await post(url, { type: "aiTap", prompt: "the Pay button" })).json()) as ExecuteResponse;
      assert.equal(ran.testsky?.savable, false, "nowhere to save to");
      assert.match(((await (await saveStep(url, "instruction-1")).json()) as { error: string }).error, /--test/);
      assert.equal((await saveStep(url, "instruction-9")).status, 404, "an instruction never run is not one, test file or not");
    });
    await withPlayground(
      fakeEngine(),
      async (url) => {
        await post(url, { type: "aiTap", prompt: "the Pay button" });
        const refused = await saveStep(url, "instruction-1");
        assert.equal(refused.status, 400);
        assert.match(((await refused.json()) as { error: string }).error, /--app/, "no app in front to name, and none given");
      },
      { test: join(dir, "new.testsky.yaml") },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Midscene's verbs become the plain English a step is written in", () => {
  assert.deepEqual(stepFor("aiTap", "the Pay button"), { do: "tap the Pay button" });
  assert.deepEqual(stepFor("aiInput", "the search field", { value: "shoes" }), { do: 'type "shoes" into the search field' });
  assert.deepEqual(stepFor("aiInput", "shoes into the search field"), { do: "type shoes into the search field" });
  assert.deepEqual(stepFor("aiWaitFor", "the cart is empty"), { expect: "the cart is empty" });
  assert.deepEqual(stepFor("aiNumber", "the total"), { extract: { answer: "the total" } });
});
