/**
 * Where thinking happens.
 *
 * The engine adapter drives the device; this decides what to do with a screen.
 * Keeping the two apart is what lets the tier ladder exist: the executor asks
 * for a point, and whether that point came from the cache, an 8B grounder or a
 * frontier planner is this module's business and nobody else's.
 *
 * W1 has one tier. The ladder arrives in W3 (cache) and W5 (local grounder),
 * and no call site changes when it does.
 */

import type {
  AimRequest,
  AimResult,
  AssertRequest,
  AssertResult,
  ExtractRequest,
  ExtractResult,
  GroundRequest,
  GroundResult,
  Observation,
  LastActionVerdict,
  PlanRequest,
  PlanResult,
  Point,
  PopupAnswer,
  PopupKind,
  PopupRequest,
  PopupResult,
  Rect,
  TreeNode,
  TreeSnapshot,
} from "@testsky/engine-core";

import { createHash } from "node:crypto";

import {
  type TreeTarget,
  STATUS_BAR_SHARE,
  aboutStatusBar,
  anchorAt,
  checkable,
  claimsIn,
  compactTree,
  controlAt,
  controlForBox,
  framePixels,
  isFlatHash,
  locateInTree,
  markPoint,
  patchHash,
  pointsAtNothing,
  treeEvidence,
} from "@testsky/perception";

import { askVision, gaveNoAnswer, ModelError, parseJsonAnswer } from "./client.ts";
import { calibrateConfidence } from "./confidence.ts";
import { allowedHosts, type ModelConfig, type RouterConfig } from "./config.ts";
import { CostLedger, type LedgerEntry } from "./ledger.ts";

/**
 * A model's answer, in device points.
 *
 * We ask for coordinates normalised to 0-1000 rather than pixels, for two
 * reasons. Models differ: Qwen-VL answers 0-1000 natively whatever the prompt
 * says, and reading that as pixels puts every tap in the top-left quadrant --
 * which is exactly the bug this replaced, caught by a doctor check whose
 * answer landed at (166, 276) when the target was at (60-300, 560-632). And
 * normalised coordinates take the device pixel ratio out of the conversation,
 * so a 2x phone and a 3x phone need no different handling anywhere.
 *
 * A coordinate above 1000 is a model that ignored the instruction and answered
 * in image pixels; converting those by the ratio means an honest answer in the
 * wrong unit still lands.
 */
export function modelPointToDevice(point: Point, size: { width: number; height: number }, pixelRatio: number): Point {
  if (point.x <= 1000 && point.y <= 1000) {
    return {
      x: Math.round((point.x / 1000) * size.width),
      y: Math.round((point.y / 1000) * size.height),
    };
  }
  return { x: Math.round(point.x / (pixelRatio || 1)), y: Math.round(point.y / (pixelRatio || 1)) };
}

/** The frame carries no usable image and no tree stood in for it. */
export class BlindScreenError extends Error {
  constructor(what: string) {
    super(
      `The screen captured blank (a secure screen, or a frame caught mid-render), ` +
        `so ${what} cannot be answered from pixels. Capture the accessibility tree for this step.`,
    );
    this.name = "BlindScreenError";
  }
}

const GROUND_SYSTEM =
  "You locate elements in screenshots of phone apps. You answer with JSON and nothing else. " +
  "You report only what is visible in the image; you never guess at an element that is not shown.";

/**
 * How a check's answer is asked for: what was seen first, the verdict after
 * it. Asked verdict-first, z-ai/glm-5.3-flash judged three screens false
 * while its own reason described each as the expectation says -- "The
 * About page displays the Model Name as iPhone SE and the iOS Version as
 * 27.0.1" -- a verdict decided before the looking, and explained after.
 */
const ASSERT_ANSWER = `\n\nAnswer exactly, the reason first and then the verdict it leads to:\n{"reason": "one short sentence, at most 25 words, naming what you saw", "pass": true|false}`;
/** What a pass that argues with itself is asked again with, after "Another model answered ...". */
const ASSERT_STRICT = ` and called this a pass. Judge it yourself, strictly: if the screen does not plainly satisfy the expectation as written, answer false.`;
const ASSERT_SAMPLING = { temperature: 0 } as const;
/** What an answer that was not usable JSON is asked again with, after the question. */
const JSON_NUDGE = "\n\nYour previous answer was not valid JSON. Answer with the JSON object only, and keep every string short.";

const JUDGE_SYSTEM =
  "You judge screenshots of phone apps against a written expectation. You answer with JSON and nothing else. " +
  "Judge only what is visible. Do not infer which company or product an app belongs to, and do not treat " +
  "unfamiliar branding, names or test data as evidence that something is wrong -- test accounts routinely " +
  "carry names that look unrelated to the app. " +
  // A judge that grades generously is worse than no judge: it reports a
  // working app while the app is broken, which is the one thing this tool
  // exists not to do. Seen in the wild, on this exact prompt: "The screen's
  // title is 'Ayarlar', but the list includes a row labelled 'Genel',
  // matching the expectation" -- a sentence that states the expectation was
  // false and then passes the step. And on Android, of a settings list: "one
  // item is titled 'Display & touch'", passing "the screen's title is
  // 'Display & touch'".
  "Judge the sentence exactly as written, not a charitable version of it. If the screen matches it only in " +
  "part, or matches something near it, the answer is false. If your own sentence would need \"but\", " +
  "\"however\" or \"although\" to explain the pass, the answer is false. A screen's title is the heading of " +
  "the screen itself; a row, a button or an item that carries the same words is not its title. " +
  // And of a page named without the word "title": on a Galaxy A53, "the Wi-Fi
  // page is open, showing <network>" was passed on the Connections page,
  // whose Wi-Fi row shows that network under it.
  "A page or screen the expectation names (\"the Wi-Fi page\", \"the General settings\") is open only when " +
  "the screen's own heading names it; a page that lists it, summarises it or shows its status in a row is " +
  "another page.";

/**
 * Where an action went, asked of the screen it was decided on. Never of where
 * it led: the question is the agent's aim, and a judge shown the outcome reads
 * a broken app as a wrong press -- which takes the blame off the app, the
 * mistake this tool must make least.
 */
const AIM_SYSTEM =
  "You check where a test agent pressed or typed on a phone screen, against the instruction it was given. " +
  "You answer with JSON and nothing else. Judge only what the screenshot shows and what the accessibility tree says.";
const AIM_ANSWER =
  `\n\nAnswer exactly, the reason first:\n{"reason": "one short sentence, at most 25 words, naming what the ring is on", "named": [x, y] | null, "onTarget": true|false}\n` +
  `- "named" is where the thing the instruction names is on this screen, normalised to 0-1000: (0,0) is the top-left ` +
  `corner, (1000,1000) the bottom-right. null when it is not on this screen.`;
