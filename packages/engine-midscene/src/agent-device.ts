/**
 * testsky's own Android agent, wearing the shape of Midscene's AndroidDevice
 * that the Android engine reads: so everything the engine has learned about
 * real phones -- launching, settling, the stale guard, calls -- carries over,
 * and only the hands and eyes change.
 *
 * What it changes: a picture is a JPEG made on the phone (0.1 s, where
 * `screencap -p` took 1.2 s on a Nothing), the tree is read without waiting
 * for the screen to go idle (16 ms, where yadb took 0.6 s and uiautomator
 * 2.3 s), and touches, keys and typing go through one accessibility
 * connection instead of an `input` command each. adb stays for what it is
 * good at: dumpsys, am, pm and the device log.
 *
 * Sizes are computed exactly as Midscene computes them -- `wm size`, and the
 * physical density of `wm density` -- because a test's memory is kept per
 * screen layout, and a layout read differently would be another layout.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AndroidAgent, AgentGoneError, adbPath, FLAG, GLOBAL, type AgentNode } from "@testsky/android-agent";
import type { Point, Size } from "@testsky/engine-core";

import { imageSize } from "./png.ts";

const run = promisify(execFile);

/** Midscene's node, as android.ts normalises it: the class in `type`, uiautomator's attributes in `attrs`, bounds in points. */
export interface AgentRawNode {
  type: string;
  attrs: Record<string, string>;
  bounds: { left: number; top: number; width: number; height: number };
  children: AgentRawNode[];
}

const flag = (node: AgentNode, bit: number): string => ((node.f & bit) !== 0 ? "true" : "false");

/** An agent node as yadb and uiautomator would have described it, its bounds divided by `scale` pixels per point. */
export function agentNodeToRaw(node: AgentNode, scale: number): AgentRawNode {
  const [left, top, right, bottom] = node.bounds;
  const attrs: Record<string, string> = {
    text: node.text ?? "",
    "content-desc": node.desc ?? "",
    "resource-id": node.id ?? "",
    class: node.class ?? "",
    package: node.pkg ?? "",
    clickable: flag(node, FLAG.clickable),
    "long-clickable": flag(node, FLAG.longClickable),
    scrollable: flag(node, FLAG.scrollable),
    checkable: flag(node, FLAG.checkable),
    checked: flag(node, FLAG.checked),
    editable: flag(node, FLAG.editable),
    enabled: flag(node, FLAG.enabled),
    focusable: flag(node, FLAG.focusable),
    focused: flag(node, FLAG.focused),
    selected: flag(node, FLAG.selected),
    password: flag(node, FLAG.password),
    "visible-to-user": flag(node, FLAG.visible),
  };
  return {
    type: node.class ?? "View",
    attrs,
    bounds: { left: left / scale, top: top / scale, width: (right - left) / scale, height: (bottom - top) / scale },
    children: (node.children ?? []).map((child) => agentNodeToRaw(child, scale)),
  };
}

/** `wm density` as Midscene reads it: the physical density, whatever a person set the display size to; 160 when it says none. */
export function densityFrom(wm: string): number {
  const physical = /Physical density: (\d+)/.exec(wm)?.[1];
  return physical ? Number(physical) : 160;
}

/** `wm size` as Midscene reads it: the override when there is one, else the physical size, in the phone's natural orientation. */
export function sizeFrom(wm: string): Size {
  const pick = (label: string) => /(\d{1,5})x(\d{1,5})/.exec(new RegExp(`${label} size: ([^\\r\\n]+)`).exec(wm)?.[1] ?? "");
  const size = pick("Override") ?? pick("Physical");
  if (!size) throw new Error(`could not read the screen size from "wm size": ${wm.trim()}`);
  return { width: Number(size[1]), height: Number(size[2]) };
}

