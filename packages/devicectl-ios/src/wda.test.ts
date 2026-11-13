import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  controlInRow,
  controlPredicate,
  ensureWda,
  forwardedWda,
  iproxyForward,
  parseWdaSource,
  portFor,
  portInUse,
  simulatorOf,
  wdaKeyboardUp,
  wdaLaunch,
  wdaPress,
  wdaSourcePath,
  wdaTypeIntoFieldAt,
} from "./wda.ts";

const FIRST = "6F1C0D2A-0B3B-4C5D-8E9F-001122334455";
const SECOND = "A0B1C2D3-E4F5-4677-8899-AABBCCDDEEFF";

/** Ports as a probe sees them: which are taken, by which simulator, and which simulators exist. */
function ports(listening: Record<number, string | undefined> = {}, simulators: string[] = []) {
  return {
    inUse: async (port: number) => port in listening,
    owner: async (port: number) => listening[port],
    simulators: async () => simulators,
  };
}

async function listening(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** Shaped exactly as WebDriverAgent answers on an iOS 26 simulator. */
const SOURCE = {
  type: "Application",
  name: " ",
  label: " ",
  rect: { x: 0, y: 0, width: 440, height: 956 },
  isEnabled: "1",
  children: [
    {
      type: "Button",
      label: "Genel",
      rawIdentifier: "com.apple.settings.general",
      name: "Genel",
      rect: { x: 20, y: 311, width: 400, height: 53 },
      isEnabled: "1",
      children: [
        { type: "StaticText", label: "Genel", name: "Genel", rect: { x: 37, y: 323, width: 88, height: 29 }, isEnabled: "1", children: [] },
      ],
    },
    {
      type: "SecureTextField",
      label: "Parola",
      name: "password_field",
      value: "••••",
      rect: { x: 20, y: 400, width: 400, height: 44 },
      isEnabled: "0",
      children: [],
    },
  ],
};

test("XCUITest's booleans are strings, and reading them wrongly costs everything quietly", () => {
  const tree = parseWdaSource(SOURCE);
  const [button, field] = tree.root.children;

  // "1" is how WDA says true. Taking only `true`/"true" marked every node on
  // iOS non-interactive: grounding still looked fine because labels survived,
  // while screen identity went empty and confidence scored every answer as
  // landing on nothing.
  assert.equal(button!.interactive, true);
  assert.equal(button!.enabled, true);
  // "0" is how it says false, and a disabled field is not a target.
  assert.equal(field!.enabled, false);
  assert.equal(field!.interactive, false);
});

test("roles lose their package, bounds stay in points, and children come along", () => {
  const tree = parseWdaSource(SOURCE);
  assert.equal(tree.platform, "ios");
  assert.equal(tree.source, "xcuitest");
  assert.equal(tree.root.role, "Application");
  const button = tree.root.children[0]!;
  assert.equal(button.role, "Button");
  assert.deepEqual(button.bounds, { x: 20, y: 311, width: 400, height: 53 });
  assert.equal(button.label, "Genel");
  assert.equal(button.children[0]!.role, "StaticText");
  // Static text is what a screen says, not what it offers.
  assert.equal(button.children[0]!.interactive, false);
});

test("a container XCUITest calls not visible keeps the rows inside it that are; what draws nothing stays hidden", () => {
  // iOS 27's Settings, as WebDriverAgent lists a network's details page on an
  // iPhone 12 mini: 28 of 31 labelled nodes visible under hidden wrappers.
  const row = (label: string, y: number, visible: string) => ({
    type: "XCUIElementTypeOther",
    rect: { x: 16, y, width: 343, height: 53 },
    isVisible: "0",
    children: [{ type: "XCUIElementTypeButton", label, name: label, rect: { x: 32, y: y + 16, width: 90, height: 21 }, isVisible: visible, children: [] }],
  });
  const tree = parseWdaSource({
    type: "XCUIElementTypeApplication",
    label: "Ayarlar",
    rect: { x: 0, y: 0, width: 375, height: 812 },
    isVisible: "1",
    children: [
      { type: "XCUIElementTypeOther", rect: { x: 0, y: 0, width: 375, height: 812 }, isVisible: "0", children: [row("Bu Ağı Unut", 528, "1"), row("Skip ad", 600, "0")] },
    ],
  });
  const wrapper = tree.root.children[0]!;
  assert.equal(wrapper.visible, undefined, "it holds something drawn");
  assert.equal(wrapper.children[0]!.visible, undefined);
  assert.equal(wrapper.children[0]!.children[0]!.label, "Bu Ağı Unut");
  assert.equal(wrapper.children[1]!.visible, false, "nothing inside it is drawn");
  assert.equal(wrapper.children[1]!.children[0]!.visible, false);
});

test("a name that only repeats the label is not an identifier", () => {
  const tree = parseWdaSource(SOURCE);
  // "Genel" is the label; keeping it as an identity would make every rename
  // look like a different control.
  assert.equal(tree.root.children[0]!.identifier, undefined);
  assert.equal(tree.root.children[1]!.identifier, "password_field");
});

test("each simulator is given a WebDriverAgent port of its own, and keeps it", async () => {
  const home = await mkdtemp(join(tmpdir(), "testsky-wda-"));
  assert.equal(await portFor(FIRST, home, ports()), 8100);
  assert.equal(await portFor(SECOND, home, ports()), 8101);
  assert.equal(await portFor(FIRST, home, ports({ 8100: FIRST })), 8100, "its own WebDriverAgent on it is no reason to move");
  assert.deepEqual(JSON.parse(await readFile(join(home, "wda", "ports.json"), "utf8")), { [FIRST]: 8100, [SECOND]: 8101 });
});

test("a simulator whose port something else took is given another one", async () => {
  const home = await mkdtemp(join(tmpdir(), "testsky-wda-"));
  await portFor(FIRST, home, ports());
  assert.equal(await portFor(FIRST, home, ports({ 8100: SECOND, 8101: undefined })), 8102);
});

test("a deleted simulator's port goes to the next one, and nothing is let go of when the list is unknown", async () => {
  const home = await mkdtemp(join(tmpdir(), "testsky-wda-"));
  assert.equal(await portFor(SECOND, home, ports()), 8100);
  assert.equal(await portFor(FIRST, home, ports({}, [FIRST])), 8100, "the second simulator is gone: its port is free");
  const unknown = await mkdtemp(join(tmpdir(), "testsky-wda-"));
  await portFor(SECOND, unknown, ports());
  assert.equal(await portFor(FIRST, unknown, ports({}, [])), 8101);
});

test("a registry that does not read as one hands ports out again", async () => {
  const home = await mkdtemp(join(tmpdir(), "testsky-wda-"));
  await mkdir(join(home, "wda"), { recursive: true });
  await writeFile(join(home, "wda", "ports.json"), "{ half written");
  assert.equal(await portFor(FIRST, home, ports()), 8100);
});

test("simulators given ports at the same moment are given different ones", async () => {
  const home = await mkdtemp(join(tmpdir(), "testsky-wda-"));
  const given = await Promise.all([FIRST, SECOND].map((udid) => portFor(udid, home, ports())));
  assert.deepEqual([...given].sort(), [8100, 8101]);
});

test("WebDriverAgent is started on the simulator's own port, its MJPEG server beside it, in its own build folder", () => {
  const launch = wdaLaunch({ udid: SECOND, port: 8101, derivedDataPath: `/h/wda/${SECOND}`, projectDir: "/wda" });
  assert.deepEqual(launch.env, { USE_PORT: "8101", MJPEG_SERVER_PORT: "9101" });
  assert.ok(launch.args.includes(`platform=iOS Simulator,id=${SECOND}`));
  assert.equal(launch.args[launch.args.indexOf("-derivedDataPath") + 1], `/h/wda/${SECOND}`);
});

test("the simulator a process runs in is read from its path", () => {
  const runner = `/Users/q/Library/Developer/CoreSimulator/Devices/${SECOND.toLowerCase()}/data/Containers/Bundle/Application/X/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner`;
  assert.equal(simulatorOf(runner), SECOND);
  assert.equal(simulatorOf("/usr/local/bin/node server.js"), undefined);
});

test("a port somebody listens on is in use, and free again once they stop", async () => {
  const server = createServer();
  const port = await listening(server);
  assert.equal(await portInUse(port), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await portInUse(port), false);
});

test("a WebDriverAgent answering on the port that is not this simulator's is never driven", async () => {
  // Answers /status exactly as WebDriverAgent does -- from a process that is no simulator's.
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ value: { ready: true } }));
  });
  const port = await listening(server);
  try {
    await assert.rejects(ensureWda({ udid: FIRST, port, home: await mkdtemp(join(tmpdir(), "testsky-wda-")) }), /not from simulator/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

const PHONE = "00008110-0001A2B3C4D5E6F7";

test("an iproxy command line says which phone it forwards, and from which port", () => {
  assert.deepEqual(iproxyForward(`iproxy -u ${PHONE} 8102 8100`), { udid: PHONE, local: 8102, device: 8100 });
  assert.deepEqual(iproxyForward(`/opt/homebrew/bin/iproxy 9102:9100 8102:8100 --udid ${PHONE.toLowerCase()}`), { udid: PHONE, local: 8102, device: 8100 }, "the WebDriverAgent pair of several");
  assert.deepEqual(iproxyForward(`iproxy --udid=${PHONE} 8107:8100`), { udid: PHONE, local: 8107, device: 8100 });
  const old = "a".repeat(40);
  assert.deepEqual(iproxyForward(`iproxy 8101 8100 ${old}`), { udid: old.toUpperCase(), local: 8101, device: 8100 }, "and in its old form, the phone after the ports");
  assert.equal(iproxyForward(`iproxy 8102 8100`), undefined, "a forward that names no phone could be any phone's");
  assert.equal(iproxyForward(`node iproxy.js -u ${PHONE} 8102 8100`), undefined);
});

test("a phone's WebDriverAgent is driven only through the iproxy that forwards it to that phone", async () => {
  // Answers /status as WebDriverAgent does -- from a process that forwards nothing.
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ value: { ready: true } }));
  });
  const port = await listening(server);
  try {
    await assert.rejects(forwardedWda(PHONE, port), /is not forwarded to the iPhone/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await assert.rejects(forwardedWda("00008101-FFFFFFFFFFFFFFFF"), /no WebDriverAgent is forwarded to this Mac/);
});

