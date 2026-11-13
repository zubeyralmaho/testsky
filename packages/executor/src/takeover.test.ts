import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { emptyLock, parseTestFile } from "@testsky/artifact";
import type { AimRequest, AssertResult, DeviceHandle, Engine, GroundResult, Observation, PlanRequest, PlanResult, Point, Provenance, TreeNode } from "@testsky/engine-core";
import { CostLedger, NotOnScreenError } from "@testsky/router";

import { conditionalTarget, runTest, type RunEvent } from "./run.ts";

const DEVICE: DeviceHandle = { id: "emulator-5554", platform: "android", osVersion: "15", kind: "emulator" };
const PROVENANCE: Provenance = { tier: 1, model: "fake", usd: 0.002, latencyMs: 5, usedTree: false, channel: "vision" };

function observation(): Observation {
  return {
    frame: { bytes: Buffer.alloc(0), capturedAt: 0, size: { width: 360, height: 720 }, pixelRatio: 3 },
    visionBlind: false,
    visionStats: { meanLuma: 200, stdLuma: 20, uniqueColors: 40 },
    signature: { phash: "aaaabbbbccccdddd", maskedRegions: [] },
    appContext: {},
    observedAt: Date.now(),
  };
}

/**
 * Settings scrolled past its General row by the step before: the row is not
 * on this screen until the list is swiped back down.
 */
function settings(plans: PlanRequest[]): Engine {
  let scrolledBack = false;
  let tapped = false;
  return {
    name: "fake",
    capabilities: { tree: false, frameStream: false, networkCapture: false, nativePlanning: false, appInstall: false },
    attach: async () => {},
    detach: async () => {},
    observe: async () => observation(),
    openFrameStream: async () => undefined,
    ground: async (req): Promise<GroundResult> => {
      if (/General/.test(req.description) && !scrolledBack) throw new Error("the row labelled General is not visible; the list starts with Privacy");
      return { point: { x: 180, y: 300 }, confidence: 0.9, anchor: {}, provenance: PROVENANCE };
    },
    act: async (req) => {
      if (req.name === "swipe") scrolledBack = true;
      if (req.name === "tap" && scrolledBack) tapped = true;
      return { dispatchedAt: Date.now(), stale: false };
    },
    assert: async (): Promise<AssertResult> => ({ pass: tapped, reason: tapped ? "General is open" : "still the list", provenance: PROVENANCE }),
    extract: (async () => ({ data: {}, provenance: PROVENANCE })) as Engine["extract"],
    plan: async (req): Promise<PlanResult> => {
      plans.push(req);
      // An agent told the row was not found, and how the test got here, swipes the list back.
      const missed = req.history.some((entry) => entry.outcome.startsWith("not found on this screen"));
      if (missed && !scrolledBack) return { actions: [{ name: "swipe", params: { direction: "down" } }], done: false, provenance: PROVENANCE };
      return { actions: [{ name: "tap", describeTarget: "the row labelled General" }], done: false, provenance: PROVENANCE };
    },
    popup: async () => ({ found: false, provenance: PROVENANCE }),
    app: { launch: async () => {}, terminate: async () => {}, install: async () => {}, currentBuildId: async () => "com.acme@1.0+1" },
    logs: { open: async () => { throw new Error("no logs"); } },
  };
}

const TEST = parseTestFile(
  `
id: settings
title: Move around Settings
targets:
  - { platform: android, app: com.android.settings }
steps:
  - id: open-general
    do: open the General section
    expect: the screen's title is General
  - id: back
    do: go back to the previous screen
    expect: the settings list is visible
`,
  "settings.testsky.yaml",
);

test("a target that is not on this screen is told to the agent, which goes and gets it", async () => {
  const plans: PlanRequest[] = [];
  const result = await runTest({ engine: settings(plans), test: TEST, device: DEVICE, ledger: new CostLedger(), lock: emptyLock("settings", "android"), settle: false });
  assert.equal(result.steps[0]?.outcome, "PASS", "not FAIL_GROUND on the first miss, and no heal: it tapped the row it had missed");
  const told = plans.find((plan) => plan.history.some((entry) => entry.outcome.startsWith("not found on this screen")));
  assert.ok(told, "the miss is in the history the agent plans from");
});

test("the agent planning a step knows the steps before it, and is not shown the ones after", async () => {
  const plans: PlanRequest[] = [];
  await runTest({ engine: settings(plans), test: TEST, device: DEVICE, ledger: new CostLedger(), lock: emptyLock("settings", "android"), settle: false });
  // Shown the next step, a planner on the A53 started on it every time.
  assert.deepEqual(plans[0]?.journey, { test: "Move around Settings", done: [] });
  const second = plans.find((plan) => plan.goal === "go back to the previous screen");
  assert.deepEqual(second?.journey?.done, ["open the General section (then: the screen's title is General)"]);
});

