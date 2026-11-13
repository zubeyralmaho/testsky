/**
 * Pop-ups: found, answered the way the rules say, and kept out of the step.
 *
 * A permission prompt, a rating sheet, a what's-new card -- they turn up at
 * random, and a scripted test that meets one fails for a reason that has
 * nothing to do with the app. The agent would cope with one on its own, and
 * that is the trouble: its answer would be whatever it thought of, filed into
 * the step's memory as if the step needed it, and replayed on the next run at
 * a spot where, this time, there is no pop-up.
 *
 * So a pop-up is not part of the step. It is answered by a rule somebody
 * chose, the tap is never remembered, and the report shows it with the screen
 * it was answered on. It is never a heal and never a reason to fail.
 */

import type { Engine, Observation, Point, PopupKind, PopupRules, Rect } from "@testsky/engine-core";
import { pressableAt, readSystemPrompt } from "@testsky/perception";

/** The kinds, as a sentence in a report would name them. */
export const POPUP_NAMES: Record<PopupKind, string> = {
  notifications: "a notification prompt",
  location: "a location prompt",
  camera: "a camera or photos prompt",
  tracking: "a tracking prompt",
  rating: "a rating request",
  promo: "a what's-new or promo sheet",
  account: "the phone's own account asking for its password",
  cookies: "a cookie banner",
  other: "a pop-up",
};

export interface FoundPopup {
  kind: PopupKind;
  title?: string;
  /** Absent when the rules leave it to the test, or nothing on screen answers it. */
  press?: { label: string; point: Point; outside?: boolean };
  /** How it was recognised: from the tree, for free, or by looking. */
  by: "tree" | "vision";
}

/**
 * Words that make a dialog the app's answer rather than something in its way.
 *
 * The model is told an error is never a pop-up, and this is the belt to that
 * brace: whatever kind it gives a dialog titled "Payment failed", nothing on
 * it is pressed, because closing it turns a failure into a pass.
 */
const APP_ANSWER =
  /\b(error|fail(ed|ure)?|couldn['’]?t|could not|cannot|can['’]?t|unable|not responding|isn['’]?t responding|stopped)\b|hata|başarısız|yapılamadı|yanıt vermiyor|durdu/i;

const centre = (bounds: Rect): Point => ({
  x: Math.round(bounds.x + bounds.width / 2),
  y: Math.round(bounds.y + bounds.height / 2),
});

/**
 * Whether a pop-up is in the way, and what answers it.
 *
 * The tree is read first because it is free, and the pop-ups a run meets most
 * -- the system's permission prompts, on first launch -- name themselves there.
 * Everything else is found the way a person finds it, by looking, which costs a
 * model call and so happens only when the caller says the moment is worth one.
 */
export async function findPopup(args: {
  engine: Engine;
  observation: Observation;
  rules: PopupRules;
  goal?: string;
  hint?: { kind: PopupKind; title?: string };
  /** Whether a model call may be spent. Without one, only the tree is read. */
  look: boolean;
}): Promise<{ found?: FoundPopup; observation: Observation }> {
  const { engine } = args;
  let observation = args.observation;
  if (!observation.tree && engine.capabilities.tree) observation = await engine.observe({ tree: true });

  const prompt = observation.tree ? readSystemPrompt(observation.tree) : undefined;
  if (prompt?.kind) {
    const answer = args.rules[prompt.kind];
    const control = answer === "allow" ? prompt.allow : answer === "deny" ? prompt.deny : answer === "dismiss" ? prompt.dismiss : undefined;
    // A kind the rules leave to the test is settled here. So is one whose
    // control the tree names; one it does not -- a grant worded in a way the
    // list has never seen -- is not the tree's to call unanswerable.
    if (answer === "off" || control) {
      return {
        found: {
          kind: prompt.kind,
          ...(prompt.title ? { title: prompt.title } : {}),
          ...(control ? { press: { label: control.label, point: centre(control.bounds) } } : {}),
          by: "tree",
        },
        observation,
      };
    }
  }
  if (!args.look) return { observation };

  // A prompt the tree found but could not finish -- a contacts request, a
  // language it has no words for, a button it does not know -- goes to the
  // eyes as a lead, not a verdict.
  const hint =
    args.hint ?? (prompt ? { kind: prompt.kind ?? ("other" as const), ...(prompt.title ? { title: prompt.title } : {}) } : undefined);
  const seen = await engine.popup({
    observation,
    rules: args.rules,
    ...(args.goal ? { goal: args.goal } : {}),
    ...(hint ? { hint } : {}),
  });
  if (!seen.found || !seen.kind) return { observation };
  if (seen.title && APP_ANSWER.test(seen.title)) return { observation };
  // The rules are kept here as well as in the engine: a kind marked "off" is
  // never pressed, whoever pointed at a button on it. Nor is "empty
  // background" that the tree says is a control: a tap meant to close a tip
  // is not to press whatever is beside it.
  const onControl = seen.press?.outside && observation.tree ? pressableAt(observation.tree, seen.press.point) : undefined;
  const press = args.rules[seen.kind] === "off" || onControl ? undefined : seen.press;
  return {
    found: {
      kind: seen.kind,
      ...(seen.title ? { title: seen.title } : {}),
      ...(press ? { press } : {}),
      by: "vision",
    },
    observation,
  };
}
