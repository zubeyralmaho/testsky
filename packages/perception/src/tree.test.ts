import assert from "node:assert/strict";
import test from "node:test";

import type { TreeNode } from "@testsky/engine-core";
import { compactTree, nodeAt, pathAt, restlessRegions, sameControlAt, treeHash } from "./tree.ts";

function node(partial: Partial<TreeNode> & { ref: string }): TreeNode {
  return {
    role: "View",
    bounds: { x: 0, y: 0, width: 100, height: 40 },
    enabled: true,
    interactive: false,
    children: [],
    ...partial,
  };
}

/** A search screen, shaped like the real one on a Samsung. */
const SCREEN = node({
  ref: "root",
  role: "FrameLayout",
  bounds: { x: 0, y: 0, width: 384, height: 832 },
  children: [
    node({ ref: "bar", role: "LinearLayout", bounds: { x: 0, y: 0, width: 384, height: 40 } }),
    node({
      ref: "field",
      role: "AutoCompleteTextView",
      label: "Ara",
      identifier: "com.android.settings.intelligence:id/search_src_text",
      bounds: { x: 30, y: 423, width: 280, height: 28 },
      interactive: true,
    }),
    node({
      ref: "clear",
      role: "Button",
      label: "Tümünü temizle",
      identifier: "com.x:id/clear_all_history",
      bounds: { x: 256, y: 107, width: 110, height: 52 },
      interactive: true,
    }),
    node({ ref: "spacer", role: "View", bounds: { x: 0, y: 500, width: 2, height: 2 } }),
    node({ ref: "video", role: "SurfaceView", bounds: { x: 0, y: 600, width: 384, height: 200 } }),
  ],
});

