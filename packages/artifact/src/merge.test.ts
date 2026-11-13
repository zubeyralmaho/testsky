import assert from "node:assert/strict";
import test from "node:test";

import { emptyLock, parseLockFile, serializeLockFile, type HealRecord, type LockFile, type StepResolution } from "./lock.ts";
import { mergeLock, PRINTS_KEPT } from "./merge.ts";

const memory = (target: string, runs = 1, passes = runs): StepResolution => ({
  do: "open the Wi-Fi settings",
  screen: { phash: "0123456789abcdef" },
  actions: [{ action: "tap", describeTarget: target, point: { x: 180, y: 300 } }],
  tier: 1,
  model: "qwen3-vl",
  confidence: 0.9,
  stability: { runs, passes },
});

/**
 * A memory as a run writes it back after replaying it whole: the same taps,
 * stamped with the screen this run saw, tier 0, full confidence and no model.
 */
function replayed(remembered: StepResolution, runs: number, passes = runs): StepResolution {
  const { model: _model, ...rest } = remembered;
  return { ...rest, screen: { phash: "fedcba9876543210" }, tier: 0, confidence: 1, stability: { runs, passes } };
}

const heal = (step: string, at: string, status: HealRecord["status"] = "pending_review"): HealRecord => ({
  step,
  at,
  reason: "the target moved",
  before: { action: "tap", describeTarget: "Wi-Fi" },
  after: { action: "tap", describeTarget: "Network & internet" },
  confidence: 0.8,
  status,
});

function lock(steps: Record<string, StepResolution> = {}, extra: Partial<LockFile> = {}): LockFile {
  return { ...emptyLock("wifi", "android"), layout: "360x800", steps, ...extra };
}

/** Two runs that both read `base`: what is on disk after the first wrote, and after the second. */
function twoRuns(base: LockFile, first: (lock: LockFile) => void, second: (lock: LockFile) => void): { afterFirst: LockFile; afterBoth: LockFile } {
  const a = structuredClone(base);
  const b = structuredClone(base);
  first(a);
  second(b);
  const afterFirst = mergeLock(base, a, structuredClone(base));
  return { afterFirst, afterBoth: mergeLock(base, b, afterFirst) };
}

test("a run nobody wrote behind is written as it is", () => {
  const base = lock({ open: memory("Settings") });
  const ours = structuredClone(base);
  ours.steps.wifi = memory("Wi-Fi");
  assert.equal(mergeLock(base, ours, structuredClone(base)), ours);
  assert.equal(mergeLock(base, ours, null), ours, "nor one whose file is gone or unreadable");
});

test("two phones that learned different steps both keep what they learned", () => {
  const { afterBoth } = twoRuns(
    lock(),
    (first) => (first.steps.open = memory("Settings")),
    (second) => (second.steps.wifi = memory("Wi-Fi")),
  );
  assert.deepEqual(Object.keys(afterBoth.steps).sort(), ["open", "wifi"]);
});

test("a memory both phones replayed is counted by both", () => {
  const { afterBoth } = twoRuns(
    lock({ wifi: memory("Wi-Fi", 4, 3) }),
    (first) => (first.steps.wifi = memory("Wi-Fi", 5, 4)),
    (second) => (second.steps.wifi = memory("Wi-Fi", 5, 3)),
  );
  assert.deepEqual(afterBoth.steps.wifi?.stability, { runs: 6, passes: 4 });
});

test("a step one phone re-resolved keeps the new memory, whichever phone writes last", () => {
  const base = lock({ wifi: memory("Wi-Fi", 4) });
  const healed = (run: LockFile) => (run.steps.wifi = memory("Network & internet", 5));
  const counted = (run: LockFile) => (run.steps.wifi = memory("Wi-Fi", 5));
  assert.equal(twoRuns(base, healed, counted).afterBoth.steps.wifi?.actions[0]?.describeTarget, "Network & internet");
  assert.equal(twoRuns(base, counted, healed).afterBoth.steps.wifi?.actions[0]?.describeTarget, "Network & internet");
});

