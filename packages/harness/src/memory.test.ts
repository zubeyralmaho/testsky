import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { emptyLock, parseLockFile, serializeLockFile } from "@testsky/artifact";

import { openLock, saveLock } from "./memory.ts";

process.env.TESTSKY_HOME = await mkdtemp(join(tmpdir(), "testsky-home-"));

const PIXEL = { width: 412, height: 915 };
const SMALLER = { width: 360, height: 800 };

async function suite(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "testsky-memory-"));
  return join(dir, "checkout.testsky.yaml");
}

const locks = async (path: string) => (await readdir(join(path, ".."))).filter((file) => file.includes(".testsky.lock.")).sort();

async function olderLock(path: string): Promise<void> {
  await writeFile(path.replace(/\.testsky\.yaml$/, ".testsky.lock.android.yaml"), serializeLockFile({ ...emptyLock("checkout", "android"), appBuild: "com.acme@1.0+1" }));
}

test("each screen layout keeps its own lock beside the test", async () => {
  const path = await suite();
  const opened = (await openLock(path, "checkout", "android", PIXEL))!;
  assert.equal(opened.path, path.replace(/\.testsky\.yaml$/, ".testsky.lock.android.412x915.yaml"));
  assert.equal(opened.lock.layout, "412x915");
  await writeFile(opened.path, serializeLockFile({ ...opened.lock, appBuild: "com.acme@1.0+1" }));

  assert.equal((await openLock(path, "checkout", "android", PIXEL))?.lock.appBuild, "com.acme@1.0+1", "read back on the next run");
  assert.equal((await openLock(path, "checkout", "android", SMALLER))?.lock.appBuild, undefined, "and not replayed on another layout");
});

test("the platform's older lock is taken over by the first layout to run, and only by it", async () => {
  const path = await suite();
  await olderLock(path);
  const first = (await openLock(path, "checkout", "android", PIXEL))!;
  assert.deepEqual([first.lock.appBuild, first.lock.layout], ["com.acme@1.0+1", "412x915"]);
  assert.deepEqual(await locks(path), ["checkout.testsky.lock.android.412x915.yaml"], "moved, not copied");
  assert.equal(parseLockFile(await readFile(first.path, "utf8"))?.appBuild, "com.acme@1.0+1");
  assert.equal((await openLock(path, "checkout", "android", SMALLER))?.lock.appBuild, undefined);
});

test("a pull request's run reads the older lock and leaves it where it was", async () => {
  const path = await suite();
  await olderLock(path);
  const read = await openLock(path, "checkout", "android", PIXEL, { adopt: false });
  assert.equal(read?.lock.appBuild, "com.acme@1.0+1");
  assert.deepEqual(await locks(path), ["checkout.testsky.lock.android.yaml"], "not even renamed: which phone takes it over is the mainline's to say");
});

test("two runners taking the older lock over at once both get it, and neither loses it", async () => {
  const path = await suite();
  await olderLock(path);
  const both = await Promise.all([openLock(path, "checkout", "android", PIXEL), openLock(path, "checkout", "android", PIXEL)]);
  assert.deepEqual(both.map((opened) => opened?.lock.appBuild), ["com.acme@1.0+1", "com.acme@1.0+1"]);
  assert.deepEqual(await locks(path), ["checkout.testsky.lock.android.412x915.yaml"]);
});

test("without a known size there is no memory, rather than the platform's old one", async () => {
  const path = await suite();
  await olderLock(path);
  assert.equal(await openLock(path, "checkout", "android", undefined), undefined);
  assert.deepEqual(await locks(path), ["checkout.testsky.lock.android.yaml"], "and nothing is written");
});

const memoryOf = (target: string) => ({
  screen: { phash: "0123456789abcdef" },
  actions: [{ action: "tap" as const, describeTarget: target }],
  tier: 0,
  confidence: 0.9,
  stability: { runs: 1, passes: 1 },
});

test("two phones of one layout that ran at once both keep what they learned", async () => {
  const path = await suite();
  const [first, second] = [(await openLock(path, "checkout", "android", PIXEL))!, (await openLock(path, "checkout", "android", PIXEL))!];
  first.lock.steps.cart = memoryOf("Cart");
  second.lock.steps.pay = memoryOf("Pay");
  second.lock.heals.push({
    step: "pay",
    at: "2026-10-26T10:00:00Z",
    reason: "the button moved",
    before: { action: "tap", describeTarget: "Pay" },
    after: { action: "tap", describeTarget: "Pay now" },
    confidence: 0.8,
    status: "pending_review",
  });
  await Promise.all([saveLock(first), saveLock(second)]);
  const written = parseLockFile(await readFile(first.path, "utf8"))!;
  assert.deepEqual(Object.keys(written.steps).sort(), ["cart", "pay"]);
  assert.equal(written.heals.length, 1);
  assert.deepEqual(await locks(path), ["checkout.testsky.lock.android.412x915.yaml"], "and no half-written file is left beside it");
});

test("a lock saved twice by one run is measured against what it last wrote", async () => {
  const path = await suite();
  const run = (await openLock(path, "checkout", "android", PIXEL))!;
  run.lock.steps.cart = memoryOf("Cart");
  await saveLock(run);
  const other = (await openLock(path, "checkout", "android", PIXEL))!;
  delete other.lock.steps.cart;
  await saveLock(other);
  run.lock.steps.pay = memoryOf("Pay");
  await saveLock(run);
  const written = parseLockFile(await readFile(run.path, "utf8"))!;
  assert.deepEqual(Object.keys(written.steps), ["pay"], "what the other run forgot since is not brought back");
});

test("a lock kept behind a link is written where the link points, and the link stays", async () => {
  const path = await suite();
  const run = (await openLock(path, "checkout", "android", PIXEL))!;
  run.lock.steps.cart = memoryOf("Cart");
  await saveLock(run);
  const kept = `${run.path}.kept`;
  await rename(run.path, kept);
  await symlink(kept, run.path);
  const next = (await openLock(path, "checkout", "android", PIXEL))!;
  next.lock.steps.pay = memoryOf("Pay");
  await saveLock(next);
  assert.equal((await lstat(run.path)).isSymbolicLink(), true);
  assert.deepEqual(Object.keys(parseLockFile(await readFile(kept, "utf8"))!.steps), ["cart", "pay"]);
});
