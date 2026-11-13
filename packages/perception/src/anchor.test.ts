import assert from "node:assert/strict";
import test from "node:test";

import type { TreeNode, TreeSnapshot } from "@testsky/engine-core";

import { anchorAt, pressableAt } from "./anchor.ts";

const node = (over: Partial<TreeNode> & Pick<TreeNode, "role" | "bounds">): TreeNode => ({
  ref: over.role,
  enabled: true,
  interactive: false,
  children: [],
  ...over,
});

// iOS Settings, reduced: a window, a full-screen container, and the rows.
const snapshot = (rows: TreeNode[]): TreeSnapshot => ({
  platform: "ios",
  capturedAt: 0,
  source: "xcuitest",
  truncated: false,
  captureMs: 1,
  root: node({
    role: "Application",
    bounds: { x: 0, y: 0, width: 440, height: 956 },
    children: [node({ role: "Other", bounds: { x: 0, y: 0, width: 440, height: 956 }, children: rows })],
  }),
});

const GENERAL = node({
  role: "Button",
  label: "Genel",
  identifier: "com.apple.settings.general",
  interactive: true,
  bounds: { x: 20, y: 311, width: 400, height: 53 },
});

test("a point on a row is anchored to the row, by name and identifier", () => {
  assert.deepEqual(anchorAt(snapshot([GENERAL]), { x: 223, y: 338 }), {
    role: "Button",
    label: "Genel",
    identifier: "com.apple.settings.general",
    bounds: { x: 20, y: 311, width: 400, height: 53 },
  });
});

test("a point on the background is not a target: the window is under every point there is", () => {
  assert.equal(anchorAt(snapshot([GENERAL]), { x: 220, y: 900 }), undefined);
});

test("a box with no name, no identifier and nothing to press identifies nothing", () => {
  const spacer = node({ role: "Other", bounds: { x: 20, y: 400, width: 400, height: 40 } });
  assert.equal(anchorAt(snapshot([GENERAL, spacer]), { x: 220, y: 420 }), undefined);
});

test("a row's label and its middle press the same row, and the screen itself is pressed by nothing", () => {
  // iOS 26 Settings: the General cell, its label, and a collection view the size of the screen.
  const label = node({ role: "StaticText", label: "Genel", bounds: { x: 76, y: 326, width: 52, height: 22 } });
  const cell = node({ role: "Cell", interactive: true, bounds: { x: 20, y: 311, width: 400, height: 53 }, children: [label] });
  const list = node({ role: "CollectionView", interactive: true, bounds: { x: 0, y: 0, width: 440, height: 956 }, children: [cell] });
  const tree = snapshot([list]);
  assert.deepEqual(pressableAt(tree, { x: 101, y: 338 }), cell.bounds, "on the label");
  assert.deepEqual(pressableAt(tree, { x: 220, y: 338 }), cell.bounds, "in the middle of the row");
  assert.equal(pressableAt(tree, { x: 220, y: 700 }), undefined, "below every row, only the list, which is the screen");
});
