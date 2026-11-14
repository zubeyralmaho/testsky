/**
 * Starting the agent on a phone and speaking to it.
 *
 * The jar is pushed to /data/local/tmp, run by the shell user through
 * app_process, and reached through `adb forward`. Closing it -- or the host
 * going away, which closes the socket -- ends it, and the jar is removed: a
 * phone is left as it was found.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AgentConnection, AgentError, AgentGoneError } from "./connection.ts";

const run = promisify(execFile);

/** The agent's build, kept in the repository so a rig needs no Android SDK. */
export const AGENT_JAR = fileURLToPath(new URL("../dist/testsky-agent.jar", import.meta.url));
/** The version the jar above says it is; a test holds the Java source to it. */
export const AGENT_VERSION = "0.2.0";
const REMOTE_JAR = "/data/local/tmp/testsky-agent.jar";
const DEVICE_PORT = 27183;
const MAIN = "dev.testsky.agent.Main";

/** adb from the SDK testsky was pointed at, or the one on the PATH. */
export function adbPath(): string {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const own = sdk ? join(sdk, "platform-tools", "adb") : undefined;
  return own && existsSync(own) ? own : "adb";
}

/** What `tree` says of a node: its class, words, id, bounds in display pixels, and flags. */
export interface AgentNode {
  class: string | null;
  text?: string;
  desc?: string;
  id?: string;
  pkg?: string;
  bounds: [number, number, number, number];
  f: number;
  children?: AgentNode[];
}

export interface AgentWindow {
  type: number;
  layer: number;
  active: boolean;
  title: string | null;
  bounds?: [number, number, number, number];
  root: AgentNode | null;
}

/** The bits of a node's `f`. */
export const FLAG = {
  clickable: 1,
  longClickable: 2,
  scrollable: 4,
  checkable: 8,
  checked: 16,
  editable: 32,
  enabled: 64,
  focused: 128,
  selected: 256,
  visible: 512,
  password: 1024,
  focusable: 2048,
} as const;

/** Android's global actions, as `global` takes them. */
export const GLOBAL = { back: 1, home: 2, recents: 3, notifications: 4 } as const;

export interface AgentInfo {
  /** The display's size in pixels as it is turned now. */
  width: number;
  height: number;
  rotation: number;
  density: number;
  /** A keyboard is on the screen. */
  ime: boolean;
}

export interface AgentQuiet {
  /** How long since the phone last reported a change on the screen. */
  quietMs: number;
  toast?: string;
  toastAgoMs?: number;
}

export interface StartOptions {
  adb?: string;
  jar?: string;
  /** How long the agent may take to say it is listening. */
  timeoutMs?: number;
}

export class AndroidAgent {
  readonly serial: string;
  readonly version: string;
  private readonly adb: string;
  private readonly connection: AgentConnection;
  private readonly child: ChildProcess;
  private readonly hostPort: number;

  private constructor(serial: string, version: string, adb: string, connection: AgentConnection, child: ChildProcess, hostPort: number) {
    this.serial = serial;
    this.version = version;
    this.adb = adb;
    this.connection = connection;
    this.child = child;
    this.hostPort = hostPort;
  }

