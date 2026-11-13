import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import type { DeviceHandle } from "@testsky/engine-core";

import { laneLabels, lanesExitCode, lanesSummary, planLanes, RunGroups, runLanes, unplaced, type Lane, type LaneRow, type LaneTest } from "./lanes.ts";

const phone = (id: string, platform: DeviceHandle["platform"] = "android"): DeviceHandle => ({ id, platform, osVersion: "", kind: "physical" });
const connect: LaneTest = { path: "/t/wifi-connect.testsky.yaml", id: "wifi-connect", platforms: ["android", "ios"] };
const forget: LaneTest = { path: "/t/wifi-forget.testsky.yaml", id: "wifi-forget", platforms: ["android"] };

/**
 * A stand-in for `testsky run`: says a line, waits, and writes the result a
 * run writes -- with when it ran, to see what ran beside what.
 */
const RUN = `
  const [file, test, outcome, wait] = process.argv.slice(1);
  const started = Date.now();
  console.log("\\u001b[2m  -> " + test + "\\u001b[0m");
  setTimeout(() => {
    if (outcome === "none") { console.error("adb could not list devices"); process.exit(2); }
    require("node:fs").writeFileSync(file, JSON.stringify({ outcome, detail: started + "-" + Date.now(), usd: 0.01, ms: 1500 }));
    process.exit(outcome === "PASS" ? 0 : outcome === "FAIL_ASSERT" ? 1 : 2);
  }, Number(wait));
`;

function lanesOf(lanes: Lane[], outcome: (device: DeviceHandle, test: LaneTest) => string, options: { parallel?: number; wait?: number } = {}) {
  const printed: string[] = [];
  const rows = runLanes(lanes, {
    parallel: options.parallel ?? lanes.length,
    print: (line) => printed.push(line),
    start: (device, test, resultFile) =>
      spawn(process.execPath, ["-e", RUN, resultFile, test.id, outcome(device, test), String(options.wait ?? 150)], { stdio: ["ignore", "pipe", "pipe"] }),
  });
  return { rows, printed };
}

const window = (row: LaneRow) => row.detail!.split("-").map(Number) as [number, number];
const overlap = (a: LaneRow, b: LaneRow) => window(a)[0] < window(b)[1] && window(b)[0] < window(a)[1];

test("each phone gets the tests written for its platform, in the order given", () => {
  const lanes = planLanes([connect, forget], [phone("R58M"), phone("6F1C0D2A-0B3B-4C5D-8E9F-001122334455", "ios"), phone("watch", "ios")]);
  assert.deepEqual(
    lanes.map((lane) => [lane.device.id, lane.tests.map((test) => test.id)]),
    [
      ["R58M", ["wifi-connect", "wifi-forget"]],
      ["6F1C0D2A-0B3B-4C5D-8E9F-001122334455", ["wifi-connect"]],
      ["watch", ["wifi-connect"]],
    ],
  );
  assert.deepEqual(planLanes([forget], [phone("6F1C", "ios")]), [], "a phone with nothing to run is left out");
});

test("a phone's label is short when that still tells the phones apart", () => {
  const short = laneLabels([phone("emulator-5554"), phone("6F1C0D2A-0B3B-4C5D-8E9F-001122334455", "ios")]);
  assert.deepEqual([...short.values()], ["emulator-5554", "6F1C0D2A     "]);
  const clash = laneLabels([phone("6F1C0D2A-0B3B-4C5D-8E9F-001122334455", "ios"), phone("6F1C0D2A-FFFF-4C5D-8E9F-001122334455", "ios")]);
  assert.deepEqual([...clash.values()], ["6F1C0D2A-0B3B-4C5D-8E9F-001122334455", "6F1C0D2A-FFFF-4C5D-8E9F-001122334455"]);
});

test("phones run side by side, and each phone's tests one after another", async () => {
  const { rows, printed } = lanesOf(planLanes([connect, forget], [phone("R58M"), phone("emulator-5554")]), () => "PASS");
  const all = await rows;
  assert.deepEqual(
    all.map((row) => [row.device, row.test, row.outcome, row.code]),
    [
      ["R58M", "wifi-connect", "PASS", 0],
      ["R58M", "wifi-forget", "PASS", 0],
      ["emulator-5554", "wifi-connect", "PASS", 0],
      ["emulator-5554", "wifi-forget", "PASS", 0],
    ],
  );
  assert.equal(overlap(all[0]!, all[1]!), false, "one phone does one thing at a time");
  assert.equal(overlap(all[0]!, all[2]!), true, "two phones do two");
  assert.ok(printed.includes("R58M           \u001b[2m  -> wifi-connect\u001b[0m"), "every line says which phone it is from");
});

test("with one phone at a time, no two phones overlap", async () => {
  const all = await lanesOf(planLanes([connect], [phone("R58M"), phone("emulator-5554")]), () => "PASS", { parallel: 1 }).rows;
  assert.equal(overlap(all[0]!, all[1]!), false);
});

test("lines a run on several phones does not pass on are not printed, nor taken for what it last said", async () => {
  const printed: string[] = [];
  const all = await runLanes(planLanes([forget], [phone("R58M")]), {
    parallel: 1,
    print: (line) => printed.push(line),
    drop: (line) => line.startsWith("dbug ADB"),
    start: (_device, _test, resultFile) =>
      spawn(process.execPath, ["-e", "console.log('  -> wifi-forget'); console.log('dbug ADB Running adb -s R58M shell wm size'); process.exit(2)", resultFile], { stdio: ["ignore", "pipe", "pipe"] }),
  });
  assert.deepEqual(printed, ["R58M    -> wifi-forget"]);
  assert.equal(all[0]!.detail, "-> wifi-forget");
});