/** Off target only when the thing named is this far from the ring, in points, where no tree tells controls apart: a fingertip and more. */
const AIM_APART = 44;

/** A pass whose own sentence argues with it. Both languages this runs in. */
const HEDGED = /\b(but|however|although|though|whereas|partly|partially)\b|\b(ancak|fakat|ama|yine de|kısmen)\b/i;

/**
 * What each action does, and what it takes.
 *
 * Without this the model guesses parameters, and its guesses are reasonable
 * and wrong: it read "swipe up" as "move further down the page" while the
 * runner read it as "go back towards the top", so the agent walked away from
 * what it was looking for three times in a row and called it progress.
 *
 * Kept beside the prompt rather than in the adapter because it is a prompt: it
 * must match `engine-midscene`'s action handling, and the pair is small enough
 * that a mismatch shows up on the first run.
 */
const ACTION_NOTES: Record<string, string> = {
  tap: 'tap {"describeTarget": "the element to tap"}',
  doubleTap: 'doubleTap {"describeTarget": "..."}',
  longPress: 'longPress {"describeTarget": "...", "params": {"duration": 800}}',
  input:
    'input {"describeTarget": "the field", "params": {"value": "the text to type"}} -- the field then holds exactly ' +
    'that text; add "append": true to the params only when the goal says to add to what is already there, and ' +
    '"submit": true when what is typed is to be sent -- a search, a message -- which presses Enter right after typing',
  clearInput: "clearInput -- empties the focused field",
  swipe:
    'swipe {"params": {"direction": "down"}} -- a quick flick: "down" moves FURTHER DOWN the page (content scrolls up), ' +
    '"up" goes back towards the top, "left"/"right" page sideways; it flings past what it passes, so use it to turn a page -- the next short, a carousel',
  scroll:
    'scroll {"params": {"direction": "down"}} -- the same directions, as a slow drag that moves the page by under half a screen and stops: ' +
    "use it to look through a list for something",
  keyPress: 'keyPress {"params": {"key": "Enter"}}',
  back: "back -- the Android back gesture",
  home: "home -- the launcher",
  recentApps: "recentApps -- the task switcher",
  openUrl: 'openUrl {"params": {"uri": "myapp://path"}} -- a deep link, which is how a test reaches a screen without walking there',
  push: 'push {"params": {"title": "...", "body": "..."}} -- delivers a notification to the app under test, then taps it',
  launchApp: 'launchApp {"params": {"app": "com.example"}}',
  terminateApp: 'terminateApp {"params": {"app": "com.example"}}',
  wait: 'wait {"params": {"ms": 1500}} -- when something is plainly still loading, or for exactly as long as the goal says: "ms" is the time, and without it this is one second',
};

/** A model's point this close to the tree's control is the same control: a fingertip's width. */
const AGREE_WITHIN = 8;

/** What a second look is told when the tree had no answer of its own to offer. */
const INSIST =
  `\n- Your first answer did not line up with any control. Look again, and prefer a point\n` +
  `  inside a control whose name matches the description.`;

/** The model looked and says the element is not on this screen -- as opposed to not answering at all. */
export class NotOnScreenError extends ModelError {
  constructor(message: string) {
    super(message);
    this.name = "NotOnScreenError";
  }
}

/** The model and the tree each found the element, in different places, and nothing was pressed. */
export class SourcesDisagreeError extends ModelError {
  constructor(message: string) {
    super(message);
    this.name = "SourcesDisagreeError";
  }
}

const grow = (rect: Rect, by: number): Rect => ({ x: rect.x - by, y: rect.y - by, width: rect.width + 2 * by, height: rect.height + 2 * by });
const insideBox = (point: Point, rect: Rect) =>
  point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
const clampInto = (point: Point, rect: Rect): Point => ({
  x: Math.min(Math.max(point.x, rect.x + 1), rect.x + rect.width - 1),
  y: Math.min(Math.max(point.y, rect.y + 1), rect.y + rect.height - 1),
});
const sameBox = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const near = (rect: Rect, point: Point, within: number) =>
  point.x >= rect.x - within &&
  point.x <= rect.x + rect.width + within &&
  point.y >= rect.y - within &&
  point.y <= rect.y + rect.height + within;

const centreOf = (rect: Rect): Point => ({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });

interface GroundAnswer {
  found?: boolean;
  point?: [number, number];
  box?: [number, number, number, number];
  why?: string;
}

interface AssertAnswer {
  pass?: boolean;
  reason?: string;
}

/**
 * A verdict the answer does not give is no verdict: read as false, it accuses
 * the app. z-ai/glm-5.3-flash on an fp4 host answered {"reason": "The Battery
 * page is open and displays the current charge level as 81%.", "pad": true}
 * fourteen times in one round, and fourteen runs failed FAIL_ASSERT.
 */
const noVerdict =
  (key: string) =>
  (answer: object): string | undefined =>
    typeof (answer as Record<string, unknown>)[key] === "boolean" ? undefined : `the answer gives no "${key}" verdict`;

interface AimAnswer {
  onTarget?: boolean;
  named?: [number, number] | null;
  reason?: string;
}

/**
 * The control under a point and what holds it, in the tree's words: `TextField
 * "Search" #q, in WebView "Google"`. A search box in a web page and the
 * browser's own address bar can look alike; what holds them does not. Only
 * what is drawn: a link behind a sheet is not what a ring on the sheet is on.
 */
function treeAround(tree: TreeSnapshot, point: Point, size: { width: number; height: number }): string | undefined {
  const hit = controlAt(tree, point, size);
  if (!hit) return undefined;
  const path: TreeNode[] = [];
  const walk = (node: TreeNode): boolean => {
    if (node === hit) return true;
    for (const child of node.children) {
      if (walk(child)) {
        path.push(node);
        return true;
      }
    }
    return false;
  };
  walk(tree.root);
  const words = (node: TreeNode) =>
    [node.role, node.label ? JSON.stringify(node.label.slice(0, 60)) : "", node.identifier ? `#${node.identifier.split("/").pop()}` : ""]
      .filter(Boolean)
      .join(" ");
  // The nearest holders that say something: a role of their own, or words.
  const holders = path.filter((node) => node !== tree.root && (node.label || /web|bar|toolbar|navigation|tab|sheet|dialog|alert/i.test(node.role))).slice(0, 2);
  return [words(hit), ...holders.map((node) => `in ${words(node)}`)].join(", ");
}

interface PopupAnswerJson {
  popup?: boolean;
  kind?: string;
  title?: string;
  button?: string;
  point?: [number, number];
  outside?: boolean;
}

/**
 * What each kind of pop-up looks like, in the words the model is shown.
 *
 * Keyed by the kind itself, so a kind added without a description is a type
 * error rather than a pop-up the model was never told about.
 */