test("a target that is nowhere still fails the step, after a couple of tries", async () => {
  const plans: PlanRequest[] = [];
  const engine = settings(plans);
  // An agent that keeps asking for the missing row, and never swipes.
  engine.plan = async (req) => {
    plans.push(req);
    return { actions: [{ name: "tap", describeTarget: "the row labelled General" }], done: false, provenance: PROVENANCE };
  };
  const result = await runTest({ engine, test: TEST, device: DEVICE, ledger: new CostLedger(), lock: emptyLock("settings", "android"), settle: false });
  assert.equal(result.outcome, "FAIL_GROUND");
  assert.equal(plans.length, 3, "planned three times: the first try and two more");
});


/** A device whose screen is whatever `now.screen` says, counting the questions a model would be asked. */
interface Device {
  screen: string;
  plans: number;
  checks: number;
  acts: string[];
}

function shot(screen: string): Observation {
  const bytes = Buffer.from(screen);
  return {
    frame: { bytes, capturedAt: 0, size: { width: 360, height: 720 }, pixelRatio: 3 },
    visionBlind: false,
    visionStats: { meanLuma: 200, stdLuma: 20, uniqueColors: 40 },
    signature: { phash: createHash("sha1").update(bytes).digest("hex").slice(0, 16), maskedRegions: [] },
    appContext: {},
    observedAt: Date.now(),
  };
}

/**
 * A profile screen whose Save button is gone. The name typed in the step
 * before already shows, so by default the expectation holds whether anything
 * is saved or not: only the missing button says the app is broken.
 */
function profile(
  now: Device,
  planner: (req: PlanRequest) => PlanResult,
  options: {
    holds?: (now: Device) => boolean;
    find?: (description: string, screen: string) => Point | undefined;
    acted?: (req: { name: string; target?: Point }) => void;
    /** What the accessibility tree says is on screen, for an engine that has one. */
    tree?: TreeNode[];
  } = {},
): Engine {
  const find = options.find ?? ((description: string) => (/Save/.test(description) ? undefined : { x: 300, y: 80 }));
  return {
    name: "fake",
    capabilities: { tree: Boolean(options.tree), frameStream: false, networkCapture: false, nativePlanning: false, appInstall: false },
    attach: async () => {},
    detach: async () => {},
    observe: async (opts) => {
      const seen = shot(now.screen);
      if (!opts?.tree || !options.tree) return seen;
      const root: TreeNode = { ref: "root", role: "Application", enabled: true, interactive: false, bounds: { x: 0, y: 0, width: 440, height: 956 }, children: options.tree };
      return { ...seen, tree: { platform: "ios", capturedAt: 0, source: "xcuitest", truncated: false, captureMs: 1, root } };
    },
    openFrameStream: async () => undefined,
    ground: async (req): Promise<GroundResult> => {
      const point = find(req.description, now.screen);
      if (!point) throw new NotOnScreenError(`could not find "${req.description}" on this screen`);
      // Pixels worth remembering, as on a real row: the tree is not read for them.
      return { point, confidence: 0.9, anchor: { patchPhash: "00c000282902342b" }, provenance: PROVENANCE };
    },
    act: async (req) => {
      now.acts.push(req.name);
      options.acted?.(req);
      return { dispatchedAt: Date.now(), stale: false };
    },
    assert: async (): Promise<AssertResult> => {
      now.checks += 1;
      const held = (options.holds ?? (() => true))(now);
      return { pass: held, reason: held ? "the profile shows Ada" : "it does not hold", provenance: PROVENANCE };
    },
    judgePrint: async (req) => createHash("sha256").update(req.observation.frame.bytes).update(`\n${req.assertion}`).digest("hex").slice(0, 32),
    extract: (async () => ({ data: {}, provenance: PROVENANCE })) as Engine["extract"],
    plan: async (req): Promise<PlanResult> => {
      now.plans += 1;
      return planner(req);
    },
    popup: async () => ({ found: false, provenance: PROVENANCE }),
    app: { launch: async () => {}, terminate: async () => {}, install: async () => {}, currentBuildId: async () => "com.acme@1.0+1" },
    logs: { open: async () => { throw new Error("no logs"); } },
  };
}

const device = (screen = "profile"): Device => ({ screen, plans: 0, checks: 0, acts: [] });

const step = (doing: string, expecting: string) =>
  parseTestFile(
    `
id: profile
title: Edit the profile
targets:
  - { platform: android, app: com.acme }
steps:
  - id: save
    do: ${doing}
    expect: ${expecting}
`,
    "profile.testsky.yaml",
  );
const PROFILE = step("tap Save", "the profile shows the name Ada");

const told = (req: PlanRequest) => req.history.some((entry) => entry.outcome.startsWith("not found on this screen"));
const tapOn = (describeTarget: string): PlanResult => ({ actions: [{ name: "tap", describeTarget }], done: false, provenance: PROVENANCE });
const DONE: PlanResult = { actions: [], done: true, provenance: PROVENANCE };
/** An agent that, told Save is not there, taps Done instead, and then calls it finished. */
const detour = (save = "the Save button") => (req: PlanRequest): PlanResult =>
  !told(req) ? tapOn(save) : req.history.some((entry) => entry.description === "the Done button") ? DONE : tapOn("the Done button");