test("a run that ends without a result is reported with the last thing it said", async () => {
  const all = await lanesOf(planLanes([connect], [phone("R58M")]), () => "none", { wait: 10 }).rows;
  assert.deepEqual([all[0]!.outcome, all[0]!.detail, all[0]!.code], ["NO_RESULT", "adb could not list devices", 2]);
});

test("once stopped, no test is started, and the ones left say so", async () => {
  const lanes = planLanes([connect, forget], [phone("R58M")]);
  let started = 0;
  const all = await runLanes(lanes, {
    parallel: 1,
    print: () => undefined,
    stopped: () => started > 0,
    start: (_device, test, resultFile) => {
      started += 1;
      return spawn(process.execPath, ["-e", RUN, resultFile, test.id, "PASS", "10"], { stdio: ["ignore", "pipe", "pipe"] });
    },
  });
  assert.deepEqual(all.map((row) => row.outcome), ["PASS", "NOT_RUN"]);
});

test("all green is 0; an app at fault is 1 over a run that could not tell; and the table says each", async () => {
  const outcomes: Record<string, string> = { R58M: "PASS", "emulator-5554": "FAIL_ASSERT", "emulator-5556": "BUDGET_EXHAUSTED" };
  const all = await lanesOf(planLanes([connect], [phone("R58M"), phone("emulator-5554"), phone("emulator-5556")]), (device) => outcomes[device.id]!).rows;
  assert.equal(lanesExitCode(all), 1);
  assert.equal(lanesExitCode(all.filter((row) => row.outcome !== "FAIL_ASSERT")), 2);
  assert.equal(lanesExitCode(all.filter((row) => row.outcome === "PASS")), 0);
  assert.equal(lanesExitCode([]), 2, "nothing run is not a pass");
  const table = lanesSummary(all);
  assert.match(table[0]!, /^ {2}R58M +wifi-connect +PASS +2s +\$0\.0100$/, "a passed run needs no why");
  assert.match(table[1]!, /FAIL_ASSERT/);
  assert.equal(table.at(-1), "  1 of 3 passed");
});

test("a test no phone here can run is counted as not run, and the run is not green", () => {
  const ios: LaneTest = { path: "/t/wifi-ios.testsky.yaml", id: "wifi-ios", platforms: ["ios"] };
  const lanes = planLanes([forget, ios], [phone("R58M")]);
  const left = unplaced([forget, ios], lanes);
  assert.deepEqual(left.map((row) => [row.test, row.outcome, row.detail]), [["wifi-ios", "NOT_RUN", "no ios phone among these"]]);
  assert.equal(lanesExitCode([{ device: "R58M", platform: "android", test: "wifi-forget", outcome: "PASS", code: 0 }, ...left]), 2);
});

test("a test for both platforms that ran on one did not run on the other", () => {
  const lanes = planLanes([connect], [phone("R58M")]);
  assert.deepEqual(unplaced([connect], lanes).map((row) => [row.test, row.platform]), [["wifi-connect", "ios"]]);
  const android = { ...connect, platforms: ["android" as const] };
  assert.deepEqual(unplaced([android, { ...forget, platforms: [] }], planLanes([android], [phone("R58M")])), [], "a platform left out on purpose is not asked about");
});

test("half a result file is no result, and costs only its own row", async () => {
  const lanes = planLanes([connect], [phone("R58M"), phone("emulator-5554")]);
  const all = await runLanes(lanes, {
    parallel: 2,
    print: () => undefined,
    start: (device, test, resultFile) =>
      device.id === "R58M"
        ? spawn(process.execPath, ["-e", `require("node:fs").writeFileSync(process.argv[1], '{"outcome": "PA'); process.exit(0)`, resultFile], { stdio: ["ignore", "pipe", "pipe"] })
        : spawn(process.execPath, ["-e", RUN, resultFile, test.id, "PASS", "10"], { stdio: ["ignore", "pipe", "pipe"] }),
  });
  assert.deepEqual(all.map((row) => row.outcome), ["NO_RESULT", "PASS"]);
  assert.equal(lanesExitCode(all), 2, "an exit of 0 with no result to show is no pass");
});

test("what a run started and left running when it exited is ended, and a well-behaved run leaves nothing to end", async () => {
  // The run starts something in its own group -- as a WebDriverAgent build is -- says its pid, and exits.
  const leaves = `
    const left = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    console.log(left.pid);
    process.exit(0);`;
  const groups = new RunGroups({ graceMs: 200, termMs: 200 });
  const run = spawn(process.execPath, ["-e", leaves], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  groups.track(run);
  // As runLanes does: the run has exited before anybody waits for its group.
  const exited = new Promise((resolve) => run.once("exit", resolve));
  let said = "";
  for await (const chunk of run.stdout!) said += String(chunk);
  const left = Number(said.trim());
  await exited;
  assert.doesNotThrow(() => process.kill(left, 0), "still running when its run exited");
  await groups.settled();
  assert.throws(() => process.kill(left, 0), /ESRCH/, "the process it left is gone");

  const tidy = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", detached: true });
  groups.track(tidy);
  const started = Date.now();
  await new Promise((resolve) => tidy.once("exit", resolve));
  await groups.settled();
  assert.ok(Date.now() - started < 1000, "nothing to wait for");
});
