import assert from "node:assert/strict";
import test from "node:test";

import type { TreeNode, TreeSnapshot } from "@testsky/engine-core";

import { aboutStatusBar, claimsIn, screenHeading, treeEvidence } from "./claims.ts";

let refs = 0;
const node = (role: string, bounds: [number, number, number, number], extra: Partial<TreeNode> = {}): TreeNode => ({
  ref: `n${(refs += 1)}`,
  role,
  bounds: { x: bounds[0], y: bounds[1], width: bounds[2], height: bounds[3] },
  enabled: true,
  interactive: false,
  children: [],
  ...extra,
});
const tree = (children: TreeNode[], source: TreeSnapshot["source"] = "uiautomator"): TreeSnapshot => ({
  platform: source === "xcuitest" ? "ios" : "android",
  capturedAt: 0,
  source,
  truncated: false,
  captureMs: 1,
  root: node("FrameLayout", [0, 0, 853, 384], { children }),
});

// As read from a Galaxy A53 on One UI 5, in landscape: the Connections page.
const connections = () =>
  tree([
    node("ImageButton", [31, 0, 56, 56], { label: "Navigate up", interactive: true }),
    node("TextView", [87, 14, 116, 28], { label: "Connections" }),
    node("Button", [753, 0, 21, 56], { label: "Search settings", interactive: true }),
    node("RecyclerView", [31, 56, 743, 328], {
      interactive: true,
      children: [
        node("LinearLayout", [31, 56, 743, 72], {
          interactive: true,
          children: [
            node("TextView", [55, 70, 52, 25], { label: "Wi-Fi", identifier: "android:id/title" }),
            node("TextView", [55, 95, 153, 19], { label: "HomeNet_A1B2", identifier: "android:id/summary" }),
          ],
        }),
        node("LinearLayout", [31, 128, 743, 56], { interactive: true, children: [node("TextView", [55, 143, 114, 25], { label: "Wi-Fi Calling" })] }),
        node("LinearLayout", [31, 184, 743, 56], { interactive: true, children: [node("TextView", [55, 199, 90, 25], { label: "Bluetooth" })] }),
      ],
    }),
  ]);

test("what an expectation claims: a page it names, phrases it quotes, an orientation", () => {
  assert.deepEqual(claimsIn('the Wi-Fi page is open, showing "HomeNet_A1B2"'), { headings: ["Wi-Fi"], texts: ["HomeNet_A1B2"] });
  assert.deepEqual(claimsIn('the screen title is "General"'), { headings: ["General"], texts: [] });
  assert.deepEqual(claimsIn('the "Genel" sayfası açık').headings, ["Genel"]);
  assert.deepEqual(claimsIn("the next screen is visible").headings, [], "the next screen names no page");
  assert.equal(claimsIn("Settings is open in landscape").orientation, "landscape");
  assert.deepEqual(claimsIn('no "Error" message is shown'), { headings: [], texts: [] }, "a quote in a negation is what must not be there");
});

test("an apostrophe inside a word opens no quote", () => {
  assert.deepEqual(claimsIn(`YouTube's search results for "4k video uzun" are shown`).texts, ["4k video uzun"]);
  assert.deepEqual(claimsIn(`Atla'ya basınca "Reklamı atla" görünür`).texts, ["Reklamı atla"]);
  assert.deepEqual(claimsIn(`the phone's own list shows 'Bluetooth'`).texts, ["Bluetooth"]);
  assert.deepEqual(claimsIn(`the player's clock is past 0:05`).texts, []);
});

test("the screen's heading is the text at the top, outside the list -- not a row's title", () => {
  assert.equal(screenHeading(connections()), "Connections");
  const home = tree([node("TextView", [27, 14, 38, 28], { label: "Settings" }), node("RecyclerView", [31, 56, 743, 328], { interactive: true, children: [node("TextView", [55, 70, 120, 25], { label: "Connections" })] })]);
  assert.equal(screenHeading(home), "Settings");
  const ios = tree([node("NavigationBar", [0, 47, 402, 96], { identifier: "General", children: [node("Button", [8, 50, 80, 44], { label: "Settings", interactive: true })] })], "xcuitest");
  assert.equal(screenHeading(ios, { width: 402, height: 874 }), "General");
  assert.equal(screenHeading(tree([node("RecyclerView", [0, 0, 853, 384], { interactive: true, children: [node("TextView", [10, 10, 100, 20], { label: "Row" })] })])), undefined);
});

test("the tree disagrees with a page it is not on, and with a phrase that is not there -- and only then", () => {
  assert.deepEqual(treeEvidence(connections(), claimsIn('the Wi-Fi page is open, showing "HomeNet_A1B2"')), [
    'the screen\'s own heading reads "Connections", not "Wi-Fi"',
  ]);
  assert.deepEqual(treeEvidence(connections(), claimsIn("the Connections settings page is open")), [], "the same page, named at more length");
  assert.deepEqual(treeEvidence(connections(), claimsIn('the list shows "Bluetooth"')), []);
  assert.deepEqual(treeEvidence(connections(), claimsIn('the list shows "Flight mode"')), ['nothing on the screen reads "Flight mode"']);
});

test("an expectation about what a status bar shows is told from one about the app", () => {
  for (const about of [
    "the battery icon shows it is charging",
    "the phone is connected to the HomeNet network",
    "Wi-Fi is off",
    "WI-FI IS ON",
    "the time reads 10:41",
    "a notification from Messages is shown",
    "uçak modu açık",
    "İnternet bağlantısı yok",
    "the 5G icon is shown",
    "the call is still in progress",
    "görüşme devam ediyor",
    "the screen is being recorded",
    "the microphone indicator is lit",
    "No Service",
    "SOS",
    "the carrier reads Turkcell",
    "the download has finished",
  ]) {
    assert.equal(aboutStatusBar(about), true, about);
  }
  for (const app of [
    "the Pay button is enabled",
    'the "General" page is open',
    "Kaydet düğmesi sağ üstte",
    "the calculator shows 50",
    "the search results for Speedtest are listed",
    'a button called "Save" is shown',
    "aramada Speedtest sonuçları listeleniyor",
  ]) {
    assert.equal(aboutStatusBar(app), false, app);
  }
});
