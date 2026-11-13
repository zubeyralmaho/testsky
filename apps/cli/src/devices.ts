/**
 * Which phones this machine can drive right now.
 *
 * The runner will manage a pool of these; the CLI just lists them, because the
 * first question anyone asks a device tool is "can you see my phone".
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { getConnectedDevices } from "@midscene/android";
import { forwardedIphones, listSimulators } from "@testsky/devicectl-ios";
import type { DeviceHandle, Platform } from "@testsky/engine-core";

import { quietly } from "./quiet.ts";

const exec = promisify(execFile);

/** Something about this machine is not ready. Printed without a stack trace:
 *  the person reading it needs an instruction, not our call frames. */
export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

const ADB_MISSING =
  "adb is not installed, or not on PATH.\n" +
  "  macOS:  brew install --cask android-platform-tools\n" +
  "  or:     install Android Studio and add <sdk>/platform-tools to PATH\n" +
  "Then check it yourself with `adb devices` before running testsky again.";

/** Android devices adb lists; `usable` leaves out the ones it cannot use yet -- unauthorized, offline. */
export async function listAndroidDevices(verbose = false, usable = false): Promise<DeviceHandle[]> {
  let devices: Awaited<ReturnType<typeof getConnectedDevices>>;
  try {
    devices = await quietly(() => getConnectedDevices(), verbose);
  } catch (error) {
    const message = (error as Error).message;
    if (/'adb' executable is not found|adb.*not found/i.test(message)) throw new SetupError(ADB_MISSING);
    throw new SetupError(`adb could not list devices: ${message}`);
  }
  const state = (device: (typeof devices)[number]) => (device as { state?: string }).state;
  return devices
    .filter((device) => !usable || state(device) === undefined || state(device) === "device")
    .map((device) => ({
      id: device.udid,
      platform: "android" as const,
      osVersion: "",
      kind: device.udid.startsWith("emulator-") ? ("emulator" as const) : ("physical" as const),
    }));
}

/**
 * iOS simulators this Mac can run, booted ones first, and then the iPhones
 * whose WebDriverAgent is forwarded to it.
 *
 * Only those phones: testsky does not sign or start WebDriverAgent on a
 * phone, so a phone without one running is one it cannot drive, and listing
 * it would promise what the runner cannot do.
 */
export async function listIosDevices(): Promise<DeviceHandle[]> {
  const phones = await iphones();
  let simulators: Awaited<ReturnType<typeof listSimulators>>;
  try {
    simulators = await listSimulators();
  } catch (error) {
    if (phones.length) return phones;
    throw new SetupError(
      `Xcode's simulator tools are not usable: ${(error as Error).message}\n` +
        "  Install Xcode from the App Store, then run: sudo xcode-select -s /Applications/Xcode.app",
    );
  }
  return [
    ...simulators
      .sort((a, b) => Number(b.state === "Booted") - Number(a.state === "Booted"))
      .map((simulator) => ({
        id: simulator.udid,
        platform: "ios" as const,
        osVersion: simulator.runtime.replace(/^iOS /, ""),
        kind: "simulator" as const,
      })),
    ...phones,
  ];
}

/** iPhones on a cable with WebDriverAgent forwarded here, and the iOS each runs when it says. */
async function iphones(): Promise<DeviceHandle[]> {
  const forwarded = await forwardedIphones().catch(() => []);
  return Promise.all(
    forwarded.map(async (phone) => ({
      id: phone.udid,
      platform: "ios" as const,
      osVersion: await exec("ideviceinfo", ["-u", phone.udid, "-k", "ProductVersion"], { timeout: 3_000 }).then(
        ({ stdout }) => stdout.trim(),
        () => "",
      ),
      kind: "physical" as const,
    })),
  );
}

export async function listDevices(platform: Platform, verbose = false): Promise<DeviceHandle[]> {
  return platform === "ios" ? listIosDevices() : listAndroidDevices(verbose);
}