const POPUP_LOOKS: Record<PopupKind, string> = {
  notifications: "a prompt asking to allow notifications",
  location: "a prompt asking for the device's location",
  camera: "a prompt asking for the camera, the microphone or the photo library",
  tracking: "iOS asking whether the app may track activity across other companies' apps",
  rating: "a request to rate or review the app",
  promo: "the app's own what's-new, offer or promotional sheet",
  account: "the phone's own system asking for its account's password (Apple Account Verification) -- never the app's own sign-in",
  cookies: "a cookie or consent banner",
  other: "any other dialog or sheet in the way -- never an error, a warning or a confirmation",
};

function pressFor(kind: PopupKind, answer: PopupAnswer): string {
  switch (answer) {
    case "allow":
      return kind === "cookies"
        ? "press the control that accepts"
        : "press the control that allows it -- the one for while the app is in use, if there is a choice";
    case "deny":
      return "press the control that declines (Don't Allow, Ask App Not to Track, Reject all)";
    case "dismiss":
      return (
        "press the control that closes it without accepting anything (Not now, Close, Cancel, or the X) -- " +
        "or, for a tip or callout pointing at something with none of these, tap empty background outside it, away from every control"
      );
    case "off":
      return "leave it";
  }
}

function isPopupKind(value: unknown): value is PopupKind {
  return typeof value === "string" && value in POPUP_LOOKS;
}

export class Router {
  /**
   * Which model answers a given question.
   *
   * Grounding -- "where is this element" -- is asked on every cache miss and
   * is the cheapest thing a model can be asked, so it goes to the cheap tier.
   * Judging an expectation and deciding what to do on an unexpected screen are
   * asked far less often and are worth a better model. With one tier
   * configured, everything goes there and the ladder is a no-op: the shape
   * costs nothing until somebody has two models.
   */
  private tierFor(purpose: LedgerEntry["purpose"] | "escalation"): { config: ModelConfig; tier: 1 | 2 } {
    const { ground, reason, escalation } = this.config.tiers;
    if (purpose === "ground") return { config: ground, tier: 1 };
    // The second look goes to the model kept for it, else to the one that
    // reasons, else to the one there is.
    if (purpose === "escalation" && escalation) return { config: escalation, tier: 2 };
    return reason ? { config: reason, tier: 2 } : { config: ground, tier: 1 };
  }

  /**
   * The offline promise, enforced rather than described.
   *
   * A security team can read this in five minutes; that is the point. With
   * `offline: true` the router refuses any host that is not one of the
   * configured endpoints, so "nothing leaves the building" is a property of
   * the code rather than a sentence in a PDF.
   */
  private assertAllowed(config: ModelConfig): void {
    if (!this.config.offline) return;
    const host = new URL(config.baseUrl).host;
    if (!allowedHosts(this.config).includes(host)) {
      throw new ModelError(`offline mode: ${host} is not one of the configured endpoints`);
    }
  }

