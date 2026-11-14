/**
 * One instruction on a phone: `testsky step` and `testsky look`.
 *
 * A test is written a step at a time -- try one, look at what it did, keep
 * it -- and here that happens from a terminal, as Midscene's own CLIs do it:
 * take the phone, do one thing, let it go. Every step runs through the
 * executor as a one-step test, so whoever drives it -- a person, an agent
 * through its shell -- learns how the step will go in a run, not how some
 * other tool would have pressed. There is no "tap at x,y" here, on purpose:
 * where to press is testsky's to decide, and the test is written in words.
 */

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { isTestFile } from "@testsky/artifact";
import type { DeviceHandle, Engine, Lease, Platform, TreeNode, TreeSnapshot } from "@testsky/engine-core";
import { describeOutcome, isFailure, type Outcome } from "@testsky/executor";
import { engineFor, StepSession, type SavedStep, type StepBody, type TriedStep } from "@testsky/harness";
import { toPng } from "@testsky/perception";
import { CostLedger, Router, routerConfigFromEnv } from "@testsky/router";

import { findDevices, resolveDevice } from "./devices.ts";
import type { JsonAnswer } from "./json.ts";
import { quietly } from "./quiet.ts";
import { exitCodeFor } from "./report.ts";

const DIM = "\u001b[2m";
const GREEN = "\u001b[32m";
const AMBER = "\u001b[33m";
const RED = "\u001b[31m";
const RESET = "\u001b[0m";

type Flag = (argv: string[], name: string) => string | undefined;
type TakePhone = (device: DeviceHandle, what: string) => Promise<Lease | undefined>;

export interface PhoneCommand {
  json: JsonAnswer | undefined;
  flag: Flag;
  takePhone: TakePhone;
}

/** The phone a command names: by --platform and --device, or by --device alone on either platform. */
export async function pickDevice(platform: string | undefined, id: string | undefined, verbose = false): Promise<DeviceHandle> {
  if (platform !== undefined && platform !== "android" && platform !== "ios") {
    throw Object.assign(new Error("--platform must be android or ios"), { name: "SetupError" });
  }
  if (platform) return resolveDevice(platform as Platform, id, verbose);
  if (id) return (await findDevices([id], ["android", "ios"], verbose))[0]!;
  return resolveDevice("android", undefined, verbose);
}