const run = (engine: Engine, lock = emptyLock("profile", "android"), test = PROFILE) =>
  runTest({ engine, test, device: DEVICE, ledger: new CostLedger(), lock, settle: false });

test("a step that missed its target and then did nothing fails, whatever the screen shows", async () => {
  const now = device();
  const result = await run(profile(now, (req) => (told(req) ? DONE : tapOn("the Save button"))));
  assert.equal(result.outcome, "FAIL_GROUND", "not a pass on a name that was already there");
  assert.match(result.steps[0]!.detail, /could not locate "the Save button"/);
  assert.deepEqual(now.acts, [], "nothing was done");
});

test("a step that acted, then missed its target and did nothing more, fails too, however the screen turns out", async () => {
  // The name arrives by itself: while Save is looked for, or once the agent has given up.
  for (const arrives of ["while looking", "after giving up"] as const) {
    const now = device();
    const planner = (req: PlanRequest): PlanResult => {
      if (!now.acts.length) return tapOn("the Edit button");
      if (!told(req)) return tapOn("the Save button");
      if (arrives === "after giving up") now.screen = "profile, Ada";
      return DONE;
    };
    const find = (description: string) => {
      if (!/Save/.test(description)) return { x: 300, y: 80 };
      if (arrives === "while looking") now.screen = "profile, Ada";
      return undefined;
    };
    const result = await run(profile(now, planner, { find, holds: (seen) => seen.screen === "profile, Ada" }));
    assert.equal(result.outcome, "FAIL_GROUND", arrives);
    assert.match(result.steps[0]!.detail, /could not locate "the Save button"/);
  }
});

test("a step that passed by going around a target it could not find is a heal for a person to look at", async () => {
  const lock = emptyLock("profile", "android");
  const result = await run(profile(device(), detour()), lock);
  assert.equal(result.outcome, "HEALED_PASS", "not a quiet pass");
  assert.deepEqual(lock.heals[0]?.before, { action: "tap", describeTarget: "the Save button" });
  assert.equal(lock.heals[0]?.after.describeTarget, "the Done button");
  assert.equal(lock.heals[0]?.status, "pending_review");
});

test("a detour that lands where the remembered tap was is still a heal, when the memory could not be checked", async () => {
  const lock = emptyLock("profile", "android");
  // Remembered with nothing to check it by, at the very place Discard now sits.
  lock.steps.save = {
    screen: { phash: shot("profile").signature.phash },
    actions: [{ action: "tap", describeTarget: "the Save button", point: { x: 300, y: 80 } }],
    tier: 1,
    confidence: 0.9,
    stability: { runs: 3, passes: 3 },
  };
  const planner = (req: PlanRequest) => (told(req) ? (req.history.some((entry) => /Discard/.test(entry.description)) ? DONE : tapOn("the Discard button")) : tapOn("the Save button"));
  const result = await run(profile(device(), planner), lock);
  assert.equal(result.outcome, "HEALED_PASS");
  assert.equal(lock.heals.at(-1)?.after.describeTarget, "the Discard button");
});

test("a step that failed after going around a target it could not find says so, and does not accuse the app", async () => {
  const result = await run(profile(device(), detour(), { holds: () => false }));
  assert.equal(result.outcome, "FAIL_GROUND", "where the detour led says nothing about the app");
  assert.match(result.steps[0]!.detail, /could not locate "the Save button".*the agent went on without it/);
});

/** Settings scrolled past General: found again, in other words, once the list is back. */
function scrolled(now: Device) {
  const planner = (req: PlanRequest): PlanResult => {
    if (!told(req)) return tapOn("the row labelled General or General management");
    if (now.screen === "settings, scrolled") return { actions: [{ name: "swipe", params: { direction: "down" } }], done: false, provenance: PROVENANCE };
    return now.acts.includes("tap") ? DONE : tapOn("the General row");
  };
  const find = (description: string, screen: string) => (screen === "settings, top" && /General/.test(description) ? { x: 100, y: 300 } : undefined);
  const acted = (req: { name: string }) => {
    if (req.name === "swipe") now.screen = "settings, top";
    if (req.name === "tap") now.screen = "general";
  };
  return { planner, find, acted };
}

test("a target the agent missed and then found in other words, on a screen that moved, was gone and got", async () => {
  const now = device("settings, scrolled");
  const { planner, find, acted } = scrolled(now);
  const lock = emptyLock("profile", "android");
  const test = step("open General", "the screen's title is General");
  const passed = await run(profile(now, planner, { find, acted, holds: (seen) => seen.screen === "general" }), lock, test);
  assert.equal(passed.outcome, "PASS", "no heal: it is the row that was meant");
  assert.equal(lock.heals.length, 0);

  // And when the app is broken there, it is the app's verdict, not a lost target.
  const again = device("settings, scrolled");
  const broken = scrolled(again);
  const failed = await run(profile(again, broken.planner, { find: broken.find, acted: broken.acted, holds: () => false }), emptyLock("profile", "android"), test);
  assert.equal(failed.outcome, "FAIL_ASSERT");
});

