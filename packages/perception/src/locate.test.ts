import assert from "node:assert/strict";
import test from "node:test";

import type { TreeNode, TreeSnapshot } from "@testsky/engine-core";

import { fieldAt, locateInTree } from "./locate.ts";

let refs = 0;
function node(role: string, bounds: [number, number, number, number], extra: Partial<TreeNode> = {}): TreeNode {
  return {
    ref: `n${(refs += 1)}`,
    role,
    bounds: { x: bounds[0], y: bounds[1], width: bounds[2], height: bounds[3] },
    enabled: true,
    interactive: false,
    children: [],
    ...extra,
  };
}

function tree(children: TreeNode[], extra: Partial<TreeSnapshot> = {}): TreeSnapshot {
  return {
    platform: "android",
    capturedAt: 0,
    source: "uiautomator",
    truncated: false,
    captureMs: 10,
    root: node("FrameLayout", [0, 0, 360, 800], { children }),
    ...extra,
  };
}

const cart = () =>
  tree([
    node("TextView", [16, 100, 120, 24], { label: "Your cart" }),
    node("Button", [30, 700, 300, 52], { label: "Pay", identifier: "com.acme.shop:id/pay", interactive: true }),
    node("Button", [300, 40, 40, 40], { label: "Cart", interactive: true }),
  ]);

test("one pressable thing by that name is found, where it is, with no model", () => {
  const found = locateInTree(cart(), "the Pay button");
  assert.deepEqual(found.target?.point, { x: 180, y: 726 });
  assert.deepEqual(found.target?.rect, { x: 30, y: 700, width: 300, height: 52 });
  assert.equal(found.target?.by, "label");
  assert.match(found.reason, /one Button called "Pay"/);
});

test("names are matched whole: kind words go, case and Turkish letters do not matter", () => {
  assert.ok(locateInTree(cart(), "Pay").target);
  assert.ok(locateInTree(cart(), "PAY button").target);
  assert.ok(locateInTree(cart(), "Pay butonu").target, "Turkish kind words are kind words too");
  assert.equal(locateInTree(cart(), "the blue Pay button under the total").target, undefined, "more than a name is a model's question");
  assert.equal(locateInTree(cart(), "Payment").target, undefined, "a word is not part of another word");
});

test("an identifier counts when nothing is called that", () => {
  const found = locateInTree(
    tree([node("ImageButton", [10, 10, 40, 40], { identifier: "com.acme:id/search_button", interactive: true })]),
    "the search button",
  );
  assert.equal(found.target?.by, "identifier");
  assert.deepEqual(found.target?.point, { x: 30, y: 30 });
});

test("a quoted phrase is the name, kind words and all", () => {
  const found = locateInTree(
    tree([node("Button", [0, 300, 360, 60], { label: "Add to cart", interactive: true })]),
    'tap "Add to cart"',
  );
  assert.equal(found.target?.by, "quoted");
});

test("text inside a pressable row presses the row", () => {
  const row = node("LinearLayout", [12, 130, 336, 72], {
    interactive: true,
    children: [node("TextView", [86, 140, 200, 20], { label: "Running shoes" })],
  });
  const found = locateInTree(tree([row]), "Running shoes");
  assert.deepEqual(found.target?.rect, { x: 12, y: 130, width: 336, height: 72 });
  assert.deepEqual(found.target?.point, { x: 180, y: 166 });
});

test("two controls by the same name are left to a model", () => {
  const found = locateInTree(
    tree([
      node("Button", [0, 100, 100, 40], { label: "OK", interactive: true }),
      node("Button", [0, 600, 100, 40], { label: "OK", interactive: true }),
    ]),
    "the OK button",
  );
  assert.equal(found.target, undefined);
  assert.match(found.reason, /2 controls are called "ok"/);
});

test("a disabled twin does not make it ambiguous", () => {
  const found = locateInTree(
    tree([
      node("Button", [0, 100, 100, 40], { label: "Next", interactive: true, enabled: false }),
      node("Button", [0, 600, 100, 40], { label: "Next", interactive: true }),
    ]),
    "Next",
  );
  assert.deepEqual(found.target?.point, { x: 50, y: 620 });
});

test("a target with something pressable drawn over it is left to a model", () => {
  const found = locateInTree(
    tree([
      node("Button", [30, 700, 300, 52], { label: "Pay", interactive: true }),
      node("FrameLayout", [0, 0, 360, 800], { interactive: true, children: [node("TextView", [60, 340, 240, 30], { label: "Payment failed" })] }),
    ]),
    "the Pay button",
  );
  assert.equal(found.target, undefined);
  assert.match(found.reason, /covered/);
});

test("nothing pressable, nothing by that name, or a cut tree: the tree does not answer", () => {
  assert.match(locateInTree(cart(), "Your cart").reason, /nothing there can be pressed/);
  assert.match(locateInTree(cart(), "the checkout button").reason, /no node in the tree is called "checkout"/);
  assert.match(locateInTree(tree(cart().root.children, { truncated: true }), "Pay").reason, /cut short/);
  assert.match(locateInTree(cart(), "the button").reason, /names no particular thing/);
});

