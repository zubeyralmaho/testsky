/**
 * WebDriverAgent: getting it running, and reading the screen from it.
 *
 * Midscene talks to WDA but does not start it -- its manager probes port 8100
 * and, finding nothing, tells you to open Xcode. That is the whole of iOS
 * provisioning left unclaimed, and on a customer's machine "open Xcode" is not
 * an install step, it is a support call. So the runner starts WDA itself:
 * `appium-webdriveragent` ships the project (Apache-2.0), xcodebuild builds
 * and runs it against a booted simulator, and the first build is the only slow
 * one -- the derived data is kept between runs.
 *
 * Simulators only, deliberately. A physical iPhone needs a developer tunnel, a
 * signed runner and a paid Apple account, and pretending otherwise in an
 * install guide is how a POC dies on day one.
 *
 * Each simulator has a WebDriverAgent of its own: its own port, kept from one
 * run to the next, and its own build folder. Two simulators that shared port
 * 8100 had the second one's WebDriverAgent bind 8101 by itself, and the
 * second run, looking on 8100, drove the first simulator's screen.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { DeviceNotReadyError, testskyHome, withFileLock, type TreeNode, type TreeSnapshot } from "@testsky/engine-core";

import { listSimulators } from "./simctl.ts";

const require = createRequire(import.meta.url);
const run = promisify(execFile);

export const DEFAULT_WDA_PORT = 8100;
/** WebDriverAgent's own range, when nobody gives it a port: 8100 to 8199. */
const PORT_RANGE = 100;
/** Its MJPEG server sits this far above it, where its 9100 sits above 8100. */
const MJPEG_OFFSET = 1000;
/** Looks at who listens on a port before believing nobody it knows does. */
const OWNER_LOOKS = 3;

/** Where a WebDriverAgent on `port` serves its MJPEG stream. */
export function mjpegPortFor(port: number): number {
  return port + MJPEG_OFFSET;
}

export function wdaProjectDir(): string {
  return dirname(require.resolve("appium-webdriveragent/package.json"));
}

export async function wdaReady(port = DEFAULT_WDA_PORT): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    const body = (await response.json()) as { value?: { ready?: boolean } };
    return body.value?.ready !== false;
  } catch {
    return false;
  }
}

export interface WdaHandle {
  /** True when we started it and are therefore responsible for stopping it. */
  ours: boolean;
  /** Where it answers. */
  port: number;
  stop(): void;
}

export interface EnsureWdaOptions {
  udid: string;
  /** A port to use as given; otherwise the simulator's own, chosen once and kept. */
  port?: number;
  /** Where xcodebuild keeps its build products between runs. */
  derivedDataPath?: string;
  /** First build on a cold machine takes minutes; later ones are seconds. */
  timeoutMs?: number;
  onProgress?: (message: string) => void;
  /** Where testsky keeps what outlives a run; ~/.testsky. */
  home?: string;
}

/**
 * Where xcodebuild keeps one simulator's WebDriverAgent between runs, to
 * spare the next run the build. One folder per simulator: two builds into one
 * folder at once lock each other out of its build database.
 */
function wdaDerivedData(udid: string, home: string): string {
  return join(home, "wda", udid);
}

/** What xcodebuild is started with to run WebDriverAgent on one simulator, on one port. */
export function wdaLaunch(options: { udid: string; port: number; derivedDataPath: string; projectDir: string }): {
  args: string[];
  env: Record<string, string>;
} {
  return {
    args: [
      "-project",
      `${options.projectDir}/WebDriverAgent.xcodeproj`,
      "-scheme",
      "WebDriverAgentRunner",
      "-destination",
      `platform=iOS Simulator,id=${options.udid}`,
      "-derivedDataPath",
      options.derivedDataPath,
      "test",
    ],
    // The runner's scheme reads both: $(USE_PORT) and $(MJPEG_SERVER_PORT).
    env: { USE_PORT: String(options.port), MJPEG_SERVER_PORT: String(mjpegPortFor(options.port)) },
  };
}

/** The same simulator or phone, however its id was written. */
function sameSimulator(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toUpperCase() === b.toUpperCase();
}

// ── Phones ────────────────────────────────────────────────────────────────

/** A phone's WebDriverAgent, forwarded to a port on this Mac. */
export interface ForwardedIphone {
  udid: string;
  port: number;
}

const PHONE_UDID = /^(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})$/;

