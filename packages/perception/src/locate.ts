/**
 * The tree's half of finding a target, and the tree's measure of a model's.
 *
 * Grounding asks a model and the tree together (see the router). This is the
 * tree's part: it names a target only when the words of the description are
 * the name of exactly one pressable control on the screen, with nothing over
 * it, and otherwise says why it cannot. It also measures what a model chose:
 * the control a model's point is on, the control a model's box is the box of,
 * and whether a model's point is on any control at all.
 *
 * Deliberately strict. A target named wrongly is worse than none: where the
 * model cannot answer, the tree's name is all there is. So only a whole name,
 * an identifier or a quoted phrase counts -- not a description that says more
 * than a name (the switch next to "Wi-Fi"), not a control of another kind
 * than the one asked for (the Wi-Fi switch is not the Wi-Fi row, though it
 * may be the one switch inside it), not on a tree cut short, off the screen,
 * hidden, under something drawn over it, or under the one thing an Android
 * tree never shows, the keyboard.
 */

import type { Point, Rect, TreeNode, TreeSnapshot } from "@testsky/engine-core";

import { coversMostOf } from "./anchor.ts";

export interface TreeTarget {
  point: Point;
  /** The box a tap presses: the control around the named node, or the node itself. */
  rect: Rect;
  node: { role: string; label?: string; identifier?: string };
  /** What picked it out. */
  by: "label" | "identifier" | "quoted";
}

export interface TreeLocate {
  target?: TreeTarget;
  /** Why the tree answered, or why it left the question to a model. */
  reason: string;
}

// Words that say what kind of thing a target is, not which one -- in English
// and in Turkish, the two languages tests here are written in. Never a word a
// name is made of: "in", "on" and "all" are parts of "Log in", "Turn on" and
// "Select all", so they are not here.
const KIND_WORDS = new Set([
  "the", "a", "an", "this", "that", "button", "btn", "icon", "field", "tab", "link", "item", "row", "option",
  "menu", "entry", "toggle", "switch", "checkbox", "radio", "label", "labelled", "labeled", "text", "input",
  "box", "textbox", "card", "cell", "tile", "named", "called", "says", "slider",
  "buton", "butonu", "butonuna", "düğme", "düğmesi", "düğmesine", "simge", "simgesi", "simgesine", "alan",
  "alanı", "alanına", "sekme", "sekmesi", "sekmesine", "bağlantı", "bağlantısı", "satır", "satırı",
]);

// What to do with a target, which is no part of its name -- but only outside
// a quoted name: unquoted, "Select all" and "Open in Maps" are names.
const VERBS = new Set(["tap", "press", "click", "select", "choose", "open", "hit", "touch", "dokun", "bas", "tıkla", "seç", "aç"]);

// Where a person types. One with focus means a keyboard is probably up, and
// on Android the keyboard is not in the tree at all.
const TEXT_ROLES = /(?:EditText|TextField|SearchField|AutoCompleteTextView)$/;

// Kinds a description can ask for, and the roles that are that kind. Asked
// for that way -- "the Wi-Fi switch" -- a row with that label is not it, but
// the one switch inside the row is.
const KINDS: { words: RegExp; roles: RegExp; name: string }[] = [
  { words: /^(?:switch|toggle)$/, roles: /Switch|Toggle|CompoundButton/, name: "switch" },
  { words: /^checkbox$/, roles: /CheckBox|Checkbox|CheckedTextView/, name: "checkbox" },
  { words: /^radio$/, roles: /Radio/, name: "radio button" },
  { words: /^(?:field|input|textbox|alan|alanı|alanına)$/, roles: TEXT_ROLES, name: "text field" },
  { words: /^slider$/, roles: /Slider|SeekBar/, name: "slider" },
  { words: /^(?:tab|sekme|sekmesi|sekmesine)$/, roles: /(?:^Tab|TabView|TabBar|TabWidget)$/, name: "tab" },
];

// Roles that can be pressed even when a platform forgets to say so -- whole
// names, so a Table is not a Tab.
const PRESSABLE_ROLES = /^(?:[A-Za-z]*Button|Cell|Link|Switch|CheckBox|Checkbox|Tab|MenuItem|Toggle|Chip)$/;