test("compaction keeps what a person could point at and drops the scaffolding", () => {
  const { text, kept, dropped } = compactTree(SCREEN);
  const refs = kept.map((n) => n.ref);
  assert.ok(refs.includes("field") && refs.includes("clear"), "interactive nodes are kept");
  assert.ok(!refs.includes("spacer"), "a 2x2 decoration is not a target");
  assert.ok(!refs.includes("bar"), "an unlabelled layout is scaffolding");
  assert.ok(dropped > 0);

  // One line per node, short enough that a screen fits in a couple of KB.
  assert.match(text, /\[\d+\] AutoCompleteTextView "Ara" #search_src_text \(30,423 280x28\)/);
  assert.ok(text.length < 2000, `compacted to ${text.length} chars`);
});

test("compaction leaves out what the platform says is not drawn, and all inside it", () => {
  // YouTube on iOS: XCUITest lists the skip button before the ad offers it.
  const player = node({
    ref: "root",
    bounds: { x: 0, y: 0, width: 390, height: 844 },
    children: [
      node({ ref: "visit", role: "Button", label: "Reklamvereni ziyaret et", bounds: { x: 10, y: 60, width: 200, height: 30 }, interactive: true }),
      node({ ref: "skip", role: "Button", label: "Atla", bounds: { x: 300, y: 180, width: 80, height: 36 }, interactive: true, visible: false }),
      node({
        ref: "overlay",
        role: "Other",
        label: "Reklam",
        bounds: { x: 0, y: 50, width: 390, height: 220 },
        visible: false,
        children: [node({ ref: "countdown", role: "StaticText", label: "Reklam atlanabilir: 5", bounds: { x: 280, y: 190, width: 100, height: 20 } })],
      }),
    ],
  });
  const { text, kept, dropped } = compactTree(player);
  assert.deepEqual(
    kept.map((n) => n.ref),
    ["visit"],
  );
  assert.doesNotMatch(text, /Atla|atlanabilir/);
  assert.equal(dropped, 4, "the root, the skip button, and the overlay with its line");
});

test("compaction has a ceiling, and spends it on the interactive nodes", () => {
  const many = node({
    ref: "root",
    bounds: { x: 0, y: 0, width: 384, height: 832 },
    children: [
      ...Array.from({ length: 30 }, (_, i) =>
        node({ ref: `label${i}`, label: `text ${i}`, bounds: { x: 0, y: i * 20, width: 300, height: 18 } }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        node({ ref: `button${i}`, role: "Button", label: `press ${i}`, interactive: true }),
      ),
    ],
  });
  const { kept } = compactTree(many, { maxNodes: 10 });
  assert.equal(kept.length, 10);
  assert.equal(kept.filter((n) => n.interactive).length, 5, "buttons survive the cut before labels do");
});

test("the screen hash follows the controls, not where they sit", () => {
  const nudged = structuredClone(SCREEN);
  nudged.children[1]!.bounds.y += 2;
  assert.equal(treeHash(SCREEN), treeHash(nudged), "a repaint is the same screen");

  const scrolled = structuredClone(SCREEN);
  scrolled.children[1]!.bounds.y += 300;
  assert.equal(treeHash(SCREEN), treeHash(scrolled), "and so is the same screen scrolled -- the anchor check, not this hash, decides whether a remembered tap still lands");

  const other = structuredClone(SCREEN);
  other.children[1]!.label = "Search";
  assert.notEqual(treeHash(SCREEN), treeHash(other), "different words are a different screen");

  const fewer = structuredClone(SCREEN);
  fewer.children.splice(1, 1);
  assert.notEqual(treeHash(SCREEN), treeHash(fewer), "a control that vanished is a different screen");
});

test("nodeAt finds the deepest node under a point -- what a tap would hit", () => {
  assert.equal(nodeAt(SCREEN, 100, 435)?.ref, "field");
  assert.equal(nodeAt(SCREEN, 300, 120)?.ref, "clear");
  // A point on no control lands on the root, which is honest: nothing there.
  assert.equal(nodeAt(SCREEN, 5, 700)?.ref, "video");
});

test("restless regions cover the clock and anything that animates itself", () => {
  const regions = restlessRegions(SCREEN);
  assert.equal(regions[0]!.y, 0, "the status bar is always masked");
  assert.ok(regions.some((r) => r.y === 600 && r.height === 200), "a SurfaceView plays on its own");
});

test("nodeAt answers the smallest box at the point, not the last one drawn", () => {
  // Real shape, from iOS Settings: the list sits inside nested full-screen
  // containers and is followed by more of them. Taking the last match in
  // document order returned a 440x956 "Other" for every point on the screen,
  // which made every stored anchor meaningless.
  const full = (role: string, children: TreeNode[] = []): TreeNode => ({
    ref: role,
    role,
    bounds: { x: 0, y: 0, width: 440, height: 956 },
    enabled: true,
    interactive: false,
    children,
  });
  const cell: TreeNode = {
    ref: "cell",
    role: "Cell",
    bounds: { x: 20, y: 300, width: 400, height: 70 },
    label: "Genel",
    enabled: true,
    interactive: true,
    children: [],
  };
  const root = full("Application", [full("Window", [full("Other", [cell]), full("Other")])]);

  assert.equal(nodeAt(root, 220, 337)?.label, "Genel");
  // A point outside every leaf still answers the container around it.
  assert.equal(nodeAt(root, 220, 900)?.role, "Other");
});

test("the control under a tap is the same one while a video plays under it, and another once the page moves", () => {
  const node = (role: string, label: string, y: number, children: TreeNode[] = []): TreeNode => ({
    ref: `${role}${y}`,
    role,
    label,
    bounds: { x: 0, y, width: 390, height: 220 },
    enabled: true,
    interactive: true,
    children,
  });
  const page = (playerY: number) => ({ ...node("Window", "", 0, [node("Other", "Video player", playerY)]), bounds: { x: 0, y: 0, width: 390, height: 844 } });
  assert.equal(sameControlAt(page(100), page(100), { x: 200, y: 200 }), true);
  assert.equal(sameControlAt(page(100), page(102), { x: 200, y: 200 }), true, "a few points of drift is the same place");
  assert.equal(sameControlAt(page(100), page(400), { x: 200, y: 200 }), false, "scrolled: something else is under the tap");
});

test("pathAt answers what a tap would hit and everything it sits in, root first", () => {
  const text = node({ ref: "name", role: "StaticText", label: "Office", bounds: { x: 59, y: 430, width: 98, height: 21 } });
  const info = node({ ref: "info", role: "Button", label: "Daha Fazla Bilgi", bounds: { x: 317, y: 427, width: 26, height: 27 } });
  const row = node({ ref: "row", role: "Cell", bounds: { x: 16, y: 412, width: 343, height: 57 }, children: [text, info] });
  const root = node({ ref: "root", role: "Application", bounds: { x: 0, y: 0, width: 375, height: 812 }, children: [row] });
  assert.deepEqual(pathAt(root, 330, 440)?.map((each) => each.ref), ["root", "row", "info"]);
  assert.equal(nodeAt(root, 330, 440)?.ref, "info");
  assert.deepEqual(pathAt(root, 100, 440)?.map((each) => each.ref), ["root", "row", "name"]);
  assert.equal(pathAt(root, 500, 900), undefined, "nothing is there");
});