test("typing goes into the field at the point, in WebDriverAgent's own session, when the keyboard is down", async () => {
  const asked: string[] = [];
  let typed: unknown;
  const fetcher = async (url: string, init?: { method?: string; body?: string }) => {
    const path = url.replace(/^http:\/\/127\.0\.0\.1:\d+/, "");
    asked.push(`${init?.method ?? "GET"} ${path}`);
    const reply = (value: unknown) => ({ ok: true, json: async () => value });
    if (path === "/source?format=json&excluded_attributes=visible,accessible") return reply({ value: { type: "XCUIElementTypeApplication", children: [{ type: "XCUIElementTypeSecureTextField" }] } });
    if (path === "/status") return reply({ sessionId: "S1", value: {} });
    if (path === "/session/S1/elements") return reply({ value: [{ ELEMENT: "search" }, { ELEMENT: "password" }] });
    if (path === "/session/S1/element/search/rect") return reply({ value: { x: 0, y: 40, width: 375, height: 36 } });
    if (path === "/session/S1/element/password/rect") return reply({ value: { x: 20, y: 300, width: 335, height: 44 } });
    if (path === "/session/S1/element/password/value") {
      typed = JSON.parse(init!.body!);
      return reply({ value: null });
    }
    return { ok: false, json: async () => ({}) };
  };
  assert.equal(await wdaKeyboardUp(8101, fetcher), false);
  assert.equal(await wdaTypeIntoFieldAt(8101, { x: 180, y: 320 }, "key 1", fetcher), true);
  assert.deepEqual(typed, { text: "key 1", value: ["k", "e", "y", " ", "1"] });
  assert.ok(!asked.includes("POST /session"), "the engine's session is the one used, no new one");
  assert.equal(await wdaTypeIntoFieldAt(8101, { x: 180, y: 600 }, "key 1", fetcher), false, "no field at that point");
});

