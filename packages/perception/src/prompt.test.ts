import assert from "node:assert/strict";
import test from "node:test";

import type { TreeNode, TreeSnapshot } from "@testsky/engine-core";

import { readSystemPrompt } from "./prompt.ts";

let refs = 0;
function node(partial: Partial<TreeNode>): TreeNode {
  return {
    ref: `n${(refs += 1)}`,
    role: "View",
    bounds: { x: 0, y: 0, width: 100, height: 40 },
    enabled: true,
    interactive: false,
    children: [],
    ...partial,
  };
}

function snapshot(platform: "android" | "ios", children: TreeNode[]): TreeSnapshot {
  return {
    platform,
    capturedAt: 0,
    source: platform === "ios" ? "xcuitest" : "uiautomator",
    truncated: false,
    captureMs: 900,
    root: node({ bounds: { x: 0, y: 0, width: 412, height: 915 }, children }),
  };
}

const controller = (id: string, label: string, y: number): TreeNode =>
  node({
    role: "Button",
    label,
    identifier: `com.android.permissioncontroller:id/${id}`,
    bounds: { x: 40, y, width: 332, height: 48 },
    interactive: true,
  });

test("Android's permission dialog is read from its ids, and what it asks from its message", () => {
  const prompt = readSystemPrompt(
    snapshot("android", [
      node({ label: "Allow Chats to access this device's location?", identifier: "com.android.permissioncontroller:id/permission_message" }),
      controller("permission_allow_foreground_only_button", "While using the app", 600),
      controller("permission_allow_one_time_button", "Only this time", 660),
      controller("permission_deny_button", "Don't allow", 720),
    ]),
  );
  assert.equal(prompt?.kind, "location");
  assert.equal(prompt?.allow?.label, "While using the app", "the grant that lasts least comes first");
  assert.equal(prompt?.deny?.label, "Don't allow");
  assert.deepEqual(prompt?.deny?.bounds, { x: 40, y: 720, width: 332, height: 48 });
});

test("the ids answer on a phone in any language; only the kind needs the words", () => {
  const prompt = readSystemPrompt(
    snapshot("android", [
      node({ label: "Chats erlauben, dir Benachrichtigungen zu senden?", identifier: "com.google.android.permissioncontroller:id/permission_message" }),
      controller("permission_allow_button", "Zulassen", 600),
      controller("permission_deny_button", "Nicht zulassen", 660),
    ]),
  );
  assert.ok(prompt, "Google's controller package is the same dialog");
  assert.equal(prompt.kind, undefined, "a kind it cannot read is left for the eyes, not guessed");
  assert.equal(prompt.allow?.label, "Zulassen");
});

test("iOS's own alert is recognised by the system's words, and tracking is told apart", () => {
  const alert = (title: string, buttons: string[]) =>
    snapshot("ios", [
      node({
        role: "Alert",
        label: title,
        children: buttons.map((label, i) => node({ role: "Button", label, bounds: { x: 60, y: 480 + i * 44, width: 270, height: 44 }, interactive: true })),
      }),
    ]);

  const tracking = readSystemPrompt(
    alert("Allow “Chats” to track your activity across other companies’ apps and websites?", ["Ask App Not to Track", "Allow"]),
  );
  assert.equal(tracking?.kind, "tracking");
  assert.equal(tracking?.deny?.label, "Ask App Not to Track");

  const notifications = readSystemPrompt(alert("“Chats” Would Like to Send You Notifications", ["Don’t Allow", "Allow"]));
  assert.equal(notifications?.kind, "notifications");
  assert.equal(notifications?.allow?.label, "Allow");
});

test("a simulator set to Turkish is read too, from the words iOS 26 actually uses", () => {
  // Captured from WDA's /source over Maps' first-launch location prompt.
  const prompt = readSystemPrompt(
    snapshot("ios", [
      node({
        role: "Alert",
        label: "“Harita”, konumunuzu kullanabilsin mi?",
        children: [
          node({ role: "StaticText", label: "“Harita”, konumunuzu kullanabilsin mi?" }),
          node({ role: "Button", label: "Bir Kez İzin Ver", bounds: { x: 76, y: 499, width: 288, height: 48 } }),
          node({ role: "Button", label: "Uygulamayı Kullanırken İzin Ver", bounds: { x: 76, y: 555, width: 288, height: 48 } }),
          node({ role: "Button", label: "İzin Verme", bounds: { x: 76, y: 611, width: 288, height: 48 } }),
        ],
      }),
    ]),
  );
  assert.equal(prompt?.kind, "location");
  assert.equal(prompt?.allow?.label, "Uygulamayı Kullanırken İzin Ver", "while in use, not just once and not always");
  assert.equal(prompt?.deny?.label, "İzin Verme");
});

