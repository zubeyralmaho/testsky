import assert from "node:assert/strict";
import test from "node:test";

import { parseTestFile } from "@testsky/artifact";
import type { DeviceHandle, Engine } from "@testsky/engine-core";

import { appOn } from "./run.ts";

const HUAWEI: DeviceHandle = { id: "HUAWEI0000000001", platform: "android", osVersion: "", kind: "physical" };

const BROWSER = parseTestFile(`
id: browser
targets:
  - { platform: android, app: com.android.chrome }
  - { platform: android, app: com.huawei.browser }
  - { platform: ios, app: com.apple.mobilesafari }
steps:
  - expect: a web page is shown
`);

/** A device that has these apps, or that cannot say. */
const has = (apps: string[] | undefined) =>
  ({ app: { installed: async (id: string) => (apps ? apps.includes(id) : undefined) } }) as unknown as Engine;

test("a test runs as the first of its apps that the phone has", async () => {
  assert.equal(await appOn(BROWSER, HUAWEI, has(["com.huawei.browser"])), "com.huawei.browser");
  assert.equal(await appOn(BROWSER, HUAWEI, has(["com.android.chrome", "com.huawei.browser"])), "com.android.chrome", "in the order written");
});

test("a phone that cannot say what it has runs the first; one that has none of them is the device's problem", async () => {
  assert.equal(await appOn(BROWSER, HUAWEI, has(undefined)), "com.android.chrome");
  await assert.rejects(appOn(BROWSER, HUAWEI, has([])), /none of com.android.chrome, com.huawei.browser is installed on HUAWEI0000000001/);
  assert.equal(await appOn(BROWSER, { ...HUAWEI, platform: "ios", kind: "simulator" }, has([])), "com.apple.mobilesafari", "one app is not asked about");
});