// What a platform calls interactive because it scrolls or holds buttons. A
// tap on one presses whatever is in its middle, so a name is never pressed
// through one -- but one drawn over a target still takes the tap.
const CONTAINER_ROLES =
  /(?:ScrollView|RecyclerView|ListView|GridView|ViewPager2?|WebView|Table|CollectionView|TabBar|TabLayout|Toolbar|NavigationBar|SegmentedControl|PickerWheel|DrawerLayout)$/;

// What changes a setting when pressed, where a row beside it only opens one.
const TOGGLE_ROLES = /Switch|Toggle|CompoundButton|CheckBox|Checkbox|Radio/;

// Drawn over the app whether or not anything in them can be pressed.
const OVERLAY_ROLES = /^(?:Keyboard|Alert|Sheet|Popover|Dialog)$/;

// On iOS a picture's identifier is usually the name of the file it was drawn
// from, not a name anybody gave the control. An Android resource id always
// is one.
const IMAGE_ROLES = /^(?:Image|ImageView|Icon)$/;
const givenId = (node: TreeNode) => Boolean(node.identifier) && (node.identifier!.includes(":id/") || !IMAGE_ROLES.test(node.role));

const words = (text: string): string[] =>
  text
    .toLocaleLowerCase("tr")
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** What is left of a phrase once the words that only name a kind of thing are gone. */
const core = (list: string[]): string => list.filter((word) => !KIND_WORDS.has(word)).join(" ");

/**
 * Whether a description's words are this label: once the kind words the label
 * itself does not use are set aside, exactly its words. "the Switch account
 * button" is the label "Switch account"; "the account button" is not.
 */
function names(description: string[], label: string[]): boolean {
  const own = new Set(label);
  return description.filter((word) => !KIND_WORDS.has(word) || own.has(word)).join(" ") === label.join(" ");
}

/**
 * An identifier's own name: "com.acme.shop:id/pay_button", "PayButton" and
 * "com.apple.settings.pay" are all "pay" -- the last part of a resource id or
 * of a reverse-domain name.
 */
function identifierCore(identifier: string): string {
  const tail = identifier.split(/[:/.]/).filter(Boolean).pop() ?? identifier;
  return core(words(tail.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.-]+/g, " ")));
}

const QUOTED = /(?:^|\s)["“'‘]([^"“”'‘’]{1,80})["”'’](?=\s|$|[.,;:!?)])/u;

interface Placed {
  node: TreeNode;
  order: number;
  ancestors: TreeNode[];
}

function flatten(root: TreeNode): Placed[] {
  const all: Placed[] = [];
  const walk = (node: TreeNode, ancestors: TreeNode[]) => {
    all.push({ node, order: all.length, ancestors });
    for (const child of node.children) walk(child, [...ancestors, node]);
  };
  walk(root, []);
  return all;
}

const area = (rect: Rect) => Math.max(0, rect.width) * Math.max(0, rect.height);
const contains = (rect: Rect, point: Point) =>
  point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