test("the app's own name never decides what a prompt asks for", () => {
  const android = (message: string) =>
    readSystemPrompt(
      snapshot("android", [
        node({ label: message, identifier: "com.android.permissioncontroller:id/permission_message" }),
        controller("permission_allow_button", "Allow", 600),
        controller("permission_deny_button", "Don't allow", 660),
      ]),
    )?.kind;
  assert.equal(android("Allow Parcel Tracker to access this device's location?"), "location", "Tracker is a name, not tracking");
  assert.equal(android("Kargo İzleme uygulamasının bu cihazın konumuna erişmesine izin verilsin mi?"), "location");
  assert.equal(android("Allow Notifications Hub to take pictures and record video?"), "camera");
  assert.equal(android("Allow Chats to access your contacts?"), undefined, "a kind it has no rule for is left to the eyes");

  const ios = readSystemPrompt(
    snapshot("ios", [
      node({
        role: "Alert",
        label: "“Location Buddy” Would Like to Access the Camera",
        children: [node({ role: "Button", label: "Don’t Allow" }), node({ role: "Button", label: "OK" })],
      }),
    ]),
  );
  assert.equal(ios?.kind, "camera", "iOS quotes the name, and the quoted name is cut out before reading");
});

test("an app's own alert, and a screen with no prompt, are nothing to this reader", () => {
  const appAlert = snapshot("ios", [
    node({ role: "Alert", label: "Delete this chat?", children: [node({ role: "Button", label: "Cancel" }), node({ role: "Button", label: "OK" })] }),
  ]);
  assert.equal(readSystemPrompt(appAlert), undefined, "OK and Cancel are every app's words; whether it is in the way is not a lookup");
  assert.equal(readSystemPrompt(snapshot("android", [node({ role: "Button", label: "Send", identifier: "com.acme.chats:id/send" })])), undefined);
});

test("the phone's own account asking for its password is read as that, and put off with Not Now", () => {
  const verification = readSystemPrompt(
    snapshot("ios", [
      node({
        role: "Alert",
        label: "Apple Account Verification",
        children: [
          node({ role: "StaticText", label: "Enter the password for “qa@example.com” in Settings." }),
          node({ role: "Button", label: "Not Now", bounds: { x: 30, y: 440, width: 160, height: 50 }, interactive: true }),
          node({ role: "Button", label: "Settings", bounds: { x: 200, y: 440, width: 160, height: 50 }, interactive: true }),
        ],
      }),
    ]),
  );
  assert.equal(verification?.kind, "account");
  assert.equal(verification?.dismiss?.label, "Not Now");
  assert.equal(verification?.allow, undefined, "Settings is not an answer: it leads to a password field");
  assert.equal(verification?.deny, undefined);

  const turkish = readSystemPrompt(
    snapshot("ios", [
      node({
        role: "Alert",
        label: "Apple Hesabı Doğrulama",
        children: [
          node({ role: "Button", label: "Sonra", bounds: { x: 30, y: 440, width: 160, height: 50 }, interactive: true }),
          node({ role: "Button", label: "Ayarlar", bounds: { x: 200, y: 440, width: 160, height: 50 }, interactive: true }),
        ],
      }),
    ]),
  );
  assert.equal(turkish?.kind, "account");
  assert.equal(turkish?.dismiss?.label, "Sonra", "a Turkish iPhone 14 puts it off this way");

  // As WebDriverAgent reads it off an iPhone SE: a no-break space in the name.
  const asWritten = readSystemPrompt(
    snapshot("ios", [
      node({
        role: "Alert",
        label: "Apple\u00a0Account Verification",
        children: [
          node({ role: "Button", label: "Not Now", bounds: { x: 43, y: 365, width: 141, height: 49 }, interactive: true }),
          node({ role: "Button", label: "Settings", bounds: { x: 191, y: 365, width: 141, height: 49 }, interactive: true }),
        ],
      }),
    ]),
  );
  assert.equal(asWritten?.kind, "account");
  assert.equal(asWritten?.dismiss?.label, "Not Now");
});