/** The keys a step can name, as Midscene names them. */
const KEY_CODES: Record<string, number> = {
  enter: 66,
  backspace: 67,
  tab: 61,
  arrowup: 19,
  up: 19,
  arrowdown: 20,
  down: 20,
  arrowleft: 21,
  left: 21,
  arrowright: 22,
  right: 22,
  escape: 111,
  esc: 111,
  home: 3,
  end: 123,
};

/** A key's code, or undefined for a key Android has no single code for. */
export function keyCode(key: string): number | undefined {
  const code = KEY_CODES[key.toLowerCase()];
  if (code !== undefined) return code;
  // A letter on its own is its own key: KEYCODE_A is 29.
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0) - 36;
  return undefined;
}

/** What the engine runs on the phone through adb, as Midscene's adb client offers it. */
export interface AdbShell {
  shell(command: string, options?: { timeout?: number }): Promise<string>;
  install(path: string): Promise<unknown>;
}

export class AgentAndroidDevice {
  /** The tree comes from the agent, quickly: the engine need not try yadb first. */
  readonly fastTree = true;
  readonly serial: string;
  private readonly adb: string;
  private agent?: AndroidAgent;
  private starting?: Promise<AndroidAgent>;
  /** Pixels per point, as Midscene derives it from the physical density. */
  private dpr = 1;
  /** `wm size`, in the phone's natural orientation. */
  private natural?: Size;
  /** The last picture's size: the display as it is turned now. */
  private latest?: Size;

  constructor(serial: string, adb = adbPath()) {
    this.serial = serial;
    this.adb = adb;
  }

  private readonly shellApi: AdbShell = {
    shell: async (command, options) =>
      (await run(this.adb, ["-s", this.serial, "shell", command], { timeout: options?.timeout ?? 60_000, maxBuffer: 64 * 1024 * 1024 })).stdout,
    install: (path) => run(this.adb, ["-s", this.serial, "install", "-r", path], { timeout: 10 * 60_000 }),
  };

  /** Starts the agent on first use, and answers with adb for what adb still does. */
  async connect(): Promise<AdbShell> {
    await this.started();
    return this.shellApi;
  }

  private async started(): Promise<AndroidAgent> {
    if (this.agent?.open) return this.agent;
    this.starting ??= (async () => {
      if (!this.natural) {
        this.dpr = densityFrom(await this.shellApi.shell("wm density")) / 160;
        this.natural = sizeFrom(await this.shellApi.shell("wm size"));
      }
      await this.agent?.close().catch(() => undefined);
      const agent = await AndroidAgent.start(this.serial, { adb: this.adb });
      // Which way the display is turned, before the first picture says it.
      const info = await agent.info().catch(() => undefined);
      if (info?.width && info.height) this.latest = { width: info.width, height: info.height };
      this.agent = agent;
      return agent;
    })().finally(() => delete this.starting);
    return this.starting;
  }

  /**
   * A request to the agent. One that only reads is asked again of a new agent
   * if the old one went away; one that touches the phone is not, since it may
   * have been carried out.
   */
  private async call<T>(ask: (agent: AndroidAgent) => Promise<T>, reads = false): Promise<T> {
    const agent = await this.started();
    try {
      return await ask(agent);
    } catch (error) {
      if (!reads || !(error instanceof AgentGoneError)) throw error;
      return ask(await this.started());
    }
  }

  /** The display in pixels as it is turned now: `wm size`, swapped when the last picture was the other way round. */
  private oriented(): Size {
    const natural = this.natural ?? { width: 1, height: 1 };
    const turned = this.latest && this.latest.width !== this.latest.height && (this.latest.width > this.latest.height) !== (natural.width > natural.height);
    return turned ? { width: natural.height, height: natural.width } : natural;
  }

  async size(): Promise<Size> {
    await this.started();
    const pixels = this.oriented();
    return { width: Math.round(pixels.width / this.dpr), height: Math.round(pixels.height / this.dpr) };
  }

  /** Display pixels per point on each axis, as Midscene's tap scale has them. */
  private async scale(): Promise<{ x: number; y: number }> {
    const points = await this.size();
    const pixels = this.oriented();
    return { x: pixels.width / points.width, y: pixels.height / points.height };
  }