const encloses = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;
const centre = (rect: Rect): Point => ({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** How much of a box is on the screen, from 0 to 1. */
function shareOnScreen(rect: Rect, screen: Rect): number {
  const width = Math.min(rect.x + rect.width, screen.x + screen.width) - Math.max(rect.x, screen.x);
  const height = Math.min(rect.y + rect.height, screen.y + screen.height) - Math.max(rect.y, screen.y);
  return width > 0 && height > 0 && area(rect) > 0 ? (width * height) / area(rect) : 0;
}

/** Drawn, as far as the platform says: not hidden itself, nor inside something hidden. */
const shown = (placed: Placed) => placed.node.visible !== false && placed.ancestors.every((node) => node.visible !== false);

/** On the screen at all, and not the screen itself: a list's rows past the fold and a closed drawer are not there. */
const onScreen = (placed: Placed, screen: Rect) =>
  shown(placed) && area(placed.node.bounds) > 0 && !coversMostOf(placed.node.bounds, screen) && shareOnScreen(placed.node.bounds, screen) > 0;

/** Something a tap on this node means: a control, not the list or bar it sits in. */
const pressable = (node: TreeNode) =>
  (node.interactive || PRESSABLE_ROLES.test(node.role)) && !CONTAINER_ROLES.test(node.role);

/** The control a tap on this node presses: itself, or the smallest pressable node around it short of the window. */
function pressTarget(placed: Placed, screen: Rect): Placed | undefined {
  if (pressable(placed.node) && !coversMostOf(placed.node.bounds, screen)) return placed;
  for (let i = placed.ancestors.length - 1; i >= 0; i -= 1) {
    const ancestor = placed.ancestors[i]!;
    if (pressable(ancestor) && !coversMostOf(ancestor.bounds, screen)) {
      return { node: ancestor, order: -1, ancestors: placed.ancestors.slice(0, i) };
    }
  }
  return undefined;
}

/**
 * The control of each kind asked for: the target itself when it, or what it
 * sits in, is that kind -- a tab bar's button is a tab -- or else the one
 * control of that kind inside it. None, or two, and the tree cannot say.
 */
function ofKind(target: Placed, kinds: (typeof KINDS)[number][], all: Placed[], screen: Rect): Placed | undefined {
  if (!kinds.length) return target;
  const is = (node: TreeNode) => kinds.every((kind) => kind.roles.test(node.role));
  if ([target.node, ...target.ancestors].some(is)) return target;
  const inside = all.filter(
    (placed) => placed.ancestors.includes(target.node) && is(placed.node) && onScreen(placed, screen),
  );
  return inside.length === 1 ? inside[0] : undefined;
}

/** What takes a tap that lands on it: a control, a list or bar short of the whole screen, a keyboard or an alert. */
const takesTaps = (node: TreeNode, screen: Rect) =>
  OVERLAY_ROLES.test(node.role) ||
  pressable(node) ||
  ((node.interactive || CONTAINER_ROLES.test(node.role)) && !coversMostOf(node.bounds, screen));

/** Something drawn after the target and over its middle -- a sheet, a scrim, a banner, a keyboard. */
function coveredBy(all: Placed[], target: Placed, point: Point, screen: Rect): TreeNode | undefined {
  const lineage = new Set([target.node, ...target.ancestors]);
  const order = all.find((placed) => placed.node === target.node)?.order ?? target.order;
  for (const other of all) {
    if (!shown(other) || lineage.has(other.node) || other.ancestors.includes(target.node)) continue;
    // A keyboard is over everything, wherever the tree lists it.
    const later = other.order > order || OVERLAY_ROLES.test(other.node.role);
    if (later && takesTaps(other.node, screen) && contains(other.node.bounds, point)) return other.node;
  }
  return undefined;
}

/**
 * The text field with focus, when one has it. Android keeps the keyboard out
 * of the tree, but it never covers the field being typed into: what is below
 * that field may be under it, and what is above it is not.
 */
const typingInto = (all: Placed[]): TreeNode | undefined =>
  all.find(({ node }) => node.focused && TEXT_ROLES.test(node.role))?.node;

/**
 * The screen a tree covers. Given by the caller, as the frame's size in
 * points, because a tree of several windows has a root with no bounds at all.
 */
function screenOf(tree: TreeSnapshot, size?: { width: number; height: number }): Rect {
  if (size && size.width > 0 && size.height > 0) return { x: 0, y: 0, ...size };
  if (area(tree.root.bounds) > 0) return tree.root.bounds;
  let right = 0;
  let bottom = 0;
  const walk = (node: TreeNode) => {
    right = Math.max(right, node.bounds.x + node.bounds.width);
    bottom = Math.max(bottom, node.bounds.y + node.bounds.height);
    node.children.forEach(walk);
  };
  walk(tree.root);
  return { x: 0, y: 0, width: right, height: bottom };
}

/**
 * The one target `description` names in `tree`, or why there is none to be
 * sure of. `screenSize` is the frame's size in points, which the tree is
 * measured in.
 */
export function locateInTree(
  tree: TreeSnapshot,
  description: string,
  screenSize?: { width: number; height: number },
): TreeLocate {
  if (tree.truncated) return { reason: "the tree was cut short, so a second match could be missing" };

  // A quoted name is the name, and the rest may only say what kind of thing
  // it is: `the "Pay" button`. Anything more -- `the switch next to "Wi-Fi"`,
  // `the delete icon on the "Milk" row` -- describes something else, found
  // by way of the name, and that is a model's question.
  const quote = description.match(QUOTED);
  const phrase = quote?.[1] ? words(quote[1]).join(" ") : undefined;
  const rest = (quote ? description.replace(quote[0], " ") : description).trim();
  const restWords = words(rest).filter((word) => !(phrase && VERBS.has(word)));
  if (phrase && restWords.some((word) => !KIND_WORDS.has(word))) {
    return { reason: `"${description}" says more than a name` };
  }
  const wanted = phrase ?? core(restWords);
  if (!wanted) return { reason: "the description names no particular thing" };

  const screen = screenOf(tree, screenSize);
  const all = flatten(tree.root);
  const matches: { placed: Placed; by: TreeTarget["by"]; kinds: (typeof KINDS)[number][] }[] = [];
  // The kinds a description asks for, beyond the words of the name itself.
  const kindsBeyond = (label: string[]) =>
    KINDS.filter((kind) => restWords.some((word) => kind.words.test(word) && !label.includes(word)));
  for (const placed of all) {
    if (!onScreen(placed, screen)) continue;
    const { node } = placed;
    const label = node.label ? words(node.label) : [];
    if (label.length && (phrase ? label.join(" ") === phrase : names(restWords, label))) {
      matches.push({ placed, by: phrase ? "quoted" : "label", kinds: kindsBeyond(label) });
    } else if (!phrase && node.identifier && pressable(node) && givenId(node) && identifierCore(node.identifier) === wanted) {
      matches.push({ placed, by: "identifier", kinds: kindsBeyond([]) });
    }
  }
  if (!matches.length) return { reason: `no node in the tree is called "${wanted}"` };

  // Several nodes naming the same control -- a row and the text inside it --
  // are one target. Two controls are two, and then the tree cannot choose.
  const targets: { target: Placed; match: (typeof matches)[number] }[] = [];
  let wrongKind: string | undefined;
  for (const match of matches) {
    const pressed = pressTarget(match.placed, screen);
    if (!pressed) continue;
    const target = ofKind(pressed, match.kinds, all, screen);
    if (!target) {
      wrongKind = match.kinds.map((kind) => kind.name).join(" ");
      continue;
    }
    if (!targets.some((other) => sameRect(other.target.node.bounds, target.node.bounds))) targets.push({ target, match });
  }
  if (!targets.length) {
    return {
      reason: wrongKind
        ? `"${wanted}" is in the tree, but not as one ${wrongKind}`
        : `"${wanted}" is in the tree, but nothing there can be pressed`,
    };
  }
  const enabled = targets.filter(({ target, match }) => target.node.enabled && match.placed.node.enabled);
  let pool = enabled.length ? enabled : targets;
  // A settings row and the switch beside it often carry one name -- Samsung's
  // "Wi-Fi" is both. Asked for by its name alone, the entry is the row; the
  // switch is pressed only when a switch is asked for, because pressing it
  // changes the setting where the row only opens it.
  if (pool.length > 1 && pool.every(({ match }) => !match.kinds.length)) {
    const entries = pool.filter(({ target }) => !TOGGLE_ROLES.test(target.node.role));
    if (entries.length === 1) pool = entries;
  }
  if (pool.length > 1) return { reason: `${pool.length} controls are called "${wanted}"` };

  const chosen = pool[0]!;
  const rect = chosen.target.node.bounds;
  const point = centre(rect);
  if (!contains(screen, point) || shareOnScreen(rect, screen) < 0.5) {
    return { reason: `"${wanted}" is only partly on the screen` };
  }
  const cover = coveredBy(all, chosen.target, point, screen);
  if (cover) {
    return { reason: `"${wanted}" is covered by ${cover.label ? `"${cover.label}"` : `a ${cover.role}`}` };
  }
  const field = typingInto(all);
  if (field && field !== chosen.target.node && field !== chosen.match.placed.node && point.y > field.bounds.y + field.bounds.height) {
    return { reason: `"${wanted}" is below the field being typed into, where a keyboard may be` };
  }

  const { node } = chosen.match.placed;
  const pressed = chosen.target.node;
  const named = chosen.match.by === "identifier" ? `with the id ${node.identifier}` : `called "${node.label}"`;
  return {
    target: {
      point,
      rect,
      node: {
        role: pressed.role,
        ...(node.label ? { label: node.label } : {}),
        ...(node.identifier ? { identifier: node.identifier } : {}),
      },
      by: chosen.match.by,
    },
    reason:
      pressed === node
        ? `the tree has one ${node.role} ${named}`
        : `the tree has one ${pressed.role} for the ${node.role} ${named}`,
  };
}

/** Every control on the screen, with where it is drawn -- for measuring a model's answer against. */
function controls(tree: TreeSnapshot, screen: Rect): TreeNode[] {
  return flatten(tree.root)
    .filter((placed) => onScreen(placed, screen) && pressable(placed.node))
    .map(({ node }) => node);
}

const overlap = (a: Rect, b: Rect): number => {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  const shared = width * height;
  return shared / (area(a) + area(b) - shared);
};

/**
 * The control a model's box is the box of, measured as the tree measures it:
 * the one whose bounds share at least half their union with the box. A model
 * is good at which control and loose about exactly where; the tree is exact
 * about where and knows nothing of which.
 */
export function controlForBox(tree: TreeSnapshot, box: Rect, screenSize?: { width: number; height: number }): TreeNode | undefined {
  let best: { node: TreeNode; score: number } | undefined;
  for (const node of controls(tree, screenOf(tree, screenSize))) {
    const score = overlap(node.bounds, box);
    if (score >= 0.5 && (!best || score > best.score)) best = { node, score };
  }
  return best?.node;
}

/** The control a point is on: the smallest one around it, short of the screen. */
export function controlAt(tree: TreeSnapshot, point: Point, screenSize?: { width: number; height: number }): TreeNode | undefined {
  let best: TreeNode | undefined;
  for (const node of controls(tree, screenOf(tree, screenSize))) {
    if (contains(node.bounds, point) && (!best || area(node.bounds) < area(best.bounds))) best = node;
  }
  return best;
}

/** Whether one box lies wholly inside another: a switch inside its row. */
export const boxInside = (inner: Rect, outer: Rect): boolean => encloses(outer, inner) && !sameRect(inner, outer);

/**
 * Whether the tree has controls on this screen and none of them is under the
 * point: the tree's way of disagreeing with a model that points at nothing.
 * A screen the tree describes no controls on -- a canvas, a game -- has no
 * opinion either way.
 */
export function pointsAtNothing(tree: TreeSnapshot, point: Point, screenSize?: { width: number; height: number }): boolean {
  const all = controls(tree, screenOf(tree, screenSize));
  return all.length > 0 && !all.some((node) => contains(node.bounds, point));
}

/**
 * What a text field holds, read back after typing into it: the field at the
 * point typed at. `secret` when the field hides what it holds -- a password
 * shows its dots, not its text.
 */
export function fieldAt(
  tree: TreeSnapshot,
  point: Point,
): { text: string; secret: boolean; role: string; bounds: Rect; atPoint: boolean } | undefined {
  // The field at the point typed at: a form of six one-digit boxes has its
  // focus on the last one, and that is not where the first digit went. Focus
  // only chooses between fields that are both at the point.
  const fields = flatten(tree.root)
    .filter((placed) => shown(placed) && TEXT_ROLES.test(placed.node.role))
    .map(({ node }) => node);
  const at = fields
    .filter((node) => contains(node.bounds, point))
    .sort((a, b) => Number(Boolean(b.focused)) - Number(Boolean(a.focused)) || area(a.bounds) - area(b.bounds));
  // A field that moved while it was typed into -- Safari's address bar rises
  // above the keyboard -- is not at the point any more: then the field with
  // focus, or the only field there is. Not certainly the same field, so the
  // caller believes it only when it holds exactly what was typed.
  const elsewhere = at.length ? undefined : (fields.find((node) => node.focused) ?? (fields.length === 1 ? fields[0] : undefined));
  const field = at[0] ?? elsewhere;
  if (!field) return undefined;
  // XCUITest keeps a field's text in its value and its name in its label;
  // uiautomator gives the text as the label unless a description took it.
  const text = (tree.source === "xcuitest" ? field.value : (field.value ?? field.label)) ?? "";
  return {
    text,
    secret: /Secure/.test(field.role) || (text.length > 0 && /^[•●*·]+$/u.test(text)),
    role: field.role,
    bounds: field.bounds,
    atPoint: Boolean(at[0]),
  };
}
