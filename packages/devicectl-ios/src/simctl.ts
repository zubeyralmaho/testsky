/**
 * The iOS simulator, driven from a terminal.
 *
 * `simctl` is the whole of the lifecycle on a simulator: list, boot, install,
 * launch, terminate. It ships with Xcode, needs no signing, no provisioning
 * profile and no device in a drawer -- which is why the first iOS support in
 * this product is simulators rather than phones. Physical iOS needs a
 * developer tunnel, a signed WebDriverAgent and a paid Apple account, and it
 * deserves its own week rather than being smuggled into this one.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { testskyHome, withFileLock } from "@testsky/engine-core";

const run = promisify(execFile);

export interface Simulator {
  udid: string;
  name: string;
  state: "Booted" | "Shutdown" | string;
  runtime: string;
}

interface SimctlDeviceList {
  devices: Record<string, { udid: string; name: string; state: string; isAvailable?: boolean }[]>;
}

export async function listSimulators(): Promise<Simulator[]> {
  const { stdout } = await run("xcrun", ["simctl", "list", "devices", "--json"], { maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as SimctlDeviceList;
  const simulators: Simulator[] = [];
  for (const [runtime, devices] of Object.entries(parsed.devices)) {
    for (const device of devices) {
      if (device.isAvailable === false) continue;
      // "com.apple.CoreSimulator.SimRuntime.iOS-26-0" -> "iOS 26.0"
      const pretty = runtime.split(".").pop()?.replace(/-/g, " ").replace(/^iOS /, "iOS ") ?? runtime;
      if (!pretty.startsWith("iOS")) continue;
      simulators.push({ udid: device.udid, name: device.name, state: device.state, runtime: pretty.replace(/(\d+) (\d+)$/, "$1.$2") });
    }
  }
  return simulators;
}

/**
 * Boots a simulator and waits until it is up.
 *
 * One `simctl boot` at a time on this Mac, whoever asks: two simulators told
 * to boot in the same moment had the second refused with "Invalid argument",
 * and booted on its own a second later it came up fine. Waiting for the boot
 * to finish is not held to one at a time -- that is the slow part.
 */
export async function bootSimulator(udid: string): Promise<void> {
  const booted = async () => (await listSimulators()).find((entry) => entry.udid === udid)?.state === "Booted";
  if (await booted()) return;
  await withFileLock(join(testskyHome(), "simulators", "boot.lock"), async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await run("xcrun", ["simctl", "boot", udid]);
        return;
      } catch (error) {
        // Booting an already-booting device is not a failure worth stopping for.
        if (/current state: Booted|Unable to boot device in current state/.test((error as Error).message) || (await booted())) return;
        if (attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }, { timeoutMs: 120_000, what: `booting simulator ${udid}` });
  await run("xcrun", ["simctl", "bootstatus", udid, "-b"]);
}

export async function installApp(udid: string, appPath: string): Promise<void> {
  await run("xcrun", ["simctl", "install", udid, appPath]);
}

/** Whether an app is installed on a simulator: it has a container there. */
export async function appInstalled(udid: string, bundleId: string): Promise<boolean> {
  return run("xcrun", ["simctl", "get_app_container", udid, bundleId]).then(
    () => true,
    () => false,
  );
}

export async function launchApp(udid: string, bundleId: string): Promise<void> {
  await run("xcrun", ["simctl", "launch", udid, bundleId]);
}

export async function terminateApp(udid: string, bundleId: string): Promise<void> {
  await run("xcrun", ["simctl", "terminate", udid, bundleId]).catch(() => undefined);
}

/** The installed build's version, as the cache's invalidation key. */
export async function appVersion(udid: string, bundleId: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("xcrun", ["simctl", "get_app_container", udid, bundleId]);
    const plist = `${stdout.trim()}/Info.plist`;
    const read = async (key: string) =>
      (await run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist])).stdout.trim();
    const [short, build] = await Promise.all([read("CFBundleShortVersionString"), read("CFBundleVersion")]);
    return `${bundleId}@${short}+${build}`;
  } catch {
    // A system app has no container we can read, and a missing version is not
    // worth failing a run over -- it only means a colder cache.
    return undefined;
  }
}

/** The clock we hold, as `status_bar override --time` is given it. */
const CLOCK = "9:41";

/**
 * Whose the overrides printed by `status_bar list` are: nobody's, ours alone,
 * or somebody else's. simctl prints `--time 9:41` back as `Time: 09:41`
 * (measured, Xcode 26); the hour is read with or without its zero.
 */
export function statusBarOwner(listed: string): "none" | "ours" | "theirs" {
  const overrides = listed.split("\n").slice(2).map((line) => line.trim()).filter(Boolean);
  if (!overrides.length) return "none";
  const ours = [`Time: ${CLOCK}`, `Time: ${CLOCK.padStart(5, "0")}`];
  return overrides.length === 1 && ours.includes(overrides[0]!) ? "ours" : "theirs";
}

async function statusBarList(udid: string): Promise<string> {
  const { stdout } = await run("xcrun", ["simctl", "status_bar", udid, "list"]);
  return stdout;
}

/**
 * The clock held at 9:41 for a run, and only the clock. A clock that ticks
 * makes two frames of an unchanged screen differ, so a check already passed
 * on it could not be recognised again. The bars and the battery are left as
 * they are: they are what a model is shown of the device, and a test that
 * turns Wi-Fi off must see it go. Somebody else's overrides are left alone;
 * our own clock, left behind by a run that never got to clear it, is ours.
 */
export async function freezeStatusBar(udid: string): Promise<boolean> {
  const owner = statusBarOwner(await statusBarList(udid));
  if (owner !== "none") return owner === "ours";
  await run("xcrun", ["simctl", "status_bar", udid, "override", "--time", CLOCK]);
  return true;
}

/** Cleared only while what is there is still just our clock: an override somebody added meanwhile stays. */
export async function releaseStatusBar(udid: string): Promise<void> {
  if (statusBarOwner(await statusBarList(udid).catch(() => "")) === "ours") {
    await run("xcrun", ["simctl", "status_bar", udid, "clear"]).catch(() => undefined);
  }
}

/** The process an app runs as -- its executable's name, which the system log goes by. */
export async function appExecutable(udid: string, bundleId: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("xcrun", ["simctl", "get_app_container", udid, bundleId]);
    const plist = `${stdout.trim()}/Info.plist`;
    return (await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plist])).stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Delivers a real notification to an app on a simulator.
 *
 * `simctl push` goes through the system's own notification path, so the app
 * receives what it would receive in the wild -- including the launch that
 * follows a tap. Reaching a screen through a notification is a flow every
 * consumer app has and almost no test suite covers, because doing it by hand
 * is miserable.
 */
export async function pushNotification(
  udid: string,
  bundleId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "testsky-push-"));
  const file = join(dir, "payload.apns");
  await writeFile(file, JSON.stringify(payload));
  await run("xcrun", ["simctl", "push", udid, bundleId, file]);
}