/**
 * What an iproxy command line forwards: which phone, from which local port
 * to which port on the phone. It is told the phone with -u/--udid or, in
 * the old form, after the ports; the ports as LOCAL:DEVICE or LOCAL DEVICE.
 * WebDriverAgent listens on 8100 on the phone, and that pair is the one kept
 * when there are several.
 */
export function iproxyForward(command: string): { udid: string; local: number; device: number } | undefined {
  const words = command.trim().split(/\s+/);
  if (!/(?:^|\/)iproxy$/.test(words[0] ?? "")) return undefined;
  let udid: string | undefined;
  const pairs: { local: number; device: number }[] = [];
  const loose: number[] = [];
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i]!;
    if (word === "-u" || word === "--udid") udid = words[++i];
    else if (word.startsWith("--udid=")) udid = word.slice("--udid=".length);
    else if (/^\d+:\d+$/.test(word)) {
      const [local, device] = word.split(":").map(Number) as [number, number];
      pairs.push({ local, device });
    } else if (/^\d+$/.test(word)) loose.push(Number(word));
    else if (!word.startsWith("-") && PHONE_UDID.test(word)) udid ??= word;
  }
  for (let i = 0; i + 1 < loose.length; i += 2) pairs.push({ local: loose[i]!, device: loose[i + 1]! });
  const pair = pairs.find((each) => each.device === DEFAULT_WDA_PORT) ?? pairs[0];
  if (!udid || !pair) return undefined;
  return { udid: udid.toUpperCase(), ...pair };
}

/**
 * iPhones whose WebDriverAgent is forwarded to this Mac right now, by
 * iproxy, as a device host usually runs them. testsky does not build, sign or start
 * WebDriverAgent on a phone -- that takes a signing team and a profile per
 * phone, which a rig already has -- it drives the one already there, or
 * none.
 */
