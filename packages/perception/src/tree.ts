/**
 * The accessibility tree, cut down to what a model can use.
 *
 * Why bother at all, when the product's pitch is vision: because vision alone
 * has a ceiling that is not a prompting problem. On iOSWorld the same frontier
 * models score roughly 52% with vision plus the accessibility XML and 20-29%
 * with pixels alone, and a FLAG_SECURE screen -- a payment PIN, a banking
 * login, a DRM video -- captures as pure black no matter which model looks at
 * it. The tree still reads those screens perfectly.
 *
 * Why cut it down: a phone screen's raw hierarchy is hundreds of nodes and
 * tens of kilobytes, most of it layout scaffolding with no name. Sent whole it
 * costs more than the screenshot and buries the six things that matter. So:
 * keep what a person could point at, drop the rest, and write it as lines
 * short enough to read.
 */

import type { Rect, TreeNode } from "@testsky/engine-core";

export interface CompactOptions {
  /** Hard ceiling on lines. The default keeps a screen around 2KB. */
  maxNodes?: number;
  /** Nodes smaller than this in either direction are decoration. */
  minSize?: number;
  /**
   * Render bounds on the 0-1000 scale a screenshot answer uses, given the
   * screen's size in points.
   *
   * One coordinate space in the prompt or none: with the picture measured
   * 0-1000 and the tree measured in device points, a model that echoes a
   * number from the tree is read as a fraction of the screen, and the tap
   * lands at a third of the distance. That bug looked exactly like bad
   * grounding until the two spaces were put side by side.
   */
  scaleTo?: { width: number; height: number };
}

export interface CompactedTree {
  text: string;
  /** The nodes that made the cut, in the order their lines appear. */
  kept: TreeNode[];
  dropped: number;
}

function worthKeeping(node: TreeNode, minSize: number): boolean {
  if (node.bounds.width < minSize || node.bounds.height < minSize) return false;
  if (node.interactive) return true;
  return Boolean(node.label?.trim() || node.value?.trim());
}

function size(node: TreeNode): number {
  return node.children.reduce((sum, child) => sum + size(child), 1);
}

function collect(node: TreeNode, minSize: number, out: TreeNode[], dropped: { n: number }): void {
  // What the platform says is not drawn, and all inside it, is not something
  // a person could point at: the tree's own lookups pass it by. Shown to a
  // model, it is pressed. On an iPhone 14, XCUITest listed YouTube's
  // skip button before the ad offered it, the planner went for it, and the
  // step failed on a target nobody could see.
  if (node.visible === false) {
    dropped.n += size(node);
    return;
  }
  if (worthKeeping(node, minSize)) out.push(node);
  else dropped.n += 1;
  for (const child of node.children) collect(child, minSize, out, dropped);
}

/** "[3] Button \"Continue\" #btn_next (60,560 240x72)" -- one line per node. */
function line(node: TreeNode, index: number, scale?: { x: number; y: number }): string {
  const parts = [`[${index}]`, node.role];
  const label = node.label?.trim();
  if (label) parts.push(JSON.stringify(label.length > 60 ? `${label.slice(0, 59)}…` : label));
  const value = node.value?.trim();
  if (value && value !== label) parts.push(`= ${JSON.stringify(value.length > 40 ? `${value.slice(0, 39)}…` : value)}`);
  const identifier = node.identifier?.split("/").pop();
  if (identifier) parts.push(`#${identifier}`);
  const { x, y, width, height } = node.bounds;
  const sx = scale ? (value: number) => Math.round(value * scale.x) : (value: number) => value;
  const sy = scale ? (value: number) => Math.round(value * scale.y) : (value: number) => value;
  parts.push(`(${sx(x)},${sy(y)} ${sx(width)}x${sy(height)})`);
  if (!node.enabled) parts.push("disabled");
  return parts.join(" ");
}

export function compactTree(root: TreeNode, options: CompactOptions = {}): CompactedTree {
  const maxNodes = options.maxNodes ?? 120;
  const minSize = options.minSize ?? 8;
  const kept: TreeNode[] = [];
  const dropped = { n: 0 };
  collect(root, minSize, kept, dropped);

  // When a screen has more than the budget, keep the interactive ones: a
  // label with nothing to do is context, a button is the point.
  let chosen = kept;
  if (kept.length > maxNodes) {
    const interactive = kept.filter((node) => node.interactive);
    const rest = kept.filter((node) => !node.interactive);
    chosen = [...interactive, ...rest].slice(0, maxNodes);
    dropped.n += kept.length - chosen.length;
  }

  const scale = options.scaleTo
    ? { x: 1000 / (options.scaleTo.width || 1), y: 1000 / (options.scaleTo.height || 1) }
    : undefined;
  return {
    text: chosen.map((node, i) => line(node, i, scale)).join("\n"),
    kept: chosen,
    dropped: dropped.n,
  };
}