test("two phones that each re-resolved a step differently: the later word stands", () => {
  const { afterBoth } = twoRuns(
    lock({ wifi: memory("Wi-Fi") }),
    (first) => (first.steps.wifi = memory("Connections")),
    (second) => (second.steps.wifi = memory("Network & internet")),
  );
  assert.equal(afterBoth.steps.wifi?.actions[0]?.describeTarget, "Network & internet");
});

test("a memory forgotten by one run stays forgotten unless the other learned a new one", () => {
  const base = lock({ wifi: memory("Wi-Fi", 2) });
  const forget = (run: LockFile) => delete run.steps.wifi;
  assert.equal(twoRuns(base, forget, (run) => (run.steps.wifi = memory("Wi-Fi", 3))).afterBoth.steps.wifi, undefined);
  assert.equal(twoRuns(base, (run) => (run.steps.wifi = memory("Wi-Fi", 3)), forget).afterBoth.steps.wifi, undefined);
  const relearned = twoRuns(base, (run) => (run.steps.wifi = memory("Connections", 3)), forget).afterBoth;
  assert.equal(relearned.steps.wifi?.actions[0]?.describeTarget, "Connections");
});

test("each phone's heals are kept, once, and a decision heard by one run is not lost", () => {
  const base = lock({}, { heals: [heal("wifi", "2026-10-26T09:00:00Z")] });
  const { afterBoth } = twoRuns(
    base,
    (first) => first.heals.push(heal("open", "2026-10-26T10:00:00Z")),
    (second) => {
      second.heals[0]!.status = "rejected";
      second.heals.push(heal("join", "2026-10-26T10:00:01Z"));
    },
  );
  assert.deepEqual(
    afterBoth.heals.map((entry) => [entry.step, entry.status]),
    [
      ["wifi", "rejected"],
      ["open", "pending_review"],
      ["join", "pending_review"],
    ],
  );
});

test("a word acted on by one run keeps its mark, and one written into the file meanwhile is left for the next run", () => {
  const base = lock({}, { heals: [heal("wifi", "2026-10-26T09:00:00Z", "rejected")] });
  const ours = structuredClone(base);
  ours.heals[0]!.applied = "rejected";
  // A person changed their mind in the file while the run was going.
  const disk = structuredClone(base);
  disk.heals[0]!.status = "accepted";

  const merged = mergeLock(base, ours, disk).heals;
  assert.deepEqual(merged.map((entry) => [entry.status, entry.applied]), [["accepted", "rejected"]]);
  // Where nobody wrote in between, the mark is written with the rest.
  assert.equal(mergeLock(base, ours, structuredClone(base)).heals[0]!.applied, "rejected");
});

test("a mark alone does not bring back a heal another run has spent", () => {
  const base = lock({}, { heals: [{ ...heal("open", "2026-10-26T09:00:00Z", "accepted"), kind: "astray" }] });
  const ours = structuredClone(base);
  ours.heals[0]!.applied = "accepted";
  // The other run reached the step, forgot the memory that went astray, and spent the heal.
  const disk = structuredClone(base);
  disk.heals = [];
  assert.deepEqual(mergeLock(base, ours, disk).heals, []);
});

test("a remembered check either phone said no to is forgotten, and each yes counts", () => {
  const print = (name: string, passes: number, since = 0) => ({ print: name, passes, since });
  const base = lock({}, { verdicts: { joined: { prints: [print("a", 2, 3), print("b", 1)] } } });
  const { afterBoth } = twoRuns(
    base,
    // A "no" to a, and a first yes to c.
    (first) => (first.verdicts = { joined: { prints: [print("c", 1), print("b", 1)] } }),
    // An answer from memory for a, and a model's second yes to b.
    (second) => (second.verdicts = { joined: { prints: [print("b", 2), print("a", 2, 4)] } }),
  );
  assert.deepEqual(afterBoth.verdicts?.joined?.prints, [print("b", 2), print("c", 1)]);

  const many = twoRuns(
    lock(),
    (first) => (first.verdicts = { joined: { prints: [print("a", 1), print("b", 1), print("c", 1)] } }),
    (second) => (second.verdicts = { joined: { prints: [print("d", 1), print("e", 1), print("a", 1)] } }),
  ).afterBoth;
  assert.equal(many.verdicts?.joined?.prints.length, PRINTS_KEPT, "a few of them, not a history");
  assert.deepEqual(many.verdicts?.joined?.prints[2], print("a", 1), "two first passes side by side count once");
});