/** The device an id names, whole or by its start. An iPhone's id is hex, the same in either case; an Android serial is what it is. */
export function matchDevice(devices: DeviceHandle[], preferred: string): DeviceHandle | undefined {
  return devices.find((device) => {
    const [id, wanted] = device.platform === "ios" ? [device.id.toUpperCase(), preferred.toUpperCase()] : [device.id, preferred];
    return id === wanted || id.startsWith(wanted);
  });
}

export async function resolveDevice(
  platform: Platform,
  preferred?: string,
  verbose = false,
): Promise<DeviceHandle> {
  const devices = await listDevices(platform, verbose);
  if (devices.length === 0) {
    throw new SetupError(
      platform === "ios"
        ? "No iOS simulator is available. Create one in Xcode, or check: xcrun simctl list devices available"
        : "No Android device is connected. Start an emulator, or plug a phone in with USB debugging enabled, " +
          "then check `adb devices`.",
    );
  }
  const match = preferred ? matchDevice(devices, preferred) : devices[0];
  if (!match) {
    throw new SetupError(`No ${platform} device "${preferred}". Available: ${devices.map((d) => d.id).join(", ")}`);
  }
  // Leased by its own serial, so that it is one phone however it is reached.
  if (match.platform === "android") {
    const serial = ownSerial(match.id, await androidSerial(match.id));
    if (serial) match.serial = serial;
  }
  return match;
}

/**
 * The phones a run on "all" goes to: what adb can use now, and the simulators
 * already booted -- not every simulator this Mac could boot.
 */
export async function readyDevices(platform: Platform, verbose = false): Promise<DeviceHandle[]> {
  if (platform === "android") return onePerPhone(await listAndroidDevices(verbose, true));
  const booted = new Set((await listSimulators().catch(() => [])).filter((simulator) => simulator.state === "Booted").map((simulator) => simulator.udid));
  return (await listIosDevices()).filter((device) => device.kind === "physical" || booted.has(device.id));
}

/**
 * Each id, as a phone on one of the platforms: an id may be given by its
 * start, as with --device, but one that could be two phones is refused
 * rather than guessed.
 */
export async function findDevices(ids: string[], platforms: Platform[], verbose = false): Promise<DeviceHandle[]> {
  const known: DeviceHandle[] = [];
  for (const platform of platforms) known.push(...(await listDevices(platform, verbose).catch(() => [])));
  const found: DeviceHandle[] = [];
  for (const id of ids) {
    const exact = known.filter((device) => device.id === id);
    const matches = exact.length ? exact : known.filter((device) => device.id.startsWith(id));
    if (matches.length === 0) {
      throw new SetupError(`No ${platforms.join(" or ")} device "${id}". Available: ${known.map((device) => device.id).join(", ") || "none"}`);
    }
    if (matches.length > 1) throw new SetupError(`"${id}" could be any of ${matches.map((device) => device.id).join(", ")}: give more of it`);
    if (!found.some((device) => device.id === matches[0]!.id)) found.push(matches[0]!);
  }
  return onePerPhone(found);
}

/** adb as the Android tools put it: the SDK's own, or the one on PATH. */
function adb(): string {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const own = sdk ? join(sdk, "platform-tools", "adb") : undefined;
  return own && existsSync(own) ? own : "adb";
}