  /**
   * Asks, and asks once more if the answer was not usable JSON.
   *
   * Models produce a broken object every few hundred calls -- a stray comma, a
   * sentence that ran past the token cap. One retry costs a fraction of a cent
   * and turns a failed run into a slightly slower one; without it, the run
   * dies and the customer sees our plumbing instead of their app.
   *
   * Broken twice is how a model writes that answer, not a slip -- Haiku quoted
   * a search term inside its reason both times -- and a third ask of it breaks
   * it a third time. The model kept for second looks, when it is another, is
   * asked instead.
   *
   * So too when a model gives no answer. askVision has already asked it twice,
   * and a third ask spends the whole wait again. Without this the run dies well
   * into the test: 5 of 18 YouTube runs in a lab comparison, about 7 minutes in or later.
   */
  private async askJson<T>(
    purpose: "ground" | "assert" | "extract" | "plan" | "popup",
    ask: Parameters<typeof askVision>[1],
    tier: 1 | 2,
    stepId?: string,
    override?: ModelConfig,
    /** What makes a parsed answer unusable, if anything: a verdict it does not give. */
    unreadable?: (parsed: T) => string | undefined,
  ): Promise<{ parsed: T; provenance: Awaited<ReturnType<typeof askVision>>["provenance"] }> {
    const config = override ?? this.tierFor(purpose).config;
    const second = this.tierFor("escalation");
    const attempts = [
      { config, ask, tier },
      { config, ask: { ...ask, user: `${ask.user}${JSON_NUDGE}` }, tier },
      ...(second.config.model !== config.model || second.config.baseUrl !== config.baseUrl ? [{ ...second, ask }] : []),
    ];
    let lastError: unknown;
    let silent: ModelConfig | undefined;
    for (const attempt of attempts) {
      if (attempt.config === silent) continue;
      this.assertAllowed(attempt.config);
      let answer: Awaited<ReturnType<typeof askVision>>;
      try {
        answer = await askVision(attempt.config, attempt.ask, attempt.tier);
      } catch (error) {
        if (!gaveNoAnswer(error)) throw error;
        lastError = error;
        silent = attempt.config;
        continue;
      }
      this.ledger.record(purpose, answer.provenance, stepId, answer.text);
      try {
        const parsed = parseJsonAnswer<T>(answer.text);
        const complaint = unreadable?.(parsed);
        if (complaint) throw new ModelError(`${complaint}: ${answer.text.slice(0, 200)}`);
        return { parsed, provenance: answer.provenance };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private readonly config: RouterConfig;
  readonly ledger: CostLedger;

  constructor(config: RouterConfig, ledger = new CostLedger()) {
    this.config = config;
    this.ledger = ledger;
  }

  /**
   * What the model gets to look at.
   *
   * A blind frame -- a secure screen, or one caught mid-render -- is never
   * sent: a model shown a black rectangle does not say it cannot see, it
   * describes a plausible screen. When the accessibility tree came along, the
   * question is answered from that instead, which is the whole reason the tree
   * is worth its two seconds. When neither is available, nothing is: refusing
   * is the only honest answer left.
   */
  private lookAt(
    observation: Observation,
    what: string,
    prefer?: "vision" | "tree",
  ): { image?: Buffer; tree?: string } {
    // Rendered on the same 0-1000 scale the picture is answered in, so the
    // prompt has exactly one coordinate space.
    const tree = observation.tree
      ? compactTree(observation.tree.root, { scaleTo: observation.frame.size }).text
      : undefined;
    // An author who asked for the tree gets the tree, and only the tree: the
    // point of asking is to be judged on what the system reports rather than
    // on what a picture looks like.
    if (prefer === "tree" && tree) return { tree };
    if (!observation.visionBlind) {
      const seen: { image?: Buffer; tree?: string } = { image: observation.frame.bytes };
      if (tree) seen.tree = tree;
      return seen;
    }
    if (tree) return { tree };
    throw new BlindScreenError(what);
  }

  /** What a question shows the model besides its words: the picture, and whether the words carry the tree. */
  private static shown(seen: { image?: Buffer; tree?: string }): { image?: Buffer; tree?: true } {
    return { ...(seen.image ? { image: seen.image } : {}), ...(seen.tree ? { tree: true as const } : {}) };
  }

  /** The tree lines, as a block the prompt can carry. */
  private static treeBlock(tree: string | undefined, treeOnly: boolean): string {
    if (!tree) return "";
    const preamble = treeOnly
      ? "There is no usable picture of this screen, so here is its accessibility tree instead.\n" +
        "Its coordinates are normalised to 0-1000, they are exact, and they are what you answer with."
      : "The screen's accessibility tree, for the elements the system exposes. Its names, text and values are exact,\n" +
        "such as how far a video has played. It also lists what is covered or hidden: what can be seen is the picture's to say.\n" +
        "Its coordinates are normalised to 0-1000, the same scale you answer in:";
    return `\n\n${preamble}\n${tree}\n`;
  }

  private toLogical(point: Point, observation: Observation): Point {
    return modelPointToDevice(point, observation.frame.size, observation.frame.pixelRatio || 1);
  }

  /**
   * What makes a remembered tap checkable later without a model: the node
   * that was under the point, as it looked when we learned it, and -- for the
   * screens with no tree, which is most of them on the happy path -- the
   * pixels around it.
   */
  private async anchorFor(observation: GroundRequest["observation"], point: GroundResult["point"]): Promise<GroundResult["anchor"]> {
    const anchor: GroundResult["anchor"] = {};
    if (!observation.visionBlind) {
      const patch = await patchHash(observation.frame.bytes, point, {
        size: observation.frame.size,
        pixelRatio: observation.frame.pixelRatio,
      });
      // A flat patch hashes to all zeros or all ones and would then match any
      // other flat patch on any screen. An anchor that verifies everything is
      // worse than no anchor at all: it turns the cache from an optimisation
      // into a way of tapping confidently in the wrong place.
      if (!isFlatHash(patch)) anchor.patchPhash = patch;
    }
    const control = observation.tree ? anchorAt(observation.tree, point) : undefined;
    if (control) anchor.tree = control;
    return anchor;
  }

  async ground(req: GroundRequest, stepId?: string): Promise<GroundResult> {
    // Two sources, both asked. The tree's own answer -- one pressable control
    // by that name, on the screen, nothing over it -- is exact; the model sees
    // what the tree cannot (pictures, canvas, a keyboard, an overlay), with the
    // tree beside the picture. A target is pressed when they agree on the
    // control, and then where the tree measures it. One alone decides only
    // when the other has nothing to go on: the tree when there is no picture
    // to look at, the model when the tree names nothing. A model that looks
    // and says the element is not there outranks the tree: something the tree
    // does not show is over it. A model that cannot be asked is not a model
    // that looked, and the run is not quietly left to the tree: it fails, as
    // the tooling it is. Disagreeing, the model is asked again,
    // told where the tree's control is, and if they still disagree nothing is
    // pressed -- the step is told both and plans again. An author who asked
    // for the picture gets the picture.
    const started = Date.now();
    const tree = req.hint?.preferChannel === "vision" ? undefined : req.observation.tree;
    const size = req.observation.frame.size;
    const opinion = tree ? locateInTree(tree, req.description, size) : undefined;
    const named = opinion?.target;

    const seen = this.lookAt(req.observation, `"${req.description}"`, req.hint?.preferChannel);
    const treeBlock = Router.treeBlock(seen.tree, !seen.image);

    const ask = (insist: boolean) => ({
      system: GROUND_SYSTEM,
      user:
        `Find this element in the ${seen.image ? "screenshot" : "accessibility tree"}: "${req.description}".` +
        treeBlock +
        `\n\nAnswer exactly:\n` +
        `{"found": true|false, "point": [x, y], "box": [x1, y1, x2, y2], "why": "one short sentence"}\n` +
        `- Coordinates are normalised to 0-1000: (0,0) is the top-left corner of the screen,\n` +
        `  (1000,1000) the bottom-right. "point" is the centre of the element.\n` +
        `- Set "found" to false if the element is not on this screen. Do not invent a point.` +
        (insist ? (named ? Router.treeSays(named, req.observation) : INSIST) : ""),
      ...Router.shown(seen),
      temperature: insist ? 0.3 : 0,
    });

    const read = async (insist: boolean, tier: 1 | 2) => {
      // The escalation deliberately does not go to the same model again: if
      // there is a better one configured, this is what it is for.
      const override = insist ? this.tierFor("escalation").config : undefined;
      const { parsed, provenance } = await this.askJson<GroundAnswer>(
        "ground",
        ask(insist),
        tier,
        stepId,
        override,
      );
      if (parsed.found === false || !Array.isArray(parsed.point) || parsed.point.length < 2) {
        throw new NotOnScreenError(
          `could not find "${req.description}" on this screen` + (parsed.why ? ` -- ${parsed.why}` : ""),
        );
      }
      const [px, py] = parsed.point;
      const point = this.toLogical({ x: px ?? 0, y: py ?? 0 }, req.observation);
      return { parsed, provenance, point, box: this.boxOf(parsed.box, req.observation) };
    };
    type Answer = Awaited<ReturnType<typeof read>>;
    const said = (answer: Answer) => (typeof answer.parsed.why === "string" ? answer.parsed.why.trim().slice(0, 200) : "");

    // Agreeing is being on the same control: the one the model's point is on,
    // or, on no control at all, within a fingertip of the tree's. A control at
    // the very spot the tree would press is the one it named: a press there
    // lands on it. A switch inside the row the tree named is another control,
    // and so is a disagreement about which one is meant.
    const agrees = (answer: Answer): boolean => {
      if (!named || !tree) return false;
      const under = controlAt(tree, answer.point, size) ?? (answer.box ? controlForBox(tree, answer.box, size) : undefined);
      if (!under) return near(named.rect, answer.point, AGREE_WITHIN);
      if (sameBox(under.bounds, named.rect)) return true;
      const pressed = controlAt(tree, named.point, size);
      return pressed !== undefined && sameBox(under.bounds, pressed.bounds);
    };

    // The tree's control, believed. Where it is pressed: its centre, which the
    // tree measures exactly -- unless the model's box, around what it can
    // see of it, leaves the centre out, as when the control runs under a
    // system bar; then the model's point, on the part that shows.
    const fromTree = async (answer: Answer | undefined, because: string): Promise<GroundResult> => {
      const box = answer?.box ? grow(answer.box, AGREE_WITHIN) : undefined;
      const point = !answer || !box || insideBox(named!.point, box) ? named!.point : clampInto(answer.point, named!.rect);
      return {
        point,
        rect: named!.rect,
        confidence: calibrateConfidence({ point, description: req.description, tree: tree! }),
        anchor: await this.anchorFor(req.observation, point),
        why: answer && said(answer) ? `${said(answer)}; ${because}` : because,
        provenance: answer
          ? answer.provenance
          : { tier: 0, usd: 0, latencyMs: Date.now() - started, usedTree: true, channel: "tree" },
        foundBy: answer ? "both" : "tree",
      };
    };

    let best: Answer;
    try {
      best = await read(false, 1);
    } catch (error) {
      // With no picture the model read only the tree, which the tree has
      // already read exactly: its name stands. With a picture, a model that
      // found nothing outranks it, and one that could not answer fails the run.
      if (named && !seen.image && error instanceof NotOnScreenError) {
        return fromTree(undefined, `${opinion!.reason}; the model, reading the tree, found nothing (${error.message})`);
      }
      throw error;
    }

    if (named) {
      if (agrees(best)) return fromTree(best, `the tree agrees: ${opinion!.reason}`);
      // One of them is wrong. Asked again, told where the tree's control is,
      // the model comes round to it, or finds the element is not on the
      // screen at all -- something is over the tree's control.
      if (req.budget.maxEscalations > 0) {
        let second: Answer | undefined;
        try {
          second = await read(true, 2);
        } catch (error) {
          if (error instanceof NotOnScreenError) throw error;
        }
        if (second && agrees(second)) return fromTree(second, `the tree agrees: ${opinion!.reason}`);
        if (second) best = second;
      }
      // Still two answers, or no budget to ask again: a tap on either would
      // be a guess. Nothing is pressed; the step is told both and plans again.
      const label = named.node.label ?? named.node.identifier ?? named.node.role;
      const { x, y, width, height } = named.rect;
      throw new SourcesDisagreeError(
        `the model and the tree disagree about "${req.description}" -- the tree's ${named.node.role} "${label}" is at ` +
          `(${x},${y} ${width}x${height}), the model points at (${best.point.x},${best.point.y})` +
          (said(best) ? `: ${said(best)}` : "") +
          "; nothing was pressed",
      );
    }

    // The tree names nothing by itself. It still disagrees with a model that
    // points at none of its controls -- worth a second look when there is
    // budget for one -- and it still measures what the model chose.
    if (tree && req.budget.maxEscalations > 0 && pointsAtNothing(tree, best.point, size)) {
      try {
        best = await read(true, 2);
      } catch (error) {
        if (error instanceof NotOnScreenError) throw error;
      }
    }
    return this.fromModel(req, best, seen.image !== undefined, tree);
  }

  /** A model's answer as a result: its point, or the tree's measure of the control its box is the box of. */
  private async fromModel(
    req: GroundRequest,
    answer: { parsed: GroundAnswer; provenance: GroundResult["provenance"]; point: Point; box?: Rect },
    pictured: boolean,
    measureWith: TreeSnapshot | undefined,
  ): Promise<GroundResult> {
    const control = measureWith && answer.box ? controlForBox(measureWith, answer.box, req.observation.frame.size) : undefined;
    const point = control ? centreOf(control.bounds) : answer.point;
    const confidence = calibrateConfidence({
      point,
      description: req.description,
      ...(req.observation.tree ? { tree: req.observation.tree } : {}),
    });
    const said = typeof answer.parsed.why === "string" ? answer.parsed.why.trim().slice(0, 200) : "";
    const why = control ? `${said || "the model chose it"}; the tree measures it: ${control.role}${control.label ? ` "${control.label}"` : ""}` : said;
    const result: GroundResult = {
      point,
      confidence,
      anchor: await this.anchorFor(req.observation, point),
      provenance: answer.provenance,
      foundBy: control ? "both" : "model",
    };
    // The box drawn on the report: the control's, measured, or the model's,
    // when it drew one on a picture.
    if (control) result.rect = control.bounds;
    else if (answer.box && pictured) result.rect = answer.box;
    if (why) result.why = why;
    return result;
  }

  /** A model's 0-1000 box, in device points. */
  private boxOf(box: unknown, observation: Observation): Rect | undefined {
    if (!Array.isArray(box) || box.length !== 4 || !box.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
    const [x1, y1, x2, y2] = box as [number, number, number, number];
    const topLeft = this.toLogical({ x: x1, y: y1 }, observation);
    const bottomRight = this.toLogical({ x: x2, y: y2 }, observation);
    return { x: topLeft.x, y: topLeft.y, width: Math.max(0, bottomRight.x - topLeft.x), height: Math.max(0, bottomRight.y - topLeft.y) };
  }

  /** What a second look is told about the tree's own answer, on the prompt's 0-1000 scale. */
  private static treeSays(named: TreeTarget, observation: Observation): string {
    const { width, height } = observation.frame.size;
    const scaled = [
      (named.rect.x / width) * 1000,
      (named.rect.y / height) * 1000,
      ((named.rect.x + named.rect.width) / width) * 1000,
      ((named.rect.y + named.rect.height) / height) * 1000,
    ].map((n) => Math.round(n));
    const name = named.node.label ?? named.node.identifier ?? named.node.role;
    return (
      `\n- The accessibility tree has exactly one control called "${name}", at box [${scaled.join(", ")}],\n` +
      `  and your first answer was somewhere else. Look again: if that control is the element, answer with it;\n` +
      `  if it is covered, hidden or a different thing, answer where the element really is, or found: false.`
    );
  }

  /**
   * An assertion as a model would be asked it, as a print: the instructions,
   * the model, the expectation, the tree lines and the picture -- exactly what
   * `assert` puts to it, built by the same code. Equal prints are the same
   * question on the same input, and a model shown it again would answer as it
   * did; a new model or new instructions are a new question. A frame with no
   * usable picture has no print: an answer from its tree alone is not kept.
   *
   * All but the status bar: its clock made every minute a new question, and
   * of 806 end-of-step frames in the 500-run campaign a remembered answer could
   * have met 30; without it, 192. Only on a phone held upright, where it was
   * measured -- turned, an iPhone hides it, and a tablet's is thinner than the
   * share -- and not for an expectation about what it shows: the time, a
   * connection, a call.
   */
  async judgePrint(req: AssertRequest): Promise<string | undefined> {
    if (req.observation.visionBlind) return undefined;
    const seen = this.lookAt(req.observation, `"${req.assertion}"`, req.channel);
    // Everything about how a check is put that is not this screen: the
    // instructions, how the answer is asked for, how a hedged pass is asked
    // again and when, how an unreadable answer is asked again, the sampling,
    // and both models that may answer.
    const judge = this.tierFor("assert").config;
    const strict = this.tierFor("escalation").config;
    const hash = createHash("sha256")
      .update([JUDGE_SYSTEM, ASSERT_ANSWER, ASSERT_STRICT, HEDGED.source, JSON_NUDGE, JSON.stringify(ASSERT_SAMPLING)].join("\n"))
      .update(`\n${judge.baseUrl}\n${judge.model}\n${strict.baseUrl}\n${strict.model}\n`)
      .update(`Expectation: "${req.assertion}"${Router.treeBlock(seen.tree, !seen.image)}\n`);
    if (seen.image) {
      // Upright and phone-shaped: an iPhone SE is 1.78 times as tall as wide, a tablet 1.6 at most.
      const { width, height } = req.observation.frame.size;
      const leftOut = height >= 1.7 * width && !aboutStatusBar(req.assertion);
      const pixels = await framePixels(seen.image, leftOut ? STATUS_BAR_SHARE : 0);
      if (!pixels) return undefined;
      hash.update(pixels);
    }
    return hash.digest("hex").slice(0, 32);
  }

  async assert(req: AssertRequest, stepId?: string): Promise<AssertResult> {
    const seen = this.lookAt(req.observation, `"${req.assertion}"`, req.channel);
    const claims = claimsIn(req.assertion);
    // Which way up a screen is no picture shows reliably -- a judge called a
    // landscape frame portrait on a Galaxy A53 -- and the frame's size says
    // exactly. Told, not guessed.
    const { width, height } = req.observation.frame.size;
    const facts = claims.orientation
      ? `\n\nA fact the picture may not make plain: the screen is ${width} by ${height} points, so it is in ` +
        `${width > height ? "landscape" : "portrait"}.`
      : "";
    const { parsed, provenance } = await this.askJson<AssertAnswer>(
      "assert",
      {
        system: JUDGE_SYSTEM,
        user: `Expectation: "${req.assertion}"` + Router.treeBlock(seen.tree, !seen.image) + facts + ASSERT_ANSWER,
        ...Router.shown(seen),
        ...ASSERT_SAMPLING,
      },
      this.tierFor("assert").tier,
      stepId,
      undefined,
      noVerdict("pass"),
    );
    let result: AssertResult = {
      pass: parsed.pass === true,
      reason: parsed.reason ?? (parsed.pass === true ? "the expectation held" : "the expectation did not hold"),
      provenance,
    };

    // A pass that argues with itself is not a pass yet, and neither is one
    // the tree disagrees with -- a heading that names another page, a quoted
    // phrase that is nowhere on the screen. Rather than overrule the model --
    // a wrong "false" here accuses the app of being broken, the most expensive
    // mistake this tool can make, and the tree can be wrong about headings --
    // the question is asked again, once, at the best tier available, with the
    // hedge quoted back and what the tree says. It costs a call only on the
    // judgements that were already suspect.
    const tree = req.observation.tree ?? req.evidenceTree;
    const evidence = result.pass && tree && checkable(claims) ? treeEvidence(tree, claims, req.observation.frame.size) : [];
    if (result.pass && (HEDGED.test(result.reason) || evidence.length)) {
      const told = evidence.length
        ? ` The screen's accessibility tree, read from the same screen, says: ${evidence.join("; ")}.`
        : "";
      const strict = await this.askJson<AssertAnswer>(
        "assert",
        {
          system: JUDGE_SYSTEM,
          user:
            `Expectation: "${req.assertion}"` +
            Router.treeBlock(seen.tree, !seen.image) +
            facts +
            `\n\nAnother model answered "${result.reason}"${ASSERT_STRICT}${told}` +
            ASSERT_ANSWER,
          ...Router.shown(seen),
          ...ASSERT_SAMPLING,
        },
        this.tierFor("escalation").tier,
        stepId,
        this.tierFor("escalation").config,
        noVerdict("pass"),
      );
      result = {
        pass: strict.parsed.pass === true,
        reason: strict.parsed.reason ?? result.reason,
        provenance: strict.provenance,
        ...(evidence.length ? { evidence } : {}),
      };
    }

    if (req.probeNegation) {
      const negated = await this.askJson<AssertAnswer>(
        "assert",
        {
          system: JUDGE_SYSTEM,
          user:
            `Expectation: "it is NOT true that ${req.assertion}"` +
            Router.treeBlock(seen.tree, !seen.image) +
            `\n\nAnswer exactly, the reason first:\n{"reason": "one short sentence", "pass": true|false}`,
          ...Router.shown(seen),
          temperature: 0,
        },
        this.tierFor("assert").tier,
        stepId,
        undefined,
        noVerdict("pass"),
      );
      result.negationPass = negated.parsed.pass === true;
    }
    return result;
  }

  /**
   * Whether an action went to what its step names, on the screen it was
   * decided on, with a ring where it went. "Not on target" takes the blame off
   * an app for an expectation that did not hold, so it is not taken on a
   * model's word alone: the model has to show where the thing the step names
   * is on that screen, and it has to be another control than the one under
   * the ring -- or, with no tree to tell, another place. A second model, where
   * one is kept for second looks, has to say so too before the answer is
   * called confirmed.
   */
  async aim(req: AimRequest, stepId?: string): Promise<AimResult> {
    if (req.observation.visionBlind) throw new BlindScreenError("where the action went");
    const size = req.observation.frame.size;
    const image = await markPoint(req.observation.frame.bytes, req.point, size);
    const tree = req.observation.tree;
    const around = tree ? treeAround(tree, req.point, size) : undefined;
    const did =
      req.action === "input"
        ? `typed${req.text !== undefined ? ` ${JSON.stringify(req.text)}` : ""} into`
        : req.action === "longPress"
          ? "long-pressed"
          : req.action === "doubleTap"
            ? "double-tapped"
            : "tapped";
    const user =
      `An agent testing a phone app was told: "${req.instruction}".\n` +
      `On this screen, taken just before it acted, it ${did} ${req.meant ? `what it called "${req.meant}"` : "something"}, at the red ring.` +
      (around ? `\nThe screen's accessibility tree says the ring is on: ${around}.` : "") +
      `\n\nIs the ring on the thing the instruction tells the agent to act on, or on a control the instruction plainly ` +
      `needs on the way to it (a tab, a menu, a field that has to be opened first, or a dialog, alert or tip in the way that ` +
      `has to be closed)? Judge only where the ring is: what ` +
      `happened afterwards is not shown and is not the question. Answer false only when the ring is plainly on a ` +
      `different thing than the one the instruction names AND you can see that thing elsewhere on this screen -- for ` +
      `example, the instruction names the browser's own address bar, the ring is on a search box inside the web page, ` +
      `and the address bar is at the bottom. When the instruction names nothing to press or type into, when what it ` +
      `names is not on this screen, or when you cannot tell, answer true.` +
      AIM_ANSWER;
    const reasonOf = (answer: AimAnswer, fallback: string) => (typeof answer.reason === "string" && answer.reason.trim() ? answer.reason.trim() : fallback);
    // Off target only with the named thing seen, and not where the ring is.
    const elsewhere = (answer: AimAnswer): boolean => {
      if (answer.onTarget !== false || !Array.isArray(answer.named) || answer.named.length < 2) return false;
      const [nx, ny] = answer.named;
      if (typeof nx !== "number" || typeof ny !== "number" || !Number.isFinite(nx) || !Number.isFinite(ny)) return false;
      const named = this.toLogical({ x: nx, y: ny }, req.observation);
      // With a tree, the named thing is a control, and not the one under the ring.
      if (tree) {
        const namedOn = controlAt(tree, named, size);
        return namedOn !== undefined && namedOn !== controlAt(tree, req.point, size);
      }
      return Math.hypot(named.x - req.point.x, named.y - req.point.y) > AIM_APART;
    };
    const ask = (config?: ModelConfig, tier: 1 | 2 = this.tierFor("assert").tier) =>
      this.askJson<AimAnswer>("assert", { system: AIM_SYSTEM, user, image, temperature: 0 }, tier, stepId, config, noVerdict("onTarget"));

    const first = await ask();
    if (!elsewhere(first.parsed)) {
      const said = reasonOf(first.parsed, "the action went to what the step names");
      return {
        onTarget: true,
        reason: first.parsed.onTarget === false ? `${said} (not counted: the thing the step names was not shown elsewhere on that screen)` : said,
        provenance: first.provenance,
      };
    }
    const judge = this.tierFor("assert").config;
    const strict = this.tierFor("escalation");
    // One model saying it twice is still one model's word: with no other one
    // kept, or when the judge's answer could not be read and the one kept for
    // second looks gave the first.
    if ((strict.config.baseUrl === judge.baseUrl && strict.config.model === judge.model) || first.provenance.model === strict.config.model) {
      return { onTarget: false, reason: reasonOf(first.parsed, "the action went somewhere the step does not name"), provenance: first.provenance };
    }
    const second = await ask(strict.config, strict.tier);
    return elsewhere(second.parsed)
      ? { onTarget: false, reason: reasonOf(second.parsed, reasonOf(first.parsed, "the action went somewhere the step does not name")), confirmed: true, provenance: second.provenance }
      : { onTarget: true, reason: `${reasonOf(second.parsed, "a second look found it on target")} (a first look said: ${reasonOf(first.parsed, "off target")})`, provenance: second.provenance };
  }

  async extract<T = Record<string, unknown>>(req: ExtractRequest, stepId?: string): Promise<ExtractResult<T>> {
    const seen = this.lookAt(req.observation, "the values to extract", req.channel);
    const fields = Object.entries(req.schema)
      .map(([name, description]) => `  "${name}": ${description}`)
      .join("\n");
    const { parsed, provenance } = await this.askJson<{ data?: T }>(
      "extract",
      {
        system: JUDGE_SYSTEM,
        user:
          `Read these values off the screen:\n${fields}` +
          Router.treeBlock(seen.tree, !seen.image) +
          `\n\n` +
          `Answer exactly:\n{"data": { ... one key per field above ... }}\n` +
          `Use null for a field that is not visible. Do not guess.`,
        ...Router.shown(seen),
        temperature: 0,
      },
      this.tierFor("extract").tier,
      stepId,
    );
    return { data: parsed.data ?? ({} as T), provenance };
  }

  /**
   * Whether something is in the way, and what to press to get it out of it.
   *
   * One question rather than two: which kind of pop-up this is and where its
   * answer is are read off the same picture, and asking them apart doubles the
   * cost of the moment a run can least afford it -- a prompt that turned up in
   * the middle of a step that was otherwise replaying for free.
   */
  async popup(req: PopupRequest, stepId?: string): Promise<PopupResult> {
    const seen = this.lookAt(req.observation, "whether a pop-up is in the way");
    const kinds = (Object.keys(POPUP_LOOKS) as PopupKind[])
      .map((kind) => `  ${kind} -- ${POPUP_LOOKS[kind]}: ${pressFor(kind, req.rules[kind])}`)
      .join("\n");
    const { parsed, provenance } = await this.askJson<PopupAnswerJson>(
      "popup",
      {
        system: GROUND_SYSTEM,
        user:
          (req.goal ? `The test is trying to: ${req.goal}\n\n` : "") +
          (req.hint
            ? `Another look reported ${req.hint.kind === "other" ? "a pop-up" : `a ${req.hint.kind} pop-up`}${req.hint.title ? ` ("${req.hint.title}")` : ""}. Check it.\n\n`
            : "") +
          `Is the app covered by something that has to be answered or closed before the test can carry on, ` +
          `and that is not part of what the test is trying to do? A screen the test itself leads to is not in the way. ` +
          // An advert on YouTube's feed drew "Last warning: Cancel / Update" in its video. Pressing
          // "Cancel" opened the App Store, over and over, until the step ran out of actions.
          `A dialog or warning drawn inside a video, an advert or a card of a feed is part of that picture and covers nothing. ` +
          // Closing the app's own answer is how a failure turns into a pass:
          // "Payment failed [OK]", pressed, is a screen with no error on it.
          `Nor is an error, a warning, a confirmation of what the test just did, or the system saying the app ` +
          `stopped or is not responding: that is the app's answer to the test, and it is left alone.\n\n` +
          `If it is, say which of these it is, and where to press:\n${kinds}` +
          Router.treeBlock(seen.tree, !seen.image) +
          `\n\nAnswer exactly:\n` +
          `{"popup": true|false, "kind": "one of the kinds above", "title": "its own words, at most 12", "button": "the label you would press", "point": [x, y], "outside": true|false}\n` +
          `- "outside" is true when the point is empty background outside a tip, not one of its controls.\n` +
          `- Coordinates are normalised to 0-1000: (0,0) is the top-left corner of the screen, (1000,1000) the bottom-right.\n` +
          `- For a kind marked "leave it", or when nothing on it does what is asked, leave out "button" and "point".\n` +
          `- If nothing is in the way, answer {"popup": false}.`,
        ...Router.shown(seen),
        temperature: 0,
      },
      this.tierFor("popup").tier,
      stepId,
    );
    if (parsed.popup !== true) return { found: false, provenance };
    const kind = isPopupKind(parsed.kind) ? parsed.kind : "other";
    const result: PopupResult = { found: true, kind, provenance };
    if (typeof parsed.title === "string" && parsed.title.trim()) result.title = parsed.title.trim();
    // The rule is the executor's to keep, and it is kept here too: a model
    // that points at "Allow" on a kind marked "leave it" is not pressed.
    if (req.rules[kind] !== "off" && Array.isArray(parsed.point) && parsed.point.length >= 2) {
      const [px, py] = parsed.point;
      result.press = {
        label: typeof parsed.button === "string" ? parsed.button.trim() : "",
        point: this.toLogical({ x: px ?? 0, y: py ?? 0 }, req.observation),
        ...(parsed.outside === true ? { outside: true } : {}),
      };
    }
    return result;
  }

  async plan(req: PlanRequest, stepId?: string): Promise<PlanResult> {
    const seen = this.lookAt(req.observation, "what to do next");
    const history = req.history.length
      ? req.history
          .map(
            (entry, i) =>
              `  ${i + 1}. ${entry.action} ${entry.description}${entry.expected ? `, expecting: ${entry.expected}` : ""} -> ${entry.outcome}`,
          )
          .join("\n")
      : "  (nothing yet)";
    // What the step has established, said back to it: what done means, in
    // its own words from its first turn, and how far it has got. Without the
    // count, the fourth turn of "forget every saved network" reads exactly
    // like the first.
    const established = [
      ...(req.ledger?.doneWhen ? [`The goal is done when: ${req.ledger.doneWhen}`] : []),
      ...(req.ledger?.progress ? [`Progress so far: ${req.ledger.progress}`] : []),
    ];
    const ledger = established.length ? `\n\n${established.join("\n")}` : "";
    // The test before the step: what the steps before it did to the screen is
    // why it looks as it does now. Never what comes after it -- see Journey.
    const journey = req.journey
      ? `This goal is one step of a test, "${req.journey.test}".\n` +
        `Steps already done, in order:\n${
          req.journey.done.length ? req.journey.done.map((line, i) => `  ${i + 1}. ${line}`).join("\n") : "  (none -- this is the first)"
        }\n` +
        `What those steps did is why the screen looks as it does now.\n\n`
      : "";
    const { parsed, provenance } = await this.askJson<PlanResult>(
      "plan",
      {
        system: GROUND_SYSTEM,
        user:
          `${journey}Goal: ${req.goal}\n\nWhat has happened so far:\n${history}` +
          ledger +
          Router.treeBlock(seen.tree, !seen.image) +
          `\n\n` +
          `Actions you may use:\n` +
          req.actionSpace.map((name) => `  ${ACTION_NOTES[name] ?? name}`).join("\n") +
          `\n\n` +
          `Answer exactly:\n` +
          `{${req.understand ? `"doneWhen": "at most 15 words, or null", ` : ""}"last": "as expected|something else|nothing", ` +
          `"actions": [{"name": "tap", "describeTarget": "the Submit button", "effect": "at most 12 words"}], ` +
          `"done": false, "progress": "at most 15 words", "reasoning": "at most 12 words"}\n` +
          (req.understand
            ? `- "doneWhen": what the screen will show once the goal is done -- a lasting state you can see, not an\n` +
              `  action. Say what is there rather than what is not, in the screen's own language, and name the page by\n` +
              `  its title. Quote only words you can see on this screen or that the goal itself quotes. null if no screen\n` +
              `  would show it.\n`
            : "") +
          `- "last": whether the last action in "What has happened so far" did what it was expected to, judged on\n` +
          `  this screen: "as expected", "something else" or "nothing". Leave it out when nothing has happened yet.\n` +
          `- "effect": what the screen will show once your action is carried out.\n` +
          `- "progress": what of the goal is done and what is left. When the goal is about each or all of\n` +
          `  several things, count them: "2 of 5 networks forgotten, 3 left".\n` +
          `- Return exactly one action. Only the first is carried out.\n` +
          `- Do what the goal says, to the letter, and nothing it does not ask for.\n` +
          `- A sign-in page is not yours to get past unless the goal says to sign in: pick no saved account, accept\n` +
          `  no saved password and type nothing. Answer with no actions: a person has to sign this phone in.\n` +
          `- A dialog or warning drawn inside a video, an advert or a card of a feed is part of that picture, not of\n` +
          `  the app: leave its buttons alone and go on as if it were not there.\n` +
          `- Name a target in the goal's own words. A name the goal puts in quotes is the element's name:\n` +
          `  copy it exactly, quotes and all, into "describeTarget".\n` +
          `- Type exactly the text the goal gives, character for character: no change to its case, spelling,\n` +
          `  spacing or punctuation.\n` +
          `- A password field's value in the tree, dots such as "••••••••", is what was typed into it, one dot a\n` +
          `  character: it is filled, and typing again only replaces it. A picture of a phone typing a password may\n` +
          `  show neither the dots nor the keyboard; the tree is the one to believe.\n` +
          `- Do not undo what you just did, and do not repeat an action that changed nothing.\n` +
          `- A swipe that changed nothing has reached the end of the page that way: to go on, swipe the other way.\n` +
          `- "describeTarget" only for tap, doubleTap, longPress and input; leave it out otherwise.\n` +
          `- Set "done" to true only when the goal is already satisfied on this screen. A goal about each or all of\n` +
          `  several things is done only when none of them is left.` +
          (req.popups
            ? `\n- If a pop-up that has nothing to do with the goal covers the app -- a permission prompt, a request ` +
              `to rate the app, a what's-new or promotional sheet, a cookie banner -- do not act on it. Answer ` +
              `{"actions": [], "done": false, "popup": {"kind": "notifications|location|camera|tracking|rating|promo|cookies|other", "title": "its own words"}} ` +
              `and it will be answered for you. An error, a warning, or a message about what was just done is not ` +
              `a pop-up: never name one.`
            : ""),
        ...Router.shown(seen),
        temperature: 0.2,
      },
      this.tierFor("plan").tier,
      stepId,
    );
    // Only a pop-up with one of the kinds is one. A model echoing the answer
    // template -- `"popup": {}`, or the list of kinds as the kind -- has named
    // nothing, and taking it at its word stops the step for a pop-up that is
    // not there.
    const said = parsed.popup as { kind?: unknown; title?: unknown } | undefined;
    const popup =
      req.popups && said && typeof said === "object" && isPopupKind(said.kind)
        ? {
            kind: said.kind,
            ...(typeof said.title === "string" && said.title.trim() ? { title: said.title.trim() } : {}),
          }
        : undefined;
    // The ledger's words are the model's, and go back into its prompt: kept
    // short, and only as text, so an answer that echoes the template or
    // nests an object adds nothing.
    const words = (value: unknown, max = 200): string | undefined => {
      if (typeof value !== "string") return undefined;
      const text = value.trim().replace(/\s+/g, " ");
      return text && text.toLowerCase() !== "null" ? text.slice(0, max) : undefined;
    };
    const actions = (Array.isArray(parsed.actions) ? parsed.actions : []).map((action) => {
      const effect = words((action as { effect?: unknown }).effect);
      const { effect: _said, ...rest } = action as PlanResult["actions"][number];
      return { ...rest, ...(effect ? { effect } : {}) };
    });
    const last = LAST_VERDICTS.find((verdict) => verdict === parsed.last);
    const doneWhen = req.understand ? words(parsed.doneWhen) : undefined;
    const progress = words(parsed.progress);
    return {
      actions,
      done: parsed.done === true,
      ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
      ...(popup ? { popup } : {}),
      ...(doneWhen ? { doneWhen } : {}),
      ...(progress ? { progress } : {}),
      ...(last ? { last } : {}),
      provenance,
    };
  }
}

/** What an agent may say its last action did. */
const LAST_VERDICTS: readonly LastActionVerdict[] = ["as expected", "something else", "nothing"];