test("the tree is read without what nothing uses, and without visibility where only a place is wanted", () => {
  assert.equal(wdaSourcePath(), "/source?format=json&excluded_attributes=accessible");
  assert.equal(wdaSourcePath(false), "/source?format=json&excluded_attributes=visible,accessible");
});

test("a control is asked for by what it is and says, quoted as a predicate reads it", () => {
  assert.equal(controlPredicate({ role: "StaticText", label: "Office" }), "type == 'XCUIElementTypeStaticText' AND label == 'Office'");
  assert.equal(
    controlPredicate({ role: "Button", label: "Daha Fazla Bilgi", identifier: "info.circle" }),
    "type == 'XCUIElementTypeButton' AND label == 'Daha Fazla Bilgi' AND name == 'info.circle'",
  );
  assert.equal(controlPredicate({ role: "StaticText", label: "Ada's \\ net" }), "type == 'XCUIElementTypeStaticText' AND label == 'Ada\\'s \\\\ net'");
  assert.equal(controlPredicate({ role: "Cell" }), undefined, "a control that says nothing cannot be asked for");
});

test("a control every row has is asked for inside the row whose text says which", () => {
  assert.deepEqual(controlInRow({ role: "Button", label: "Daha Fazla Bilgi", identifier: "info.circle" }, "Office"), {
    using: "class chain",
    value: "**/XCUIElementTypeCell[$type == 'XCUIElementTypeStaticText' AND label == 'Office'$]/**/XCUIElementTypeButton[`label == 'Daha Fazla Bilgi' AND name == 'info.circle'`]",
  });
  assert.equal(controlInRow({ role: "Button", label: "More Info" }, "price $5"), undefined, "words the chain's syntax cannot carry");
});

