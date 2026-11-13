import assert from "node:assert/strict";
import test from "node:test";

import type { TreeNode, TreeSnapshot } from "@testsky/engine-core";

import { callAnswerControl } from "./call.ts";

let refs = 0;
function el(role: string, bounds: [number, number, number, number], extra: Partial<TreeNode> = {}, children: TreeNode[] = []): TreeNode {
  const [x, y, width, height] = bounds;
  return { ref: `n${(refs += 1)}`, role, bounds: { x, y, width, height }, enabled: true, interactive: role === "Button" || role === "ImageButton", children, ...extra };
}

function screen(children: TreeNode[], platform: "android" | "ios" = "android"): TreeSnapshot {
  return { platform, capturedAt: 0, source: platform === "ios" ? "xcuitest" : "uiautomator", truncated: false, captureMs: 0, root: el("FrameLayout", [0, 0, 412, 869], { interactive: false }, children) };
}

test("an incoming call's accept control is found by what it says, and its decline never", () => {
  const ring = screen([
    el("TextView", [40, 120, 300, 40], { label: "Test Caller" }),
    el("ImageButton", [60, 700, 96, 96], { label: "Decline" }),
    el("ImageButton", [256, 700, 96, 96], { label: "Accept" }),
  ]);
  assert.equal(callAnswerControl(ring)?.label, "Accept");
  assert.deepEqual(callAnswerControl(ring)?.bounds, { x: 256, y: 700, width: 96, height: 96 });
  assert.equal(callAnswerControl(screen([el("ImageButton", [60, 700, 96, 96], { label: "Decline" })])), undefined);
});

test("the words a call is answered with, in English and Turkish, and an identifier that says so", () => {
  for (const label of ["Answer", "Answer video call", "Accept call", "Join call", "Kabul Et", "Cevapla", "Yanıtla", "Görüntülü aramayı kabul et"]) {
    assert.equal(callAnswerControl(screen([el("Button", [256, 700, 96, 96], { label })]))?.label, label, label);
  }
  const byId = screen([el("ImageButton", [256, 700, 96, 96], { identifier: "com.facebook.orca:id/incoming_call_accept_button" })]);
  assert.equal(callAnswerControl(byId)?.label, "com.facebook.orca:id/incoming_call_accept_button");
  assert.equal(callAnswerControl(screen([el("ImageButton", [60, 700, 96, 96], { identifier: "com.acme:id/decline_and_answer_later" })])), undefined);
});

test("a chat line that mentions answering is not a control, and a word on a button is pressed as the button", () => {
  const chats = screen([el("TextView", [80, 300, 280, 20], { label: "Did you answer the call?" }), el("TextView", [80, 330, 200, 20], { label: "Accept the invite" })]);
  assert.equal(callAnswerControl(chats), undefined);
  // The word is a plain text inside the button that is pressed.
  const wrapped = screen([el("Button", [200, 690, 160, 110], { label: "" }, [el("TextView", [230, 760, 100, 24], { label: "Answer", interactive: false })])]);
  assert.deepEqual(callAnswerControl(wrapped)?.bounds, { x: 200, y: 690, width: 160, height: 110 });
});

test("what the tree says is not drawn does not answer a call", () => {
  assert.equal(callAnswerControl(screen([el("Button", [256, 700, 96, 96], { label: "Accept", visible: false })], "ios")), undefined);
});
