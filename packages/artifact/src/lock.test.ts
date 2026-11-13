import assert from "node:assert/strict";
import test from "node:test";

import { emptyLock, isTestFile, layoutOf, lockPathFor, parseLockFile, serializeLockFile } from "./lock.ts";

test("a test's lock sits beside it, one per platform, named after it", () => {
  assert.equal(lockPathFor("tests/checkout.testsky.yaml", "android"), "tests/checkout.testsky.lock.android.yaml");
  assert.equal(lockPathFor("tests/checkout.testsky.yml", "ios"), "tests/checkout.testsky.lock.ios.yaml");
  // The runner names a test by its id, with no extension.
  assert.equal(lockPathFor("/tests/checkout", "android"), "/tests/checkout.testsky.lock.android.yaml");
});

test("a test file is named for testsky, and a lock is never a test", () => {
  for (const name of ["checkout.testsky.yaml", "checkout.testsky.yml"]) assert.equal(isTestFile(name), true, name);
  for (const name of ["checkout.testsky.lock.android.yaml", "checkout.yaml", "models.yaml"]) {
    assert.equal(isTestFile(name), false, name);
  }
});

test("a layout is the screen's size in points, the short side first", () => {
  assert.equal(layoutOf({ width: 412, height: 915 }), "412x915");
  assert.equal(layoutOf({ width: 915, height: 412 }), "412x915", "a phone met sideways is the same phone");
  assert.equal(layoutOf({ width: 439.8, height: 956.2 }), "440x956");
});

test("a lock is named for its test, platform and layout", () => {
  assert.equal(lockPathFor("tests/checkout.testsky.yaml", "ios", { width: 440, height: 956 }), "tests/checkout.testsky.lock.ios.440x956.yaml");
  assert.equal(lockPathFor("/tests/checkout", "android", { width: 412, height: 915 }), "/tests/checkout.testsky.lock.android.412x915.yaml");
  assert.equal(isTestFile("checkout.testsky.lock.ios.440x956.yaml"), false, "and a layout's lock is no test either");
});

test("the layout a lock was learned on survives being written and read", () => {
  const lock = { ...emptyLock("checkout", "android"), layout: "412x915" };
  assert.equal(parseLockFile(serializeLockFile(lock))?.layout, "412x915");
  assert.equal(parseLockFile(serializeLockFile(emptyLock("checkout", "android")))?.layout, undefined);
});

test("remembered checks survive being written and read, and what does not read as one is dropped", () => {
  const lock = {
    ...emptyLock("checkout", "android"),
    verdicts: { cart: { prints: [{ print: "ab12", passes: 2, since: 3 }] } },
  };
  assert.deepEqual(parseLockFile(serializeLockFile(lock))?.verdicts, { cart: { prints: [{ print: "ab12", passes: 2, since: 3 }] } });
  const edited = serializeLockFile(lock).replace("passes: 2", "passes: two");
  assert.equal(parseLockFile(edited)?.verdicts, undefined, "a hand-edited entry that no longer reads is not trusted");
});