test("off the screen is not there: rows past the fold neither answer nor make a twin", () => {
  const rows = tree([
    node("Cell", [0, 200, 360, 60], { label: "Delete", interactive: true }),
    node("Cell", [0, 1400, 360, 60], { label: "Delete", interactive: true }),
  ]);
  assert.deepEqual(locateInTree(rows, "Delete").target?.point, { x: 180, y: 230 });
  const below = tree([node("Cell", [0, 1400, 360, 60], { label: "Archive", interactive: true })]);
  assert.match(locateInTree(below, "Archive").reason, /no node in the tree is called "archive"/);
  const cut = tree([node("Button", [0, 780, 360, 60], { label: "Archive", interactive: true })]);
  assert.match(locateInTree(cut, "Archive").reason, /only partly on the screen/);
});

test("a list or a table is never what a name presses through", () => {
  const list = node("RecyclerView", [0, 100, 360, 400], {
    interactive: true,
    children: [node("LinearLayout", [0, 100, 360, 72], { children: [node("TextView", [16, 120, 200, 24], { label: "Running shoes" })] })],
  });
  assert.match(locateInTree(tree([list]), "Running shoes").reason, /nothing there can be pressed/);
  const table = node("Table", [0, 100, 360, 400], {
    interactive: true,
    children: [node("StaticText", [16, 110, 200, 24], { label: "Notifications" })],
  });
  assert.match(locateInTree(tree([table]), "Notifications").reason, /nothing there can be pressed/, "a Table is not a Tab");
});

test("a keyboard is over whatever it covers, and on Android a focused field stands in for it", () => {
  const ios = tree([
    node("Button", [30, 700, 300, 52], { label: "Log in", interactive: true }),
    node("Keyboard", [0, 520, 360, 280], { children: [node("Key", [0, 520, 36, 50], { label: "q" })] }),
  ]);
  assert.match(locateInTree(ios, "Log in").reason, /covered by a Keyboard/);

  const android = (focused: boolean) =>
    tree([
      node("TextView", [16, 80, 200, 24], { label: "Forgot password?", interactive: true }),
      node("EditText", [16, 300, 328, 52], { label: "Password", interactive: true, focused }),
      node("Button", [30, 700, 300, 52], { label: "Log in", interactive: true }),
    ]);
  assert.match(locateInTree(android(true), "Log in").reason, /below the field being typed into/);
  assert.ok(locateInTree(android(true), "Forgot password?").target, "above the field, the keyboard cannot be");
  assert.ok(locateInTree(android(false), "Log in").target, "and with nothing being typed, nothing is in the way");
});

test("a tree of several windows has no bounds of its own; the frame's size stands in", () => {
  const windows = tree(cart().root.children, {});
  windows.root = { ...windows.root, role: "hierarchy", bounds: { x: 0, y: 0, width: 0, height: 0 } };
  assert.deepEqual(locateInTree(windows, "Pay", { width: 360, height: 800 }).target?.point, { x: 180, y: 726 });
  assert.ok(locateInTree(windows, "Pay").target, "and without it, how far the tree reaches");
});

test("a quoted name with more said around it is something else, found by way of the name: a model's question", () => {
  const settings = tree([
    node("LinearLayout", [0, 200, 360, 64], {
      interactive: true,
      children: [
        node("TextView", [16, 220, 200, 24], { label: "Wi-Fi" }),
        node("Switch", [290, 212, 56, 40], { interactive: true }),
      ],
    }),
  ]);
  assert.match(locateInTree(settings, 'the switch next to "Wi-Fi"').reason, /says more than a name/);
  assert.match(locateInTree(settings, 'the delete icon on the "Wi-Fi" row').reason, /says more than a name/);
  assert.ok(locateInTree(settings, 'tap "Wi-Fi"').target, "a verb and kind words around a name are still only the name");
});

test("a kind asked for is that kind: the Wi-Fi switch is the one switch in the Wi-Fi row, never the row", () => {
  const row = (children: TreeNode[]) =>
    tree([node("LinearLayout", [0, 200, 360, 64], { interactive: true, children: [node("TextView", [16, 220, 200, 24], { label: "Wi-Fi" }), ...children] })]);
  const found = locateInTree(row([node("Switch", [290, 212, 56, 40], { interactive: true })]), "the Wi-Fi switch");
  assert.deepEqual(found.target?.rect, { x: 290, y: 212, width: 56, height: 40 });
  assert.match(found.reason, /one Switch for the TextView called "Wi-Fi"/);
  assert.deepEqual(locateInTree(row([node("Switch", [290, 212, 56, 40], { interactive: true })]), "Wi-Fi").target?.rect, { x: 0, y: 200, width: 360, height: 64 }, "the name alone is the row");
  assert.match(locateInTree(row([]), "the Wi-Fi switch").reason, /in the tree, but not as one switch/);
  const tabs = tree([
    node("TabBar", [0, 740, 360, 60], { interactive: true, children: [node("Button", [0, 740, 120, 60], { label: "Settings", interactive: true })] }),
  ]);
  assert.ok(locateInTree(tabs, "the Settings tab").target, "a tab bar's button is a tab");
});