test("found again in other words is judged by the row it presses, not by where on the row a grounder lands", async () => {
  const now = device("settings, scrolled");
  const { planner, acted } = scrolled(now);
  // The missed words land in the middle of the row; the agent's own words, on its label.
  const find = (description: string, screen: string) =>
    screen !== "settings, top" || !/General/.test(description) ? undefined : /General management/.test(description) ? { x: 220, y: 300 } : { x: 100, y: 300 };
  const row: TreeNode = { ref: "row", role: "Cell", enabled: true, interactive: true, bounds: { x: 20, y: 280, width: 400, height: 50 }, children: [] };
  const lock = emptyLock("profile", "android");
  const result = await run(profile(now, planner, { find, acted, tree: [row], holds: (seen) => seen.screen === "general" }), lock, step("open General", "the screen's title is General"));
  assert.equal(result.outcome, "PASS", "120 points apart on one row is one row");
  assert.equal(lock.heals.length, 0);
});

test("pressing a row is not pressing the button inside it, however a grounder lands", async () => {
  const now = device("wifi, scrolled");
  const planner = (req: PlanRequest): PlanResult => {
    if (!told(req)) return tapOn("the More Info button of TestNet");
    if (now.screen === "wifi, scrolled") return { actions: [{ name: "swipe", params: { direction: "down" } }], done: false, provenance: PROVENANCE };
    return now.acts.includes("tap") ? DONE : tapOn("the TestNet row");
  };
  // Back at the top, the missed words land on the row's (i) button; the agent's own, on the network's name.
  const find = (description: string, screen: string) =>
    screen !== "wifi, top" ? undefined : /More Info/.test(description) ? { x: 396, y: 301 } : { x: 100, y: 305 };
  const acted = (req: { name: string }) => {
    if (req.name === "swipe") now.screen = "wifi, top";
    if (req.name === "tap") now.screen = "wifi, joined";
  };
  const info: TreeNode = { ref: "info", role: "Button", label: "More Info", enabled: true, interactive: true, bounds: { x: 380, y: 285, width: 32, height: 32 }, children: [] };
  const row: TreeNode = { ref: "row", role: "Cell", label: "TestNet", enabled: true, interactive: true, bounds: { x: 20, y: 280, width: 400, height: 50 }, children: [info] };
  const lock = emptyLock("profile", "android");
  const result = await run(profile(now, planner, { find, acted, tree: [row], holds: (seen) => seen.screen === "wifi, joined" }), lock, step("open TestNet's details", "the network's details are shown"));
  assert.equal(result.outcome, "HEALED_PASS", "it joined the network instead: a detour, for a person to look at");
  assert.equal(lock.heals[0]?.before.describeTarget, "the More Info button of TestNet");
});

test("a target pressed once and missed on a second go was not gone around", async () => {
  const now = device();
  const find = (description: string) => {
    if (!/Save/.test(description) || !now.acts.length) return { x: 300, y: 80 };
    now.screen = "profile, Ada"; // the first press closed the form, and the name has arrived since
    return undefined;
  };
  const acted = () => {
    now.screen = "profile, saving";
  };
  const result = await run(profile(now, () => tapOn("the Save button"), { find, acted, holds: (seen) => seen.screen === "profile, Ada" }));
  assert.equal(result.outcome, "PASS", "Save was pressed; the second go found it gone because it had worked");
});

test("an action that went stale gives back the look it took for a missed target", async () => {
  const now = device("settings, scrolled");
  const { planner, find, acted } = scrolled(now);
  const engine = profile(now, planner, { find, acted, holds: (seen) => seen.screen === "general" });
  const act = engine.act;
  let stale = true;
  engine.act = async (req) => {
    if (req.name === "tap" && stale) {
      stale = false;
      return { dispatchedAt: Date.now(), stale: true };
    }
    return act(req);
  };
  const lock = emptyLock("profile", "android");
  const result = await run(engine, lock, step("open General", "the screen's title is General"));
  assert.equal(result.outcome, "PASS", "looked for again when the tap was decided again, and found");
  assert.equal(lock.heals.length, 0);
});

test("the same detour, reworded by the agent, once a person has rejected it, fails the run", async () => {
  const lock = emptyLock("profile", "android");
  await run(profile(device(), detour("the Save button")), lock);
  const heal = lock.heals[0]!;
  const decision = { step: heal.step, status: "rejected" as const, before: heal.before, after: heal.after, reviewedAt: new Date().toISOString() };
  const again = await runTest({ engine: profile(device(), detour("Save button")), test: PROFILE, device: DEVICE, ledger: new CostLedger(), lock, settle: false, healDecisions: [decision] });
  assert.equal(again.outcome, "FAIL_REJECTED_HEAL");
});