/** PNG or JPEG by the bytes' own signature, for a file's name. */
export function extensionOf(bytes: Buffer): "png" | "jpg" | "webp" {
  if (bytes.subarray(0, 4).toString("binary") === "\x89PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  return "webp";
}

/** A frame on disk: where it was asked to go, or a file of its own in the temporary folder. */
export async function keepFrame(bytes: Buffer, asked: string | undefined, what: string): Promise<string> {
  const path = asked ? resolve(asked) : join(tmpdir(), `testsky-${what}-${Date.now()}.${extensionOf(bytes)}`);
  // A file asked for as a .png is a PNG, whatever the phone sent: the agent sends JPEGs.
  await writeFile(path, /\.png$/i.test(path) ? await toPng(bytes) : bytes);
  return path;
}

const box = (node: TreeNode) => `(${Math.round(node.bounds.x)},${Math.round(node.bounds.y)} ${Math.round(node.bounds.width)}x${Math.round(node.bounds.height)})`;

/**
 * The accessibility tree as lines a person or a model can read: a node that
 * says something -- a label, a value, an identifier -- or can be used, with
 * where it is; a container that says nothing is passed through, and what is
 * not drawn is left out. Cut at `limit` lines, and said to be.
 */
export function outlineTree(tree: TreeSnapshot, limit = 300): string[] {
  const lines: string[] = [];
  let cut = false;
  const walk = (node: TreeNode, depth: number) => {
    if (node.visible === false) return;
    const says = node.label || node.value || node.identifier;
    let below = depth;
    if (says || node.interactive) {
      if (lines.length >= limit) {
        cut = true;
        return;
      }
      const words = [
        node.role,
        node.label ? JSON.stringify(node.label) : "",
        node.value && node.value !== node.label ? `= ${JSON.stringify(node.value)}` : "",
        node.identifier ? `#${node.identifier}` : "",
        box(node),
        node.enabled ? "" : "[disabled]",
        node.focused ? "[focused]" : "",
      ].filter(Boolean);
      lines.push(`${"  ".repeat(depth)}${words.join(" ")}`);
      below = depth + 1;
    }
    for (const child of node.children) walk(child, below);
  };
  walk(tree.root, 0);
  if (cut || tree.truncated) lines.push(`... ${cut ? `more than ${limit} nodes` : "the device cut the tree short"}`);
  return lines;
}

/** The step a command's --do, --expect and --read make: one, two or all three of them. */
export function stepFromFlags(argv: string[], flag: Flag): StepBody | undefined {
  const done = flag(argv, "do");
  const expected = flag(argv, "expect");
  const read = flag(argv, "read");
  if (!done && !expected && !read) return undefined;
  return {
    ...(done ? { do: done } : {}),
    ...(expected ? { expect: expected } : {}),
    ...(read ? { extract: { answer: read } } : {}),
  };
}

/** A tried step as `--json` and `testsky mcp` answer it. */
export function stepAnswer(tried: TriedStep, device: DeviceHandle, extra: { shot?: string; saved?: SavedStep; notSaved?: string } = {}) {
  const step = tried.result.steps[0];
  const outcome = (step?.outcome ?? tried.result.outcome) as Outcome;
  return {
    id: tried.id,
    outcome,
    passed: tried.passed,
    exitCode: tried.passed ? 0 : exitCodeFor(tried.result),
    meaning: describeOutcome(outcome),
    detail: step?.detail ?? tried.result.detail,
    ...(tried.answer !== undefined ? { answer: tried.answer } : {}),
    step: tried.step,
    device: device.id,
    platform: device.platform,
    actions: step?.actions ?? 0,
    ms: tried.result.finishedAt - tried.result.startedAt,
    usd: tried.calls.reduce((sum, call) => sum + call.usd, 0),
    modelCalls: tried.calls.length,
    ...(tried.result.popups ? { popups: tried.result.popups } : {}),
    ...extra,
  };
}

/** What a command has attached, for a stop from outside to let go of. */
interface Attached {
  engine?: Engine;
}

/** The phone held for one command: its engine attached, and everything let go of together. */
async function hold(device: DeviceHandle, argv: string[], flag: Flag, attached: Attached) {
  const verbose = argv.includes("--verbose");
  const wdaPort = flag(argv, "wda-port") === undefined ? undefined : Number(flag(argv, "wda-port"));
  if (wdaPort !== undefined && (!Number.isInteger(wdaPort) || wdaPort <= 0)) throw Object.assign(new Error("--wda-port is a port number"), { name: "SetupError" });
  const ledger = new CostLedger();
  const engine: Engine & { stepId?: string } = engineFor(device.platform, new Router(routerConfigFromEnv(), ledger), {
    ...(wdaPort !== undefined ? { wdaPort } : {}),
    onProgress: (message) => console.log(`${DIM}  ${message}${RESET}`),
  });
  // Known before the attach: a stop while WebDriverAgent builds lets go of it too.
  attached.engine = engine;
  await quietly(() => engine.attach(device), verbose);
  return { engine, ledger };
}

/**
 * The phone taken for one thing and let go of after it, even when the
 * command is stopped from outside: a phone held by a process that is gone
 * waits for the next run to notice.
 */
async function withPhone<T>(device: DeviceHandle, what: string, command: PhoneCommand, work: (attached: Attached) => Promise<T>): Promise<T | undefined> {
  const lease = await command.takePhone(device, what);
  if (!lease) return undefined;
  const attached: Attached = {};
  // The device let go of before the phone: a stay-awake setting, a frozen
  // status bar and a WebDriverAgent session are the device's to give back.
  const stop = (signal: NodeJS.Signals) =>
    void Promise.allSettled([attached.engine?.detach()])
      .then(() => lease.release())
      .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    return await work(attached);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await lease.release();
  }
}