export async function forwardedIphones(): Promise<ForwardedIphone[]> {
  const { stdout } = await run("ps", ["-axo", "command="], { maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
  const seen = new Map<string, ForwardedIphone>();
  for (const line of stdout.split("\n")) {
    const forward = iproxyForward(line);
    if (forward && !seen.has(forward.udid)) seen.set(forward.udid, { udid: forward.udid, port: forward.local });
  }
  return [...seen.values()];
}

/**
 * A phone's WebDriverAgent as the rig runs it: found by the iproxy that
 * forwards it, asked whether it answers, and checked to be this phone's --
 * never started and never stopped here.
 */
export async function forwardedWda(udid: string, port?: number): Promise<WdaHandle> {
  const at = port ?? (await forwardedIphones()).find((phone) => sameSimulator(phone.udid, udid))?.port;
  if (at === undefined) {
    throw new DeviceNotReadyError(
      `no WebDriverAgent is forwarded to this Mac for the iPhone ${udid}.\n` +
        "  testsky drives a phone through the WebDriverAgent already running on it -- on a lab rig the\n" +
        "  midscene service starts it, and iproxy forwards it. Start it first.",
    );
  }
  if (!(await wdaReady(at))) throw new DeviceNotReadyError(`WebDriverAgent for the iPhone ${udid} does not answer on port ${at}`);
  const owner = await ownerOf(at, udid);
  if (!sameSimulator(owner, udid)) {
    throw new DeviceNotReadyError(owner ? `port ${at} is forwarded to ${owner}, not to the iPhone ${udid}` : `port ${at} is not forwarded to the iPhone ${udid}`);
  }
  return { ours: false, port: at, stop: () => undefined };
}

export async function ensureWda(options: EnsureWdaOptions): Promise<WdaHandle> {
  const home = options.home ?? testskyHome();
  const port = options.port ?? (await portFor(options.udid, home));
  if (await wdaReady(port)) {
    // A WebDriverAgent is there already. It is used only if it is this
    // simulator's: one on another simulator -- or a tunnel to a phone --
    // answers every request just as well, about the wrong screen.
    const owner = await ownerOf(port, options.udid);
    if (sameSimulator(owner, options.udid)) return { ours: false, port, stop: () => undefined };
    throw new Error(
      owner
        ? `port ${port} is WebDriverAgent for simulator ${owner}, not for ${options.udid}`
        : `port ${port} answers like WebDriverAgent, but not from simulator ${options.udid}`,
    );
  }

  const derived = options.derivedDataPath ?? wdaDerivedData(options.udid, home);
  options.onProgress?.("starting WebDriverAgent (the first build takes a few minutes; later runs reuse it)");

  const launch = wdaLaunch({ udid: options.udid, port, derivedDataPath: derived, projectDir: wdaProjectDir() });
  const child: ChildProcess = spawn("xcodebuild", launch.args, {
    stdio: "ignore",
    detached: false,
    env: { ...process.env, ...launch.env },
  });

  let exited: number | null = null;
  child.on("exit", (code) => {
    exited = code ?? 0;
  });

  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  while (Date.now() < deadline) {
    if (await wdaReady(port)) {
      // Up where it was told to be -- unless something else got the port
      // first while it built: another simulator's WebDriverAgent, or iproxy
      // forwarding the port to a phone on a cable. Only this simulator's own
      // listener is driven.
      const owner = await ownerOf(port, options.udid);
      if (!sameSimulator(owner, options.udid)) {
        child.kill("SIGTERM");
        throw new Error(
          owner
            ? `port ${port} was taken by WebDriverAgent for simulator ${owner} while ${options.udid}'s was starting`
            : `port ${port} answers like WebDriverAgent, but not from simulator ${options.udid}: something else took it while it was starting`,
        );
      }
      options.onProgress?.("WebDriverAgent is up");
      return { ours: true, port, stop: () => child.kill("SIGTERM") };
    }
    if (exited !== null) {
      throw new Error(
        `WebDriverAgent stopped before it was ready (xcodebuild exited ${exited}). ` +
          "Check that the simulator is booted and that Xcode's command line tools are selected.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  child.kill("SIGTERM");
  throw new Error("WebDriverAgent did not come up in time");
}

/** Who listens on a port, looked at more than once: lsof can be slow to answer on a busy Mac. */
async function ownerOf(port: number, udid: string): Promise<string | undefined> {
  let owner: string | undefined;
  for (let look = 0; look < OWNER_LOOKS; look += 1) {
    if (look > 0) await new Promise((resolve) => setTimeout(resolve, 500));
    owner = await wdaOwner(port);
    if (sameSimulator(owner, udid)) return owner;
  }
  return owner;
}

/**
 * The port a simulator's WebDriverAgent listens on: its own, kept in
 * ~/.testsky/wda/ports.json so it is the same port every run. A new
 * simulator is given the first port no other simulator has and nothing is
 * listening on; one whose port something else took is given another.
 */
export async function portFor(
  udid: string,
  home = testskyHome(),
  probe: PortProbe = { inUse: portInUse, owner: wdaOwner, simulators: knownSimulators },
): Promise<number> {
  const file = join(home, "wda", "ports.json");
  await mkdir(dirname(file), { recursive: true });
  return withFileLock(`${file}.lock`, async () => {
    const ports = await readFile(file, "utf8").then(readPorts, () => ({}) as Record<string, number>);
    const kept = ports[udid];
    if (kept !== undefined && (!(await probe.inUse(kept)) || sameSimulator(await probe.owner(kept), udid))) return kept;
    // Simulators deleted since keep no port: a Mac that makes and deletes
    // them would otherwise run out of the hundred.
    const existing = await probe.simulators();
    if (existing.length) {
      for (const id of Object.keys(ports)) if (!existing.some((other) => sameSimulator(other, id))) delete ports[id];
    }
    const others = new Set(Object.entries(ports).filter(([id]) => id !== udid).map(([, port]) => port));
    for (let port = DEFAULT_WDA_PORT; port < DEFAULT_WDA_PORT + PORT_RANGE; port += 1) {
      if (others.has(port) || (await probe.inUse(port))) continue;
      ports[udid] = port;
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(ports, null, 2)}\n`);
      await rename(temporary, file);
      return port;
    }
    throw new Error(`no port is free for WebDriverAgent between ${DEFAULT_WDA_PORT} and ${DEFAULT_WDA_PORT + PORT_RANGE - 1}`);
  });
}

export interface PortProbe {
  inUse: (port: number) => Promise<boolean>;
  owner: (port: number) => Promise<string | undefined>;
  /** The simulators this Mac has; empty when it cannot say. */
  simulators: () => Promise<string[]>;
}

async function knownSimulators(): Promise<string[]> {
  return (await listSimulators().catch(() => [])).map((simulator) => simulator.udid);
}

/** The registry, or nothing when it does not read as one: ports are handed out again. */
function readPorts(text: string): Record<string, number> {
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch {
    return {};
  }
}

/** Whether anything accepts connections on a local port. */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (used: boolean) => {
      socket.destroy();
      resolve(used);
    };
    socket.setTimeout(1000, () => done(true));
    socket.once("connect", () => done(true));
    socket.once("error", (error: NodeJS.ErrnoException) => done(error.code !== "ECONNREFUSED"));
  });
}

/**
 * Which simulator or phone is listening on a port. A simulator's apps run
 * from inside its own folder -- .../CoreSimulator/Devices/<udid>/... -- and
 * its WebDriverAgent is one of them, so the listening process's path names
 * it; a phone's port is held by the iproxy forwarding it, which names the
 * phone.
 */
export async function wdaOwner(port: number): Promise<string | undefined> {
  let pids: string[];
  try {
    const { stdout } = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 5_000 });
    pids = stdout.split(/\s+/).filter(Boolean);
  } catch {
    // Nothing listening: lsof says so by failing.
    return undefined;
  }
  for (const pid of pids) {
    const command = await run("ps", ["-o", "command=", "-p", pid], { timeout: 5_000 }).then(({ stdout }) => stdout, () => "");
    const udid = simulatorOf(command) ?? iproxyForward(command)?.udid;
    if (udid) return udid;
  }
  return undefined;
}

/** The simulator a path inside one belongs to. */
export function simulatorOf(path: string): string | undefined {
  return /\/CoreSimulator\/Devices\/([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\//.exec(path)?.[1]?.toUpperCase();
}

// ── Reading the screen ────────────────────────────────────────────────────

export interface WdaNode {
  type?: string;
  name?: string;
  label?: string;
  value?: string;
  rawIdentifier?: string;
  isEnabled?: boolean | string;
  isVisible?: boolean | string;
  rect?: { x: number; y: number; width: number; height: number };
  children?: WdaNode[];
}

/** XCUIElement types a person can act on. StaticText is not one of them --
 *  it is what a screen says, not what it offers. */
const INTERACTIVE = new Set([
  "Button",
  "Cell",
  "TextField",
  "SecureTextField",
  "SearchField",
  "Switch",
  "Slider",
  "Link",
  "TabBar",
  "SegmentedControl",
  "PickerWheel",
  "Stepper",
  "Toggle",
  "MenuItem",
  "CollectionView",
  "Table",
  "ScrollView",
]);

/**
 * XCUITest reports booleans as the string "1".
 *
 * Reading only `true` and `"true"` marked every node on iOS non-interactive,
 * which nothing failed loudly about: the tree still listed labels, so
 * grounding looked fine, while the screen identity was empty and confidence
 * calibration silently scored every answer as landing on nothing.
 */
function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "true" || value === "1";
}

function toNode(raw: WdaNode, index: number): TreeNode {
  const role = (raw.type ?? "Other").replace(/^XCUIElementType/, "");
  const rect = raw.rect ?? { x: 0, y: 0, width: 0, height: 0 };
  const label = (raw.label ?? "").trim();
  const name = (raw.name ?? "").trim();
  const node: TreeNode = {
    ref: `i${index}`,
    role,
    bounds: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    enabled: raw.isEnabled === undefined ? true : truthy(raw.isEnabled),
    interactive: INTERACTIVE.has(role) && (raw.isEnabled === undefined || truthy(raw.isEnabled)),
    children: (raw.children ?? []).map((child, i) => toNode(child, index * 100 + i + 1)),
  };
  if (label) node.label = label;
  // XCUITest lists what it holds whether or not it is drawn: a cell scrolled
  // out of its table, a view behind another. Said, it is kept -- for what
  // draws nothing at all. iOS 27's Settings wraps every row in containers it
  // calls not visible while the rows inside them are: taken at its word, a
  // container hid all it held, and the Wi-Fi page's tree came out as the bare
  // application, so every Wi-Fi decision there was made from the picture alone.
  if (raw.isVisible !== undefined && !truthy(raw.isVisible) && !node.children.some((child) => child.visible !== false)) node.visible = false;
  // On iOS `name` carries the accessibility identifier when the developer set
  // one, and the label when they did not -- only the first is worth keeping as
  // an identity, because the second changes with the words on screen.
  if (name && name !== label) node.identifier = name;
  const value = (raw.value ?? "").toString().trim();
  if (value && value !== label) node.value = value;
  return node;
}

/**
 * The screen as XCUITest describes it.
 *
 * This is the piece Midscene does not have -- its iOS device never implements
 * `getUITree`, and its WebDriver client wraps no `/source` endpoint -- and it
 * is the piece that matters most on iOS, where the same models score around
 * 52% with the tree against 20-29% from pixels alone.
 */
/** The mapping, separated from the fetching so it can be tested without a Mac. */
export function parseWdaSource(value: WdaNode, capturedAt = Date.now(), captureMs = 0): TreeSnapshot {
  return {
    platform: "ios",
    capturedAt,
    source: "xcuitest",
    root: toNode(value, 0),
    truncated: false,
    captureMs,
  };
}

/**
 * The source as XCUITest is asked for it. Whether each element is drawn is
 * most of the price: on an iPhone 12 mini's Wi-Fi page 1.4 s of a 1.8 s read
 * (0.2 s without it), and a read that slow went stale under a list re-sorting
 * as it scanned. Nothing here reads "accessible". Visibility is kept for what
 * a model is shown -- a skip button listed before the ad offered it was
 * pressed -- and left out where only a control's place or kind is wanted.
 */
export function wdaSourcePath(visibility = true): string {
  return `/source?format=json&excluded_attributes=${visibility ? "accessible" : "visible,accessible"}`;
}

export async function wdaTree(port = DEFAULT_WDA_PORT, options: { visibility?: boolean } = {}): Promise<TreeSnapshot | undefined> {
  const startedAt = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}${wdaSourcePath(options.visibility ?? true)}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { value?: WdaNode };
  if (!body.value) return undefined;
  return parseWdaSource(body.value, startedAt, Date.now() - startedAt);
}

type Fetch = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Whether the keyboard is up: typing goes to the focused field, and with none it goes nowhere. */
export async function wdaKeyboardUp(port = DEFAULT_WDA_PORT, fetcher: Fetch = fetch as unknown as Fetch): Promise<boolean | undefined> {
  const response = await fetcher(`http://127.0.0.1:${port}${wdaSourcePath(false)}`, { signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
  if (!response?.ok) return undefined;
  const has = (node: { type?: string; children?: unknown[] } | undefined): boolean =>
    Boolean(node) && (node!.type === "XCUIElementTypeKeyboard" || (node!.children ?? []).some((child) => has(child as { type?: string; children?: unknown[] })));
  return has(((await response.json()) as { value?: { type?: string; children?: unknown[] } }).value);
}

/** One WebDriverAgent call: its JSON answer, or nothing for a call that failed. */
function wdaCaller(port: number, fetcher: Fetch) {
  const base = `http://127.0.0.1:${port}`;
  return async (path: string, body?: unknown): Promise<{ value?: unknown; sessionId?: string } | undefined> => {
    const response = await fetcher(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => undefined);
    return response?.ok ? ((await response.json().catch(() => ({}))) as { value?: unknown; sessionId?: string }) : undefined;
  };
}

/** The element ids in a find's answer, in either protocol's spelling. */
function elementIds(found: unknown): string[] {
  return Array.isArray(found) ? found.map((each) => (each as Record<string, string>).ELEMENT ?? Object.values(each as Record<string, string>)[0]!).filter(Boolean) : [];
}

const FIELDS = "type IN {'XCUIElementTypeSecureTextField', 'XCUIElementTypeTextField', 'XCUIElementTypeSearchField'}";

/**
 * Types into the text field at `point`, as XCUITest types into an element: it
 * gives the field the keyboard first. A tap on the password field of iOS 27's
 * join sheet left the keyboard down, and every key typed after it went
 * nowhere. In WebDriverAgent's current session, so that the engine's own
 * session is the one used. False when no field is at the point.
 */
export async function wdaTypeIntoFieldAt(port: number, point: { x: number; y: number }, text: string, fetcher: Fetch = fetch as unknown as Fetch): Promise<boolean> {
  const call = wdaCaller(port, fetcher);
  const session = (await call("/status"))?.sessionId;
  if (!session) return false;
  const ids = elementIds((await call(`/session/${session}/elements`, { using: "predicate string", value: FIELDS }))?.value);
  for (const id of ids) {
    const rect = (await call(`/session/${session}/element/${id}/rect`))?.value as { x: number; y: number; width: number; height: number } | undefined;
    if (!rect || point.x < rect.x || point.x > rect.x + rect.width || point.y < rect.y || point.y > rect.y + rect.height) continue;
    return Boolean(await call(`/session/${session}/element/${id}/value`, { text, value: [...text] }));
  }
  return false;
}

/** How XCUITest is asked for one control: by what it is and says, or by that inside the row that says something no other row does. */
export interface WdaLocator {
  using: "predicate string" | "class chain";
  value: string;
}

/** A control as the tree names it: its role (an XCUIElementType without the prefix), its words, its identifier. */
export interface WdaControl {
  role: string;
  label?: string;
  identifier?: string;
}

/** A string in a predicate, quoted as NSPredicate reads one. */
function quoted(text: string): string {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** What the control is and says, as a predicate; nothing for a control that says nothing. */
export function controlPredicate(control: WdaControl): string | undefined {
  if (!control.label && !control.identifier) return undefined;
  return [
    `type == ${quoted(`XCUIElementType${control.role}`)}`,
    ...(control.label ? [`label == ${quoted(control.label)}`] : []),
    ...(control.identifier ? [`name == ${quoted(control.identifier)}`] : []),
  ].join(" AND ");
}

/**
 * The control inside the row whose text says `row`: every network on the
 * Wi-Fi page has its own "More Info" button, and only the row around it says
 * which one this is. A class chain, so XCUITest finds it in one query; none
 * for words its syntax cannot carry.
 */
export function controlInRow(control: WdaControl, row: string): WdaLocator | undefined {
  if ((!control.label && !control.identifier) || [control.label ?? "", control.identifier ?? "", row].some((each) => /[`$]/.test(each))) return undefined;
  const own = [...(control.label ? [`label == ${quoted(control.label)}`] : []), ...(control.identifier ? [`name == ${quoted(control.identifier)}`] : [])].join(" AND ");
  const rowText = `type == 'XCUIElementTypeStaticText' AND label == ${quoted(row)}`;
  return { using: "class chain", value: "**/XCUIElementTypeCell[$" + rowText + "$]/**/XCUIElementType" + control.role + "[`" + own + "`]" };
}

/** What became of a press asked for by locator. */
export type WdaPress =
  /** XCUITest pressed it, where it was at that moment. */
  | "pressed"
  /** Nothing on the screen now answers the locator. */
  | "absent"
  /** More than one thing does: which one was meant is not for this call to guess. */
  | "ambiguous"
  /** WebDriverAgent could not be asked, or refused the press. */
  | "unavailable";

/**
 * Presses one control as XCUITest presses an element: it is looked up as the
 * press is made, so a list that moves between the decision and the press
 * moves the press with it. A coordinate tap 3 s after the tree was read
 * opened another network's password sheet on an iPhone 12 mini, its list
 * re-sorting as it scanned; found this way the same row was pressed in 1.1 s.
 * In WebDriverAgent's current session -- the engine's own.
 */
export async function wdaPress(
  port: number,
  locator: WdaLocator,
  fetcher: Fetch = fetch as unknown as Fetch,
  options: { drawnOnly?: boolean } = {},
): Promise<WdaPress> {
  const call = wdaCaller(port, fetcher);
  const session = (await call("/status"))?.sessionId;
  if (!session) return "unavailable";
  const found = await call(`/session/${session}/elements`, locator);
  if (!found) return "unavailable";
  let ids = elementIds(found.value);
  if (ids.length === 0) return "absent";
  // Asked for what is drawn only -- a control read off a tree that did not
  // say what was drawn -- one that is not drawn is not there.
  if (options.drawnOnly && ids.length <= AMBIGUOUS_CHECKED) {
    const drawn: string[] = [];
    for (const id of ids) {
      const visible = (await call(`/session/${session}/element/${id}/attribute/visible`))?.value;
      if (visible === true || visible === "true" || visible === 1 || visible === "1") drawn.push(id);
    }
    if (drawn.length === 0) return "absent";
    ids = drawn;
  }
  // Two that answer, of which one is drawn: the page just left behind keeps
  // its rows for a moment, and the one on the screen is the one meant.
  if (ids.length > 1 && ids.length <= AMBIGUOUS_CHECKED) {
    const drawn: string[] = [];
    for (const id of ids) {
      const visible = (await call(`/session/${session}/element/${id}/attribute/visible`))?.value;
      if (visible === true || visible === "true" || visible === 1 || visible === "1") drawn.push(id);
    }
    if (drawn.length) ids = drawn;
  }
  if (ids.length > 1) return "ambiguous";
  return (await call(`/session/${session}/element/${ids[0]}/click`, {})) ? "pressed" : "unavailable";
}

/** How many answers to a locator are worth asking whether each is drawn: each asking costs about 0.3 s. */
const AMBIGUOUS_CHECKED = 4;