test("a question a model said no to is not asked again of the same screen", async () => {
  const now = device();
  const planner = (req: PlanRequest) => (!now.acts.length ? tapOn("the Edit button") : told(req) ? tapOn("the Done button") : tapOn("the Save button"));
  const find = (description: string) => (/Save/.test(description) ? undefined : /Done/.test(description) ? { x: 300, y: 900 } : { x: 300, y: 80 });
  const acted = (req: { target?: Point }) => {
    if (req.target?.y === 900) now.screen = "profile, saved";
  };
  await run(profile(now, planner, { find, acted, holds: (seen) => seen.screen === "profile, saved" }));
  // Edit, then a check; Save missed, and no check of a screen that has not changed; Done, then a check.
  assert.equal(now.plans, 3);
  assert.equal(now.checks, 2);
});

test("the missed target, pressed at last in the same words, counts even when that press is the last straw", async () => {
  const now = device();
  let grounds = 0;
  const plans = [tapOn("the Save button"), { actions: [{ name: "wait" as const }], done: false, provenance: PROVENANCE }, { actions: [{ name: "wait" as const }], done: false, provenance: PROVENANCE }, tapOn("the Save button")];
  const find = () => (++grounds === 1 ? undefined : { x: 300, y: 80 });
  const result = await run(profile(now, () => plans[Math.min(now.plans - 1, plans.length - 1)]!, { find, holds: () => false }));
  assert.equal(result.outcome, "LOOP_DETECTED", "Save was pressed; the screen just never changed");
});

const YOUTUBE = "open the first video in the results that is not an ad, and if an ad plays before it, skip it as soon as it offers a skip button";

test("a target is the step's to ask for only if something comes about when it belongs to the part under the condition", () => {
  assert.equal(conditionalTarget(YOUTUBE, "the Atla (Reklamı atla) skip ad button"), true);
  assert.equal(conditionalTarget(YOUTUBE, "the first video in the results"), false, "the video is owed whatever the ad does");
  assert.equal(conditionalTarget(YOUTUBE, "Atla"), false, "no words in common with either part: still owed");
  const dialog = "if a dialog shows, close it and then tap Save";
  assert.equal(conditionalTarget(dialog, "the Close button of the dialog"), true);
  assert.equal(conditionalTarget(dialog, "the Save button"), false);
  assert.equal(conditionalTarget("if asked, tap Sign in", "the Login button"), false, "a target in other words than the condition's part is still owed");
  assert.equal(conditionalTarget("reklam çıkarsa geç ve videoyu aç", "reklamı geç butonu"), true);
  assert.equal(conditionalTarget("reklam çıkarsa geç ve videoyu aç", "ilk video"), false);
  assert.equal(conditionalTarget("bildirim izni soruluyorsa izin ver", "izin ver düğmesi"), true);
  assert.equal(conditionalTarget('tap "Notify If Left Behind"', 'the "Notify If Left Behind" switch'), false, "a quoted name is no condition");
  assert.equal(conditionalTarget("tap 'Notify If Left Behind'", "the Notify If Left Behind switch"), false, "in single quotes too");
  assert.equal(conditionalTarget("reklam çıkarsa Atla'ya bas", "Atla düğmesi"), true, "an apostrophe in Turkish is no quote");
  assert.equal(conditionalTarget('if a dialog shows, tap "Not now"', 'the "Not now" button'), true, "and still the words its target is known by");
  for (const plain of [
    "tap Save",
    "when the edit form opens, tap Save",
    "skip the ad as soon as it offers a skip button",
    "tap the video once so its controls show",
    "tap Reverse on Güneş_5G",
    "form açılınca Save'e bas",
    "form açıldığında Save'e bas",
  ]) {
    assert.equal(conditionalTarget(plain, "the Save button"), false, `${plain}: says what comes after what, not whether`);
  }
});

/** YouTube on an iPhone 14: the agent goes for Skip before the ad offers it. */
function youtube(now: Device, { offered = false }: { offered?: boolean } = {}) {
  const planner = (req: PlanRequest): PlanResult => {
    if (!now.acts.length) return tapOn("the first video in the results");
    if (!told(req)) return tapOn("the Atla (Reklamı atla) skip ad button");
    // While the agent looked, the ad ended by itself -- or put up its Skip, unpressed.
    now.screen = offered ? "video, skip offered" : "video";
    return DONE;
  };
  const find = (description: string, screen: string) =>
    /skip/i.test(description) ? (screen === "video, skip offered" ? { x: 330, y: 200 } : undefined) : screen === "results" ? { x: 180, y: 300 } : undefined;
  const acted = (req: { name: string }) => {
    if (req.name === "tap") now.screen = "ad";
  };
  return { planner, find, acted };
}