test("a press is made on the one control that answers, in WebDriverAgent's own session", async () => {
  const asked: string[] = [];
  let answer: unknown[] = [{ ELEMENT: "row" }];
  const fetcher = async (url: string, init?: { method?: string; body?: string }) => {
    const path = url.replace(/^http:\/\/127\.0\.0\.1:\d+/, "");
    asked.push(`${init?.method ?? "GET"} ${path}${init?.body && path.endsWith("/elements") ? ` ${JSON.parse(init.body).using}` : ""}`);
    const reply = (value: unknown) => ({ ok: true, json: async () => value });
    if (path === "/status") return reply({ sessionId: "S1", value: {} });
    if (path === "/session/S1/elements") return reply({ value: answer });
    if (path === "/session/S1/element/row/click") return reply({ value: null });
    if (path === "/session/S1/element/row/attribute/visible") return reply({ value: true });
    if (path === "/session/S1/element/left/attribute/visible") return reply({ value: false });
    return { ok: false, json: async () => ({}) };
  };
  const locator = { using: "predicate string" as const, value: "type == 'XCUIElementTypeStaticText' AND label == 'Office'" };
  assert.equal(await wdaPress(8107, locator, fetcher), "pressed");
  assert.deepEqual(asked, ["GET /status", "POST /session/S1/elements predicate string", "POST /session/S1/element/row/click"]);
  answer = [];
  assert.equal(await wdaPress(8107, locator, fetcher), "absent");
  answer = [{ ELEMENT: "one" }, { ELEMENT: "two" }];
  assert.equal(await wdaPress(8107, locator, fetcher), "ambiguous", "both drawn, or nobody says");
  answer = [{ ELEMENT: "left" }, { ELEMENT: "row" }];
  assert.equal(await wdaPress(8107, locator, fetcher), "pressed", "the one drawn of two");
  answer = [{ ELEMENT: "left" }];
  assert.equal(await wdaPress(8107, locator, fetcher, { drawnOnly: true }), "absent", "asked for what is drawn, one that is not is not there");
  answer = [{ ELEMENT: "row" }];
  assert.equal(await wdaPress(8107, locator, fetcher, { drawnOnly: true }), "pressed");
  assert.ok(!asked.includes("POST /session"), "no session of its own");
});