  private async pixel(point: Point): Promise<Point> {
    const scale = await this.scale();
    return { x: Math.round(point.x * scale.x), y: Math.round(point.y * scale.y) };
  }

  async screenshotBase64(): Promise<string> {
    const jpeg = await this.call((agent) => agent.shot(1, 85), true);
    this.latest = imageSize(jpeg);
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  }

  /** The active window's tree, in Midscene's node shape with bounds in points. */
  async getUITree(): Promise<{ root?: AgentRawNode; capturedAt?: number }> {
    const windows = await this.call((agent) => agent.tree(false), true);
    const root = windows.find((window) => window.root)?.root;
    if (!root) return {};
    const scale = await this.scale();
    return { root: agentNodeToRaw(root, scale.x), capturedAt: Date.now() };
  }

  /** Closes a keyboard that is up: Escape first, then Back, each given a second to work -- as Midscene does it. */
  private async hideKeyboard(): Promise<void> {
    for (const code of [111, 4]) {
      if (!(await this.call((agent) => agent.info(), true)).ime) return;
      await this.call((agent) => agent.key(code));
      for (const until = Date.now() + 1000; Date.now() < until; ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (!(await this.call((agent) => agent.info(), true)).ime) return;
      }
    }
  }

  readonly inputPrimitives = {
    pointer: {
      tap: async (point: Point) => {
        const at = await this.pixel(point);
        await this.call((agent) => agent.tap(at.x, at.y, 80));
      },
      doubleClick: async (point: Point) => {
        const at = await this.pixel(point);
        await this.call((agent) => agent.doubleTap(at.x, at.y));
      },
      longPress: async (point: Point, options?: { duration?: number }) => {
        const at = await this.pixel(point);
        await this.call((agent) => agent.tap(at.x, at.y, options?.duration ?? 800));
      },
    },
    keyboard: {
      clearInput: async (_target?: unknown) => {
        await this.call((agent) => agent.clear());
      },
      keyboardPress: async (key: string) => {
        const code = keyCode(key);
        if (code === undefined) throw new Error(`Android has no key called "${key}"`);
        await this.call((agent) => agent.key(code));
      },
      typeText: async (text: string, options?: { autoDismissKeyboard?: boolean }) => {
        if (!text) return;
        await this.call((agent) => agent.type(text));
        if (options?.autoDismissKeyboard !== false) await this.hideKeyboard();
      },
    },
    touch: {
      swipe: async (from: Point, to: Point, options?: { duration?: number }) => {
        const [start, end] = [await this.pixel(from), await this.pixel(to)];
        await this.call((agent) => agent.swipe(start, end, options?.duration ?? 300));
      },
    },
    system: {
      backButton: () => this.call((agent) => agent.global(GLOBAL.back)),
      homeButton: () => this.call((agent) => agent.global(GLOBAL.home)),
      recentAppsButton: () => this.call((agent) => agent.global(GLOBAL.recents)),
    },
  };

  /** A link opened as a link, and a package by its launcher activity. */
  async launch(uri: string): Promise<void> {
    const quoted = `'${uri.replace(/'/g, "'\\''")}'`;
    if (uri.includes("://")) {
      await this.shellApi.shell(`am start -W -a android.intent.action.VIEW -d ${quoted}`);
      return;
    }
    const component = (await this.shellApi.shell(`cmd package resolve-activity --brief ${quoted}`).catch(() => "")).trim().split("\n").pop()?.trim();
    if (component?.includes("/")) await this.shellApi.shell(`am start -W -n '${component.replace(/'/g, "")}'`);
    else await this.shellApi.shell(`monkey -p ${quoted} -c android.intent.category.LAUNCHER 1`);
  }

  async destroy(): Promise<void> {
    await this.starting?.catch(() => undefined);
    await this.agent?.close();
    delete this.agent;
  }
}