test("a target the step asks for only if it comes about, gone without coming about, does not stop the step passing", async () => {
  const now = device("results");
  const { planner, find, acted } = youtube(now);
  const events: RunEvent[] = [];
  const lock = emptyLock("profile", "android");
  const result = await runTest({
    engine: profile(now, planner, { find, acted, holds: (seen) => seen.screen.startsWith("video") }),
    test: step(YOUTUBE, "the video itself plays, not an advertisement"),
    device: DEVICE,
    ledger: new CostLedger(),
    lock,
    settle: false,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.outcome, "PASS", "the ad ended before it offered a skip: nothing was owed");
  assert.equal(lock.heals.length, 0, "and nothing was gone around");
  assert.ok(events.some((event) => event.kind === "note" && /"the Atla \(Reklamı atla\) skip ad button" was never pressed/.test(event.message)));

  // The same miss, with the video owed by the part that does not wait: still a miss.
  const owed = device("results");
  const missing = await run(
    profile(owed, (req) => (told(req) ? DONE : tapOn("the first video in the results")), { find: () => undefined }),
    emptyLock("profile", "android"),
    step(YOUTUBE, "the video itself plays, not an advertisement"),
  );
  assert.equal(missing.outcome, "FAIL_GROUND");
});

test("a target the step asks for if it comes about, there and unpressed, was owed", async () => {
  const now = device("results");
  const { planner, find, acted } = youtube(now, { offered: true });
  // An expectation loose enough to hold with the skip button up.
  const holds = (seen: Device) => seen.screen.startsWith("video");
  const result = await run(profile(now, planner, { find, acted, holds }), emptyLock("profile", "android"), step(YOUTUBE, "the video plays"));
  assert.equal(result.outcome, "FAIL_GROUND", "the skip button is up and nobody pressed it");
  assert.match(result.steps[0]!.detail, /skip ad button/);
});

test("a target the tree still finds was owed, whatever a model says of it", async () => {
  const now = device("results");
  const { planner, find, acted } = youtube(now);
  // The tree lists a Skip button, drawn, where the model sees none.
  const skip: TreeNode = { ref: "skip", role: "Button", label: "Skip ad", enabled: true, interactive: true, bounds: { x: 300, y: 180, width: 80, height: 36 }, children: [] };
  const holds = (seen: Device) => seen.screen.startsWith("video");
  const result = await run(profile(now, planner, { find, acted, holds, tree: [skip] }), emptyLock("profile", "android"), step(YOUTUBE, "the video plays"));
  assert.equal(result.outcome, "FAIL_GROUND");
});

test("a waited-on target that never came about never turns a failure into the app's", async () => {
  const now = device("results");
  const { planner, find, acted } = youtube(now);
  const result = await run(profile(now, planner, { find, acted, holds: () => false }), emptyLock("profile", "android"), step(YOUTUBE, "the video itself plays, not an advertisement"));
  assert.equal(result.outcome, "FAIL_GROUND", "nothing it asked for was pressed: not the app's verdict");
});

test("a waited-on target gone around by pressing something else is still a detour for a person to look at", async () => {
  const lock = emptyLock("profile", "android");
  const result = await run(profile(device(), detour()), lock, step("if the form shows a Save button, tap Save", "the profile shows the name Ada"));
  assert.equal(result.outcome, "HEALED_PASS", "Done was pressed instead: not moot");
  assert.equal(lock.heals[0]?.before.describeTarget, "the Save button");
});

const ADDRESS = 'go to the address "https://www.google.com" in the address bar';
const typeInto = (describeTarget: string): PlanResult => ({
  actions: [{ name: "input", describeTarget, params: { value: "https://www.google.com" } }],
  done: false,
  provenance: PROVENANCE,
});
/** Safari opened on the last test's results page: typed into, the page's own search box searches for the address. */
function browser(now: Device, aim: (req: AimRequest) => boolean, { tree, confirmed = false }: { tree?: TreeNode[]; confirmed?: boolean } = {}) {
  const asked: AimRequest[] = [];
  const engine = profile(now, (req) => (now.acts.length ? DONE : typeInto("the search box at the top")), {
    acted: () => {
      now.screen = "results for the address";
    },
    holds: () => false,
    ...(tree ? { tree } : {}),
  });
  engine.aim = async (req) => {
    asked.push(req);
    const onTarget = aim(req);
    return {
      onTarget,
      reason: onTarget ? "the ring is on the address bar" : "the ring is on the page's own search box",
      ...(!onTarget && confirmed ? { confirmed: true } : {}),
      provenance: PROVENANCE,
    };
  };
  return { engine, asked };
}

test("before an app is blamed, where the agent typed is asked: somewhere the step does not name is a lost target", async () => {
  const now = device("results");
  const { engine, asked } = browser(now, () => false);
  const result = await run(engine, emptyLock("profile", "android"), step(ADDRESS, "the Google home page is shown"));
  assert.equal(result.outcome, "FAIL_GROUND", "not the app's verdict");
  assert.match(result.steps[0]!.detail, /^the agent typed into "the search box at the top", which is not what the step names: the ring is on the page's own search box; and then: it does not hold/);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.instruction, ADDRESS);
  assert.equal(asked[0]!.text, "https://www.google.com");
  assert.deepEqual(asked[0]!.point, { x: 300, y: 80 });
  assert.equal(Buffer.from(asked[0]!.observation.frame.bytes).toString(), "results", "asked of the screen it was decided on, not where it led");
});

test("where the agent went to what the step names, the app is blamed, and the report says it was checked", async () => {
  const now = device("results");
  const { engine } = browser(now, () => true);
  const events: RunEvent[] = [];
  const result = await runTest({ engine, test: step(ADDRESS, "the Google home page is shown"), device: DEVICE, ledger: new CostLedger(), lock: emptyLock("profile", "android"), settle: false, onEvent: (event) => events.push(event) });
  assert.equal(result.outcome, "FAIL_ASSERT");
  assert.ok(events.some((event) => event.kind === "note" && event.message === "checked where the agent last pressed and typed before blaming the app: it went to what the step names"));
});

/** A memory of typing into the page's own search box, which checks out by the tree as it did when it was learned. */
function wrongMemory(lock: ReturnType<typeof emptyLock>) {
  const bounds = { x: 20, y: 115, width: 300, height: 34 };
  lock.steps.save = {
    do: ADDRESS,
    screen: { phash: shot("results").signature.phash },
    actions: [
      {
        action: "input",
        describeTarget: "the search box at the top showing 'weather'",
        params: { value: "https://www.google.com" },
        point: { x: 171, y: 132 },
        anchor: { tree: { role: "TextField", label: "Search", bounds } },
      },
    ],
    tier: 1,
    confidence: 0.9,
    stability: { runs: 4, passes: 4 },
  };
  const search: TreeNode = { ref: "q", role: "TextField", label: "Search", value: "https://www.google.com", enabled: true, interactive: true, bounds, children: [] };
  return [search];
}

test("a memory that typed where the step does not say is for a person to look at, and kept on one model's word", async () => {
  const lock = emptyLock("profile", "android");
  const tree = wrongMemory(lock);
  const result = await run(browser(device("results"), () => false, { tree }).engine, lock, step(ADDRESS, "the Google home page is shown"));
  assert.equal(result.outcome, "FAIL_GROUND");
  assert.match(result.steps[0]!.detail, /^the memory typed into "the search box at the top showing 'weather'"/);
  assert.ok(lock.steps.save, "one model is not enough to make every phone of this layout work the step out again");
  assert.equal(lock.heals.length, 1);
  assert.equal(lock.heals[0]!.status, "pending_review");
  assert.equal(lock.heals[0]!.before.describeTarget, "the search box at the top showing 'weather'");
  assert.match(lock.heals[0]!.reason, /which is not what the step names: the ring is on the page's own search box; the step then failed/);
});

test("a memory gone astray every run is filed for review once", async () => {
  const lock = emptyLock("profile", "android");
  const tree = wrongMemory(lock);
  for (let run = 0; run < 2; run += 1) {
    await runTest({ engine: browser(device("results"), () => false, { tree }).engine, test: step(ADDRESS, "the Google home page is shown"), device: DEVICE, ledger: new CostLedger(), lock, settle: false });
  }
  assert.equal(lock.heals.length, 1);
});

test("a memory a person ruled went where the step says leaves the failure the app's", async () => {
  const lock = emptyLock("profile", "android");
  const tree = wrongMemory(lock);
  const remembered = lock.steps.save!.actions[0]!;
  lock.heals.push({
    step: "save",
    at: "2026-10-27T00:00:00Z",
    reason: "went astray",
    before: { action: remembered.action, describeTarget: remembered.describeTarget!, point: remembered.point!, anchor: remembered.anchor! },
    after: {},
    confidence: 0.9,
    status: "rejected",
    kind: "astray",
  });
  const events: RunEvent[] = [];
  const result = await runTest({ engine: browser(device("results"), () => false, { tree }).engine, test: step(ADDRESS, "the Google home page is shown"), device: DEVICE, ledger: new CostLedger(), lock, settle: false, onEvent: (event) => events.push(event) });
  assert.equal(result.outcome, "FAIL_ASSERT");
  assert.ok(events.some((event) => event.kind === "note" && /a person ruled it is what the step names/.test(event.message)));
});

test("a memory a person agreed went astray is forgotten before the step, and the step worked out anew", async () => {
  const lock = emptyLock("profile", "android");
  const tree = wrongMemory(lock);
  const remembered = lock.steps.save!.actions[0]!;
  lock.heals.push({
    step: "save",
    at: "2026-10-27T00:00:00Z",
    reason: "went astray",
    before: { action: remembered.action, describeTarget: remembered.describeTarget!, point: remembered.point!, anchor: remembered.anchor! },
    after: {},
    confidence: 0.9,
    status: "accepted",
    kind: "astray",
  });
  const result = await run(browser(device("results"), () => false, { tree }).engine, lock, step(ADDRESS, "the Google home page is shown"));
  assert.match(result.steps[0]!.detail, /^the agent typed into/, "the agent's own, not the memory's");
  assert.equal(lock.steps.save, undefined);
  assert.equal(lock.heals.filter((heal) => heal.status === "accepted").length, 0, "spent: a memory learned anew on the same control is not forgotten again");
});

test("a memory two models say typed where the step does not say is forgotten, and worked out again next time", async () => {
  const lock = emptyLock("profile", "android");
  const tree = wrongMemory(lock);
  const result = await run(browser(device("results"), () => false, { tree, confirmed: true }).engine, lock, step(ADDRESS, "the Google home page is shown"));
  assert.equal(result.outcome, "FAIL_GROUND");
  assert.equal(lock.steps.save, undefined, "not replayed into the same failure run after run");
  assert.equal(lock.heals.length, 1, "and what was forgotten is on record");
});

test("only the last press is asked about: one gone back from on the way is not held against the agent", async () => {
  // A Nothing Phone: a remembered tap on the Display row opened Notifications; the agent backed out and pressed Display again.
  const now = device("settings");
  const bounds = { x: 0, y: 400, width: 413, height: 50 };
  const row: TreeNode = { ref: "row", role: "LinearLayout", label: "Display", enabled: true, interactive: true, bounds, children: [] };
  const display = "the Display entry in the settings list";
  const engine = profile(now, (req) => (now.screen === "display" ? DONE : tapOn(display)), {
    find: () => ({ x: 207, y: 648 }),
    acted: (req) => {
      now.screen = req.target?.y === 424 ? "notifications" : "display";
    },
    holds: () => false,
    tree: [row],
  });
  const asked: AimRequest[] = [];
  engine.aim = async (req) => {
    asked.push(req);
    const onTarget = req.point.y !== 424;
    return { onTarget, reason: onTarget ? "the ring is on the Display row" : "the ring is on the Notifications row", provenance: PROVENANCE };
  };
  const lock = emptyLock("profile", "android");
  lock.steps.save = {
    do: "open the display settings",
    screen: { phash: shot("settings").signature.phash },
    actions: [{ action: "tap", describeTarget: display, point: { x: 207, y: 424 }, anchor: { tree: { role: "LinearLayout", label: "Display", bounds } } }],
    tier: 1,
    confidence: 0.9,
    stability: { runs: 3, passes: 3 },
  };
  const result = await run(engine, lock, step("open the display settings", "a page of display settings is open"));
  assert.equal(result.outcome, "FAIL_ASSERT", "the Display page that came of the second press is the app's");
  assert.equal(now.acts.filter((name) => name === "tap").length, 2, "the remembered press, then the agent's");
  assert.deepEqual(asked.map((req) => req.point), [{ x: 207, y: 648 }], "only the press that stands is asked about");
});

test("the agent is told which way it swiped, not only that it did", async () => {
  const plans: PlanRequest[] = [];
  const events: RunEvent[] = [];
  await runTest({ engine: settings(plans), test: TEST, device: DEVICE, ledger: new CostLedger(), lock: emptyLock("settings", "android"), settle: false, onEvent: (event) => events.push(event) });
  const swiped = plans.flatMap((plan) => plan.history).find((entry) => entry.action === "swipe");
  assert.equal(swiped?.description, "down", "so a swipe that changed nothing names the end it reached");
  assert.ok(events.some((event) => event.kind === "action" && event.message === "swipe down"), "and so is whoever reads the report");
});

const CLOSES = parseTestFile(
  `
id: closes
title: Closes the app
targets:
  - { platform: android, app: com.acme }
policy:
  budget: { max_seconds: 1 }
setup:
  - launch app
steps:
  - id: one
    do: tap Save
    expect: saved
teardown:
  - terminate app
`,
  "closes.testsky.yaml",
);

test("a run that throws still closes the app, once, and a teardown that fails changes no verdict", async () => {
  const engine = profile(device(), () => { throw new Error("the phone went away"); });
  let closed = 0;
  engine.app.terminate = async () => { closed += 1; };
  const thrown = await run(engine, emptyLock("closes", "android"), CLOSES);
  assert.equal(thrown.outcome, "DEVICE_ERROR");
  assert.equal(closed, 1);

  const passing = profile(device(), () => DONE);
  passing.app.terminate = async () => { throw new Error("already gone"); };
  const passed = await run(passing, emptyLock("closes", "android"), CLOSES);
  assert.equal(passed.outcome, "PASS");
});

test("a press dropped twice on a screen that keeps moving is pressed the third time, and judged without waiting for rest", async () => {
  const now = device("live");
  const guards: boolean[] = [];
  const settles: (boolean | undefined)[] = [];
  const engine = profile(now, (req) => (now.acts.length ? DONE : tapOn("the video")), { holds: (seen) => seen.screen === "controls" });
  let frame = 0;
  engine.observe = async (opts) => {
    settles.push(opts?.settle);
    frame += 1;
    return shot(`${now.screen}-${frame}`);
  };
  const act = engine.act;
  engine.act = async (req) => {
    guards.push(Boolean(req.staleGuard));
    if (req.staleGuard) return { dispatchedAt: Date.now(), stale: true };
    now.screen = "controls";
    return act(req);
  };
  engine.assert = async (req) => {
    const pass = Buffer.from(req.observation.frame.bytes).toString().startsWith("controls");
    return { pass, reason: pass ? "controls" : "no controls", provenance: PROVENANCE };
  };
  const result = await runTest({ engine, test: step("tap the video once", "the player's controls show"), device: DEVICE, ledger: new CostLedger(), lock: emptyLock("profile", "android"), settle: true });
  assert.equal(result.outcome, "PASS");
  assert.deepEqual(guards, [true, true, false]);
  assert.ok(settles.includes(false), "the frame after the press is not waited on");
});