  static async start(serial: string, options: StartOptions = {}): Promise<AndroidAgent> {
    const adb = options.adb ?? adbPath();
    const timeout = options.timeoutMs ?? 15_000;
    const device = (...args: string[]) => run(adb, ["-s", serial, ...args], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    // An agent a crashed run left behind holds the accessibility connection and the port.
    await device("shell", `pkill -f ${MAIN} || true`).catch(() => undefined);
    await device("push", options.jar ?? AGENT_JAR, REMOTE_JAR);
    const child = spawn(adb, ["-s", serial, "shell", `CLASSPATH=${REMOTE_JAR} app_process / ${MAIN} ${DEVICE_PORT}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const version = await new Promise<string>((resolve, reject) => {
      let said = "";
      const timer = setTimeout(() => fail(`did not start within ${timeout} ms`), timeout);
      const fail = (why: string) => {
        clearTimeout(timer);
        child.kill();
        reject(new AgentGoneError(`the testsky agent on ${serial} ${why}${said.trim() ? `: ${said.trim().split("\n").slice(-4).join(" | ")}` : ""}`));
      };
      const hear = (chunk: Buffer) => {
        said += chunk.toString("utf8");
        const listening = /listening \d+ (\S+)/.exec(said);
        if (listening) {
          clearTimeout(timer);
          resolve(listening[1]!);
        }
      };
      child.stdout!.on("data", hear);
      child.stderr!.on("data", hear);
      child.once("exit", (code) => fail(`ended before it listened (exit ${code})`));
      child.once("error", (error) => fail(`could not be started: ${error.message}`));
    });
    child.removeAllListeners("exit");
    let hostPort = 0;
    try {
      hostPort = Number((await device("forward", "tcp:0", `tcp:${DEVICE_PORT}`)).stdout.trim());
      const socket = connect(hostPort, "127.0.0.1");
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      return new AndroidAgent(serial, version, adb, new AgentConnection(socket), child, hostPort);
    } catch (error) {
      child.kill();
      if (hostPort) await device("forward", "--remove", `tcp:${hostPort}`).catch(() => undefined);
      throw new AgentGoneError(`the testsky agent on ${serial} could not be reached: ${(error as Error).message}`);
    }
  }

  get open(): boolean {
    return this.connection.open;
  }

  private async text(line: string, timeoutMs?: number): Promise<string> {
    return (await this.connection.request(line, timeoutMs)).toString("utf8");
  }

  private async done(line: string, timeoutMs?: number): Promise<void> {
    const answer = await this.text(line, timeoutMs);
    if (answer !== "done") throw new AgentError(`the phone refused "${line.split(" ")[0]}": ${answer}`);
  }

  /** The screen as a JPEG, scaled on the phone. */
  shot(scale = 1, quality = 85): Promise<Buffer> {
    return this.connection.request(`shot ${scale} ${quality}`);
  }

  /** The active window's tree -- what uiautomator dumps -- or every window's. */
  async tree(all = false): Promise<AgentWindow[]> {
    return (JSON.parse(await this.text(all ? "tree all" : "tree")) as { windows: AgentWindow[] }).windows;
  }

  async info(): Promise<AgentInfo> {
    return JSON.parse(await this.text("info")) as AgentInfo;
  }

  async quiet(): Promise<AgentQuiet> {
    return JSON.parse(await this.text("quiet")) as AgentQuiet;
  }

  /** A press at a display pixel; held long, a long press. */
  tap(x: number, y: number, holdMs = 60): Promise<void> {
    return this.done(`tap ${Math.round(x)} ${Math.round(y)} ${Math.round(holdMs)}`, 15_000 + holdMs);
  }

  doubleTap(x: number, y: number): Promise<void> {
    return this.done(`doubletap ${Math.round(x)} ${Math.round(y)}`);
  }

  /** A finger drawn between two display pixels; with a stop, it rests at the end before lifting. */
  swipe(from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number, stopMs = 0): Promise<void> {
    return this.done(`swipe ${Math.round(from.x)} ${Math.round(from.y)} ${Math.round(to.x)} ${Math.round(to.y)} ${Math.round(durationMs)} ${Math.round(stopMs)}`, 15_000 + durationMs + stopMs);
  }

  key(code: number): Promise<void> {
    return this.done(`key ${code}`);
  }

  global(action: number): Promise<void> {
    return this.done(`global ${action}`);
  }

  /** Adds text to the focused field, and answers with what the field holds after. */
  type(text: string): Promise<string> {
    return this.text(`type ${Buffer.from(text, "utf8").toString("base64")}`);
  }

  /** Empties the focused field, and answers with what it holds after. */
  clear(): Promise<string> {
    return this.text("clear", 30_000);
  }

  /** Ends the agent and removes it from the phone. */
  async close(): Promise<void> {
    if (this.connection.open) await this.connection.request("quit", 2000).catch(() => undefined);
    this.connection.destroy();
    const device = (...args: string[]) => run(this.adb, ["-s", this.serial, ...args], { timeout: 15_000 });
    await device("forward", "--remove", `tcp:${this.hostPort}`).catch(() => undefined);
    if (this.child.exitCode === null) this.child.kill();
    await device("shell", `pkill -f ${MAIN}; rm -f ${REMOTE_JAR}`).catch(() => undefined);
  }
}