test("kind words the label itself uses are part of its name, and nothing else is", () => {
  const screen = tree([node("Button", [16, 300, 328, 52], { label: "Switch account", interactive: true })]);
  assert.ok(locateInTree(screen, "the Switch account button").target);
  assert.match(locateInTree(screen, "the account button").reason, /no node in the tree is called "account"/);
});

test("hidden is not there, and a picture's file name is no name", () => {
  const hidden = tree([node("Cell", [0, 200, 360, 60], { label: "Archive", interactive: true, visible: false })]);
  assert.match(locateInTree(hidden, "Archive").reason, /no node in the tree is called "archive"/);
  const asset = tree([node("Image", [16, 16, 40, 40], { identifier: "icon_settings", interactive: true })]);
  assert.match(locateInTree(asset, "Settings").reason, /no node in the tree is called "settings"/);
});

test("the words of a name are all of it: Log in is not Log, Select all is not All, Open in Maps is not Maps", () => {
  const screen = tree([
    node("Button", [0, 100, 120, 40], { label: "Log", interactive: true }),
    node("Button", [0, 200, 120, 40], { label: "All", interactive: true }),
    node("Button", [0, 300, 120, 40], { label: "Maps", interactive: true }),
  ]);
  assert.match(locateInTree(screen, "the Log in button").reason, /no node in the tree is called "log in"/);
  assert.match(locateInTree(screen, "Select all").reason, /no node in the tree is called "select all"/);
  assert.match(locateInTree(screen, "Open in Maps").reason, /no node in the tree is called "open in maps"/);
  assert.ok(locateInTree(tree([node("Button", [0, 100, 120, 40], { label: "Log in", interactive: true })]), "the Log in button").target);
  assert.ok(locateInTree(screen, 'tap "Maps"').target, "a verb outside a quoted name is still only a verb");
});

test("a reverse-domain identifier is named by its last part, as iOS Settings names its rows", () => {
  // As read from iOS 26 Settings in Turkish: the row says "Genel", its id says general.
  const settings = tree([
    node("Cell", [20, 155, 400, 52], {
      interactive: true,
      children: [
        node("Button", [20, 155, 400, 52], {
          label: "Genel",
          identifier: "com.apple.settings.general",
          interactive: true,
          children: [node("StaticText", [37, 161, 88, 29], { label: "Genel" })],
        }),
      ],
    }),
  ]);
  assert.equal(locateInTree(settings, "General").target?.by, "identifier");
  assert.equal(locateInTree(settings, "Genel").target?.by, "label");
  assert.deepEqual(locateInTree(settings, "General").target?.rect, locateInTree(settings, "Genel").target?.rect);
});

test("a field that moved while it was typed into is found where it went: the focused one, or the only one", () => {
  const moved = (focused: boolean, extra: TreeNode[] = []) =>
    tree([node("TextField", [20, 300, 320, 40], { label: "Address", value: "typed text", interactive: true, focused }), ...extra]);
  const ios = (t: TreeSnapshot) => ({ ...t, source: "xcuitest" as const });
  const tapped = { x: 180, y: 760 };
  assert.deepEqual(
    [fieldAt(ios(moved(false)), tapped)?.text, fieldAt(ios(moved(false)), tapped)?.atPoint],
    ["typed text", false],
    "the only field on the screen",
  );
  const two = moved(false, [node("TextField", [20, 400, 320, 40], { value: "other", interactive: true })]);
  assert.equal(fieldAt(ios(two), tapped), undefined, "two fields and neither focused: not this one for certain");
  const focusedOfTwo = moved(true, [node("TextField", [20, 400, 320, 40], { value: "other", interactive: true })]);
  assert.equal(fieldAt(ios(focusedOfTwo), tapped)?.text, "typed text");
  assert.equal(fieldAt(ios(moved(false)), { x: 100, y: 310 })?.atPoint, true);
});

test("a row and the switch beside it with one name: the name alone is the row, the switch only when asked for", () => {
  // As read from a Galaxy A53's Connections page (One UI 5): the title and the
  // switch are both "Wi-Fi".
  const connections = tree([
    node("LinearLayout", [0, 100, 300, 72], {
      interactive: true,
      children: [node("TextView", [24, 112, 52, 25], { label: "Wi-Fi", identifier: "android:id/title" })],
    }),
    node("Switch", [308, 104, 52, 64], { label: "Wi-Fi", identifier: "com.android.settings:id/switch_widget", interactive: true }),
  ]);
  const row = locateInTree(connections, "Wi-Fi");
  assert.deepEqual(row.target?.rect, { x: 0, y: 100, width: 300, height: 72 }, "tapping the name opens the page; it does not turn Wi-Fi off");
  assert.deepEqual(locateInTree(connections, "the Wi-Fi switch").target?.rect, { x: 308, y: 104, width: 52, height: 64 });
});
