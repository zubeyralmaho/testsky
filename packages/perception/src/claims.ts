/**
 * What an expectation claims that the tree can check, and what the tree says
 * about it.
 *
 * A judge looking at a picture passes near misses: "the Wi-Fi page is open"
 * on the Connections page, whose Wi-Fi row shows the network the expectation
 * names. The tree knows which page it is -- the heading -- and which words are
 * on the screen. It does not overrule the judge: it is read when the judge
 * passes, and when it disagrees, the second look is told what it says.
 *
 * Only plain claims are read: a page or a title named, a phrase in quotes, an
 * orientation. A sentence that negates ("no error is shown") is left alone: a
 * quoted phrase in it is what must NOT be there.
 */

import type { Rect, TreeNode, TreeSnapshot } from "@testsky/engine-core";

export interface Claims {
  /** Pages or titles the expectation names: "the Wi-Fi page", the title "General". */
  headings: string[];
  /** Phrases the expectation quotes as being on the screen. */
  texts: string[];
  /** An orientation the expectation names -- which no picture shows reliably. */
  orientation?: "landscape" | "portrait";
}

const NEGATION =
  /\b(not|no|never|without|nothing|none|neither|nor|isn't|aren't|doesn't|don't|cannot|can't|hidden|gone|disappears?)\b|değil|yok|olmadan|hiçbir|kayboldu/iu;

// A quote opens after no letter: the apostrophe of "YouTube's results for ..." opens nothing, and
// taken for one it made a claim of the words up to the next quote, which no screen ever reads.
const QUOTE = /(?<![\p{L}\p{N}])["“”„'‘’]([^"“”„'‘’]{1,80})["“”„'‘’]/gu;

// What names a page without saying which one.
const NOT_A_NAME = new Set([
  "next", "previous", "same", "new", "current", "first", "last", "other", "following", "that", "this", "a", "an",
  "any", "one", "whole", "entire", "top", "level", "top level", "home", "main", "detail", "details", "right",
  "correct", "expected", "next screen", "start",
]);

const words = (text: string): string[] =>
  text
    .toLocaleLowerCase("tr")
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

export function claimsIn(expectation: string): Claims {
  const claims: Claims = { headings: [], texts: [] };
  if (/\b(landscape)\b|\byatay\b/iu.test(expectation)) claims.orientation = "landscape";
  else if (/\b(portrait)\b|\bdikey\b/iu.test(expectation)) claims.orientation = "portrait";
  if (NEGATION.test(expectation)) return claims;

  const consumed = new Set<string>();
  // The title "X", the heading is "X", başlık "X".
  for (const match of expectation.matchAll(/(?:title|heading|başlı[kğ]\p{L}*)\W{0,12}(?:is|reads|says|shows|=|:)?\s*["“”„'‘’]([^"“”„'‘’]{1,80})["“”„'‘’]/giu)) {
    claims.headings.push(match[1]!);
    consumed.add(match[1]!);
  }
  // "X" page, "X" screen, "X" sayfası.
  for (const match of expectation.matchAll(/["“”„'‘’]([^"“”„'‘’]{1,80})["“”„'‘’]\s+(?:page|screen|sayfas\p{L}*|ekran\p{L}*)/giu)) {
    if (!consumed.has(match[1]!)) claims.headings.push(match[1]!);
    consumed.add(match[1]!);
  }
  // the X page, the X screen -- a name, not "the next screen".
  for (const match of expectation.matchAll(/\bthe\s+([\p{L}\p{N}&+\- ]{1,40}?)\s+(?:page|screen)\b/giu)) {
    const name = match[1]!.trim();
    if (!words(name).length || NOT_A_NAME.has(words(name).join(" ")) || words(name).every((word) => NOT_A_NAME.has(word))) continue;
    claims.headings.push(name);
  }
  for (const match of expectation.matchAll(QUOTE)) {
    if (!consumed.has(match[1]!)) claims.texts.push(match[1]!);
  }
  return claims;
}

/** Whether an expectation says anything the tree could check. */
export const checkable = (claims: Claims): boolean => claims.headings.length > 0 || claims.texts.length > 0;

// What a status bar shows, in English and Turkish: the time, the battery, a
// connection, a call or a recording in progress, the carrier, a download.
// Read wide: an expectation wrongly taken to be about it is only remembered
// less often. Not "arama", though, which is every search as well as a call.
const STATUS_BAR =
  /(?<![\p{L}\p{N}])(?:status bar|batter|charg|signal|wi.?fi|wlan|cellular|mobile data|airplane|flight mode|bluetooth|vpn|hotspot|tether|location|gps|time|clock|alarm|notification|do not disturb|silent|vibrat|nfc|lte|[2345]g(?![\p{L}\p{N}])|network|connect|disconnect|online|offline|internet|call(?!ed)|record|micro|servi|sos(?![\p{L}\p{N}])|sim(?![\p{L}\p{N}])|carrier|roaming|download|durum çubu|pil|şarj|sinyal|kablosuz|ağ|bağlan|bağlı|uçak modu|konum|saat|zaman|bildirim|rahatsız etme|sessiz|titreşim|çevrimiçi|çevrimdışı|hücresel|mobil veri|çağrı|görüşme|kayıt|mikrofon|operatör|dolaşım|indir)/iu;

/**
 * Whether an expectation is about something a status bar shows -- the time,
 * the battery, a connection -- so that its screen is judged, and remembered,
 * with the status bar in the picture.
 */
export function aboutStatusBar(expectation: string): boolean {
  // Lowered the Turkish way too, for an İnternet; not only, for a WI-FI.
  return STATUS_BAR.test(expectation) || STATUS_BAR.test(expectation.toLocaleLowerCase("tr"));
}

interface Placed {
  node: TreeNode;
  ancestors: TreeNode[];
}

function flatten(root: TreeNode): Placed[] {
  const all: Placed[] = [];
  const walk = (node: TreeNode, ancestors: TreeNode[]) => {
    all.push({ node, ancestors });
    for (const child of node.children) walk(child, [...ancestors, node]);
  };
  walk(root, []);
  return all;
}

const LISTS = /(?:ScrollView|RecyclerView|ListView|GridView|ViewPager2?|WebView|Table|CollectionView)$/;
const TEXTS = /(?:TextView|StaticText|Text|Label|Heading|Title)$/;
const BARS = /^(?:NavigationBar|Toolbar)$|ActionBar|AppBar|CollapsingToolbar/;

const area = (rect: Rect) => Math.max(0, rect.width) * Math.max(0, rect.height);
const shown = ({ node, ancestors }: Placed) => node.visible !== false && ancestors.every((each) => each.visible !== false);

function screenOf(tree: TreeSnapshot, size?: { width: number; height: number }): Rect {
  if (size && size.width > 0 && size.height > 0) return { x: 0, y: 0, ...size };
  return tree.root.bounds;
}

/**
 * The screen's own heading, as the tree has it: the first text near the top
 * that is not in the list below it and not a control -- One UI's "Connections"
 * after "Navigate up", an iOS navigation bar's title. None when nothing
 * qualifies: the tree then has no opinion about which page this is.
 */
export function screenHeading(tree: TreeSnapshot, screenSize?: { width: number; height: number }): string | undefined {
  const screen = screenOf(tree, screenSize);
  const top = screen.y + screen.height * 0.25;
  for (const placed of flatten(tree.root)) {
    const { node, ancestors } = placed;
    if (!shown(placed) || area(node.bounds) === 0) continue;
    if (ancestors.some((each) => LISTS.test(each.role))) continue;
    const centreY = node.bounds.y + node.bounds.height / 2;
    if (centreY > top || centreY < screen.y) continue;
    // An iOS navigation bar names its page itself.
    if (/^NavigationBar$/.test(node.role) && node.identifier && !/^[A-Z][A-Za-z]+(?:View|Controller)$/.test(node.identifier)) {
      return node.identifier;
    }
    if (!node.label || node.interactive || !TEXTS.test(node.role)) continue;
    if (/:id\/(?:summary|subtitle)$/.test(node.identifier ?? "")) continue;
    // A row's title -- "Wi-Fi #title" inside a list -- was skipped above; a
    // title in a bar, or loose at the top, is the page's.
    if (ancestors.some((each) => BARS.test(each.role)) || !ancestors.some((each) => each.interactive)) return node.label;
  }
  return undefined;
}

/** All the words on the screen, phrase by phrase, as the tree has them. */
function phrases(tree: TreeSnapshot, screen: Rect): string[][] {
  return flatten(tree.root)
    .filter((placed) => shown(placed) && area(placed.node.bounds) > 0)
    .filter(({ node }) => node.bounds.x < screen.x + screen.width && node.bounds.y < screen.y + screen.height)
    .flatMap(({ node }) => [node.label, node.value].filter((text): text is string => Boolean(text)).map(words));
}

const containsRun = (haystack: string[], needle: string[]) =>
  needle.length > 0 && haystack.some((_, start) => needle.every((word, i) => haystack[start + i] === word));

/**
 * Where the tree disagrees with the claims, in sentences a judge can read.
 * Empty when it agrees, or has nothing to say.
 */
export function treeEvidence(tree: TreeSnapshot, claims: Claims, screenSize?: { width: number; height: number }): string[] {
  const evidence: string[] = [];
  const screen = screenOf(tree, screenSize);
  const heading = screenHeading(tree, screenSize);
  if (heading) {
    const said = words(heading);
    for (const name of claims.headings) {
      const named = words(name);
      // "the Wi-Fi settings page" over a heading "Wi-Fi" is the same page.
      const same = named.every((word) => said.includes(word)) || said.every((word) => named.includes(word));
      if (!same) evidence.push(`the screen's own heading reads "${heading}", not "${name}"`);
    }
  }
  const onScreen = phrases(tree, screen);
  // A screen the tree hardly describes -- a canvas, a picture -- says nothing
  // by leaving a phrase out.
  if (onScreen.length >= 3) {
    for (const text of claims.texts) {
      const wanted = words(text);
      if (wanted.length && !onScreen.some((phrase) => containsRun(phrase, wanted))) {
        evidence.push(`nothing on the screen reads "${text}"`);
      }
    }
  }
  return evidence;
}