/**
 * What this screen IS, as far as the cache is concerned.
 *
 * The interactive nodes, by role, label and identifier -- and deliberately not
 * by position. Bucketing coordinates looked tempting and is a trap: a list
 * nudged two pixels crosses a bucket edge as easily as a list scrolled a page,
 * so the hash flickers on repaints while still missing real changes. What the
 * position is actually needed for is deciding whether a remembered tap is
 * still valid, and that is the anchor check's job, on the node itself, right
 * before the tap.
 *
 * Labels are in because a Settings page and a Bluetooth page share a layout
 * and differ only in words.
 */
export function treeHash(root: TreeNode): string {
  const parts: string[] = [];
  const visit = (node: TreeNode): void => {
    if (node.interactive) parts.push(`${node.role}|${node.label ?? ""}|${node.identifier ?? ""}`);
    for (const child of node.children) visit(child);
  };
  visit(root);
  parts.sort();
  // FNV-1a: no dependency, and collisions do not matter here -- a wrong
  // "same screen" is caught by the anchor check before anything is tapped.
  return fnv(parts.join("\n"));
}

/**
 * Every word the tree shows, in order, hashed. treeHash is a screen's
 * controls and does not move when only what it says does: a network's row
 * going from "Connecting" to "Connected" is the same controls, other words.
 */
export function textHash(root: TreeNode): string {
  const parts: string[] = [];
  const visit = (node: TreeNode): void => {
    if (node.visible === false) return;
    if (node.label) parts.push(node.label);
    if (node.value) parts.push(node.value);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return fnv(parts.join("\n"));
}

function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The same control under a point in two trees: its role, its words, its id
 * and, give or take a few points, its place. A playing video moves every
 * pixel of the spot a tap was aimed at, and the control it is -- the player,
 * a result's title over an autoplaying preview -- stays exactly where it was.
 */
export function sameControlAt(before: TreeNode, after: TreeNode, point: { x: number; y: number }): boolean {
  const was = nodeAt(before, point.x, point.y);
  const now = nodeAt(after, point.x, point.y);
  if (!was || !now) return false;
  const near = (a: number, b: number) => Math.abs(a - b) <= 4;
  return (
    was.role === now.role &&
    (was.label ?? "") === (now.label ?? "") &&
    (was.identifier ?? "") === (now.identifier ?? "") &&
    near(was.bounds.x, now.bounds.x) &&
    near(was.bounds.y, now.bounds.y) &&
    near(was.bounds.width, now.bounds.width) &&
    near(was.bounds.height, now.bounds.height)
  );
}

/** The node drawn at this point, deepest first -- what a tap would hit. */
export function nodeAt(root: TreeNode, x: number, y: number): TreeNode | undefined {
  const path = pathAt(root, x, y);
  return path?.[path.length - 1];
}

/**
 * The nodes from the root down to the one `nodeAt` answers: what a tap would
 * hit, and what it sits in -- a row's own "More Info" button is told from every
 * other row's by the row around it.
 */
export function pathAt(root: TreeNode, x: number, y: number): TreeNode[] | undefined {
  // The smallest box containing the point, not the last one seen. Both
  // platforms wrap their content in several full-screen containers, and some
  // of them come *after* the list in document order -- so taking the last
  // match walks past the cell you are standing on and answers "the window".
  // Every caller then loses: the anchor identifies nothing, tree
  // corroboration never corroborates, and hitInteractive is never true.
  let found: TreeNode[] | undefined;
  let bestArea = Number.POSITIVE_INFINITY;
  let bestDepth = -1;
  const trail: TreeNode[] = [];
  const visit = (node: TreeNode, depth: number): void => {
    trail.push(node);
    const { bounds } = node;
    const inside = x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
    if (inside) {
      const area = Math.max(0, bounds.width) * Math.max(0, bounds.height);
      // Equal area means nested wrappers of the same box: the deepest one is
      // the one actually drawn, and among equals the later sibling is on top.
      if (area < bestArea || (area === bestArea && depth >= bestDepth)) {
        found = [...trail];
        bestArea = area;
        bestDepth = depth;
      }
    }
    // A child can stick out of its parent (a scrolled row, a popover), so the
    // walk continues regardless of whether the parent was hit.
    for (const child of node.children) visit(child, depth + 1);
    trail.pop();
  };
  visit(root, 0);
  return found;
}

/**
 * Regions whose pixels change on their own: the status bar's clock, a playing
 * video, an advert. Excluded from the screen hash, or every second frame is a
 * new screen and nothing ever settles or hits the cache.
 */
const RESTLESS_ROLES = new Set(["VideoView", "SurfaceView", "TextureView", "WebView", "AdView"]);

export function restlessRegions(root: TreeNode, statusBarHeight = 32): Rect[] {
  const regions: Rect[] = [
    // The clock and the battery percentage, always moving, never relevant.
    { x: 0, y: 0, width: Number.MAX_SAFE_INTEGER, height: statusBarHeight },
  ];
  const visit = (node: TreeNode): void => {
    if (RESTLESS_ROLES.has(node.role)) regions.push(node.bounds);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return regions;
}
