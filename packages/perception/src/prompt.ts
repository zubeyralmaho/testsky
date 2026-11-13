/**
 * A system permission prompt, read off the accessibility tree.
 *
 * The operating system draws these, not the app, so they look the same in
 * every app and name themselves in the tree: on Android every control carries
 * a permission-controller resource id, on iOS the prompt is an Alert whose
 * buttons use the system's own words. Reading them there costs a second and no
 * model call -- and they are the pop-ups a run meets most, on first launch,
 * before the app has shown a single screen of its own.
 *
 * What this does not do is guess. A prompt whose kind it cannot tell -- a
 * contacts request, a language it has no words for -- comes back without a
 * kind, and anything that is not plainly the system's comes back as nothing:
 * an app's own alert is the app's, and whether it is in the way is a question
 * for the eyes, not for a list of labels.
 */

import type { PopupKind, Rect, TreeNode, TreeSnapshot } from "@testsky/engine-core";

export interface PromptControl {
  label: string;
  bounds: Rect;
}

export interface SystemPrompt {
  /** Absent when the prompt's words did not say what it asks for. */
  kind?: PopupKind;
  /** The prompt's own words, for the report. */
  title: string;
  /** The control that grants, preferring the grant that lasts least. */
  allow?: PromptControl;
  /** The control that declines. */
  deny?: PromptControl;
  /** The control that puts it off without answering it. */
  dismiss?: PromptControl;
}

/** Everything that draws Android's runtime permission dialog, old and new. */
const ANDROID_CONTROLLER = /^com\.(?:google\.)?android\.(?:permissioncontroller|packageinstaller):id\/(.+)$/;

/** Grants in the order to prefer them: "while using the app" before "all the time". */
const ANDROID_ALLOW = [
  "permission_allow_foreground_only_button",
  "permission_allow_button",
  "permission_allow_all_button",
  "permission_allow_one_time_button",
];
const ANDROID_DENY = ["permission_deny_button", "permission_deny_and_dont_ask_again_button"];

/**
 * iOS's own button words, in the two languages this runs in -- the Turkish
 * ones as a simulator set to Turkish reports them. Both apostrophes in
 * English, because the system uses the curly one and people type the
 * straight one. A language not listed here is not a failure: the prompt is
 * left to the eyes, like anything else the tree cannot vouch for.
 */
const IOS_ALLOW = [
  "Allow While Using App",
  "Uygulamayı Kullanırken İzin Ver",
  "Allow",
  "İzin Ver",
  "Allow Full Access",
  "Tam Erişime İzin Ver",
  "Allow Access to All Photos",
  "Allow Once",
  "Bir Kez İzin Ver",
  "OK",
  "Tamam",
];
const IOS_DENY = ["Don’t Allow", "Don't Allow", "İzin Verme", "Ask App Not to Track"];

/**
 * The phone's own account asking for its password again: "Apple Account
 * Verification -- Enter the password for … in Settings", with Not Now and
 * Settings. Settings raises it, never the app in front, so it is in the way
 * whatever the test just did; seen on an iPhone SE in the middle of a
 * calculation. Matched on its title, in the two languages this runs in; a
 * Turkish iPhone 14 put it off with "Sonra".
 */
const IOS_ACCOUNT = /^(apple account verification|apple id verification|apple hesab[ıi] doğrulama(s[ıi])?|apple kimliği doğrulama(s[ıi])?)$/i;
const IOS_NOT_NOW = ["Not Now", "Şimdi Değil", "Sonra"];

function walk(node: TreeNode, visit: (node: TreeNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/**
 * A control's words, with every kind of space as one plain space: iOS writes
 * "Apple\u00a0Account Verification" with a no-break space to keep its name in
 * one piece, and a title matched with a plain one never matched it -- the
 * phone's account prompt on an iPhone SE went unrecognised in every run.
 */
function words(node: TreeNode): string {
  return (node.label ?? node.value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * What the prompt asks for, from its own words, in English or Turkish.
 *
 * Matched on the system's phrases, never on a single word: the app's own name
 * sits in the same sentence, and "Allow Parcel Tracker to access this device's
 * location?" is a location prompt, not a tracking one. iOS quotes the name, so
 * it is cut out first; Android does not, which is what the phrases are for.
 *
 * Turkish letters are folded before matching: lower-casing "İ" in JavaScript
 * yields an "i" with a combining dot that no pattern matches, and the dotless
 * "ı" is not an "i" to a regex either.
 */
function kindOf(title: string): PopupKind | undefined {
  const text = title
    .replace(/“[^”]*”|"[^"]*"/g, " ")
    .replace(/[İIı]/g, "i")
    .toLowerCase();
  if (/send you notifications|size bildirim|bildirim göndermesine/.test(text)) return "notifications";
  if (/track your activity|etkinliklerinizi/.test(text)) return "tracking";
  if (/device[’']s location|your location|konumunuzu|konumuna|konumunu/.test(text)) return "location";
  if (
    /take pictures|record video|record audio|access the camera|access the microphone|access your photos|photo library|photos and videos|photos, media|kameraya|mikrofona|fotoğraflariniza|fotoğraf çek|video kaydet|ses kaydet/.test(
      text,
    )
  ) {
    return "camera";
  }
  return undefined;
}

function readAndroid(root: TreeNode): SystemPrompt | undefined {
  const controls = new Map<string, TreeNode>();
  walk(root, (node) => {
    const id = node.identifier ? ANDROID_CONTROLLER.exec(node.identifier)?.[1] : undefined;
    if (id) controls.set(id, node);
  });
  if (!controls.size) return undefined;
  const pick = (ids: string[]) => {
    const node = ids.map((id) => controls.get(id)).find((found) => found && found.enabled);
    return node ? { label: words(node) || "(unlabelled)", bounds: node.bounds } : undefined;
  };
  const allow = pick(ANDROID_ALLOW);
  const deny = pick(ANDROID_DENY);
  if (!allow && !deny) return undefined;
  const message = controls.get("permission_message");
  const title = message ? words(message) : "";
  const kind = kindOf(title);
  return { ...(kind ? { kind } : {}), title, ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) };
}

function readIos(root: TreeNode): SystemPrompt | undefined {
  let alert: TreeNode | undefined;
  walk(root, (node) => {
    if (!alert && node.role === "Alert") alert = node;
  });
  if (!alert) return undefined;
  const buttons: TreeNode[] = [];
  walk(alert, (node) => {
    if (node.role === "Button" && words(node)) buttons.push(node);
  });
  const pick = (labels: string[]) => {
    for (const label of labels) {
      const node = buttons.find((button) => words(button) === label);
      if (node) return { label, bounds: node.bounds };
    }
    return undefined;
  };
  const title = words(alert);
  if (IOS_ACCOUNT.test(title)) {
    const dismiss = pick(IOS_NOT_NOW);
    return { kind: "account", title, ...(dismiss ? { dismiss } : {}) };
  }
  const allow = pick(IOS_ALLOW);
  const deny = pick(IOS_DENY);
  // "OK" alone is every app's alert; it takes a system word on the other side
  // to make this the system's prompt.
  if (!deny) return undefined;
  const kind = kindOf(title);
  return { ...(kind ? { kind } : {}), title, ...(allow ? { allow } : {}), deny };
}

export function readSystemPrompt(tree: TreeSnapshot): SystemPrompt | undefined {
  return tree.platform === "ios" ? readIos(tree.root) : tree.platform === "android" ? readAndroid(tree.root) : undefined;
}
