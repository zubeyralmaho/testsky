import assert from "node:assert/strict";
import test from "node:test";

import type { DeviceHandle } from "@testsky/engine-core";

import { matchDevice, onePerPhone, othersUsing, ownSerial } from "./devices.ts";

const android = (id: string): DeviceHandle => ({ id, platform: "android", osVersion: "", kind: "physical" });
const serials: Record<string, string> = { R58M1234: "R58M1234", "192.168.1.5:5555": "R58M1234", "emulator-5554": "EMULATOR" };

test("an iPhone's id is found in either case, and an Android serial only as it is", () => {
  const iphone: DeviceHandle = { id: "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678", platform: "ios", osVersion: "", kind: "physical" };
  assert.equal(matchDevice([iphone], "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"), iphone);
  assert.equal(matchDevice([iphone], "a1b2c3d4"), iphone, "by its start too");
  assert.equal(matchDevice([android("R58M1234")], "r58m1234"), undefined);
  assert.deepEqual(matchDevice([android("R58M1234")], "R58M"), android("R58M1234"));
});

test("a phone adb lists on a cable and over the network is one phone, kept by its cable", async () => {
  const kept = await onePerPhone([android("192.168.1.5:5555"), android("emulator-5554"), android("R58M1234")], async (id) => serials[id]);
  assert.deepEqual(
    kept.map((device) => [device.id, device.serial]),
    [
      ["R58M1234", "R58M1234"],
      ["emulator-5554", undefined],
    ],
  );
});

test("a phone that will not say its serial is kept as it is", async () => {
  const kept = await onePerPhone([android("R58M1234"), android("ZY22")], async (id) => (id === "ZY22" ? undefined : serials[id]));
  assert.deepEqual(kept.map((device) => [device.id, device.serial]), [["R58M1234", "R58M1234"], ["ZY22", undefined]]);
});

test("emulators of one SDK all say the same serial, and each is still its own phone", async () => {
  const kept = await onePerPhone([android("emulator-5554"), android("emulator-5556")], async () => "EMULATOR37.1.11.0");
  assert.deepEqual(kept.map((device) => [device.id, device.serial]), [["emulator-5554", undefined], ["emulator-5556", undefined]]);
  assert.equal(ownSerial("ZY22", "0123456789ABCDEF"), undefined, "nor is a factory placeholder anybody's");
});

test("a phone on wireless debugging is reached over the network, and its cable is kept", async () => {
  const mdns = "adb-R58M1234-Xq1kZ7._adb-tls-connect._tcp";
  const kept = await onePerPhone([android(mdns), android("R58M1234")], async () => "R58M1234");
  assert.deepEqual(kept.map((device) => device.id), ["R58M1234"]);
});

test("a phone another program is at work on is said to be in use, by program and never by its arguments", () => {
  const ps = [
    "  101    02:34:12 iproxy -u 00008110-0001A2B3C4D5E6F7 8102 8100",
    "  102    01:48:13 /bin/bash -lc security unlock-keychain; xcodebuild -project appium-webdriveragent/WebDriverAgent.xcodeproj -destination id=00008110-0001A2B3C4D5E6F7 test",
    "  103    00:00:49 /usr/local/bin/node ./node_modules/.bin/tsx src/runner.ts --join Lab --key hunter2 --udid=00008110-0001A2B3C4D5E6F7",
    "  104    04:26:31 scrcpy -s R58M1234",
    "  105    00:00:03 ideviceinfo -u 00008110-0001A2B3C4D5E6F7 -k ProductVersion",
    "  106    00:00:01 node apps/cli/src/main.ts run t.testsky.yaml --devices 00008110-0001A2B3C4D5E6F7,R58M1234",
    "  107    00:00:01 node ./tool --device 00008110-0001A2B3C4D5E6F7X",
  ].join("\n");
  const iphone = othersUsing(ps, ["00008110-0001A2B3C4D5E6F7"], new Set([106]));
  assert.deepEqual(iphone, ["pid 103 (node src/runner.ts, running 00:00:49)"], "the forwarder, the WebDriverAgent build, a read and this run's own parent are not users");
  assert.ok(!iphone.join().includes("hunter2"), "a run's arguments carry its secrets");
  assert.deepEqual(othersUsing(ps, ["R58M1234"], new Set([106])), ["pid 104 (scrcpy, running 04:26:31)"], "a mirror somebody has open is somebody at the phone");
  assert.deepEqual(othersUsing(ps, ["ABCD1234EFGH5678"], new Set()), []);
});

test("an MCP server is not at work on the phones it may use: it holds one only by the lease, and its runs name the phone themselves", () => {
  const ps = [
    "  201    20:46 /usr/local/bin/node apps/cli/src/main.ts mcp --devices 00008030-001A2B3C4D5E6F70,QV7701XYZW --out runs",
    "  202    11:39 testsky mcp --devices QV7701XYZW",
    "  203    00:12 /usr/local/bin/node /opt/testsky/apps/cli/src/main.ts run --json checkout.testsky.yaml --devices QV7701XYZW",
  ].join("\n");
  assert.deepEqual(othersUsing(ps, ["QV7701XYZW"], new Set()), ["pid 203 (node src/main.ts, running 00:12)"]);
  assert.deepEqual(othersUsing(ps, ["00008030-001A2B3C4D5E6F70"], new Set()), []);
});
