import assert from "node:assert/strict";
import test from "node:test";

import { FLAG, type AgentNode } from "@testsky/android-agent";
import { Router } from "@testsky/router";

import { AgentAndroidDevice, agentNodeToRaw, densityFrom, keyCode, sizeFrom } from "./agent-device.ts";
import { AndroidMidsceneEngine, androidDriver } from "./android.ts";
import { imageSize } from "./png.ts";

/** The start of a JPEG: SOI, an APP0 segment, then a frame header of the given kind. */
function jpegHeader(width: number, height: number, sof = 0xc0): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const frame = Buffer.alloc(19);
  frame.writeUInt8(0xff, 0);
  frame.writeUInt8(sof, 1);
  frame.writeUInt16BE(17, 2);
  frame.writeUInt8(8, 4);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, frame]);
}

test("a JPEG's size is read from its frame header, a progressive one's too, and a PNG's from its own", () => {
  assert.deepEqual(imageSize(jpegHeader(1084, 2412)), { width: 1084, height: 2412 });
  assert.deepEqual(imageSize(jpegHeader(2412, 1084, 0xc2)), { width: 2412, height: 1084 });
  const png = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
  png.writeUInt32BE(1080, 16);
  png.writeUInt32BE(2400, 20);
  assert.deepEqual(imageSize(png), { width: 1080, height: 2400 });
  assert.throws(() => imageSize(Buffer.from("not a picture")), /PNG or JPEG/);
});

test("the screen's size and density are read as Midscene reads them: an override size counts, an override density does not", () => {
  assert.deepEqual(sizeFrom("Physical size: 1084x2412\n"), { width: 1084, height: 2412 });
  assert.deepEqual(sizeFrom("Physical size: 1080x2400\nOverride size: 720x1600\n"), { width: 720, height: 1600 });
  assert.equal(densityFrom("Physical density: 420\nOverride density: 480\n"), 420);
  assert.equal(densityFrom(""), 160);
  assert.throws(() => sizeFrom("error: no display"), /screen size/);
});

test("keys are named as Midscene names them, and a letter is its own key", () => {
  assert.deepEqual(["Enter", "Backspace", "Escape", "End", "ArrowDown", "a", "Z"].map(keyCode), [66, 67, 111, 123, 20, 29, 54]);
  assert.equal(keyCode("Ctrl+C"), undefined);
});

test("an agent node reads as a yadb node: its words, id and flags as attributes, its bounds in points", () => {
  const node: AgentNode = {
    class: "android.widget.Button",
    text: "Pay now",
    id: "com.acme.shop:id/pay",
    bounds: [105, 2100, 525, 2310],
    f: FLAG.clickable | FLAG.enabled | FLAG.visible,
    children: [{ class: "android.widget.TextView", desc: "Total", bounds: [0, 0, 2625, 262], f: FLAG.enabled }],
  };
  const raw = agentNodeToRaw(node, 2.625);
  assert.equal(raw.type, "android.widget.Button");
  assert.deepEqual(raw.bounds, { left: 40, top: 800, width: 160, height: 80 });
  assert.equal(raw.attrs.text, "Pay now");
  assert.equal(raw.attrs["resource-id"], "com.acme.shop:id/pay");
  assert.deepEqual([raw.attrs.clickable, raw.attrs.enabled, raw.attrs.scrollable, raw.attrs["visible-to-user"]], ["true", "true", "false", "true"]);
  assert.equal(raw.children[0]!.attrs["content-desc"], "Total");
  assert.equal(raw.children[0]!.attrs["visible-to-user"], "false");
});