test("a no said on another phone is not outvoted by passes this run counted before it", () => {
  const print = (name: string, passes: number, since = 0) => ({ print: name, passes, since });
  const withPrint = (passes: number) => lock({}, { verdicts: { joined: { prints: [print("p", passes)] } } });

  // Three phones of one layout, none had p: two models said yes, one said no
  // -- and a no about a print this run never held leaves nothing to merge.
  let disk = lock();
  for (const said of [1, 0, 1]) {
    const base = structuredClone(disk);
    const run = said ? withPrint(1) : structuredClone(base);
    disk = mergeLock(lock(), run, disk);
  }
  assert.deepEqual(disk.verdicts?.joined?.prints, [print("p", 1)], "not confirmed: the next run asks a model again");

  // p had three passes. A no forgot it on one phone, a yes began it again on
  // another, and a third phone that read the old three passes said yes too.
  const old = withPrint(3);
  disk = mergeLock(old, lock(), structuredClone(old));
  const again = structuredClone(disk);
  disk = mergeLock(again, withPrint(1), disk);
  disk = mergeLock(old, withPrint(4), disk);
  assert.deepEqual(disk.verdicts?.joined?.prints, [print("p", 1)]);
});

test("a phone that only replayed a step does not undo another phone's heal of it, whichever writes last", () => {
  const base = lock({ wifi: memory("Wi-Fi", 4) });
  const healed = (run: LockFile) => (run.steps.wifi = memory("Network & internet", 5));
  const replay = (run: LockFile) => (run.steps.wifi = replayed(base.steps.wifi!, 5));
  for (const [first, second] of [
    [healed, replay],
    [replay, healed],
  ]) {
    const { afterBoth } = twoRuns(base, first!, second!);
    assert.equal(afterBoth.steps.wifi?.actions[0]?.describeTarget, "Network & internet");
    assert.deepEqual(afterBoth.steps.wifi?.stability, { runs: 5, passes: 5 }, "a pass of the old memory is not counted on the new one");
  }
});

test("a step forgotten on one phone is not brought back by another phone replaying it", () => {
  const base = lock({ wifi: memory("Wi-Fi", 4) });
  const forget = (run: LockFile) => delete run.steps.wifi;
  const replay = (run: LockFile) => (run.steps.wifi = replayed(base.steps.wifi!, 5));
  assert.equal(twoRuns(base, forget, replay).afterBoth.steps.wifi, undefined);
  assert.equal(twoRuns(base, replay, forget).afterBoth.steps.wifi, undefined);
});

test("a build adopted by the run that writes is the lock's build; otherwise the file's stays", () => {
  const base = lock({}, { appBuild: "com.acme@1.0+1" });
  const adopted = twoRuns(base, (first) => (first.steps.open = memory("Settings")), (second) => (second.appBuild = "com.acme@1.1+2"));
  assert.equal(adopted.afterBoth.appBuild, "com.acme@1.1+2");
  const kept = twoRuns(base, (first) => (first.appBuild = "com.acme@1.1+2"), (second) => (second.steps.open = memory("Settings")));
  assert.equal(kept.afterBoth.appBuild, "com.acme@1.1+2");
});

test("a merged lock is written in the same order as any other, so it diffs like one", () => {
  const { afterBoth } = twoRuns(
    lock({}, { appBuild: "com.acme@1.0+1", heals: [] }),
    (first) => (first.steps.open = memory("Settings")),
    (second) => (second.verdicts = { joined: { prints: [{ print: "a", passes: 1, since: 0 }] } }),
  );
  assert.deepEqual(Object.keys(afterBoth), ["version", "test", "platform", "appBuild", "layout", "steps", "verdicts", "heals"]);
  assert.deepEqual(parseLockFile(serializeLockFile(afterBoth)), afterBoth);
});
