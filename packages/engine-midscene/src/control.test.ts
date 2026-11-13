import assert from "node:assert/strict";
import test from "node:test";

import type { TreeNode, TreeSnapshot } from "@testsky/engine-core";

import { controlLocator } from "./control.ts";

let refs = 0;
function el(role: string, bounds: [number, number, number, number], extra: Partial<TreeNode> = {}, children: TreeNode[] = []): TreeNode {
  const [x, y, width, height] = bounds;
  return { ref: `n${(refs += 1)}`, role, bounds: { x, y, width, height }, enabled: true, interactive: role !== "StaticText", children, ...extra };
}

/** One network's row on iOS 27's Wi-Fi page, as WebDriverAgent lists it on an iPhone 12 mini. */
function row(ssid: string, y: number): TreeNode {
  return el("Cell", [16, y, 343, 57], {}, [
    el("Button", [16, y, 343, 57], { label: `${ssid}, Güvenli Ağ, Sinyal Gücü: 3/3 çubuk` }, [
      el("Button", [34, y + 18, 123, 21], {}, [el("StaticText", [59, y + 18, 98, 21], { label: ssid })]),
      el("Other", [271, y + 22, 11, 14], { label: "Güvenli Ağ", identifier: "lock.fill" }),
      el("Button", [317, y + 15, 26, 27], { label: "Daha Fazla Bilgi", identifier: "info.circle" }),
    ]),
  ]);
}

function page(rows: TreeNode[]): TreeSnapshot {
  const root = el("Application", [0, 0, 375, 812], { label: "Ayarlar" }, [
    el("NavigationBar", [0, 50, 375, 54], { identifier: "Wi‑Fi" }, [el("StaticText", [166, 61, 43, 22], { label: "Wi‑Fi" }), el("StaticText", [166, 61, 43, 22], { label: "Wi‑Fi" })]),
    el("CollectionView", [0, 0, 375, 812], {}, rows),
  ]);
  return { platform: "ios", capturedAt: 0, source: "xcuitest", root, truncated: false, captureMs: 0 };
}

const wifi = page([row("Lab", 343), row("Guest", 405), row("Office", 467)]);

test("a network's name is pressed as the one text that says it", () => {
  assert.deepEqual(controlLocator(wifi, { x: 100, y: 494 }), {
    using: "predicate string",
    value: "type == 'XCUIElementTypeStaticText' AND label == 'Office'",
  });
});

test("its More Info button, which every row has, is pressed inside the row its name is in", () => {
  assert.deepEqual(controlLocator(wifi, { x: 330, y: 495 }), {
    using: "class chain",
    value:
      "**/XCUIElementTypeCell[$type == 'XCUIElementTypeStaticText' AND label == 'Office'$]/**/XCUIElementTypeButton[`label == 'Daha Fazla Bilgi' AND name == 'info.circle'`]",
  });
});

test("a row pressed beside its name is pressed by its name, which its signal bars do not change", () => {
  assert.deepEqual(controlLocator(wifi, { x: 250, y: 360 }), {
    using: "predicate string",
    value: "type == 'XCUIElementTypeStaticText' AND label == 'Lab'",
  });
});

test("what the tree cannot name unmistakably is left to the point", () => {
  assert.equal(controlLocator(wifi, { x: 180, y: 70 }), undefined, "two texts say Wi-Fi, and no row tells them apart");
  const bare = page([el("Cell", [16, 300, 343, 57])]);
  assert.equal(controlLocator(bare, { x: 100, y: 320 }), undefined, "a row that says nothing");
  assert.equal(controlLocator(wifi, { x: 5, y: 790 }), undefined, "the screen itself");
  const hidden = page([el("Cell", [16, 300, 343, 57], {}, [el("StaticText", [59, 318, 98, 21], { label: "Skip ad", visible: false })])]);
  assert.equal(controlLocator(hidden, { x: 100, y: 328 }), undefined, "what the tree says is not drawn is pressed, if at all, where it was seen");
});