/** A device whose agent is a recorder: what was asked of the phone, in display pixels. */
function recordingDevice(natural: { width: number; height: number }, density: number, latest?: { width: number; height: number }) {
  const device = new AgentAndroidDevice("TEST123");
  const asked: string[] = [];
  const agent = {
    open: true,
    tap: async (x: number, y: number, hold: number) => void asked.push(`tap ${x} ${y} ${hold}`),
    doubleTap: async (x: number, y: number) => void asked.push(`doubletap ${x} ${y}`),
    swipe: async (from: { x: number; y: number }, to: { x: number; y: number }, ms: number) => void asked.push(`swipe ${from.x} ${from.y} ${to.x} ${to.y} ${ms}`),
    tree: async () => [{ type: 1, layer: 0, active: true, title: "Settings", root: { class: "android.widget.FrameLayout", bounds: [0, 0, 1084, 2412], f: FLAG.enabled | FLAG.visible } }],
    global: async (action: number) => void asked.push(`global ${action}`),
    key: async (code: number) => void asked.push(`key ${code}`),
    type: async (text: string) => (asked.push(`type ${text}`), text),
    info: async () => ({ width: 1084, height: 2412, rotation: 0, density, ime: false }),
  };
  const inside = device as unknown as Record<string, unknown>;
  inside.agent = agent;
  inside.natural = natural;
  inside.dpr = density / 160;
  if (latest) inside.latest = latest;
  return { device, asked };
}

test("a point goes to the phone in its display pixels, by the same scale its size was read with", async () => {
  const { device, asked } = recordingDevice({ width: 1084, height: 2412 }, 420);
  assert.deepEqual(await device.size(), { width: 413, height: 919 });
  await device.inputPrimitives.pointer.tap({ x: 207, y: 865 });
  await device.inputPrimitives.pointer.longPress({ x: 10, y: 10 }, { duration: 1200 });
  await device.inputPrimitives.touch.swipe({ x: 207, y: 460 }, { x: 207, y: 92 }, { duration: 1000 });
  await device.inputPrimitives.system.backButton();
  assert.deepEqual(asked, ["tap 543 2270 80", "tap 26 26 1200", "swipe 543 1207 543 241 1000", "global 1"]);
  const tree = await device.getUITree();
  const bounds = tree.root!.bounds;
  assert.deepEqual([bounds.left, bounds.top, Math.round(bounds.width), Math.round(bounds.height)], [0, 0, 413, 919], "the engine rounds a node's bounds to points");
});

test("once a picture comes the other way round, the size and every point follow the turn", async () => {
  const { device, asked } = recordingDevice({ width: 1084, height: 2412 }, 420, { width: 2412, height: 1084 });
  assert.deepEqual(await device.size(), { width: 919, height: 413 });
  await device.inputPrimitives.pointer.tap({ x: 900, y: 400 });
  assert.deepEqual(asked, ["tap 2362 1050 80"]);
});

test("typing sent with Enter keeps its keyboard; typing that is not closes it only when one is up", async () => {
  const { device, asked } = recordingDevice({ width: 1084, height: 2412 }, 420);
  await device.inputPrimitives.keyboard.typeText("Merhaba dünya", { autoDismissKeyboard: false });
  await device.inputPrimitives.keyboard.typeText("ç", { autoDismissKeyboard: true });
  await device.inputPrimitives.keyboard.keyboardPress("Enter");
  assert.deepEqual(asked, ["type Merhaba dünya", "type ç", "key 66"], "no keyboard was up, so nothing was pressed to close one");
});

test("TESTSKY_ANDROID_ENGINE picks the driver, Midscene unless it says agent, and a run names the one it used", () => {
  assert.equal(androidDriver({}), "midscene");
  assert.equal(androidDriver({ TESTSKY_ANDROID_ENGINE: " Agent " }), "agent");
  assert.equal(androidDriver({ TESTSKY_ANDROID_ENGINE: "midscene" }), "midscene");
  assert.throws(() => androidDriver({ TESTSKY_ANDROID_ENGINE: "appium" }), /agent or midscene/);
  const router = new Router({ tiers: { ground: { baseUrl: "http://127.0.0.1:1/v1", model: "none" } } });
  assert.match(new AndroidMidsceneEngine({ router, driver: "agent" }).name, /^agent@\d/);
  assert.match(new AndroidMidsceneEngine({ router }).name, /^midscene@/);
});