/** An Android phone's own serial, as it says it, whichever id adb reaches it by. */
export async function androidSerial(id: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec(adb(), ["-s", id, "shell", "getprop", "ro.serialno"], { timeout: 5_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Serials that are nobody's own: every emulator of one SDK says
 * EMULATOR<version>, and some phones leave the factory with a placeholder.
 * Taken for a phone's identity, two emulators were one phone -- one of them
 * left out of the run, the other's lease shared.
 */
const PLACEHOLDER_SERIAL = /^(emulator.*|0123456789abcdef|unknown|0+)$/i;

/** The serial that identifies the phone behind an id, or nothing: then the id is its identity. */
export function ownSerial(id: string, said: string | undefined): string | undefined {
  if (id.startsWith("emulator-") || !said || PLACEHOLDER_SERIAL.test(said)) return undefined;
  return said;
}

/** Reached over the network -- `adb connect`, or wireless debugging's mDNS name -- not by its cable. */
function overNetwork(id: string): boolean {
  return id.includes(":") || id.includes("._tcp");
}

/**
 * Each phone once, with its serial. adb lists a phone on a cable and over
 * `adb connect` as two devices, and both were run on at once. The cable's id
 * is the one kept: it does not drop when the Wi-Fi does, which in a Wi-Fi
 * test is the point.
 */
export async function onePerPhone(devices: DeviceHandle[], serialOf = androidSerial): Promise<DeviceHandle[]> {
  const serials = await Promise.all(
    devices.map(async (device) => (device.platform === "android" ? ownSerial(device.id, await serialOf(device.id)) : undefined)),
  );
  const kept: DeviceHandle[] = [];
  devices.forEach((device, index) => {
    const serial = serials[index];
    const named = serial ? { ...device, serial } : device;
    const earlier = serial ? kept.findIndex((other) => other.serial === serial) : -1;
    if (earlier === -1) kept.push(named);
    else if (overNetwork(kept[earlier]!.id) && !overNetwork(device.id)) kept[earlier] = named;
  });
  return kept;
}

/**
 * Other programs at work on a phone right now: anything whose command line
 * names it, other than what keeps it reachable -- the iproxy forwarding a
 * phone's WebDriverAgent, the build that runs it -- and other than this run
 * and the run that started it. Another automation run, a mirror somebody has open:
 * the lease knows only testsky's own runs, and a phone's WebDriverAgent takes
 * one session at a time -- a second runner takes it over.
 */
export function othersUsing(ps: string, ids: string[], mine: ReadonlySet<number>): string[] {
  const named = ids.filter(Boolean).map((id) => new RegExp(`(?:^|[^A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^A-Za-z0-9]|$)`, "i"));
  const others: string[] = [];
  for (const line of ps.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, elapsed, command] = match as unknown as [string, string, string, string];
    if (mine.has(Number(pid)) || !named.some((id) => id.test(command))) continue;
    // What keeps a phone reachable, or reads it without driving it.
    if (/(?:^|\/)(?:iproxy|idevice\w*)\s|WebDriverAgent/.test(command)) continue;
    // A testsky MCP server names the phones it may use, not one it is using:
    // it holds a phone only by the lease, as a run does. Two idle servers,
    // left by two Claude sessions, refused every run on their four phones.
    if (/(?:^|[\s/])(?:main\.ts|testsky)\s+mcp(?:\s|$)/.test(command)) continue;
    // Said by program and script, never by its arguments: a run's arguments
    // may carry secrets.
    const words = command.split(/\s+/);
    const program = words[0]!.split("/").pop()!;
    const script = words.slice(1).find((word) => /\.(?:[cm]?[jt]s)$/.test(word) || word === "scrcpy");
    others.push(`pid ${pid} (${program}${script ? ` ${script.split("/").slice(-2).join("/")}` : ""}, running ${elapsed})`);
  }
  return others;
}

/** This process and the ones that started it: a run started by `run --devices` names its phone in its parent's arguments. */
async function ancestry(): Promise<Set<number>> {
  const mine = new Set<number>([process.pid]);
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid="], { maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
  const parents = new Map(stdout.split("\n").map((line) => line.trim().split(/\s+/).map(Number) as [number, number]));
  for (let pid = process.ppid; pid > 1 && !mine.has(pid); pid = parents.get(pid) ?? 0) mine.add(pid);
  return mine;
}

/** What else is at work on this phone now, in a person's words; empty when nothing is. */
export async function busyWithOthers(device: DeviceHandle): Promise<string[]> {
  const { stdout } = await exec("ps", ["-axo", "pid=,etime=,command="], { maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
  return othersUsing(stdout, [device.id, device.serial ?? ""], await ancestry());
}