export async function commandStep(argv: string[], command: PhoneCommand): Promise<number> {
  const { json, flag } = command;
  const step = stepFromFlags(argv, flag);
  if (!step) {
    console.error('testsky step --do "<what to do>" [--expect "<what must hold>"] [--read "<what to read>"] [--save <file.testsky.yaml>]');
    return 2;
  }
  const saveTo = flag(argv, "save");
  if (saveTo !== undefined && !isTestFile(saveTo)) {
    console.error("--save names a test file: <name>.testsky.yaml");
    return 2;
  }
  const device = await pickDevice(flag(argv, "platform"), flag(argv, "device"), argv.includes("--verbose"));
  const code = await withPhone(device, "step", command, async (attached) => {
    const { engine, ledger } = await hold(device, argv, flag, attached);
    try {
      const session = new StepSession({ engine, device, ledger });
      const tried = await session.attempt(step);
      const frame = tried.shots.get(tried.id);
      const shot = frame && (flag(argv, "shot") !== undefined || json) ? await keepFrame(frame, flag(argv, "shot"), "step") : undefined;
      // Kept only when it passed: a step saved because it was asked to be,
      // and failed, is a broken test somebody else finds later.
      let saved: SavedStep | undefined;
      let notSaved: string | undefined;
      if (saveTo && tried.passed && (step.do || step.expect)) {
        const app = flag(argv, "app");
        saved = await session.save(tried.id, { test: resolve(saveTo), ...(app ? { app } : {}) }).catch((error: Error) => {
          notSaved = (error as { reason?: string }).reason === "no-app" ? "name the app to begin a test file: --app <id>" : error.message;
          return undefined;
        });
      } else if (saveTo) {
        notSaved = tried.passed ? "a read is no step of its own: save it as the `extract` of the step it belongs to" : "it did not pass";
      }

      const answer = stepAnswer(tried, device, { ...(shot ? { shot } : {}), ...(saved ? { saved } : {}), ...(notSaved ? { notSaved } : {}) });
      const colour = answer.passed ? GREEN : isFailure(answer.outcome) && answer.exitCode === 1 ? RED : AMBER;
      console.log(`  ${colour}${answer.passed ? "ok" : answer.outcome}${RESET}  ${DIM}(${answer.actions} action(s), ${(answer.ms / 1000).toFixed(1)}s${answer.usd > 0 ? `, $${answer.usd.toFixed(4)}` : ""})${RESET}`);
      if (answer.detail) console.log(`      ${DIM}${answer.detail}${RESET}`);
      if (answer.answer !== undefined) console.log(`      read: ${JSON.stringify(answer.answer)}`);
      if (saved) console.log(`  saved as ${saved.stepId} in ${saved.test}${saved.remembered ? ` ${DIM}(with what it learned)${RESET}` : ""}`);
      if (notSaved) console.log(`  ${AMBER}not saved: ${notSaved}${RESET}`);
      if (shot) console.log(`  ${DIM}${shot}${RESET}`);
      json?.answer(answer);
      return answer.exitCode;
    } finally {
      await engine.detach().catch(() => undefined);
    }
  });
  return code ?? 2;
}

export async function commandLook(argv: string[], command: PhoneCommand): Promise<number> {
  const { json, flag } = command;
  const withTree = argv.includes("--tree");
  const device = await pickDevice(flag(argv, "platform"), flag(argv, "device"), argv.includes("--verbose"));
  const code = await withPhone(device, "look", command, async (attached) => {
    const { engine } = await hold(device, argv, flag, attached);
    try {
      const observation = await engine.observe({ fresh: true, ...(withTree ? { tree: true } : {}) });
      const shot = await keepFrame(observation.frame.bytes, flag(argv, "shot"), "look");
      const tree = withTree && observation.tree ? outlineTree(observation.tree) : undefined;
      const { width, height } = observation.frame.size;
      const app = observation.appContext.appId;
      console.log(`  ${shot}  ${DIM}${width}x${height}${app ? ` · ${app}${observation.appContext.screenId ? ` ${observation.appContext.screenId}` : ""}` : ""}${RESET}`);
      if (withTree && !tree) console.log(`  ${AMBER}the device gave no tree${RESET}`);
      for (const line of tree ?? []) console.log(`  ${line}`);
      json?.answer({
        device: device.id,
        platform: device.platform,
        size: observation.frame.size,
        ...(app ? { app } : {}),
        ...(observation.appContext.screenId ? { screen: observation.appContext.screenId } : {}),
        shot,
        ...(withTree ? { tree: tree ?? null } : {}),
      });
      return 0;
    } finally {
      await engine.detach().catch(() => undefined);
    }
  });
  return code ?? 2;
}
